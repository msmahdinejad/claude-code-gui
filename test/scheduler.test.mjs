import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
