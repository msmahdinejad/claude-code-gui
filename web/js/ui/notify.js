// Desktop notifications + tab title badge when Claude needs attention or finishes.
import { app, bus } from "../core/state.js";
import { t } from "../core/i18n.js";
import { openSession } from "../session.js";

export function initNotifications() {
  const base = document.title;
  const notify = (title, body, sessionId) => {
    if (!app.prefs.notifications || !("Notification" in window) || Notification.permission !== "granted") return;
    if (document.hasFocus() && sessionId === app.currentId) return;
    const note = new Notification(title, { body, tag: sessionId, icon: "/icon.svg" });
    note.onclick = () => { window.focus(); openSession(sessionId); note.close(); };
  };
  bus.on("attention", ({ sessionId, request }) => {
    const what = request.toolName ? t("Claude needs your approval for {tool}", { tool: request.toolName }) : t("Claude needs your input");
    notify("Wheelhouse", what, sessionId);
    if (document.hidden) document.title = `● ${base}`;
  });
  let previous = new Map();
  bus.on("live", (id) => {
    const state = app.live.get(id)?.state;
    if (previous.get(id) === "running" && state === "idle") notify("Wheelhouse", t("Claude finished"), id);
    previous.set(id, state);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) bus.emit("current");
  });
}
