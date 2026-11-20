// Scheduled tasks: recurring prompts that Wheelhouse itself starts as Claude Code sessions while it is running.
//
// Modelled on Claude Code Desktop's scheduled tasks: a task has a name, a prompt, a folder, a frequency (manual, hourly,
// daily, weekdays, weekly), a model, a permission mode and optional worktree isolation. Runs happen only while Wheelhouse
// is running; after a restart one run is caught up for the most recent missed time (not older than 7 days). Every run is
// a new session, kept in a run log (last 50 per task). Tasks live in <dataDir>/scheduled-tasks/<id>.json.
//
// The first half of this file is pure (validation, next/previous run in local time); the second half is the engine
// (persistence, a one-run-at-a-time queue, the session plumbing). Both take their clock and dependencies as arguments.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

// ---- vocabulary ----------------------------------------------------------------------
export const FREQUENCIES = ["manual", "hourly", "daily", "weekdays", "weekly"];
/**
 * Permission modes a scheduled run may use. A run has nobody to answer a prompt, so `default` (which asks) and
 * `bypassPermissions` (which asks for nothing and can do damage) are not offered. `dontAsk` denies whatever is not
 * pre-approved by an allow rule, `plan` only reads, `acceptEdits` and `auto` let Claude work on its own.
 */
export const PERMISSION_MODES = ["plan", "acceptEdits", "dontAsk", "auto"];
export const DEFAULT_PERMISSION_MODE = "plan";
export const DEFAULT_MAX_TURNS = 40;
export const MAX_TURNS_LIMIT = 200;
export const HISTORY_LIMIT = 50;
const CATCHUP_AFTER_MS = 2 * 60 * 1000; // later than this after its time, a run counts as a catch-up
const RUN_STATUSES = ["queued", "running", "success", "failed", "timeout", "stopped", "skipped"];
const ID_PATTERN = /^t-[a-f0-9]{12}$/;

export class SchedulerError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---- validation ------------------------------------------------------------------------
const clean = (value) => (typeof value === "string" ? value.replace(/\r\n/g, "\n") : "");

/** Turn user input into a task's editable fields, or throw a SchedulerError that says what is wrong. */
export function validateTask(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SchedulerError("The task is missing");
  const name = clean(input.name).trim();
  if (!name) throw new SchedulerError("Give the task a name");
  if (name.length > 80 || /[\n\u0000-\u001f]/.test(name)) throw new SchedulerError("The name must be one line of at most 80 characters");
  const prompt = clean(input.prompt).trim();
  if (!prompt) throw new SchedulerError("Write the instructions for the task");
  if (prompt.length > 20000) throw new SchedulerError("The instructions are too long (at most 20000 characters)");
  const cwdRaw = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (!cwdRaw) throw new SchedulerError("Choose a folder");
  if (cwdRaw.length > 1000 || /\u0000/.test(cwdRaw) || !isAbsolute(cwdRaw)) throw new SchedulerError("The folder must be an absolute path");
  const frequency = input.frequency === undefined ? "daily" : input.frequency;
  if (!FREQUENCIES.includes(frequency)) throw new SchedulerError("Unknown frequency");
  const time = input.time === undefined || input.time === "" ? "09:00" : input.time;
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new SchedulerError("The time must look like 09:30");
  const weekdayRaw = input.weekday === undefined || input.weekday === "" ? 1 : Number(input.weekday);
  if (!Number.isInteger(weekdayRaw) || weekdayRaw < 0 || weekdayRaw > 6) throw new SchedulerError("The day of the week must be 0 (Sunday) to 6 (Saturday)");
  const modelRaw = input.model === undefined || input.model === null ? "" : String(input.model).trim();
  if (modelRaw && !/^[A-Za-z0-9._:/[\]-]{1,100}$/.test(modelRaw)) throw new SchedulerError("The model name is not valid");
  const permissionMode = input.permissionMode === undefined ? DEFAULT_PERMISSION_MODE : input.permissionMode;
  if (!PERMISSION_MODES.includes(permissionMode)) throw new SchedulerError(`The permission mode must be one of: ${PERMISSION_MODES.join(", ")}`);
  const turns = input.maxTurns === undefined || input.maxTurns === "" || input.maxTurns === null ? DEFAULT_MAX_TURNS : Number(input.maxTurns);
  if (!Number.isInteger(turns) || turns < 1 || turns > MAX_TURNS_LIMIT) throw new SchedulerError(`The turn limit must be a whole number from 1 to ${MAX_TURNS_LIMIT}`);
  return {
    name,
    prompt,
    cwd: resolve(cwdRaw),
    frequency,
    time,
    weekday: weekdayRaw,
    model: modelRaw === "default" ? "" : modelRaw,
    permissionMode,
    worktree: input.worktree === true,
    maxTurns: turns,
  };
}

// ---- schedule arithmetic (local time) ---------------------------------------------------
const parseTime = (time) => {
  const [hours, minutes] = String(time || "09:00").split(":").map(Number);
  return [Number.isFinite(hours) ? hours : 9, Number.isFinite(minutes) ? minutes : 0];
};

const dayMatches = (task, date) => {
  const day = date.getDay();
  if (task.frequency === "weekdays") return day >= 1 && day <= 5;
  if (task.frequency === "weekly") return day === Number(task.weekday);
  return true; // daily
};

export const isScheduled = (task) => task.frequency !== "manual" && FREQUENCIES.includes(task.frequency);

/** First scheduled time strictly after `from` (ms), or null for a manual task. */
export function nextRun(task, from) {
  if (!isScheduled(task)) return null;
  const [hours, minutes] = parseTime(task.time);
  if (task.frequency === "hourly") {
    const date = new Date(from);
    date.setMinutes(minutes, 0, 0);
    if (date.getTime() <= from) date.setHours(date.getHours() + 1);
    return date.getTime();
  }
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = new Date(from);
    date.setDate(date.getDate() + offset);
    date.setHours(hours, minutes, 0, 0);
    if (date.getTime() > from && dayMatches(task, date)) return date.getTime();
  }
  return null;
}

/** Last scheduled time at or before `at` (ms), or null for a manual task. */
export function previousRun(task, at) {
  if (!isScheduled(task)) return null;
  const [hours, minutes] = parseTime(task.time);
  if (task.frequency === "hourly") {
    const date = new Date(at);
    date.setMinutes(minutes, 0, 0);
    if (date.getTime() > at) date.setHours(date.getHours() - 1);
    return date.getTime();
  }
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = new Date(at);
    date.setDate(date.getDate() - offset);
    date.setHours(hours, minutes, 0, 0);
    if (date.getTime() <= at && dayMatches(task, date)) return date.getTime();
  }
  return null;
}

/**
 * What the tick should do for a task at `now`: null (nothing due), or { scheduledFor, catchUp }.
 * Only the most recent scheduled time counts: older missed ones are dropped, so a task is caught up at most once, and
 * (the longest gap between runs being a week) never for a time older than 7 days. It is due when it is newer than both
 * the last time the task fired and the moment the schedule started (created, resumed, edited, switch turned on).
 */
export function dueRun(task, now) {
  if (!task.enabled || !isScheduled(task)) return null;
  const scheduledFor = previousRun(task, now);
  if (scheduledFor === null) return null;
  const floor = Math.max(task.lastScheduledFor || 0, task.scheduleBaseline || 0);
  if (scheduledFor <= floor) return null;
  const lag = now - scheduledFor;
  return { scheduledFor, catchUp: lag > CATCHUP_AFTER_MS };
}

// ---- the engine ---------------------------------------------------------------------------
const UNATTENDED_NOTE =
  "This is a scheduled, unattended run: nobody is watching and nobody can answer questions or approve actions. " +
  "Do not ask the user anything. If something needs approval or information you do not have, say so in your final message and finish.";

const isDirectory = async (path) => Boolean((await stat(path).catch(() => null))?.isDirectory());
const pathExists = async (path) => Boolean(await stat(path).catch(() => null));

async function inGitRepo(path, exists) {
  let current = path;
  for (let depth = 0; depth < 40; depth += 1) {
    if (await exists(join(current, ".git"))) return true;
    const parent = resolve(current, "..");
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

function describeResult(msg) {
  if (msg.subtype === "error_max_turns") return "Stopped at the turn limit";
  if (msg.subtype === "error_max_budget_usd") return "Stopped at the spending limit";
  const text = Array.isArray(msg.errors) && msg.errors.length ? msg.errors.join("; ") : typeof msg.result === "string" ? msg.result : "";
  return (text || msg.subtype || "The run ended with an error").slice(0, 500);
}

export class TaskScheduler {
  /**
   * dir:       folder for the task files (<dataDir>/scheduled-tasks)
   * manager:   SessionManager (create(), emit())
   * config:    Wheelhouse config (systemPromptAppend is kept in front of the unattended note)
   * enabled(): the global "Scheduled tasks enabled" switch
   * annotate(sessionId, meta): remember a run's session name for the session list (store.patchSessionMeta)
   * now():     clock in ms (tests inject their own)
   */
  constructor({
    dir, manager, config = {}, enabled = () => false, annotate = async () => {}, now = Date.now,
    isDir = isDirectory, exists = pathExists,
    runTimeoutMs = 60 * 60 * 1000, stallMs = 10 * 60 * 1000, tickMs = 60 * 1000, historyLimit = HISTORY_LIMIT,
  }) {
    this.dir = dir;
    this.manager = manager;
    this.config = config;
    this.enabled = enabled;
    this.annotate = annotate;
    this.now = now;
    this.isDir = isDir;
    this.exists = exists;
    this.runTimeoutMs = runTimeoutMs;
    this.stallMs = stallMs;
    this.tickMs = tickMs;
    this.historyLimit = historyLimit;
    this.tasks = new Map();
    this.queue = []; // { taskId, runId }
    this.current = null; // { taskId, runId, stop(outcome) }
    this.loop = null;
    this.timer = null;
    this.wasEnabled = undefined; // what the last tick saw of the switch
    this.writing = Promise.resolve();
  }

  // ---- persistence ----
  async load() {
    this.tasks.clear();
    let files = [];
    try { files = await readdir(this.dir); } catch { /* nothing saved yet */ }
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      try {
        const raw = JSON.parse(await readFile(join(this.dir, file), "utf8"));
        if (!ID_PATTERN.test(String(raw.id)) || `${raw.id}.json` !== file) continue;
        const fields = validateTask(raw); // a hand-edited file with a forbidden mode is not loaded, never run
        const runs = (Array.isArray(raw.runs) ? raw.runs : []).filter((run) => run && RUN_STATUSES.includes(run.status)).slice(0, this.historyLimit);
        for (const run of runs) {
          if (run.status === "queued" || run.status === "running") {
            run.status = "failed"; // the process that owned it is gone
            run.error = "Wheelhouse was closed before this run finished";
            run.endedAt = run.endedAt || Number(raw.updatedAt) || this.now();
          }
        }
        this.tasks.set(raw.id, {
          id: raw.id, ...fields, enabled: raw.enabled !== false,
          createdAt: Number(raw.createdAt) || this.now(), updatedAt: Number(raw.updatedAt) || this.now(),
          scheduleBaseline: Number(raw.scheduleBaseline) || Number(raw.createdAt) || 0,
          lastScheduledFor: Number(raw.lastScheduledFor) || 0,
          runs,
        });
      } catch (error) {
        console.warn(`[wheelhouse] scheduled task file ${file} was not loaded: ${error.message}`);
      }
    }
    return this;
  }

  save(task) {
    this.writing = this.writing.then(async () => {
      if (this.tasks.get(task.id) !== task) return; // deleted meanwhile: its file must not come back
      await mkdir(this.dir, { recursive: true });
      const path = join(this.dir, `${task.id}.json`);
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(task, null, 2), "utf8");
      await rename(tmp, path);
    }).catch((error) => console.warn(`[wheelhouse] could not save scheduled task ${task.id}: ${error.message}`));
    return this.writing;
  }

  /** Resolves once everything written so far is on disk. */
  flush() {
    return this.writing;
  }

  // ---- reading ----
  task(id) {
    const task = this.tasks.get(String(id));
    if (!task) throw new SchedulerError("No such task", 404);
    return task;
  }

  activeRunOf(taskId) {
    return this.tasks.get(taskId)?.runs.find((run) => run.status === "queued" || run.status === "running") || null;
  }

  async view(task, { runs = false } = {}) {
    const now = this.now();
    const active = this.activeRunOf(task.id);
    const live = this.enabled() && task.enabled;
    return {
      id: task.id, name: task.name, prompt: task.prompt, cwd: task.cwd, frequency: task.frequency, time: task.time, weekday: task.weekday,
      model: task.model, permissionMode: task.permissionMode, worktree: task.worktree, maxTurns: task.maxTurns, enabled: task.enabled,
      createdAt: task.createdAt, updatedAt: task.updatedAt,
      nextRun: live ? nextRun(task, now) : null,
      active: active ? active.status : null,
      lastRun: task.runs.find((run) => run.status !== "queued" && run.status !== "running") || null,
      folderMissing: !(await this.isDir(task.cwd)),
      ...(runs ? { runs: task.runs } : {}),
    };
  }

  async list() {
    const tasks = [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
    return Promise.all(tasks.map((task) => this.view(task)));
  }

  status() {
    return {
      enabled: Boolean(this.enabled()),
      running: this.current ? { taskId: this.current.taskId, runId: this.current.runId } : null,
      queued: this.queue.length,
      permissionModes: PERMISSION_MODES,
      frequencies: FREQUENCIES,
      defaultMaxTurns: DEFAULT_MAX_TURNS,
      now: this.now(),
    };
  }

  // ---- changing tasks ----
  async checkFields(fields) {
    if (!(await this.isDir(fields.cwd))) throw new SchedulerError("The folder does not exist");
    if (fields.worktree && !(await inGitRepo(fields.cwd, this.exists))) throw new SchedulerError("A worktree needs a folder that is a Git repository");
  }

  async create(input) {
    const fields = validateTask(input);
    await this.checkFields(fields);
    const now = this.now();
    const task = { id: `t-${randomUUID().replaceAll("-", "").slice(0, 12)}`, ...fields, enabled: input.enabled !== false, createdAt: now, updatedAt: now, scheduleBaseline: now, lastScheduledFor: 0, runs: [] };
    this.tasks.set(task.id, task);
    await this.save(task);
    return this.view(task, { runs: true });
  }

  async update(id, input) {
    const task = this.task(id);
    const fields = validateTask({ ...task, ...input });
    await this.checkFields(fields);
    const rescheduled = ["frequency", "time", "weekday"].some((key) => fields[key] !== task[key]);
    Object.assign(task, fields, { updatedAt: this.now() });
    if (rescheduled) task.scheduleBaseline = this.now(); // a new schedule does not catch up on the old one
    await this.save(task);
    return this.view(task, { runs: true });
  }

  async setPaused(id, paused) {
    const task = this.task(id);
    if (task.enabled === !paused) return this.view(task, { runs: true });
    task.enabled = !paused;
    task.updatedAt = this.now();
    if (!paused) task.scheduleBaseline = this.now(); // the time spent paused is not caught up
    await this.save(task);
    return this.view(task, { runs: true });
  }

  async remove(id) {
    const task = this.task(id);
    this.stopRun(id, { quiet: true });
    this.queue = this.queue.filter((entry) => entry.taskId !== id);
    this.tasks.delete(id);
    await this.writing;
    await rm(join(this.dir, `${id}.json`), { force: true });
    return { ok: true, name: task.name };
  }

  // ---- runs ----
  addRun(task, run) {
    task.runs.unshift(run);
    if (task.runs.length > this.historyLimit) task.runs.length = this.historyLimit;
    task.updatedAt = this.now();
    return this.save(task);
  }

  record(task, status, trigger, scheduledFor, error = null) {
    const at = this.now();
    return this.addRun(task, { id: randomUUID().slice(0, 8), trigger, scheduledFor, queuedAt: at, startedAt: null, endedAt: at, status, sessionId: null, error });
  }

  /** Queue a run. A manual one that cannot run says why; a scheduled one that cannot is written to the history. */
  enqueue(task, { trigger, scheduledFor = null }) {
    if (this.activeRunOf(task.id)) {
      if (trigger === "manual") throw new SchedulerError("This task is already running or waiting to run", 409);
      return this.record(task, "skipped", trigger, scheduledFor, "The previous run was still in progress");
    }
    const run = { id: randomUUID().slice(0, 8), trigger, scheduledFor, queuedAt: this.now(), startedAt: null, endedAt: null, status: "queued", sessionId: null, error: null };
    const saved = this.addRun(task, run);
    this.queue.push({ taskId: task.id, runId: run.id });
    this.pump();
    return saved.then(() => run);
  }

  async runNow(id) {
    const task = this.task(id);
    if (!this.enabled()) throw new SchedulerError("Scheduled tasks are switched off", 409);
    const run = await this.enqueue(task, { trigger: "manual" });
    return { run, task: await this.view(task, { runs: true }) };
  }

  /** Stop the run that is working, or take a waiting one out of the queue. */
  stopRun(id, { quiet = false } = {}) {
    const task = this.task(id);
    if (this.current?.taskId === id) {
      this.current.stop({ status: "stopped", error: null });
      return true;
    }
    const waiting = this.queue.findIndex((entry) => entry.taskId === id);
    if (waiting >= 0) {
      const [entry] = this.queue.splice(waiting, 1);
      const run = task.runs.find((item) => item.id === entry.runId);
      if (run) Object.assign(run, { status: "stopped", endedAt: this.now() });
      if (!quiet) this.save(task);
      return true;
    }
    if (quiet) return false;
    throw new SchedulerError("This task is not running", 409);
  }

  pump() {
    if (this.loop) return this.loop;
    this.loop = (async () => {
      while (this.queue.length) {
        const entry = this.queue.shift();
        const task = this.tasks.get(entry.taskId);
        const run = task?.runs.find((item) => item.id === entry.runId);
        if (!task || !run || run.status !== "queued") continue;
        if (!this.enabled()) {
          Object.assign(run, { status: "skipped", endedAt: this.now(), error: "Scheduled tasks were switched off" });
          await this.save(task);
          continue;
        }
        await this.execute(task, run).catch((error) => console.warn(`[wheelhouse] scheduled run failed to start: ${error.message}`));
      }
    })().finally(() => {
      this.loop = null;
      if (this.queue.length) this.pump();
    });
    return this.loop;
  }

  /** Resolves when nothing is queued or running (tests, shutdown). */
  async idle() {
    while (this.loop) await this.loop;
  }

  async finishRun(task, run, outcome) {
    Object.assign(run, { status: outcome.status, error: outcome.error ? String(outcome.error).slice(0, 500) : null, endedAt: this.now() });
    if (outcome.turns !== undefined) run.turns = outcome.turns;
    if (outcome.costUsd !== undefined) run.costUsd = outcome.costUsd;
    await this.save(task);
  }

  async execute(task, run) {
    run.startedAt = this.now();
    run.status = "running";
    this.current = { taskId: task.id, runId: run.id, stop: () => {} };
    try {
      // Re-checked on every run: the file on disk or the folder may have changed since the task was saved.
      if (!PERMISSION_MODES.includes(task.permissionMode)) return await this.finishRun(task, run, { status: "failed", error: "The permission mode is not allowed for scheduled tasks" });
      if (!(await this.isDir(task.cwd))) return await this.finishRun(task, run, { status: "failed", error: `The folder does not exist: ${task.cwd}` });
      await this.save(task);
      const title = `${task.name} · ${formatStamp(run.startedAt)}`;
      let session;
      try {
        session = this.manager.create({
          cwd: task.cwd,
          meta: {
            title,
            scheduled: { taskId: task.id, runId: run.id },
            permissionMode: task.permissionMode,
            maxTurns: task.maxTurns,
            ...(task.model ? { model: task.model } : {}),
            ...(task.worktree ? { worktree: true } : {}),
            disallowedTools: ["AskUserQuestion"], // nobody is there to answer
            appendPrompt: [this.config.systemPromptAppend, UNATTENDED_NOTE].filter(Boolean).join("\n\n"),
          },
        });
      } catch (error) {
        return await this.finishRun(task, run, { status: "failed", error: error.message });
      }
      run.sessionId = session.id;
      await this.annotate(session.id, { title, scheduledTaskId: task.id, scheduledRunId: run.id });
      await this.save(task);
      const outcome = await this.watch(task, run, session);
      await this.settleSession(session, outcome);
      await this.finishRun(task, run, outcome);
      this.manager.emit?.("sessions.changed");
    } finally {
      this.current = null;
    }
  }

  /** Send the prompt and wait for the run to end: result, error, timeout, stop. Never waits for a person. */
  watch(task, run, session) {
    return new Promise((resolve) => {
      let finished = false;
      let lastError = null;
      const stalls = new Map(); // pending request id -> timer
      const end = (outcome) => {
        if (finished) return;
        finished = true;
        clearTimeout(wall);
        for (const timer of stalls.values()) clearTimeout(timer);
        session.off("event", onEvent);
        resolve(outcome);
      };
      // A prompt nobody answers (a tool that needs approval, a question) must not hold the one run slot for ever:
      // after a grace period (enough to answer it from the session) it is refused, and Claude carries on without it.
      const refuse = (request) => {
        stalls.delete(request.id);
        if (finished || !session.pending?.has(request.id)) return;
        const message = "Nobody is available to answer: this is a scheduled run. Continue without this, and mention it in your final message.";
        const answer = request.kind === "permission" ? { behavior: "deny", message } : request.kind === "dialog" ? { behavior: "cancelled" } : { action: "cancel" };
        try { session.respond(request.id, answer); } catch { /* answered in the meantime */ }
      };
      const onEvent = ({ msg }) => {
        if (!msg) return;
        if (msg.type === "result") {
          const failed = Boolean(msg.is_error);
          end({ status: failed ? "failed" : "success", error: failed ? describeResult(msg) : null, turns: msg.num_turns, costUsd: msg.total_cost_usd });
        } else if (msg.type === "wh_closed") {
          end({ status: "failed", error: lastError || "Claude Code stopped before the run finished" });
        } else if (msg.type === "wh_error") {
          lastError = msg.message || lastError;
        } else if (msg.type === "wh_request" && msg.request?.id) {
          stalls.set(msg.request.id, setTimeout(() => refuse(msg.request), this.stallMs));
        } else if (msg.type === "wh_request_resolved") {
          clearTimeout(stalls.get(msg.id));
          stalls.delete(msg.id);
        }
      };
      const wall = setTimeout(() => end({ status: "timeout", error: `Stopped after ${Math.round(this.runTimeoutMs / 60000)} minutes` }), this.runTimeoutMs);
      this.current.stop = end;
      session.on("event", onEvent);
      session.sendUser({ text: task.prompt }).then(
        () => this.manager.emit?.("sessions.changed"), // the new session is listed now
        (error) => end({ status: "failed", error: error.message }),
      );
    });
  }

  /** After a run: free the Claude process (the transcript stays; the session opens again from the list). */
  async settleSession(session, outcome) {
    try {
      if (outcome.status === "timeout" || outcome.status === "stopped") {
        await Promise.race([Promise.resolve(session.interrupt?.()).catch(() => {}), new Promise((done) => setTimeout(done, 5000).unref?.())]);
      }
      const watched = session.listenerCount?.("event") > 0; // a page is looking at it: leave the process to the idle timer
      if (outcome.status === "timeout" || outcome.status === "stopped" || (!watched && !session.backgroundTasks)) session.close();
    } catch { /* already closed */ }
  }

  // ---- the clock ----
  /** Called every minute and once at start: fire what is due. */
  async tick() {
    const on = Boolean(this.enabled());
    const now = this.now();
    if (on && this.wasEnabled === false) {
      // The switch was just turned on: what came due while it was off is not caught up.
      for (const task of this.tasks.values()) {
        task.scheduleBaseline = now;
        await this.save(task);
      }
    }
    this.wasEnabled = on;
    if (!on) return [];
    const fired = [];
    for (const task of [...this.tasks.values()]) {
      const due = dueRun(task, now);
      if (!due) continue;
      task.lastScheduledFor = due.scheduledFor;
      await this.enqueue(task, { trigger: due.catchUp ? "catchup" : "schedule", scheduledFor: due.scheduledFor });
      fired.push(task.id);
    }
    return fired;
  }

  start() {
    this.stop();
    this.tick().catch((error) => console.warn(`[wheelhouse] scheduler tick failed: ${error.message}`));
    this.timer = setInterval(() => this.tick().catch((error) => console.warn(`[wheelhouse] scheduler tick failed: ${error.message}`)), this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Wheelhouse is shutting down: end the run that is working. */
  shutdown() {
    this.stop();
    this.queue = [];
    this.current?.stop({ status: "stopped", error: "Wheelhouse was closed" });
  }
}

function formatStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
