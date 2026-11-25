import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox } from "../server/lib/outbox.mjs";
import {
  PERMISSION_MODES, SchedulerError, TaskScheduler, dueRun, nextRun, previousRun, validateTask,
} from "../server/lib/scheduler.mjs";

// All times are built from local-time parts (a mid-year week without clock changes), so the tests hold in any zone.
const at = (month, day, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute, 0, 0).getTime();
// 2026-06-10 is a Wednesday.
const WED = [6, 10];
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const task = (extra = {}) => ({ enabled: true, frequency: "daily", time: "09:30", weekday: 1, scheduleBaseline: 0, lastScheduledFor: 0, ...extra });

test("daily: next run is the next time of day, strictly after now", () => {
  const daily = task();
  assert.equal(nextRun(daily, at(...WED, 8, 0)), at(...WED, 9, 30));
  assert.equal(nextRun(daily, at(...WED, 9, 30)), at(6, 11, 9, 30));
  assert.equal(nextRun(daily, at(...WED, 23, 59)), at(6, 11, 9, 30));
});

test("hourly: runs at the chosen minute past every hour", () => {
  const hourly = task({ frequency: "hourly", time: "00:15" });
  assert.equal(nextRun(hourly, at(...WED, 8, 0)), at(...WED, 8, 15));
  assert.equal(nextRun(hourly, at(...WED, 8, 15)), at(...WED, 9, 15));
  assert.equal(nextRun(hourly, at(...WED, 23, 40)), at(6, 11, 0, 15));
  assert.equal(previousRun(hourly, at(...WED, 8, 10)), at(...WED, 7, 15));
  assert.equal(previousRun(hourly, at(...WED, 8, 15)), at(...WED, 8, 15));
});

test("weekdays skip Saturday and Sunday", () => {
  const weekdays = task({ frequency: "weekdays" });
  assert.equal(nextRun(weekdays, at(6, 12, 10, 0)), at(6, 15, 9, 30)); // Friday after the time -> Monday
  assert.equal(nextRun(weekdays, at(6, 13, 8, 0)), at(6, 15, 9, 30)); // Saturday -> Monday
  assert.equal(nextRun(weekdays, at(6, 14, 8, 0)), at(6, 15, 9, 30)); // Sunday -> Monday
  assert.equal(nextRun(weekdays, at(6, 15, 8, 0)), at(6, 15, 9, 30)); // Monday morning -> today
  assert.equal(previousRun(weekdays, at(6, 15, 8, 0)), at(6, 12, 9, 30)); // Monday before the time -> Friday
  assert.equal(previousRun(weekdays, at(6, 14, 20, 0)), at(6, 12, 9, 30));
});

test("weekly runs on the chosen day only", () => {
  const weekly = task({ frequency: "weekly", weekday: 3 }); // Wednesday
  assert.equal(nextRun(weekly, at(...WED, 8, 0)), at(...WED, 9, 30));
  assert.equal(nextRun(weekly, at(...WED, 9, 30)), at(6, 17, 9, 30));
  assert.equal(previousRun(weekly, at(6, 16, 12, 0)), at(...WED, 9, 30));
  const sundays = task({ frequency: "weekly", weekday: 0 });
  assert.equal(nextRun(sundays, at(...WED, 8, 0)), at(6, 14, 9, 30));
});

test("a manual task has no schedule", () => {
  const manual = task({ frequency: "manual" });
  assert.equal(nextRun(manual, at(...WED, 8, 0)), null);
  assert.equal(previousRun(manual, at(...WED, 8, 0)), null);
  assert.equal(dueRun(manual, at(...WED, 12, 0)), null);
});

test("catch-up: one run for the most recent missed time, none older than 7 days", () => {
  const daily = task({ scheduleBaseline: at(6, 1, 0, 0), lastScheduledFor: at(6, 5, 9, 30) });
  // asleep from the 5th until the 10th at noon: only the 10th 09:30 is run, once
  const due = dueRun(daily, at(...WED, 12, 0));
  assert.deepEqual(due, { scheduledFor: at(...WED, 9, 30), catchUp: true });
  // right on time is not a catch-up
  assert.equal(dueRun(daily, at(...WED, 9, 30) + 20_000).catchUp, false);
  // not due before the time of the day, and not again once it has fired
  assert.equal(dueRun({ ...daily, lastScheduledFor: at(...WED, 9, 30) }, at(...WED, 12, 0)), null);
  // a new task does not run for a time before it existed
  assert.equal(dueRun(task({ scheduleBaseline: at(...WED, 10, 0) }), at(...WED, 11, 0)), null);
  // a weekly task missed for a month is caught up once, for the latest Wednesday only (never older than 7 days)
  const weekly = task({ frequency: "weekly", weekday: 3, scheduleBaseline: at(5, 1, 0, 0), lastScheduledFor: at(5, 6, 9, 30) });
  const month = dueRun(weekly, at(6, 18, 12, 0));
  assert.equal(month.scheduledFor, at(6, 17, 9, 30));
  assert.ok(at(6, 18, 12, 0) - month.scheduledFor < 7 * DAY);
  // paused tasks never come due
  assert.equal(dueRun({ ...daily, enabled: false }, at(...WED, 12, 0)), null);
});

// ---- validation ---------------------------------------------------------------------
const FOLDER = tmpdir();
const input = (extra = {}) => ({ name: "Morning review", prompt: "Review yesterday's commits", cwd: FOLDER, ...extra });

test("validateTask fills defaults: plan mode, daily 09:00, turn limit", () => {
  const fields = validateTask(input());
  assert.equal(fields.permissionMode, "plan");
  assert.equal(fields.frequency, "daily");
  assert.equal(fields.time, "09:00");
  assert.equal(fields.worktree, false);
  assert.ok(fields.maxTurns > 0 && fields.maxTurns <= 200);
  assert.equal(validateTask(input({ model: "default" })).model, "");
  assert.equal(validateTask(input({ model: "opus[1m]" })).model, "opus[1m]");
});

test("validateTask rejects bad input", () => {
  const bad = (extra, pattern) => assert.throws(() => validateTask(input(extra)), (error) => error instanceof SchedulerError && error.status === 400 && pattern.test(error.message));
  bad({ name: "  " }, /name/i);
  bad({ name: "a\nb" }, /name/i);
  bad({ name: "x".repeat(81) }, /name/i);
  bad({ prompt: "" }, /instructions/i);
  bad({ prompt: "x".repeat(20001) }, /too long/i);
  bad({ cwd: "" }, /folder/i);
  bad({ cwd: "relative/path" }, /absolute/i);
  bad({ frequency: "monthly" }, /frequency/i);
  bad({ time: "25:00" }, /time/i);
  bad({ time: "9:30" }, /time/i);
  bad({ weekday: 7 }, /day of the week/i);
  bad({ model: "bad model; rm" }, /model/i);
  bad({ maxTurns: 0 }, /turn/i);
  bad({ maxTurns: 1000 }, /turn/i);
  assert.throws(() => validateTask(null), SchedulerError);
});

test("only the safe permission modes are accepted, bypassPermissions and default never", () => {
  assert.deepEqual(PERMISSION_MODES, ["plan", "acceptEdits", "dontAsk", "auto"]);
  for (const mode of PERMISSION_MODES) assert.equal(validateTask(input({ permissionMode: mode })).permissionMode, mode);
  for (const mode of ["bypassPermissions", "default", "", "PLAN", null, 5]) {
    assert.throws(() => validateTask(input({ permissionMode: mode })), /permission mode/i, String(mode));
  }
});

// ---- the engine ----------------------------------------------------------------------
/** A stand-in for SessionManager: sessions that finish when the test says so (or at once with `auto`). */
function fakeManager({ auto = true } = {}) {
  const manager = new EventEmitter();
  manager.sessions = [];
  manager.changed = 0;
  manager.on("sessions.changed", () => { manager.changed += 1; });
  manager.waiting = [];
  manager.create = ({ cwd, meta }) => {
    const session = new EventEmitter();
    Object.assign(session, { id: `s${manager.sessions.length + 1}`, cwd, meta, pending: new Map(), sent: [], closed: 0, answers: [], backgroundTasks: 0 });
    session.sendUser = async ({ text }) => {
      session.sent.push(text);
      if (auto) setImmediate(() => manager.finish(session));
      else manager.waiting.push(session);
      return { uuid: "u" };
    };
    session.close = () => { session.closed += 1; };
    session.interrupt = async () => ({ interrupted: true });
    session.respond = (id, answer) => {
      session.pending.delete(id);
      session.answers.push({ id, answer });
      session.emit("event", { seq: 9, msg: { type: "wh_request_resolved", id } });
    };
    manager.sessions.push(session);
    return session;
  };
  manager.finish = (session, msg = { type: "result", is_error: false, num_turns: 3, total_cost_usd: 0.02 }) => session.emit("event", { seq: 1, msg });
  return manager;
}

/** Wait until the n-th session has been sent its prompt (the run is then waiting for a result). */
async function started(manager, count = 1) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (manager.sessions.length >= count && manager.sessions[count - 1].sent.length) return manager.sessions[count - 1];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`session ${count} did not start`);
}

async function setup(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "wh-sched-"));
  const dir = join(root, "scheduled-tasks");
  const folder = join(root, "project");
  await mkdir(folder, { recursive: true });
  const clock = { now: at(...WED, 8, 0) };
  const manager = options.manager || fakeManager();
  const prefs = { on: options.on !== false };
  const annotated = [];
  const make = () => new TaskScheduler({
    dir, manager, config: { systemPromptAppend: "Be brief." }, enabled: () => prefs.on, now: () => clock.now,
    annotate: async (id, meta) => { annotated.push({ id, ...meta }); }, stallMs: 40, runTimeoutMs: options.runTimeoutMs ?? 5000,
    ...options.scheduler,
  });
  const scheduler = await make().load();
  const cleanup = async () => { scheduler.shutdown(); await scheduler.idle(); await scheduler.flush(); await rm(root, { recursive: true, force: true }); };
  return { root, dir, folder, clock, manager, prefs, annotated, scheduler, make, cleanup };
}

test("a due task starts a session once, in the saved permission mode, and logs the run", async () => {
  const ctx = await setup();
  try {
    const created = await ctx.scheduler.create({ name: "Review", prompt: "Look at the diff", cwd: ctx.folder, frequency: "daily", time: "09:30", model: "sonnet", permissionMode: "acceptEdits" });
    assert.equal(created.nextRun, at(...WED, 9, 30));
    ctx.clock.now = at(...WED, 9, 31);
    assert.deepEqual(await ctx.scheduler.tick(), [created.id]);
    await ctx.scheduler.idle();
    assert.deepEqual(await ctx.scheduler.tick(), []); // the same time never runs twice
    await ctx.scheduler.idle();
    assert.equal(ctx.manager.sessions.length, 1);
    const session = ctx.manager.sessions[0];
    assert.equal(session.cwd, ctx.folder);
    assert.equal(session.meta.permissionMode, "acceptEdits");
    assert.equal(session.meta.model, "sonnet");
    assert.ok(session.meta.maxTurns > 0);
    assert.deepEqual(session.meta.disallowedTools, ["AskUserQuestion"]);
    assert.match(session.meta.appendPrompt, /Be brief\.[\s\S]*unattended/);
    assert.deepEqual(session.sent, ["Look at the diff"]);
    assert.equal(session.closed, 1); // the process is freed once the run is over
    assert.match(session.meta.title, /^Review · \d{4}-\d\d-\d\d \d\d:\d\d$/);
    assert.deepEqual(ctx.annotated.map((item) => [item.id, item.scheduledTaskId]), [["s1", created.id]]);
    assert.ok(ctx.manager.changed >= 1);
    const [view] = await ctx.scheduler.list();
    assert.equal(view.lastRun.status, "success");
    assert.equal(view.lastRun.trigger, "schedule");
    assert.equal(view.lastRun.sessionId, "s1");
    assert.equal(view.lastRun.turns, 3);
    assert.equal(view.active, null);
  } finally { await ctx.cleanup(); }
});

test("nothing runs while the global switch is off, and turning it on does not replay what was missed", async () => {
  const ctx = await setup({ on: false });
  try {
    const created = await ctx.scheduler.create({ name: "Daily", prompt: "p", cwd: ctx.folder, time: "09:30" });
    ctx.clock.now = at(...WED, 10, 0);
    assert.deepEqual(await ctx.scheduler.tick(), []);
    assert.equal(ctx.manager.sessions.length, 0);
    assert.equal((await ctx.scheduler.view(ctx.scheduler.task(created.id))).nextRun, null);
    await assert.rejects(() => ctx.scheduler.runNow(created.id), (error) => error.status === 409 && /switched off/.test(error.message));
    ctx.clock.now = at(...WED, 11, 0);
    ctx.prefs.on = true;
    assert.deepEqual(await ctx.scheduler.tick(), []); // 09:30 came and went while it was off
    ctx.clock.now = at(6, 11, 9, 31);
    assert.deepEqual(await ctx.scheduler.tick(), [created.id]); // tomorrow's run is on
    await ctx.scheduler.idle();
    assert.equal(ctx.manager.sessions.length, 1);
  } finally { await ctx.cleanup(); }
});

test("after a restart one catch-up run is made, from the saved state", async () => {
  const ctx = await setup();
  try {
    const created = await ctx.scheduler.create({ name: "Daily", prompt: "p", cwd: ctx.folder, time: "09:30" });
    ctx.clock.now = at(...WED, 9, 31);
    await ctx.scheduler.tick();
    await ctx.scheduler.idle();
    await ctx.scheduler.flush();
    assert.equal(ctx.manager.sessions.length, 1);
    // Wheelhouse is closed for 3 days; the next start finds three missed times and runs the latest one
    const restarted = await ctx.make().load();
    ctx.clock.now = at(6, 13, 10, 0);
    const fired = await restarted.tick();
    await restarted.idle();
    assert.deepEqual(fired, [created.id]);
    assert.equal(ctx.manager.sessions.length, 2);
    const [latest, earlier] = restarted.task(created.id).runs;
    assert.equal(latest.trigger, "catchup");
    assert.equal(latest.scheduledFor, at(6, 13, 9, 30));
    assert.equal(earlier.trigger, "schedule");
    assert.deepEqual(await restarted.tick(), []);
    restarted.shutdown();
  } finally { await ctx.cleanup(); }
});

test("one run at a time overall: the others wait in the queue", async () => {
  const ctx = await setup({ manager: fakeManager({ auto: false }) });
  try {
    const a = await ctx.scheduler.create({ name: "A", prompt: "a", cwd: ctx.folder, time: "09:00" });
    const b = await ctx.scheduler.create({ name: "B", prompt: "b", cwd: ctx.folder, time: "09:00" });
    ctx.clock.now = at(...WED, 9, 1);
    await ctx.scheduler.tick();
    await started(ctx.manager, 1);
    assert.equal(ctx.manager.sessions.length, 1, "only the first starts");
    assert.equal(ctx.scheduler.status().queued, 1);
    assert.equal(ctx.scheduler.task(a.id).runs[0].status, "running");
    assert.equal(ctx.scheduler.task(b.id).runs[0].status, "queued");
    assert.equal((await ctx.scheduler.view(ctx.scheduler.task(b.id))).active, "queued");
    ctx.manager.finish(ctx.manager.sessions[0]);
    await started(ctx.manager, 2);
    assert.equal(ctx.manager.sessions.length, 2, "the second starts when the first has finished");
    ctx.manager.finish(ctx.manager.sessions[1]);
    await ctx.scheduler.idle();
    assert.equal(ctx.scheduler.task(b.id).runs[0].status, "success");
  } finally { await ctx.cleanup(); }
});

test("a task never starts while its previous run is still going; a manual start says so", async () => {
  const ctx = await setup({ manager: fakeManager({ auto: false }) });
  try {
    const created = await ctx.scheduler.create({ name: "Hourly", prompt: "p", cwd: ctx.folder, frequency: "hourly", time: "00:00" });
    ctx.clock.now = at(...WED, 9, 1);
    await ctx.scheduler.tick();
    await started(ctx.manager, 1);
    ctx.clock.now = at(...WED, 10, 1);
    await ctx.scheduler.tick(); // the 10:00 run comes due while the 9:00 run is still working
    const runs = ctx.scheduler.task(created.id).runs;
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, "skipped");
    assert.match(runs[0].error, /previous run/);
    assert.equal(ctx.manager.sessions.length, 1);
    await assert.rejects(() => ctx.scheduler.runNow(created.id), (error) => error.status === 409);
  } finally { await ctx.cleanup(); }
});

test("run now works for a manual task and the run can be stopped", async () => {
  const ctx = await setup({ manager: fakeManager({ auto: false }) });
  try {
    const created = await ctx.scheduler.create({ name: "Manual", prompt: "p", cwd: ctx.folder, frequency: "manual" });
    assert.equal(created.nextRun, null);
    const { run } = await ctx.scheduler.runNow(created.id);
    assert.equal(run.trigger, "manual");
    await started(ctx.manager, 1);
    assert.equal(ctx.scheduler.stopRun(created.id), true);
    await ctx.scheduler.idle();
    assert.equal(ctx.scheduler.task(created.id).runs[0].status, "stopped");
    assert.equal(ctx.manager.sessions[0].closed, 1);
    assert.throws(() => ctx.scheduler.stopRun(created.id), (error) => error.status === 409);
  } finally { await ctx.cleanup(); }
});

test("a run that waits for a prompt nobody can answer is refused after the grace period and finishes", async () => {
  const ctx = await setup({ manager: fakeManager({ auto: false }) });
  try {
    const created = await ctx.scheduler.create({ name: "Edits", prompt: "p", cwd: ctx.folder, frequency: "manual", permissionMode: "acceptEdits" });
    await ctx.scheduler.runNow(created.id);
    await started(ctx.manager, 1);
    const session = ctx.manager.sessions[0];
    const request = { id: "req1", kind: "permission", toolName: "Bash" };
    session.pending.set("req1", { request });
    session.emit("event", { seq: 2, msg: { type: "wh_request", request } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(session.answers.length, 1);
    assert.equal(session.answers[0].answer.behavior, "deny");
    ctx.manager.finish(session);
    await ctx.scheduler.idle();
    assert.equal(ctx.scheduler.task(created.id).runs[0].status, "success");
  } finally { await ctx.cleanup(); }
});

test("a prompt that is answered in time is left alone", async () => {
  const ctx = await setup({ manager: fakeManager({ auto: false }) });
  try {
    const created = await ctx.scheduler.create({ name: "Edits", prompt: "p", cwd: ctx.folder, frequency: "manual" });
    await ctx.scheduler.runNow(created.id);
    await started(ctx.manager, 1);
    const session = ctx.manager.sessions[0];
    session.pending.set("r", { request: { id: "r", kind: "permission" } });
    session.emit("event", { seq: 2, msg: { type: "wh_request", request: { id: "r", kind: "permission" } } });
    session.pending.delete("r");
    session.emit("event", { seq: 3, msg: { type: "wh_request_resolved", id: "r" } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(session.answers.length, 0);
    ctx.manager.finish(session);
    await ctx.scheduler.idle();
  } finally { await ctx.cleanup(); }
});

test("a run that takes too long is stopped with status timeout", async () => {
  const ctx = await setup({ manager: fakeManager({ auto: false }), runTimeoutMs: 50 });
  try {
    const created = await ctx.scheduler.create({ name: "Slow", prompt: "p", cwd: ctx.folder, frequency: "manual" });
    await ctx.scheduler.runNow(created.id);
    await ctx.scheduler.idle();
    const [run] = ctx.scheduler.task(created.id).runs;
    assert.equal(run.status, "timeout");
    assert.equal(ctx.manager.sessions[0].closed, 1);
  } finally { await ctx.cleanup(); }
});

test("errors are logged: a failed result, a crash, a vanished folder", async () => {
  const manager = fakeManager({ auto: false });
  const ctx = await setup({ manager });
  try {
    const created = await ctx.scheduler.create({ name: "Bad", prompt: "p", cwd: ctx.folder, frequency: "manual" });
    await ctx.scheduler.runNow(created.id);
    await started(ctx.manager, 1);
    manager.finish(manager.sessions[0], { type: "result", is_error: true, subtype: "error_max_turns", num_turns: 40 });
    await ctx.scheduler.idle();
    assert.deepEqual([ctx.scheduler.task(created.id).runs[0].status, ctx.scheduler.task(created.id).runs[0].error], ["failed", "Stopped at the turn limit"]);

    await ctx.scheduler.runNow(created.id);
    await started(ctx.manager, 2);
    manager.sessions[1].emit("event", { seq: 1, msg: { type: "wh_error", message: "boom" } });
    manager.sessions[1].emit("event", { seq: 2, msg: { type: "wh_closed" } });
    await ctx.scheduler.idle();
    assert.deepEqual([ctx.scheduler.task(created.id).runs[0].status, ctx.scheduler.task(created.id).runs[0].error], ["failed", "boom"]);

    await rm(ctx.folder, { recursive: true, force: true });
    await ctx.scheduler.runNow(created.id);
    await ctx.scheduler.idle();
    assert.equal(ctx.manager.sessions.length, 2, "no session for a folder that is gone");
    assert.match(ctx.scheduler.task(created.id).runs[0].error, /does not exist/);
    assert.equal((await ctx.scheduler.list())[0].folderMissing, true);
  } finally { await ctx.cleanup(); }
});

test("starting the process can fail without leaving a run stuck", async () => {
  const manager = fakeManager();
  const ctx = await setup({ manager });
  try {
    const create = manager.create;
    manager.create = (args) => { const session = create(args); session.sendUser = async () => { throw new Error("no claude"); }; return session; };
    const created = await ctx.scheduler.create({ name: "Bad", prompt: "p", cwd: ctx.folder, frequency: "manual" });
    await ctx.scheduler.runNow(created.id);
    await ctx.scheduler.idle();
    assert.deepEqual([ctx.scheduler.task(created.id).runs[0].status, ctx.scheduler.task(created.id).runs[0].error], ["failed", "no claude"]);
    assert.equal(ctx.scheduler.status().running, null);
  } finally { await ctx.cleanup(); }
});

test("tasks and their run log survive a restart; a run that was working is marked failed", async () => {
  const ctx = await setup({ manager: fakeManager({ auto: false }) });
  try {
    const created = await ctx.scheduler.create({ name: "Persist", prompt: "keep me", cwd: ctx.folder, frequency: "weekly", time: "07:45", weekday: 5, permissionMode: "dontAsk", worktree: false });
    await ctx.scheduler.runNow(created.id);
    await started(ctx.manager, 1);
    await ctx.scheduler.flush();
    const files = await readdir(ctx.dir);
    assert.deepEqual(files, [`${created.id}.json`]);
    const onDisk = JSON.parse(await readFile(join(ctx.dir, files[0]), "utf8"));
    assert.equal(onDisk.permissionMode, "dontAsk");
    const reloaded = await ctx.make().load();
    const back = reloaded.task(created.id);
    assert.equal(back.name, "Persist");
    assert.equal(back.prompt, "keep me");
    assert.equal(back.frequency, "weekly");
    assert.equal(back.time, "07:45");
    assert.equal(back.weekday, 5);
    assert.equal(back.runs.length, 1);
    assert.equal(back.runs[0].status, "failed");
    assert.match(back.runs[0].error, /closed before/);
  } finally { await ctx.cleanup(); }
});

test("a task file edited to a forbidden mode or with a bad id is not loaded", async () => {
  const ctx = await setup();
  try {
    const created = await ctx.scheduler.create({ name: "Ok", prompt: "p", cwd: ctx.folder, frequency: "manual" });
    await ctx.scheduler.flush();
    const file = join(ctx.dir, `${created.id}.json`);
    const raw = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...raw, permissionMode: "bypassPermissions" }));
    await writeFile(join(ctx.dir, "t-000000000000.json"), JSON.stringify({ ...raw, id: "../escape" }));
    await writeFile(join(ctx.dir, "broken.json"), "{not json");
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await ctx.make().load()).tasks.size, 0);
    } finally { console.warn = warn; }
  } finally { await ctx.cleanup(); }
});

test("pause, resume, edit and delete", async () => {
  const ctx = await setup();
  try {
    const created = await ctx.scheduler.create({ name: "Daily", prompt: "p", cwd: ctx.folder, time: "09:30" });
    await ctx.scheduler.setPaused(created.id, true);
    ctx.clock.now = at(...WED, 10, 0);
    assert.deepEqual(await ctx.scheduler.tick(), []);
    assert.equal((await ctx.scheduler.list())[0].nextRun, null);
    ctx.clock.now = at(...WED, 12, 0);
    const resumed = await ctx.scheduler.setPaused(created.id, false);
    assert.equal(resumed.enabled, true);
    assert.deepEqual(await ctx.scheduler.tick(), [], "the time spent paused is not caught up");
    // editing the schedule restarts it, and the edit is validated
    const edited = await ctx.scheduler.update(created.id, { time: "12:30", name: "Renamed" });
    assert.equal(edited.name, "Renamed");
    assert.equal(edited.nextRun, at(...WED, 12, 30));
    await assert.rejects(() => ctx.scheduler.update(created.id, { permissionMode: "bypassPermissions" }), SchedulerError);
    await assert.rejects(() => ctx.scheduler.update("t-aaaaaaaaaaaa", { name: "x" }), (error) => error.status === 404);
    await ctx.scheduler.flush();
    assert.equal((await readdir(ctx.dir)).length, 1);
    await ctx.scheduler.remove(created.id);
    assert.equal((await readdir(ctx.dir)).length, 0);
    assert.equal((await ctx.scheduler.list()).length, 0);
  } finally { await ctx.cleanup(); }
});

test("creating a task checks the folder and the worktree's Git repository", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(() => ctx.scheduler.create({ name: "n", prompt: "p", cwd: join(ctx.root, "missing") }), /folder does not exist/);
    await assert.rejects(() => ctx.scheduler.create({ name: "n", prompt: "p", cwd: ctx.folder, worktree: true }), (error) => error.status === 400 && /Git/.test(error.message));
    await mkdir(join(ctx.folder, ".git"));
    const created = await ctx.scheduler.create({ name: "n", prompt: "p", cwd: ctx.folder, worktree: true, frequency: "manual" });
    assert.equal(created.worktree, true);
    await ctx.scheduler.runNow(created.id);
    await ctx.scheduler.idle();
    assert.equal(ctx.manager.sessions[0].meta.worktree, true);
  } finally { await ctx.cleanup(); }
});

test("the run log keeps only the newest runs", async () => {
  const ctx = await setup({ scheduler: { historyLimit: 5 } });
  try {
    const created = await ctx.scheduler.create({ name: "Many", prompt: "p", cwd: ctx.folder, frequency: "manual" });
    for (let index = 0; index < 8; index += 1) {
      await ctx.scheduler.runNow(created.id);
      await ctx.scheduler.idle();
    }
    const runs = ctx.scheduler.task(created.id).runs;
    assert.equal(runs.length, 5);
    assert.deepEqual(runs.map((run) => run.sessionId), ["s8", "s7", "s6", "s5", "s4"]);
  } finally { await ctx.cleanup(); }
});

// ---- inside an existing session ----------------------------------------------------------
// The real send queue (Outbox) with a fake session: what a scheduled prompt does when the session is idle, busy, held by a
// usage limit, closed, or when Wheelhouse restarts.
const SESSION = "0cbdcfd7-f8c7-4e5e-9660-d108c3201124";

async function until(check, what = "condition") {
  for (let tries = 0; tries < 400; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function inSession(options = {}) {
  const manager = fakeManager();
  manager.live = new Map();
  manager.get = (id) => manager.live.get(id);
  const outboxDir = await mkdtemp(join(tmpdir(), "wh-outbox-"));
  const open = (id, cwd) => {
    let live = manager.live.get(id);
    if (!live) {
      live = new EventEmitter();
      Object.assign(live, { id, cwd, state: "idle", pending: new Map(), sent: [], interrupted: 0, closed: 0, alive: true });
      live.interrupt = async () => { live.interrupted += 1; };
      live.close = () => { live.closed += 1; };
      live.summary = () => ({ id, state: live.state });
      manager.live.set(id, live);
    }
    return live;
  };
  const outbox = new Outbox({
    dir: outboxDir, manager, settleMs: 5, graceMs: 20, retryMs: [5, 5, 5],
    send: async (id, entry) => {
      if (options.failSend) throw new Error("the process would not start");
      const live = open(id, entry.cwd);
      live.sent.push(entry.text);
      live.state = "running";
      manager.emit("session.sent", { id, source: entry.source });
    },
  });
  outbox.start({ startDelayMs: 60_000 });
  const ctx = await setup({ ...options, manager, scheduler: { outbox: () => outbox, ensureSession: open, ...options.scheduler } });
  const baseCleanup = ctx.cleanup;
  const finishTurn = (id = SESSION, msg = { type: "result", is_error: false, num_turns: 4, total_cost_usd: 0.05 }) => {
    const live = manager.live.get(id);
    live.state = "idle";
    live.emit("event", { seq: 1, msg });
    manager.emit("session.state", live.summary());
  };
  const create = (extra = {}) => ctx.scheduler.create({ name: "Weekly report", prompt: "/weekly-report team", cwd: ctx.folder, sessionId: SESSION, frequency: "manual", ...extra });
  const lastRun = (taskId) => ctx.scheduler.task(taskId).runs[0];
  const cleanup = async () => { outbox.stop(); await baseCleanup(); await rm(outboxDir, { recursive: true, force: true }); };
  return { ...ctx, outbox, open, finishTurn, create, lastRun, cleanup };
}

test("validateTask: a session id is kept, a bad one rejected, and a worktree makes no sense inside a session", () => {
  assert.equal(validateTask(input()).sessionId, "");
  assert.equal(validateTask(input({ sessionId: `  ${SESSION} ` })).sessionId, SESSION);
  assert.equal(validateTask(input({ sessionId: null })).sessionId, "");
  assert.equal(validateTask(input({ sessionId: SESSION, worktree: true })).worktree, false);
  assert.equal(validateTask(input({ worktree: true })).worktree, true);
  for (const bad of ["../x", "a b", "x".repeat(81), "a/b"]) {
    assert.throws(() => validateTask(input({ sessionId: bad })), (error) => error instanceof SchedulerError && /session id/i.test(error.message), bad);
  }
});

test("in a session: an idle session gets the prompt as it is, no new session starts, and the run records the session", async () => {
  const ctx = await inSession();
  try {
    ctx.open(SESSION, ctx.folder);
    const created = await ctx.create();
    assert.equal(created.sessionId, SESSION);
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.manager.live.get(SESSION).sent.length === 1, "the prompt to be sent");
    const live = ctx.manager.live.get(SESSION);
    assert.deepEqual(live.sent, ["/weekly-report team"]);
    await until(() => ctx.lastRun(created.id).status === "running", "the run to be running");
    assert.ok(ctx.lastRun(created.id).startedAt);
    ctx.finishTurn();
    await until(() => ctx.lastRun(created.id).status === "success", "the run to succeed");
    const run = ctx.lastRun(created.id);
    assert.equal(run.sessionId, SESSION);
    assert.equal(run.turns, 4);
    assert.equal(run.trigger, "manual");
    assert.equal(ctx.manager.sessions.length, 0); // nothing was created
    assert.equal(ctx.annotated.length, 0); // and the session keeps its own name and ordinary limit handling
    assert.equal(live.closed, 0);
    assert.equal(live.interrupted, 0);
    assert.equal((await ctx.scheduler.list())[0].active, null);
    assert.equal(ctx.outbox.waiting(SESSION), false);
  } finally { await ctx.cleanup(); }
});

test("in a session: a busy session makes the prompt wait like a typed message, then it goes out when the turn ends", async () => {
  const ctx = await inSession();
  try {
    const live = ctx.open(SESSION, ctx.folder);
    live.state = "running"; // Claude is in the middle of a turn
    const created = await ctx.create();
    await ctx.scheduler.runNow(created.id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(live.sent, []); // not sent into the running turn
    assert.equal(ctx.lastRun(created.id).status, "queued");
    assert.equal((await ctx.scheduler.list())[0].active, "queued");
    assert.equal(ctx.outbox.view(SESSION).items.length, 1);
    live.state = "idle";
    ctx.manager.emit("session.state", live.summary()); // the running turn ends
    await until(() => live.sent.length === 1, "the prompt to be sent");
    assert.equal(live.sent[0], "/weekly-report team");
    await until(() => ctx.lastRun(created.id).status === "running");
    ctx.finishTurn();
    await until(() => ctx.lastRun(created.id).status === "success");
  } finally { await ctx.cleanup(); }
});

test("in a session: a usage limit holds the prompt until it resets, and the waiting does not block other tasks", async () => {
  const ctx = await inSession();
  try {
    const live = ctx.open(SESSION, ctx.folder);
    ctx.manager.emit("session.limit", { id: SESSION, info: { status: "rejected", resetsAt: Date.now() + 250, rateLimitType: "five_hour" } });
    assert.equal(ctx.outbox.held(SESSION), true);
    const created = await ctx.create();
    await ctx.scheduler.runNow(created.id);
    const other = await ctx.scheduler.create({ name: "Other", prompt: "hello", cwd: ctx.folder, frequency: "manual" });
    await ctx.scheduler.runNow(other.id); // a task that starts a new session still runs meanwhile
    await ctx.scheduler.idle();
    assert.equal(ctx.lastRun(other.id).status, "success");
    assert.equal(ctx.lastRun(created.id).status, "queued");
    assert.deepEqual(live.sent, []);
    // after the reset the session is first asked to continue the turn the limit cut off, then the prompt follows
    await until(() => live.sent.length === 1, "the automatic continue");
    assert.match(live.sent[0], /continue/i);
    ctx.finishTurn();
    await until(() => live.sent.length === 2, "the prompt");
    assert.equal(live.sent[1], "/weekly-report team");
    await until(() => ctx.lastRun(created.id).status === "running");
    ctx.finishTurn();
    await until(() => ctx.lastRun(created.id).status === "success");
  } finally { await ctx.cleanup(); }
});

test("in a session: a closed session is opened for the prompt, in the task's folder", async () => {
  const ctx = await inSession();
  try {
    const opened = [];
    const created = await ctx.create();
    ctx.scheduler.ensureSession = (id, cwd) => { opened.push([id, cwd]); return ctx.open(id, cwd); };
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.manager.live.get(SESSION)?.sent.length === 1, "the prompt to be sent");
    assert.deepEqual(opened, [[SESSION, ctx.folder]]);
    assert.equal(ctx.manager.live.get(SESSION).cwd, ctx.folder);
  } finally { await ctx.cleanup(); }
});

test("in a session: Stop takes a waiting prompt back out of the queue", async () => {
  const ctx = await inSession();
  try {
    const live = ctx.open(SESSION, ctx.folder);
    live.state = "running";
    const created = await ctx.create();
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.outbox.view(SESSION)?.items.length === 1, "the prompt to wait");
    ctx.scheduler.stopRun(created.id);
    await until(() => ctx.lastRun(created.id).status === "stopped", "the run to stop");
    assert.equal(ctx.outbox.waiting(SESSION), false);
    live.state = "idle";
    ctx.manager.emit("session.state", live.summary());
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(live.sent, []); // it never goes out
    assert.equal((await ctx.scheduler.list())[0].active, null);
  } finally { await ctx.cleanup(); }
});

test("in a session: Stop on a working run interrupts the turn but leaves the session open", async () => {
  const ctx = await inSession();
  try {
    const live = ctx.open(SESSION, ctx.folder);
    const created = await ctx.create();
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.lastRun(created.id).status === "running");
    ctx.scheduler.stopRun(created.id);
    await until(() => ctx.lastRun(created.id).status === "stopped");
    assert.equal(live.interrupted, 1);
    assert.equal(live.closed, 0);
    live.emit("event", { seq: 2, msg: { type: "result", is_error: false } }); // a late result changes nothing
    assert.equal(ctx.lastRun(created.id).status, "stopped");
  } finally { await ctx.cleanup(); }
});

test("in a session: a prompt the user deletes from the queue ends the run as stopped", async () => {
  const ctx = await inSession();
  try {
    const live = ctx.open(SESSION, ctx.folder);
    live.state = "running";
    const created = await ctx.create();
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.outbox.view(SESSION)?.items.length === 1);
    ctx.outbox.remove(SESSION, ctx.outbox.view(SESSION).items[0].id);
    await until(() => ctx.lastRun(created.id).status === "stopped");
    assert.match(ctx.lastRun(created.id).error, /removed from the queue/);
  } finally { await ctx.cleanup(); }
});

test("in a session: a prompt that waits too long is withdrawn, and a turn that never ends does not interrupt the session", async () => {
  const waits = await inSession({ scheduler: { waitMs: 60 } });
  try {
    waits.open(SESSION, waits.folder).state = "running";
    const created = await waits.create();
    await waits.scheduler.runNow(created.id);
    await until(() => waits.lastRun(created.id).status === "timeout", "the wait to run out");
    assert.match(waits.lastRun(created.id).error, /waited too long/);
    assert.equal(waits.outbox.waiting(SESSION), false);
  } finally { await waits.cleanup(); }
  const slow = await inSession({ runTimeoutMs: 60 });
  try {
    const live = slow.open(SESSION, slow.folder);
    const created = await slow.create();
    await slow.scheduler.runNow(created.id);
    await until(() => slow.lastRun(created.id).status === "timeout", "the turn to time out");
    assert.equal(live.interrupted, 0);
    assert.equal(live.closed, 0);
  } finally { await slow.cleanup(); }
});

test("in a session: failed results and a closed process are logged as failed", async () => {
  const ctx = await inSession();
  try {
    ctx.open(SESSION, ctx.folder);
    const created = await ctx.create();
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.lastRun(created.id).status === "running");
    ctx.finishTurn(SESSION, { type: "result", is_error: true, subtype: "error_max_turns" });
    await until(() => ctx.lastRun(created.id).status === "failed");
    assert.match(ctx.lastRun(created.id).error, /turn limit/);
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.lastRun(created.id).status === "running" && ctx.manager.live.get(SESSION).sent.length === 2);
    ctx.manager.live.get(SESSION).emit("event", { seq: 3, msg: { type: "wh_closed" } });
    await until(() => ctx.lastRun(created.id).status === "failed" && /stopped before/.test(ctx.lastRun(created.id).error || ""));
  } finally { await ctx.cleanup(); }
});

test("in a session: when sending keeps failing the run fails and the prompt is not left behind to go out later", async () => {
  const ctx = await inSession({ failSend: true });
  try {
    ctx.open(SESSION, ctx.folder);
    const created = await ctx.create();
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.lastRun(created.id).status === "failed", "the run to fail");
    assert.match(ctx.lastRun(created.id).error, /could not be sent: the process would not start/);
    assert.equal(ctx.outbox.waiting(SESSION), false);
  } finally { await ctx.cleanup(); }
});

test("in a session: nothing is delivered while the switch is off, and a missing folder fails the run", async () => {
  const off = await inSession({ on: false });
  try {
    const created = await off.create();
    await assert.rejects(() => off.scheduler.runNow(created.id), (error) => error.status === 409);
    assert.equal(off.outbox.waiting(SESSION), false);
  } finally { await off.cleanup(); }
  const gone = await inSession();
  try {
    const created = await gone.create();
    await rm(gone.folder, { recursive: true });
    await gone.scheduler.runNow(created.id);
    await until(() => gone.lastRun(created.id).status === "failed");
    assert.match(gone.lastRun(created.id).error, /folder does not exist/);
    assert.equal(gone.outbox.waiting(SESSION), false);
  } finally { await gone.cleanup(); }
});

test("in a session: a scheduled time delivers the prompt and the next one is skipped while the first still waits", async () => {
  const ctx = await inSession();
  try {
    const live = ctx.open(SESSION, ctx.folder);
    live.state = "running";
    const created = await ctx.create({ frequency: "weekly", weekday: 3, time: "15:45" });
    ctx.clock.now = at(...WED, 15, 46);
    assert.deepEqual(await ctx.scheduler.tick(), [created.id]);
    await until(() => ctx.outbox.view(SESSION)?.items.length === 1);
    assert.equal(ctx.lastRun(created.id).trigger, "schedule");
    ctx.clock.now = at(6, 17, 15, 46); // next Wednesday, the first prompt is still waiting
    await ctx.scheduler.tick();
    assert.equal(ctx.lastRun(created.id).status, "skipped");
    assert.equal(ctx.outbox.view(SESSION).items.length, 1);
  } finally { await ctx.cleanup(); }
});

test("in a session: a prompt still waiting survives a restart of Wheelhouse and its run carries on", async () => {
  const ctx = await inSession();
  try {
    const live = ctx.open(SESSION, ctx.folder);
    live.state = "running";
    const created = await ctx.create();
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.outbox.view(SESSION)?.items.length === 1);
    await ctx.scheduler.flush();
    ctx.scheduler.shutdown(); // Wheelhouse closes: the queue file stays
    await ctx.scheduler.flush();
    const reloaded = await ctx.make().load();
    try {
      const run = reloaded.task(created.id).runs[0];
      assert.equal(run.status, "queued"); // not failed: its prompt is still in the queue
      live.state = "idle";
      ctx.manager.emit("session.state", live.summary());
      await until(() => live.sent.length === 1, "the prompt to be sent");
      await until(() => run.status === "running");
      ctx.finishTurn();
      await until(() => run.status === "success");
    } finally { reloaded.shutdown(); await reloaded.flush(); }
  } finally { await ctx.cleanup(); }
});

test("in a session: a restart while the turn was working marks the run failed and leaves the session alone", async () => {
  const ctx = await inSession();
  try {
    const live = ctx.open(SESSION, ctx.folder);
    const created = await ctx.create();
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.lastRun(created.id).status === "running");
    ctx.scheduler.shutdown();
    await ctx.scheduler.flush();
    const reloaded = await ctx.make().load();
    assert.equal(reloaded.task(created.id).runs[0].status, "failed");
    assert.match(reloaded.task(created.id).runs[0].error, /closed before/);
    assert.equal(live.interrupted, 0);
    reloaded.shutdown();
  } finally { await ctx.cleanup(); }
});

test("in a session: deleting the task takes its waiting prompt out of the queue", async () => {
  const ctx = await inSession();
  try {
    ctx.open(SESSION, ctx.folder).state = "running";
    const created = await ctx.create();
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.outbox.view(SESSION)?.items.length === 1);
    await ctx.scheduler.remove(created.id);
    assert.equal(ctx.outbox.waiting(SESSION), false);
  } finally { await ctx.cleanup(); }
});

// ---- the session must exist ------------------------------------------------------------------
const known = () => {
  const sessions = new Map([[SESSION, { cwd: "", archived: false, title: "Weekly" }]]);
  return { sessions, lookupSession: async (id) => sessions.get(id) ?? null };
};

test("a task checks that its session exists, is not archived, and takes the session's own folder", async () => {
  const lookup = known();
  const ctx = await inSession({ scheduler: { lookupSession: lookup.lookupSession } });
  try {
    lookup.sessions.get(SESSION).cwd = ctx.folder;
    const base = { name: "Weekly report", prompt: "/weekly-report team", sessionId: SESSION, frequency: "weekly", weekday: 3, time: "15:45" };
    const created = await ctx.scheduler.create(base); // no folder given: the session's folder is used
    assert.equal(created.cwd, ctx.folder);
    assert.deepEqual(created.session, { state: "ok", title: "Weekly" });
    await assert.rejects(() => ctx.scheduler.create({ ...base, sessionId: "no-such-session" }), (error) => error instanceof SchedulerError && error.status === 400 && /session was not found/.test(error.message));
    lookup.sessions.set("old-one", { cwd: ctx.folder, archived: true, title: "Old" });
    await assert.rejects(() => ctx.scheduler.create({ ...base, sessionId: "old-one" }), /archived/);
    // The session goes away later: the task is still listed (as missing) and can still be edited, paused or deleted.
    lookup.sessions.delete(SESSION);
    const [view] = await ctx.scheduler.list();
    assert.equal(view.session.state, "missing");
    const edited = await ctx.scheduler.update(created.id, { prompt: "/weekly-report zare" });
    assert.equal(edited.prompt, "/weekly-report zare");
    await assert.rejects(() => ctx.scheduler.update(created.id, { sessionId: "another-missing" }), /not found/);
    lookup.sessions.get("old-one").archived = false;
    assert.equal((await ctx.scheduler.update(created.id, { sessionId: "old-one" })).sessionId, "old-one");
  } finally { await ctx.cleanup(); }
});

test("in a session: a deleted or archived session fails the run clearly and never starts a new session", async () => {
  const lookup = known();
  const ctx = await inSession({ scheduler: { lookupSession: lookup.lookupSession } });
  try {
    lookup.sessions.get(SESSION).cwd = ctx.folder;
    const created = await ctx.create({ sessionId: SESSION });
    lookup.sessions.delete(SESSION); // deleted after the task was made
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.lastRun(created.id).status === "failed");
    assert.match(ctx.lastRun(created.id).error, /session was not found/);
    assert.equal(ctx.manager.live.size, 0); // no session object was invented for the unknown id
    assert.equal(ctx.outbox.waiting(SESSION), false);
    assert.equal((await ctx.scheduler.list())[0].active, null);
    lookup.sessions.set(SESSION, { cwd: ctx.folder, archived: true, title: "Weekly" });
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.lastRun(created.id).status === "failed" && /archived/.test(ctx.lastRun(created.id).error || ""));
    assert.equal((await ctx.scheduler.list())[0].session.state, "archived");
    lookup.sessions.set(SESSION, { cwd: ctx.folder, archived: false, title: "Weekly" });
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.manager.live.get(SESSION)?.sent.length === 1);
    assert.equal(ctx.manager.live.get(SESSION).cwd, ctx.folder);
  } finally { await ctx.cleanup(); }
});

test("in a session: a session deleted while the prompt waits ends the run as failed", async () => {
  const ctx = await inSession();
  try {
    ctx.open(SESSION, ctx.folder).state = "running";
    const created = await ctx.create();
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.outbox.view(SESSION)?.items.length === 1);
    ctx.outbox.forget(SESSION); // what the server does when the session is deleted
    await until(() => ctx.lastRun(created.id).status === "failed");
    assert.match(ctx.lastRun(created.id).error, /session was deleted/);
  } finally { await ctx.cleanup(); }
});

test("in a session: two tasks for one session go out one after the other and each ends with its own turn", async () => {
  const ctx = await inSession();
  try {
    const live = ctx.open(SESSION, ctx.folder);
    live.state = "running";
    const first = await ctx.create({ name: "Zare report", prompt: "/weekly-report zare" });
    const second = await ctx.create({ name: "Team report", prompt: "/weekly-report team" });
    await ctx.scheduler.runNow(first.id);
    await ctx.scheduler.runNow(second.id);
    await until(() => ctx.outbox.view(SESSION)?.items.length === 2);
    assert.equal((await ctx.scheduler.list()).every((item) => item.active === "queued"), true);
    live.state = "idle";
    ctx.manager.emit("session.state", live.summary());
    await until(() => live.sent.length === 1);
    assert.deepEqual(live.sent, ["/weekly-report zare"]);
    await until(() => ctx.lastRun(first.id).status === "running");
    assert.equal(ctx.lastRun(second.id).status, "queued"); // still waiting behind the first
    ctx.finishTurn();
    await until(() => ctx.lastRun(first.id).status === "success");
    await until(() => live.sent.length === 2);
    assert.equal(live.sent[1], "/weekly-report team");
    await until(() => ctx.lastRun(second.id).status === "running");
    ctx.finishTurn();
    await until(() => ctx.lastRun(second.id).status === "success");
  } finally { await ctx.cleanup(); }
});

test("in a session: a run that waits for a usage limit says so (held) until the prompt goes out", async () => {
  const ctx = await inSession();
  try {
    ctx.open(SESSION, ctx.folder);
    ctx.manager.emit("session.limit", { id: SESSION, info: { status: "rejected", resetsAt: Date.now() + 60_000, rateLimitType: "five_hour" } });
    const created = await ctx.create();
    await ctx.scheduler.runNow(created.id);
    await until(() => ctx.outbox.view(SESSION)?.items.length === 1);
    const [view] = await ctx.scheduler.list();
    assert.equal(view.active, "queued");
    assert.equal(view.held, true);
    assert.deepEqual(ctx.manager.live.get(SESSION).sent, []);
  } finally { await ctx.cleanup(); }
});

test("in a session: after a restart that missed the weekly time, one catch-up prompt goes out", async () => {
  const ctx = await inSession();
  try {
    ctx.open(SESSION, ctx.folder);
    const created = await ctx.create({ frequency: "weekly", weekday: 3, time: "15:45" });
    ctx.scheduler.shutdown(); // Wheelhouse is closed over Wednesday 15:45
    await ctx.scheduler.flush();
    ctx.clock.now = at(6, 11, 9, 0); // Thursday morning
    const restarted = await ctx.make().load();
    try {
      assert.deepEqual(await restarted.tick(), [created.id]);
      await until(() => ctx.manager.live.get(SESSION).sent.length === 1);
      const run = restarted.task(created.id).runs[0];
      assert.equal(run.trigger, "catchup");
      assert.equal(run.scheduledFor, at(6, 10, 15, 45));
      assert.deepEqual(await restarted.tick(), []); // not twice
    } finally { restarted.shutdown(); await restarted.flush(); }
  } finally { await ctx.cleanup(); }
});

test("weekly 15:45 and 14:30 on Wednesday in Asia/Tehran fire at those local times (no clock change there)", () => {
  const before = process.env.TZ;
  process.env.TZ = "Asia/Tehran";
  try {
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== "Asia/Tehran") return; // this platform cannot switch zones at run time
    const local = (ms) => new Date(ms).toLocaleString("en-GB", { timeZone: "Asia/Tehran", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const team = task({ frequency: "weekly", weekday: 3, time: "15:45" });
    const zare = task({ frequency: "weekly", weekday: 3, time: "14:30" });
    // Around the dates when Iran used to change its clocks the wall-clock time stays the same.
    for (const day of ["2026-03-18", "2026-03-25", "2026-09-16", "2026-09-23"].map((text) => new Date(`${text}T00:00:00Z`).getTime())) {
      assert.match(local(nextRun(team, day)), /^Wed,? 15:45$/);
      assert.match(local(nextRun(zare, day)), /^Wed,? 14:30$/);
      assert.equal(nextRun(team, day) - day < 8 * DAY, true);
    }
    assert.equal(new Date(nextRun(team, new Date("2026-11-24T12:00:00Z").getTime())).toISOString(), "2026-11-25T12:15:00.000Z"); // 15:45 at +03:30
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test("a clock change that skips or repeats the scheduled time still fires once a day", () => {
  const before = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== "America/New_York") return;
    const day = (y, m, d, h = 0) => new Date(y, m - 1, d, h).getTime();
    const skipped = task({ frequency: "daily", time: "02:30" }); // 2026-03-08: 02:30 does not exist
    const run = nextRun(skipped, day(2026, 3, 8));
    assert.equal(new Date(run).getDate(), 8);
    assert.equal(nextRun(skipped, run) > run, true); // strictly later, so the same moment never fires twice
    const repeated = task({ frequency: "daily", time: "01:30" }); // 2026-11-01: 01:30 happens twice
    const first = nextRun(repeated, day(2026, 11, 1));
    assert.equal(new Date(nextRun(repeated, first)).getDate(), 2);
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});
