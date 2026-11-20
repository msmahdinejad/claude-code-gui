// Claude Code processes Wheelhouse starts outside sessions: sign-ins, the /limit-reset console window, `claude plugin …`
// runs, profile checks, title requests. The updater must not swap or delete the files one of them runs.

/** id -> { bin, alive, keepUntil } */
const entries = new Map();
let nextId = 0;

/**
 * Register work that runs `bin`. `work` is a ChildProcess (done on "exit"/"error") or a promise (done when it settles).
 * `keepMs`: also report `bin` as in use for that long after the start, whatever happens to the process (a detached
 * window can outlive this server, which then cannot see it any more).
 */
export function trackClaude(bin, work, { keepMs = 0 } = {}) {
  if (!bin || !work) return work;
  const id = ++nextId;
  const entry = { bin, alive: true, keepUntil: keepMs ? Date.now() + keepMs : 0 };
  entries.set(id, entry);
  const done = () => {
    entry.alive = false;
    if (!entry.keepUntil) entries.delete(id);
  };
  if (typeof work.then === "function") work.then(done, done);
  else if (typeof work.once === "function") {
    if (work.exitCode !== null && work.exitCode !== undefined) done();
    work.once("exit", done);
    work.once("error", done);
  }
  return work;
}

/** True while a tracked process is still running. */
export function claudeBusy() {
  for (const entry of entries.values()) if (entry.alive) return true;
  return false;
}

/** Executables a tracked process runs now or ran recently enough that its files must stay. */
export function claudeBinsInUse(now = Date.now()) {
  const bins = new Set();
  for (const [id, entry] of entries) {
    if (entry.alive || now < entry.keepUntil) bins.add(entry.bin);
    else entries.delete(id);
  }
  return bins;
}

export const claudeProcesses = { busy: claudeBusy, binsInUse: claudeBinsInUse };
