// Notifications when Claude finishes or needs you. The server decides what is worth announcing (and stays quiet about
// the conversation you are reading); with the Windows tray it shows them natively, even with this window closed.
// Without a tray the page shows them itself with the browser Notification API. Also a badge on the tab title.
import { app, bus } from "../core/state.js";
import { api, onServerEvent } from "../core/api.js";
import { getLang } from "../core/i18n.js";
import { openSession } from "../session.js";

const HEARTBEAT_MS = 10_000;

export function initNotifications() {
  const report = () => {
    api.post("/api/presence", { focused: document.hasFocus() && !document.hidden, sessionId: app.currentId, lang: getLang() }).catch(() => {});
  };
  for (const name of ["focus", "blur", "visibilitychange"]) window.addEventListener(name, report);
  bus.on("current", report);
  setInterval(() => { if (document.hasFocus()) report(); }, HEARTBEAT_MS);
  report();

  onServerEvent("notification", (item) => {
    if (document.hidden && !document.title.startsWith("● ")) document.title = `● ${document.title}`;
    if (app.config?.nativeNotifications) return; // the tray already shows it
    if (!app.prefs.notifications || !("Notification" in window) || Notification.permission !== "granted") return;
    const note = new Notification(item.title, { body: item.body, tag: item.sessionId || "wheelhouse", icon: "/icons/icon-192.png" });
    note.onclick = () => { window.focus(); if (item.sessionId) openSession(item.sessionId); note.close(); };
  });

  // A notification clicked in the tray: show that conversation.
  onServerEvent("focus.session", ({ sessionId }) => {
    window.focus();
    openSession(sessionId);
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) bus.emit("current"); // redraws the title without the badge
  });
}
