// Helpers shared by the insight panels (context, usage, tasks, activity, checkpoints).
import { h, toast, errorMessage } from "../core/dom.js";
import { api } from "../core/api.js";
import { app } from "../core/state.js";

/** Run a control op, starting the session process first when it is not alive. */
export async function liveControl(op, args = {}) {
  const id = app.currentId;
  if (!id) throw new Error("no session");
  if (!app.live.get(id)?.alive) {
    const summary = await api.startSession(id, app.currentCwd);
    app.live.set(id, summary);
  }
  return api.control(id, op, args);
}

export function isAlive() {
  return Boolean(app.currentId && app.live.get(app.currentId)?.alive);
}

export function download(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFileName(text, fallback = "conversation") {
  const clean = String(text || "").replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 60).replace(/[.\s]+$/, "");
  return clean || fallback;
}

export function bar(percent, cls = "") {
  const value = Math.max(0, Math.min(100, percent || 0));
  return h("div.progress", h(`i${cls ? `.${cls}` : ""}`, { style: { width: `${value}%` } }));
}

export function guard(container, fn) {
  return Promise.resolve()
    .then(fn)
    .catch((error) => {
      container.append(h("div.banner.error", errorMessage(error)));
      toast(errorMessage(error), "error");
    });
}

export function pct(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Number(value).toFixed(value >= 10 ? 0 : digits)}%`;
}

/** Latin digits with thousands separators: keeps numbers uniform next to formatTokens()/formatCost(). */
export const num = (value) => (value === null || value === undefined ? "" : new Intl.NumberFormat("en-US").format(value));
