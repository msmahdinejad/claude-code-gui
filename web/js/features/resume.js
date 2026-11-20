// Sessions that were working when Wheelhouse stopped: a dialog at start offers to continue them, and Settings has the
// switch for continuing them automatically (off by default). The server does the work (server/lib/resume.mjs).
import { h, modal, toast, errorMessage, baseName } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { api } from "../core/api.js";
import { registerSettingsSection } from "../core/registry.js";

const titleOf = (entry) => app.sessions.find((session) => session.id === entry.id)?.title || baseName(entry.cwd) || entry.id.slice(0, 8);
const ago = (ms) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? t("{n} min ago", { n: minutes }) : t("{n} h ago", { n: Math.round(minutes / 60) });
};
const say = (error) => errorMessage(error);

function list(status) {
  return h(
    "ul.resume-list",
    status.pending.map((entry) => h("li", { dir: "auto" }, h("strong", titleOf(entry)), h("span.muted", ` · ${ago(entry.ageMs)}`), h("span.muted.small", { dir: "ltr", style: { display: "block" } }, entry.cwd))),
  );
}

let offered = false;

async function offer() {
  let status;
  try {
    status = await api.get("/api/resume");
  } catch {
    return;
  }
  if (status.lastResumed?.ok?.length && Date.now() - status.lastResumed.at < 10 * 60_000) {
    toast(t("Continued {n} session(s) that were working when the app closed.", { n: status.lastResumed.ok.length }), "ok");
  }
  if (!status.pending.length || offered) return;
  offered = true;
  const dialog = modal({
    title: t("Sessions were working when the app closed"),
    width: 540,
    body: h(
      "div",
      h("p", t("These sessions were in the middle of a turn when Wheelhouse stopped. Continue them: each gets one short message that asks it to check what already happened and then go on.")),
      list(status),
      h("p.muted.small", t("Continuing uses your account's usage. Sessions you don't continue stay in Settings → Resume after restart for a few hours.")),
    ),
    actions: [
      { label: t("Not now"), onClick: (api2) => api2.close() },
      { label: t("Dismiss"), onClick: async (api2) => { await api.post("/api/resume/dismiss", {}).catch(() => {}); api2.close(); } },
      {
        label: t("Continue them"),
        variant: "primary",
        onClick: async (api2) => {
          api2.close();
          try {
            await api.post("/api/resume/run", {});
            toast(t("Continuing…"), "ok");
            bus.emit("sessions");
          } catch (error) {
            toast(say(error), "error");
          }
        },
      },
    ],
  });
  return dialog;
}

// After the page is up (the session list is loaded by then, so titles show).
setTimeout(offer, 2500);

registerSettingsSection({
  id: "resume", title: "Resume after restart", icon: "refresh", order: 5,
  async render(el) {
    const host = h("div");
    el.append(
      h("h2", t("Resume after restart")),
      h("p.lead", t("If Wheelhouse is restarted (an update, a crash, a reboot) while a session is working, the turn is cut off. This continues such sessions afterwards.")),
      host,
    );
    const draw = (status) => {
      const input = h("input", { type: "checkbox", checked: status.enabled });
      input.addEventListener("change", async () => {
        try {
          await api.put("/api/prefs", { resumeInterrupted: input.checked });
          draw(await api.get("/api/resume"));
        } catch (error) {
          toast(say(error), "error");
          input.checked = !input.checked;
        }
      });
      const last = status.lastResumed;
      host.replaceChildren(
        h("div.group", h("h3", t("Automatic")),
          h("div.setting-row", h("div.grow", h("strong", t("Continue interrupted sessions by themselves")), h("small", t("Off by default. When on, sessions that were interrupted in the last {n} minutes are continued a few seconds after Wheelhouse starts: at most {max} at once, each one once. Others are only offered.", { n: status.autoWindowMin, max: status.maxAtOnce }))), h("label.switch", input)),
        ),
        h("div.group", h("h3", t("Waiting to be continued")),
          status.pending.length
            ? h("div", list(status), h("div", { style: { display: "flex", gap: "8px", marginTop: "8px" } },
              h("button.btn.primary", { type: "button", onclick: async () => { try { await api.post("/api/resume/run", {}); toast(t("Continuing…"), "ok"); setTimeout(async () => draw(await api.get("/api/resume")), 3000); draw(await api.get("/api/resume")); } catch (error) { toast(say(error), "error"); } } }, icon("refresh", 13), t("Continue them")),
              h("button.btn", { type: "button", onclick: async () => { try { draw(await api.post("/api/resume/dismiss", {})); } catch (error) { toast(say(error), "error"); } } }, t("Dismiss"))))
            : h("p.muted", t("Nothing is waiting.")),
        ),
        last ? h("div.group", h("h3", t("Last time")), h("p", { dir: "auto" }, t("{ok} continued, {failed} could not be continued.", { ok: last.ok.length, failed: last.failed.length })), last.failed.length ? h("ul", last.failed.map((entry) => h("li.muted", { dir: "auto" }, `${titleOf(entry)}: ${entry.error}`))) : null) : null,
        h("div.banner.info", icon("info", 14), h("span", t("A turn that was cut off in the middle of an action (a deploy, a push, a migration) may have stopped half-way. The message asks the session to check what finished before it goes on; look at those sessions yourself."))),
      );
    };
    try {
      draw(await api.get("/api/resume"));
    } catch (error) {
      host.replaceChildren(h("div.banner.error", icon("alert", 14), h("span", say(error))));
    }
  },
});
