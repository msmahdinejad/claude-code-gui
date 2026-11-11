// Claude Code updates: a Settings page (switch, versions, "Check now") and a watcher that refreshes the model list and
// says so when the server has just installed a newer Claude Code (see server/lib/claude-updater.mjs).
import { h, toast, errorMessage, confirmDialog } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { registerSettingsSection } from "../core/registry.js";
import { api } from "../core/api.js";
import * as session from "../session.js";

const WATCH_MS = 5 * 60 * 1000;
let seenUpdate = null; // `updatedAt` of the last install this page knows about (null until the first answer)

async function fetchStatus() {
  const status = await api.get("/api/update");
  if (seenUpdate === null) seenUpdate = status.updatedAt || 0;
  else if (status.updatedAt && status.updatedAt !== seenUpdate) {
    seenUpdate = status.updatedAt;
    toast(t("Claude Code was updated to {version}. The model list was reloaded.", { version: status.updatedTo }), "ok");
    session.ensureCatalog(app.currentCwd, true);
  }
  bus.emit("update:status", status);
  return status;
}

function watch() {
  const poll = () => fetchStatus().catch(() => {});
  poll();
  setInterval(poll, WATCH_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });
}
watch();

const PHASES = {
  checking: "Looking for a newer version…",
  downloading: "Downloading the new version in the background…",
  waiting: "The new version is in use. The Claude Code your terminal runs is updated as soon as no session is working.",
  installing: "Updating the Claude Code your terminal runs…",
};

registerSettingsSection({
  id: "updates", title: "Updates", icon: "download", order: 3,
  async render(el) {
    const host = h("div");
    el.append(h("h2", t("Updates")), h("p.lead", t("Claude Code only knows the models that existed when it was built, so a new model appears here after Claude Code is updated. Wheelhouse can do that for you while nothing is running.")), host);
    let timer = null;

    const draw = (status) => {
      // The server owns this switch (it is the one that updates), so the page shows what the server says.
      const input = h("input", { type: "checkbox", checked: status.enabled });
      input.addEventListener("change", async () => {
        try {
          await api.put("/api/prefs", { autoUpdateClaude: input.checked });
          draw(await api.get("/api/update"));
        } catch (error) {
          toast(errorMessage(error), "error");
          input.checked = !input.checked;
        }
      });
      const bits = [
        status.active ? `${t("In use")}: ${status.active}` : null,
        status.installed && status.installed !== status.active ? `${t("Terminal")}: ${status.installed}` : null,
        status.latest ? `${t("Newest")}: ${status.latest}` : null,
        status.checkedAt ? `${t("Last checked")}: ${new Date(status.checkedAt).toLocaleTimeString()}` : null,
      ].filter(Boolean);
      const note = status.error
        ? h("div.banner.warn", icon("alert", 14), h("span", { dir: "auto" }, t(status.error)))
        : status.phase !== "idle" && PHASES[status.phase]
          ? h("div.banner.info", icon("refresh", 14), h("span", t(PHASES[status.phase])))
          : status.updateAvailable
            ? h("div.banner.info", icon("download", 14), h("span", t("A newer version is available.")))
            : status.active ? h("div.banner.info", icon("check-circle", 14), h("span", t("Claude Code is up to date."))) : null;
      host.replaceChildren(
        h("div.group", h("h3", t("Claude Code")),
          h("div.setting-row", h("div.grow", h("strong", t("Update automatically")), h("small", t("When a newer version is out it is downloaded in the background and used for every new session right away; sessions that are working keep going. The Claude Code your terminal runs is updated once no session is working."))), h("label.switch", input)),
          h("div.setting-row", h("div.grow", h("strong", t("Version")), h("small", { dir: "ltr" }, bits.join(" · ") || "…")), h("div", { style: { display: "flex", gap: "8px" } },
            h("button.btn", { type: "button", onclick: async () => { try { draw(await api.post("/api/update/check", {})); } catch (error) { toast(errorMessage(error), "error"); } } }, t("Check now")),
            status.updateAvailable || status.phase === "waiting" || (status.installed && status.active && status.installed !== status.active)
              ? h("button.btn.primary", { type: "button", onclick: async () => {
                if (!(await confirmDialog({ title: t("Update now"), message: t("Sessions that run the old version are stopped, also if they are working; they continue on your next message. Claude Code windows open in a terminal can block the update."), confirmLabel: t("Update now") }))) return;
                try { draw(await api.post("/api/update/apply", { now: true })); schedule(); } catch (error) { toast(errorMessage(error), "error"); }
              } }, t("Update now"))
              : null,
          )),
          note,
        ),
      );
    };

    // While something is happening, look again every few seconds.
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!el.isConnected) return;
        try {
          const status = await fetchStatus();
          draw(status);
          if (status.phase !== "idle") schedule();
        } catch { /* try again on the next visit */ }
      }, 4000);
    };

    try {
      const status = await fetchStatus();
      draw(status);
      if (status.phase !== "idle") schedule();
    } catch (error) {
      host.replaceChildren(h("div.banner.error", icon("alert", 14), h("span", errorMessage(error))));
    }
  },
});
