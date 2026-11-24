// What is being typed in each conversation's message box, saved on the server (it survives restarts, a closed window
// and another address or port) with a copy of the text in this browser for an instant start. Attachments go to the
// server only. A save is sent a moment after the last change, at once when the conversation is left or the page hides.
// Every save carries the time it was made; the server ignores one older than what it has, so a late or retried save
// never overwrites a newer one.
import { api } from "./api.js";

const SEND_MS = 700;
const KEEPALIVE_MAX = 60 * 1024; // browsers drop keepalive requests with a larger body
const textKey = (id) => `wheelhouse-draft-${id}`;
const atKey = (id) => `wheelhouse-draft-at-${id}`;
const pending = new Map(); // id -> { text, images | keepImages, at } not on the server yet
const newest = new Map(); // id -> time of the newest save made here (a failed older one is not tried again)
let timer = null;

function readLocal(id) {
  try {
    return { text: localStorage.getItem(textKey(id)) || "", at: Number(localStorage.getItem(atKey(id))) || 0 };
  } catch {
    return { text: "", at: 0 };
  }
}

/** The text saved in this browser (shown at once, before the server answers). */
export function localText(id) {
  return pending.get(id)?.text ?? readLocal(id).text;
}

/**
 * Record the box of `id` as it is now. `keepImages` saves only the text and leaves the attachments the server has
 * (a box without attachments, or one whose attachments did not change).
 */
export function saveDraft(id, { text = "", images = [], keepImages = false } = {}) {
  if (!id) return;
  const at = Math.max(Date.now(), (newest.get(id) || 0) + 1);
  newest.set(id, at);
  try {
    if (text) {
      localStorage.setItem(textKey(id), text);
      localStorage.setItem(atKey(id), String(at));
    } else {
      localStorage.removeItem(textKey(id));
      localStorage.removeItem(atKey(id));
    }
  } catch { /* storage full or unavailable: the server copy still goes */ }
  // An unsent save that carried attachments keeps them when a text-only save replaces it.
  const before = pending.get(id);
  const carry = keepImages && before && !before.keepImages ? { images: before.images } : null;
  pending.set(id, carry ? { text, ...carry, at } : keepImages ? { text, keepImages: true, at } : { text, images: images.slice(), at });
  clearTimeout(timer);
  timer = setTimeout(() => flushDrafts(), SEND_MS);
}

/** Send every unsent draft now (leaving a conversation, hiding the page). */
export function flushDrafts({ keepalive = false } = {}) {
  clearTimeout(timer);
  timer = null;
  for (const [id, draft] of pending) {
    pending.delete(id);
    const body = JSON.stringify(draft);
    const retry = () => { // only if nothing newer was saved since
      if (!pending.has(id) && draft.at >= (newest.get(id) || 0)) {
        pending.set(id, draft);
        clearTimeout(timer);
        timer = setTimeout(() => flushDrafts(), SEND_MS * 4);
      }
    };
    fetch(`/api/drafts/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      keepalive: keepalive && body.length < KEEPALIVE_MAX,
    }).then((response) => { if (!response.ok && response.status !== 413) retry(); }).catch(retry);
  }
}

/** The newest draft of `id`: this browser's text when it is newer than the server's copy, the server's otherwise. */
export async function loadDraft(id) {
  const unsent = pending.get(id);
  if (unsent && !unsent.keepImages) return unsent;
  const local = readLocal(id);
  let server = { text: "", images: [], at: 0 };
  try { server = await api.get(`/api/drafts/${encodeURIComponent(id)}`); } catch { /* offline: this browser's copy */ }
  const now = pending.get(id);
  if (now) return { text: now.text, images: now.keepImages ? server.images || [] : now.images, at: now.at }; // typed while we waited
  if (local.at > (server.at || 0) || !server.at) return { text: local.text || server.text || "", images: server.images || [], at: Math.max(local.at, server.at || 0) };
  return { text: server.text || "", images: server.images || [], at: server.at };
}

addEventListener("pagehide", () => flushDrafts({ keepalive: true }));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushDrafts({ keepalive: true }); });
