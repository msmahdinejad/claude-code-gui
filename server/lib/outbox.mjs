// Messages waiting to be sent to a session, kept by the server (not the page) so they survive a restart, a closed
// window and a conversation that is not on screen.
//
// A message typed while Claude is working (or while a usage limit holds the session) is queued here and written to
// <dir>/<session id>.json. The server sends the next one as soon as the session is free: not running, not starting and
// not waiting for an answer. A claude.ai usage limit (a "rejected" rate_limit_event) holds the queue until the limit
// resets; at the reset the session is first asked to continue the turn the limit cut off (the automatic continue, on by
// default, at most MAX_AUTO times in a row), and the queued messages follow once that turn has finished. A limit belongs
// to the account, so while it holds one session the queues of the other sessions of that profile wait too.
// Pressing Stop pauses the session's queue until the user resumes it or sends another message.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONTINUE_TEXT = "Please continue the task you were working on.";
export const GRACE_MS = 3000; // a moment after the reset, so the limit is surely lifted
export const SETTLE_MS = 400; // a finished turn's last events (rate limit, result) arrive around its "idle"
export const MAX_AUTO = 3; // like Claude Code: stop after this many automatic continues in a row
export const MAX_ITEMS = 50;
export const RETRY_MS = [15_000, 60_000, 5 * 60_000]; // a send that failed is tried again after these waits, then paused
export const SOFT_HOLD_MS = 5 * 60_000;
export const INTERRUPTED_SEND =
  "Wheelhouse stopped while this message was being sent, so it may or may not have reached Claude. Check the conversation, then try again or remove it.";
const NOTICE_TTL_MS = 12 * 60 * 60_000;
const KEEP_IDLE_MS = 2 * 24 * 60 * 60_000; // a box that only remembers a setting (switch off, a run of continues) goes after this
const BUSY = ["running", "starting", "requires_action"];
const ID = /^[A-Za-z0-9_-]{1,80}$/;

const cleanItem = (item) =>
  item && typeof item.id === "string" && (item.text || item.images?.length)
    ? { id: item.id, text: String(item.text || ""), images: Array.isArray(item.images) ? item.images : [], at: Number(item.at) || Date.now() }
    : null;

const clean = (raw) => {
  if (!raw || typeof raw !== "object" || !ID.test(String(raw.id || ""))) return null;
  const items = (Array.isArray(raw.items) ? raw.items : []).map(cleanItem).filter(Boolean);
  let hold = raw.hold && Number(raw.hold.resetsAt) > 0
    ? { resetsAt: Number(raw.hold.resetsAt), type: String(raw.hold.type || ""), at: Number(raw.hold.at) || Date.now(), ...(raw.hold.soft ? { soft: true } : {}), ...(raw.hold.reset ? { reset: true } : {}) }
    : null;
  if (hold?.reset && Date.now() - hold.resetsAt > NOTICE_TTL_MS) hold = null; // an old "has reset" notice is not worth keeping
  return {
    id: raw.id,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    profile: typeof raw.profile === "string" ? raw.profile : null,
    items,
    hold,
    auto: raw.auto !== false,
    autoCount: Number(raw.autoCount) || 0,
    continueDue: Boolean(raw.continueDue),
    paused: Boolean(raw.paused),
    stopped: Boolean(raw.stopped),
    retryAt: Number(raw.retryAt) || 0,
    inflight: raw.inflight && raw.inflight.source === "outbox" ? { ...cleanItem(raw.inflight), source: "outbox" } : null,
    error: raw.error && typeof raw.error.message === "string" ? { message: raw.error.message, at: Number(raw.error.at) || 0, attempts: Number(raw.error.attempts) || 1 } : null,
    touched: Number(raw.touched) || Date.now(),
  };
};

export class Outbox extends EventEmitter {
  /**
   * @param {object} deps
   * @param {string} deps.dir                 folder for one small file per session with something waiting
   * @param {object} deps.manager             SessionManager (emits session.state / session.limit / session.sent / session.interrupted)
   * @param {(id, entry) => Promise} deps.send   sends one message (opens and starts the session as needed)
   * @param {() => string} [deps.profile]     the active connection profile: a queue only drains under its own profile
   * @param {(id) => boolean} [deps.skip]     sessions whose limits are not handled here (scheduled runs have their own rules)
   */
  constructor({ dir, manager, send, profile = () => null, skip = () => false, now = Date.now, settleMs = SETTLE_MS, graceMs = GRACE_MS, retryMs = RETRY_MS }) {
    super();
    Object.assign(this, { dir, manager, sendFn: send, profileFn: profile, skip, now, settleMs, graceMs, retryMs });
    this.boxes = new Map(); // id -> state (see clean())
    this.sending = new Set(); // sessions with a send in flight
    this.timers = new Map(); // id -> timeout (settle, reset or retry)
    this.accountHolds = new Map(); // profile -> { resetsAt, type, from }: a limit of the account holds every queue of it
  }

  /** Read what an earlier run left behind and start listening. Drains after `startDelayMs` (after the resume of interrupted sessions). */
  start({ startDelayMs = 10_000 } = {}) {
    try { mkdirSync(this.dir, { recursive: true }); } catch { /* the queue then lives in memory only */ }
    let files = [];
    try { files = readdirSync(this.dir).filter((name) => name.endsWith(".json")); } catch { /* none */ }
    for (const name of files) {
      try {
        const box = clean(JSON.parse(readFileSync(join(this.dir, name), "utf8")));
        if (box?.inflight) {
          // The server stopped in the middle of sending it: put it back first and let the user decide.
          const { source: _source, ...item } = box.inflight;
          if (item.id) box.items.unshift(item);
          box.inflight = null;
          box.paused = true;
          box.error = { message: INTERRUPTED_SEND, at: this.now(), attempts: 1 };
        }
        if (box && !this.idle(box)) {
          this.boxes.set(box.id, box);
          if (box.hold && !box.hold.reset && !box.hold.soft && box.profile) this.holdAccount(box.profile, box.hold, box.id);
        } else {
          this.unlink(name.slice(0, -5));
        }
      } catch { /* a broken file is left alone */ }
    }
    this.manager.on("session.state", (summary) => this.onState(summary));
    this.manager.on("session.limit", ({ id, info }) => this.onLimit(id, info));
    this.manager.on("session.sent", ({ id, source }) => this.onSent(id, source));
    this.manager.on("session.interrupted", ({ id }) => this.onInterrupted(id));
    const later = setTimeout(() => { for (const id of this.boxes.keys()) this.schedule(id, 0); }, startDelayMs);
    later.unref?.();
    return [...this.boxes.keys()];
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // ---- state --------------------------------------------------------------------
  box(id, create = false) {
    let box = this.boxes.get(id);
    if (!box && create) {
      box = clean({ id, items: [] });
      this.boxes.set(id, box);
    }
    return box || null;
  }

  /** Something is waiting to be sent (or a limit holds it back). */
  waiting(id) {
    const box = this.boxes.get(id);
    return Boolean(box && (box.items.length || box.continueDue || (box.hold && !box.hold.reset)));
  }

  /** The account-wide limit that holds this box back, if any (only while it has something to send). */
  sharedHold(box) {
    const profile = box.profile || this.profileFn();
    const shared = profile ? this.accountHolds.get(profile) : null;
    if (!shared || shared.from === box.id || this.now() >= shared.resetsAt + this.graceMs) return null;
    return box.items.length ? { resetsAt: shared.resetsAt, type: shared.type, at: shared.at, account: true } : null;
  }

  /** What a page needs to draw the queue and the limit banner (attachment data is left out). */
  view(id) {
    const box = this.boxes.get(id);
    if (!box) return null;
    const own = box.hold && !box.hold.reset ? box.hold : null;
    return {
      items: box.items.map((item) => ({ id: item.id, text: item.text, at: item.at, attachments: item.images.map((image) => ({ mediaType: image.mediaType, name: image.name })) })),
      hold: own || this.sharedHold(box) || box.hold,
      auto: box.auto,
      continueDue: box.continueDue,
      paused: box.paused,
      stopped: box.stopped,
      error: box.error,
      sending: this.sending.has(id),
    };
  }

  /** True while a usage limit holds the queue back (a message typed now has to wait). */
  held(id) {
    const box = this.boxes.get(id);
    return Boolean(box && ((box.hold && !box.hold.reset) || this.sharedHold(box)));
  }

  save(id) {
    const box = this.boxes.get(id);
    if (!box) return this.unlink(id);
    if (this.idle(box) && !this.sending.has(id)) {
      this.boxes.delete(id);
      return this.unlink(id);
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, `${id}.json`);
      writeFileSync(`${file}.tmp`, JSON.stringify(box));
      renameSync(`${file}.tmp`, file);
    } catch { /* kept in memory; written again on the next change */ }
  }

  /** Nothing waits; what is left (a run of automatic continues, the switch turned off) is only kept for a while. */
  idle(box) {
    if (box.items.length || box.hold || box.continueDue || box.error || box.inflight || box.paused) return false;
    return (!box.autoCount && box.auto) || this.now() - box.touched > KEEP_IDLE_MS;
  }

  unlink(id) {
    try { unlinkSync(join(this.dir, `${id}.json`)); } catch { /* not there */ }
  }

  changed(id) {
    const box = this.boxes.get(id);
    if (box) box.touched = this.now();
    this.save(id);
    const live = this.manager.get(id);
    if (live) this.manager.emit("session.state", live.summary());
    this.emit("changed", id);
  }

  holdAccount(profile, hold, from) {
    const current = this.accountHolds.get(profile);
    if (current && current.resetsAt >= hold.resetsAt) return;
    this.accountHolds.set(profile, { resetsAt: hold.resetsAt, type: hold.type, at: hold.at || this.now(), from });
  }

  /** Every other queue of the profile: tell their pages and look again (a hold began or ended). */
  touchOthers(profile, except) {
    for (const [id, box] of this.boxes) {
      if (id === except || (box.profile || profile) !== profile || !box.items.length) continue;
      this.changed(id);
      this.schedule(id, 0);
    }
  }

  // ---- what the page asks for ---------------------------------------------------
  /** `front` puts it first (a message given back after a failed "send now"); it may go over the limit of MAX_ITEMS. */
  add(id, { text = "", images = [], cwd, front = false } = {}) {
    if (!ID.test(String(id))) throw new Error("bad session id");
    if (!String(text).trim() && !images.length) throw new Error("empty message");
    const box = this.box(id, true);
    if (!front && box.items.length >= MAX_ITEMS) throw new Error(`at most ${MAX_ITEMS} messages can wait`);
    if (cwd) box.cwd = cwd;
    box.profile = this.profileFn() || box.profile;
    const item = { id: randomUUID(), text: String(text), images, at: this.now() };
    if (front) box.items.unshift(item); else box.items.push(item);
    if (!front && box.paused) { // a new message after Stop (or after failures) means: go on
      box.paused = false;
      box.stopped = false;
      box.retryAt = 0;
    }
    this.changed(id);
    this.schedule(id, 0);
    return item;
  }

  remove(id, itemId) {
    const box = this.boxes.get(id);
    const index = box ? box.items.findIndex((item) => item.id === itemId) : -1;
    if (index < 0) return null;
    const [item] = box.items.splice(index, 1);
    if (!box.items.length) {
      box.error = null;
      box.retryAt = 0;
      box.paused = false;
      box.stopped = false;
    }
    this.changed(id);
    return item;
  }

  /** Take a message out of the queue to send it right away (the caller interrupts the running turn first). */
  take(id, itemId) {
    return this.remove(id, itemId);
  }

  setAuto(id, auto) {
    const box = this.box(id, true);
    box.auto = Boolean(auto);
    if (box.auto) box.autoCount = 0;
    else box.continueDue = false;
    this.changed(id);
    this.schedule(id, 0);
  }

  /** "Continue" pressed after a limit reset (automatic continue off): send the continue now, then the queue. */
  continueNow(id) {
    const box = this.box(id, true);
    box.hold = null;
    box.continueDue = true;
    box.paused = false;
    box.stopped = false;
    this.changed(id);
    this.schedule(id, 0);
  }

  /** Paused (Stop, repeated failures) or held by a limit the user wants to skip: go on now. */
  resume(id, { skipHold = false } = {}) {
    const box = this.boxes.get(id);
    if (!box) return;
    box.paused = false;
    box.stopped = false;
    box.error = null;
    box.retryAt = 0;
    if (skipHold) {
      box.hold = null;
      box.skipShared = true; // this queue goes now even if another session of the account is held
    }
    this.changed(id);
    this.schedule(id, 0);
  }

  /** The session was deleted: forget what waited for it. */
  forget(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.boxes.delete(id);
    this.unlink(id);
    this.emit("forgotten", id);
  }

  // ---- events from the sessions -------------------------------------------------
  onState(summary) {
    if (!summary?.id || !this.boxes.has(summary.id)) return;
    // A turn just ended (or the process stopped): let its last events land before deciding what to send.
    if (!BUSY.includes(summary.state)) this.schedule(summary.id, this.settleMs);
  }

  /** The user pressed Stop: what waits stays waiting until they resume it (or send something new). */
  onInterrupted(id) {
    const box = this.boxes.get(id);
    if (!box || (!box.items.length && !box.continueDue)) return;
    box.continueDue = false;
    if (!box.items.length) return this.changed(id);
    box.paused = true;
    box.stopped = true;
    this.changed(id);
  }

  onLimit(id, info) {
    if (!info || typeof info !== "object" || this.skip(id)) return;
    const type = String(info.rateLimitType || info.rate_limit_type || "");
    const profile = this.profileFn();
    if (info.status === "rejected" && info.soft && !Number(info.resetsAt)) {
      // The turn stopped on a limit whose reset time is unknown: hold the queue a while instead of sending into it.
      const box = this.box(id, true);
      if (box.hold && !box.hold.reset && this.now() < box.hold.resetsAt) return; // the real reset time is already known
      box.hold = { resetsAt: this.now() + SOFT_HOLD_MS, type: "", at: this.now(), soft: true };
      box.profile = profile || box.profile;
      this.changed(id);
      this.schedule(id, 0);
      return;
    }
    if (info.status === "rejected" && Number(info.resetsAt) > 0) {
      const resetsAt = info.resetsAt > 1e12 ? Number(info.resetsAt) : Number(info.resetsAt) * 1000;
      const box = this.box(id, true);
      if (box.hold?.resetsAt === resetsAt && !box.hold.reset) return;
      box.hold = { resetsAt, type, at: this.now() };
      box.continueDue = false;
      const live = this.manager.get(id);
      if (live?.cwd) box.cwd = live.cwd;
      box.profile = profile || box.profile;
      this.changed(id);
      this.schedule(id, 0);
      if (box.profile) {
        this.holdAccount(box.profile, box.hold, id);
        this.touchOthers(box.profile, id);
      }
    } else if (info.status && info.status !== "rejected") {
      // The window is open again (a reset was used, or another model answers).
      const shared = profile ? this.accountHolds.get(profile) : null;
      if (shared && (!type || !shared.type || type === shared.type)) {
        this.accountHolds.delete(profile);
        this.touchOthers(profile, id);
      }
      const box = this.boxes.get(id);
      if (!box?.hold || (type && box.hold.type && type !== box.hold.type)) return;
      box.hold = null;
      this.changed(id);
      this.schedule(id, 0);
    }
  }

  /** A message reached the session. One the user sent on their own ends the wait for a limit and the run of automatic continues. */
  onSent(id, source) {
    const box = this.boxes.get(id);
    if (!box || source === "outbox" || source === "auto-continue") return;
    if (source === "resume") { // the restart's own "check and continue" message: no second continue after it
      if (box.continueDue) {
        box.continueDue = false;
        this.changed(id);
      }
      return;
    }
    const before = JSON.stringify([box.autoCount, box.hold, box.continueDue]);
    box.autoCount = 0;
    box.hold = null;
    box.continueDue = false;
    if (JSON.stringify([box.autoCount, box.hold, box.continueDue]) !== before) this.changed(id);
  }

  // ---- sending ------------------------------------------------------------------
  schedule(id, delay) {
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.drain(id).catch(() => {});
    }, Math.max(0, Math.min(delay, 2 ** 31 - 1)));
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /** Send the next thing that waits, if the session is free. Each call sends at most one; the next waits for that turn to end. */
  async drain(id) {
    const box = this.boxes.get(id);
    if (!box || this.sending.has(id) || box.paused) return null;
    if (box.profile && this.profileFn() && box.profile !== this.profileFn()) return null; // another account: wait for it
    if (box.retryAt && this.now() < box.retryAt) { // after a failed send: state changes must not hurry the next try
      this.schedule(id, box.retryAt - this.now());
      return null;
    }
    const live = this.manager.get(id);
    if (live && (BUSY.includes(live.state) || live.pending?.size)) return null; // the end of that turn calls us again
    let dirty = false;
    if (box.hold && !box.hold.reset) {
      const due = box.hold.resetsAt + this.graceMs;
      if (this.now() < due) {
        this.schedule(id, due - this.now());
        return null;
      }
      // The limit has reset. First the turn it cut off is continued (automatic continue), then the queue follows.
      if (box.auto && !box.hold.soft && box.autoCount < MAX_AUTO) {
        box.hold = null;
        box.continueDue = true;
      } else {
        if (box.auto && !box.hold.soft) {
          box.auto = false; // like Claude Code: a limit that keeps coming back needs the user
          this.emit("auto-stopped", id);
        }
        // Kept as a notice ("the limit has reset", with a Continue button) until the user acts; it holds nothing back.
        box.hold = box.hold.soft ? null : { ...box.hold, reset: true };
      }
      dirty = true;
    }
    const shared = box.skipShared ? null : this.sharedHold(box);
    if (shared && !box.continueDue) { // another session of this account hit the limit: do not send into it
      this.schedule(id, shared.resetsAt + this.graceMs - this.now());
      if (dirty) this.changed(id);
      return null;
    }
    let entry;
    let source;
    if (box.continueDue) {
      entry = { text: CONTINUE_TEXT, images: [] };
      source = "auto-continue";
    } else if (box.items.length) {
      entry = box.items[0];
      source = "outbox";
    } else {
      box.skipShared = false;
      if (dirty) this.changed(id); // the limit reset with nothing to send: pages swap the banner for the notice
      return null;
    }
    // Taken off the list before it is sent and remembered as "in flight": a crash during the send puts it back, paused,
    // for the user to check (it can never be sent twice on its own). A failed send puts it back at once.
    if (source === "outbox") {
      box.items.shift();
      box.inflight = { ...entry, source };
    } else {
      box.continueDue = false;
    }
    this.sending.add(id);
    this.changed(id);
    try {
      await this.sendFn(id, { text: entry.text, images: entry.images, cwd: box.cwd, source });
      if (source === "auto-continue") box.autoCount += 1;
      else box.autoCount = 0;
      if (source === "outbox") this.emit("sent", id, entry.id); // a scheduled run waits for its own message to go out
      box.error = null;
      box.retryAt = 0;
      if (!box.items.length) box.skipShared = false;
      return source;
    } catch (error) {
      if (source === "outbox") box.items.unshift(entry);
      else box.continueDue = true;
      const attempts = (box.error?.attempts || 0) + 1;
      box.error = { message: String(error?.message || error), at: this.now(), attempts };
      if (attempts > this.retryMs.length) {
        box.paused = true;
        box.retryAt = 0;
      } else {
        box.retryAt = this.now() + this.retryMs[attempts - 1];
        this.schedule(id, this.retryMs[attempts - 1]);
      }
      return null;
    } finally {
      box.inflight = null;
      this.sending.delete(id);
      this.changed(id);
    }
  }
}
