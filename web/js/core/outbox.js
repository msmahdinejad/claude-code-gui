// The page's view of a session's server-side send queue (see server/lib/outbox.mjs). The server keeps and sends the
// messages; the page only shows them and asks for changes. Its state arrives with every session summary.
import { api } from "./api.js";
import { app, bus } from "./state.js";
import { isBusy } from "../chat/reducer.js";

export const outboxOf = (id) => (id ? app.live.get(id)?.outbox || null : null);

/** A usage limit holds the queue back (the "has reset" notice does not). */
export const isHeld = (box) => Boolean(box?.hold && !box.hold.reset);

/** True when a message typed now has to wait in the queue instead of going straight to Claude. */
export function mustQueue(id) {
  const conv = app.convs.get(id);
  const box = outboxOf(id);
  const busy = conv ? isBusy(conv) && conv.state !== "starting" : false;
  return busy || isHeld(box) || Boolean(box && (box.items?.length || box.paused || box.sending || box.continueDue));
}

export function setOutbox(id, view) {
  const live = app.live.get(id);
  if (live) live.outbox = view;
  else app.live.set(id, { id, state: "closed", alive: false, outbox: view });
  bus.emit("live", id);
}

const base = (id) => `/api/sessions/${encodeURIComponent(id)}/outbox`;

/** Queue a message for `id`; it is sent as soon as the session is free and no limit holds it. */
export async function enqueue(id, { text = "", images = [] } = {}) {
  const conv = app.convs.get(id);
  const result = await api.post(base(id), { text, images, cwd: conv?.cwd || app.currentCwd, meta: conv?.meta });
  setOutbox(id, result.outbox);
  return result;
}

/** Take a waiting message out (returns it with its text and attachments). */
export async function unqueue(id, itemId) {
  const result = await api.del(`${base(id)}/${itemId}`);
  setOutbox(id, result.outbox);
  return result.item;
}

export async function sendQueuedNow(id, itemId) {
  const result = await api.post(`${base(id)}/${itemId}/now`);
  setOutbox(id, result.outbox);
}

export async function setAutoContinue(id, auto) {
  setOutbox(id, (await api.put(`${base(id)}/auto`, { auto })).outbox);
}

export async function continueNow(id) {
  setOutbox(id, (await api.post(`${base(id)}/continue`)).outbox);
}

export async function resumeOutbox(id, { skipHold = false } = {}) {
  setOutbox(id, (await api.post(`${base(id)}/resume`, { skipHold })).outbox);
}

/** The state a status dot shows: a turn that ended while its subagents still work is still "running". */
export function shownState(id, fallback = "closed") {
  const live = app.live.get(id);
  const state = live?.state || fallback;
  return state === "idle" && live?.agentTasks > 0 ? "running" : state;
}
