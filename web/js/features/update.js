// Claude Code updates: a chip in the top bar when a newer version is out ("Update and relaunch" opens a dialog that shows
// the progress), a Settings page (switch, versions, "Check now") and a watcher that refreshes the model list and says so
// when the server has just installed a newer Claude Code (see server/lib/claude-updater.mjs).
import { h, toast, errorMessage, confirmDialog, modal } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { registerSettingsSection } from "../core/registry.js";
import { api } from "../core/api.js";
import * as session from "../session.js";

const WATCH_MS = 5 * 60 * 1000;
const FAST_MS = 1200; // while an update runs
const CHANGELOG_URL = "https://code.claude.com/docs/en/changelog";
const RELEASES_URL = "https://github.com/anthropics/claude-code/releases";

let seenUpdate = null; // `updatedAt` of the last install this page knows about (null until the first answer)
let status = null; // the last answer of GET /api/update
let working = false; // "Update and relaunch" was pressed in this page and has not finished
let outcome = null; // how that run ended: { kind: "ok" | "partial" | "failed", status }
let dialog = null; // { draw() } while the dialog is open
let fastTimer = null;

const percentOf = (s) => (s?.progress && s.phase === "downloading" ? s.progress.percent : null);
const showPercent = (value) => t("{n}%", { n: value });

/** What went wrong, in the user's language (the technical reason goes under it, as the server wrote it). */
function failureText(s) {
  const kind = s?.failure?.kind;
  if (!kind) return s?.error ? t(s.error) : t("The update did not work.");
  if (kind === "locked") return t("Claude Code is in use, so its files could not be replaced. Close Claude Code windows in your terminal and try again.");
  if (kind === "incomplete") return t("The new version did not start once it was installed, so the old one was put back.");
  if (kind === "restore") return t("The old files could not be put back automatically. They are kept in a backup folder next to the installation.");
  return t("The new version could not be downloaded completely.");
}

const PHASES = {
  checking: "Looking for a newer version…",
  downloading: "Downloading the new version in the background…",
  waiting: "The new version is in use. The Claude Code your terminal runs is updated as soon as no session is working.",
  installing: "Updating the Claude Code your terminal runs…",
};

// ---- state ------------------------------------------------------------------------------------------------------

/** A run started here is over once the server is no longer busy. */
function settle() {
  if (!working || !status || status.busy) return;
  working = false;
  const ok = !status.updateAvailable;
  outcome = { kind: ok ? (status.failure ? "partial" : "ok") : "failed", status };
}

function notifyDone(version) {
  // Only when nobody is looking at the page: the toast is enough otherwise.
  try {
    if (document.visibilityState === "hidden" && typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("Wheelhouse", { body: t("Claude Code was updated to {version}. The model list was reloaded.", { version }) });
    }
  } catch { /* notifications are optional */ }
}

async function fetchStatus() {
  const next = await api.get("/api/update");
  if (seenUpdate === null) seenUpdate = next.updatedAt || 0;
  else if (next.updatedAt && next.updatedAt !== seenUpdate) {
    seenUpdate = next.updatedAt;
    if (!dialog) toast(t("Claude Code was updated to {version}. The model list was reloaded.", { version: next.updatedTo }), "ok");
    notifyDone(next.updatedTo);
    session.ensureCatalog(app.currentCwd, true);
  }
  status = next;
  settle();
  bus.emit("update:status", status);
  render();
  ensureFast();
  return status;
}

/** While an update runs, look again every second or so. */
function ensureFast() {
  if (fastTimer || !(working || status?.busy)) return;
  fastTimer = setTimeout(async () => {
    fastTimer = null;
    try { await fetchStatus(); } catch { /* the server may be busy; try again */ }
    ensureFast();
  }, FAST_MS);
}

async function startUpdate() {
  working = true;
  outcome = null;
  render();
  try {
    status = await api.post("/api/update/apply", { now: true });
    settle();
  } catch (error) {
    working = false;
    outcome = { kind: "failed", status: { ...status, failure: null, error: errorMessage(error) } };
  }
  render();
  ensureFast();
}

function watch() {
  const poll = () => fetchStatus().catch(() => {});
  poll();
  setInterval(poll, WATCH_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });
  // The top bar is built after the features load (and once only): put the chip into it whenever it is there.
  const bar = document.getElementById("topbar");
  if (bar) new MutationObserver(() => place()).observe(bar, { childList: true });
}

// ---- the chip ---------------------------------------------------------------------------------------------------

const chip = h("button.btn.small.update-chip", { type: "button", hidden: true, onclick: () => openDialog() });

function place() {
  const bar = document.getElementById("topbar");
  const anchor = bar?.querySelector(".tb-title");
  if (anchor && chip.previousElementSibling !== anchor) anchor.after(chip);
}

function render() {
  const updating = working || (status?.busy && ["downloading", "installing"].includes(status.phase) && status.updateAvailable);
  const show = Boolean(status && status.install === "npm" && (updating || status.updateAvailable));
  chip.hidden = !show;
  if (show) {
    place();
    chip.classList.toggle("updating", Boolean(updating));
    chip.classList.toggle("failed", !updating && outcome?.kind === "failed");
    const percent = percentOf(status);
    chip.title = t("Update Claude Code");
    chip.replaceChildren(...(updating
      ? [icon("refresh", 13, "spin"), h("span.update-chip-text", t("Updating Claude Code…")), percent !== null ? h("span.update-chip-act", showPercent(percent)) : null]
      : [icon("download", 13), h("span.update-chip-text", t("Claude Code {version} available", { version: status.latest })), h("span.update-chip-sep", { "aria-hidden": "true" }, "·"), h("span.update-chip-act", outcome?.kind === "failed" ? t("Retry") : t("Update"))]));
  }
  dialog?.draw();
}

// ---- the dialog -------------------------------------------------------------------------------------------------

const link = (label, href) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, label);

function openDialog() {
  if (dialog || !status) return;
  const body = h("div.upd");
  const m = modal({ title: t("Update Claude Code"), body, width: 480, onClose: () => { dialog = null; } });
  const close = h("button.btn", { type: "button", onclick: () => m.close() });
  const draw = () => {
    if (!body.isConnected) return;
    const s = outcome?.status || status;
    const actions = [];
    const nodes = [];
    if (working) {
      const percent = percentOf(status);
      const label = status.phase === "installing" ? t("Installing and restarting sessions…") : status.phase === "downloading" ? t("Downloading Claude Code {version}…", { version: status.target || status.latest }) : t("Getting ready…");
      nodes.push(
        h("p.upd-phase", icon("refresh", 14, "spin"), h("span", label), percent !== null ? h("strong.upd-pct", showPercent(percent)) : null),
        h(`div.progress.upd-bar${percent === null ? ".indeterminate" : ""}`, { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": percent ?? undefined }, h("i", { style: percent === null ? {} : { width: `${percent}%` } })),
        h("p.muted.upd-note", t("Sessions running the old version are restarted and continue on your next message. A Claude Code window in a terminal is not closed, but it can block the update; if it does, close it and try again.")),
      );
      close.textContent = t("Run in background");
      actions.push(close);
    } else if (outcome?.kind === "ok") {
      nodes.push(
        h("p.upd-result.ok", icon("check-circle", 18), h("span", t("Updated to {version}. Sessions will continue with the new version.", { version: s.installed || s.updatedTo }))),
        h("p.muted.upd-note", t("Claude Code windows open in a terminal were not closed.")),
      );
      close.textContent = t("Close");
      close.classList.add("primary");
      actions.push(close);
    } else if (outcome) {
      const partial = outcome.kind === "partial";
      const f = s.failure;
      nodes.push(
        h(`p.upd-result.${partial ? "warn" : "error"}`, icon("alert", 18), h("span", partial ? t("Wheelhouse now uses {version}, but the Claude Code your terminal runs could not be updated.", { version: s.active }) : t("The update did not work."))),
        h("p", failureText(s)),
        f?.kept ? h("p.upd-note", t("The previous version ({version}) was kept and is still in use.", { version: f.kept })) : null,
        f?.reason ? h("p.muted.upd-detail", { dir: "auto" }, f.reason) : s.error ? h("p.muted.upd-detail", { dir: "auto" }, s.error) : null,
      );
      close.textContent = t("Close");
      actions.push(close);
      if (!partial) actions.push(h("button.btn.primary", { type: "button", onclick: () => startUpdate() }, t("Try again")));
    } else {
      nodes.push(
        h("p", t("Claude Code {latest} is available. You are on {current}.", { latest: status.latest, current: status.installed || status.active || "?" })),
        h("p.upd-links", `${t("What changed:")} `, link(t("Changelog"), CHANGELOG_URL), " · ", link(t("GitHub releases"), RELEASES_URL)),
        h("p.muted.upd-note", t("Sessions running the old version are restarted and continue on your next message. A Claude Code window in a terminal is not closed, but it can block the update; if it does, close it and try again.")),
      );
      close.textContent = t("Not now");
      actions.push(close, h("button.btn.primary", { type: "button", autofocus: true, onclick: () => startUpdate() }, icon("refresh", 14), t("Update and relaunch")));
    }
    body.replaceChildren(...nodes.filter(Boolean), h("div.upd-actions", actions));
  };
  dialog = { draw };
  outcome = working ? outcome : null; // a result that was already seen is not shown again
  draw();
}

watch();

// ---- Settings → Updates ------------------------------------------------------------------------------------------

registerSettingsSection({
  id: "updates", title: "Updates", icon: "download", order: 3,
  async render(el) {
    const host = h("div");
    el.append(h("h2", t("Updates")), h("p.lead", t("Claude Code only knows the models that existed when it was built, so a new model appears here after Claude Code is updated. Wheelhouse can do that for you while nothing is running.")), host);
    let timer = null;

    const draw = (state) => {
      // The server owns this switch (it is the one that updates), so the page shows what the server says.
      const input = h("input", { type: "checkbox", checked: state.enabled });
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
        state.active ? `${t("In use")}: ${state.active}` : null,
        state.installed && state.installed !== state.active ? `${t("Terminal")}: ${state.installed}` : null,
        state.latest ? `${t("Newest")}: ${state.latest}` : null,
        state.checkedAt ? `${t("Last checked")}: ${new Date(state.checkedAt).toLocaleTimeString()}` : null,
      ].filter(Boolean);
      const percent = percentOf(state);
      const note = state.error
        ? h("div.banner.warn", icon("alert", 14), h("span", { dir: "auto" }, state.failure ? failureText(state) : t(state.error)))
        : state.phase !== "idle" && PHASES[state.phase]
          ? h("div.banner.info", icon("refresh", 14), h("span", t(PHASES[state.phase]), percent !== null ? ` ${showPercent(percent)}` : ""))
          : state.updateAvailable
            ? h("div.banner.info", icon("download", 14), h("span", t("A newer version is available.")))
            : state.active ? h("div.banner.info", icon("check-circle", 14), h("span", t("Claude Code is up to date."))) : null;
      host.replaceChildren(
        h("div.group", h("h3", t("Claude Code")),
          h("div.setting-row", h("div.grow", h("strong", t("Update automatically")), h("small", t("When a newer version is out it is downloaded in the background and used for every new session right away; sessions that are working keep going. The Claude Code your terminal runs is updated once no session is working."))), h("label.switch", input)),
          h("div.setting-row", h("div.grow", h("strong", t("Version")), h("small", { dir: "ltr" }, bits.join(" · ") || "…")), h("div", { style: { display: "flex", gap: "8px" } },
            h("button.btn", { type: "button", onclick: async () => { try { draw(await api.post("/api/update/check", {})); } catch (error) { toast(errorMessage(error), "error"); } } }, t("Check now")),
            state.updateAvailable || state.phase === "waiting" || (state.installed && state.active && state.installed !== state.active)
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
          const state = await fetchStatus();
          draw(state);
          if (state.phase !== "idle") schedule();
        } catch { /* try again on the next visit */ }
      }, 4000);
    };

    try {
      const state = await fetchStatus();
      draw(state);
      if (state.phase !== "idle") schedule();
    } catch (error) {
      host.replaceChildren(h("div.banner.error", icon("alert", 14), h("span", errorMessage(error))));
    }
  },
});
