// Sessions that were working when Wheelhouse stopped (a restart, an update, a crash) and can be continued afterwards.
//
// While a session is working it is listed in <dir>/running.json (rewritten on every change and refreshed every 30 s so a
// crash leaves a recent time behind). When the server shuts down it freezes that file first, so the sessions the
// shutdown itself closes stay on it. At the next start the list becomes "pending": the page offers to continue them,
// and, only if the switch is on, sessions interrupted in the last 30 minutes are continued by themselves (at most 3,
// each once). A continued session is resumed from its transcript and gets one short message that asks it to check what
// already happened before going on, because the cut-off turn may have stopped in the middle of an action.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const AUTO_WINDOW_MS = 30 * 60_000; // continued automatically only when interrupted this recently
export const OFFER_WINDOW_MS = 6 * 60 * 60_000; // offered (and continued on request) for this long
export const MAX_AT_ONCE = 3;
const HEARTBEAT_MS = 30_000;
const AUTO_DELAY_MS = 6_000;

export const PROMPT =
  "The app was restarted while you were working, so your last turn was cut off. Before doing anything else, check the " +
  "current state (files, git status, running jobs) to see which steps already finished, then continue the task you " +
  "were working on. Do not repeat steps that already completed.";

const readJson = (file) => {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, file);
}

const clean = (entry, fallbackAt) =>
  entry && typeof entry.id === "string" && entry.id && typeof entry.cwd === "string" && entry.cwd
    ? { id: entry.id, cwd: entry.cwd, since: Number(entry.since) || fallbackAt, at: Number(entry.at) || fallbackAt }
    : null;

export class InterruptedSessions {
  /**
   * @param {object} deps
   * @param {string} deps.dir        folder for the two small state files
   * @param {object} deps.manager    SessionManager (emits "session.state")
   * @param {() => boolean} deps.enabled   automatic continue switch
   * @param {(id: string, cwd: string) => object} deps.open   returns the session object (starting a resume if needed)
   * @param {(id: string, meta: object) => boolean} [deps.skip]   sessions that must never be continued (scheduled runs)
   */
  constructor({ dir, manager, enabled = () => false, open, skip = () => false, now = Date.now, exists = existsSync, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), spacingMs = 2000 }) {
    Object.assign(this, { manager, isEnabled: enabled, open, skip, now, exists, sleep, spacingMs });
    this.runningFile = join(dir, "running.json");
    this.pendingFile = join(dir, "pending.json");
    this.running = new Map(); // id -> { id, cwd, since }
    this.pending = [];
    this.frozen = false;
    this.lastResumed = null; // { at, auto, ok: [id], failed: [{ id, error }] }
    this.busy = null;
    this.heartbeat = null;
  }

  /** Read what the previous run left, start tracking, and schedule the automatic continue. */
  start({ autoDelayMs = AUTO_DELAY_MS } = {}) {
    const stamp = this.now();
    const previous = readJson(this.runningFile);
    const left = (Array.isArray(previous?.sessions) ? previous.sessions : []).map((entry) => clean({ ...entry, at: previous.updatedAt }, stamp)).filter(Boolean);
    const older = (readJson(this.pendingFile)?.sessions || []).map((entry) => clean(entry, stamp)).filter(Boolean);
    const merged = new Map();
    for (const entry of [...older, ...left]) merged.set(entry.id, { ...merged.get(entry.id), ...entry });
    this.pending = [...merged.values()].filter((entry) => stamp - entry.at < OFFER_WINDOW_MS).sort((a, b) => b.at - a.at);
    this.savePending();
    this.saveRunning(); // an empty list for this run
    this.manager.on("session.state", (summary) => this.onState(summary));
    if (autoDelayMs >= 0) {
      this.autoTimer = setTimeout(() => this.autoResume().catch(() => {}), autoDelayMs);
      this.autoTimer.unref?.();
    }
    return this.pending;
  }

  onState(summary) {
    if (this.frozen || !summary?.id) return;
    if (summary.state === "running") {
      if (this.skip(summary.id, summary.meta || {}) || !summary.cwd) return;
      if (!this.running.has(summary.id)) this.running.set(summary.id, { id: summary.id, cwd: summary.cwd, since: this.now() });
    } else if (!this.running.delete(summary.id)) {
      return;
    }
    this.saveRunning();
  }

  saveRunning() {
    try {
      writeJson(this.runningFile, { updatedAt: this.now(), sessions: [...this.running.values()] });
    } catch { /* the marker is a convenience; never break a session over it */ }
    if (this.running.size && !this.heartbeat) {
      this.heartbeat = setInterval(() => this.saveRunning(), HEARTBEAT_MS);
      this.heartbeat.unref?.();
    } else if (!this.running.size && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  savePending() {
    try {
      writeJson(this.pendingFile, { sessions: this.pending });
    } catch { /* see saveRunning */ }
  }

  /** Called right before the server closes every session: what is working now is what was interrupted. */
  freeze() {
    if (this.frozen) return;
    this.saveRunning();
    this.frozen = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Sessions stopped on purpose (a profile switch): nothing to continue. */
  clear() {
    this.running.clear();
    this.saveRunning();
  }

  status() {
    const stamp = this.now();
    return {
      enabled: Boolean(this.isEnabled()),
      pending: this.pending.map((entry) => ({ ...entry, ageMs: Math.max(0, stamp - entry.at) })),
      lastResumed: this.lastResumed,
      busy: Boolean(this.busy),
      autoWindowMin: AUTO_WINDOW_MS / 60_000,
      maxAtOnce: MAX_AT_ONCE,
    };
  }

  dismiss(ids) {
    this.pending = ids?.length ? this.pending.filter((entry) => !ids.includes(entry.id)) : [];
    this.savePending();
    return this.status();
  }

  /** Continue the pending sessions (all, or the given ids), at most MAX_AT_ONCE per call. Each one is taken off the list first, so none is sent twice. */
  resume(ids, { auto = false } = {}) {
    if (this.busy) return this.busy;
    const stamp = this.now();
    const window = auto ? AUTO_WINDOW_MS : OFFER_WINDOW_MS;
    const chosen = this.pending.filter((entry) => (!ids || ids.includes(entry.id)) && stamp - entry.at < window).slice(0, MAX_AT_ONCE);
    this.pending = this.pending.filter((entry) => !chosen.includes(entry));
    this.savePending();
    this.busy = (async () => {
      const outcome = { at: stamp, auto, ok: [], failed: [] };
      for (const [index, entry] of chosen.entries()) {
        if (index) await this.sleep(this.spacingMs);
        try {
          if (!this.exists(entry.cwd)) throw new Error("the folder no longer exists");
          const target = this.open(entry.id, entry.cwd);
          if (target.state === "running") throw new Error("it is already working");
          await target.sendUser({ text: PROMPT });
          outcome.ok.push(entry.id);
        } catch (error) {
          outcome.failed.push({ id: entry.id, error: error.message });
        }
      }
      if (chosen.length) this.lastResumed = outcome;
      return outcome;
    })().finally(() => { this.busy = null; });
    return this.busy;
  }

  autoResume() {
    return this.isEnabled() ? this.resume(null, { auto: true }) : Promise.resolve(null);
  }
}
