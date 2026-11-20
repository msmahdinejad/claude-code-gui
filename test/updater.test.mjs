import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { ClaudeUpdater, binIn, compareVersions, installOf, npmCommand } from "../server/lib/claude-updater.mjs";
import { claudeBinsInUse, claudeBusy, trackClaude } from "../server/lib/claude-processes.mjs";

const REL = join("node_modules", "@anthropic-ai", "claude-code");
const MIN = 1000; // the updater is told that anything below this is a stub (the real limit is 50 MB)
const real = (version, size = 2000) => `BIN ${version}\n`.padEnd(size, "#"); // a "working" executable
const STUB = "echo 'Error: claude native binary not installed.'\n".padEnd(500, "#"); // what the package ships until postinstall
const versionIn = (path) => {
  try { return /^BIN (\d+\.\d+\.\d+)/.exec(readFileSync(path, "utf8"))?.[1] || null; } catch { return null; }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("versions compare numerically", () => {
  assert.equal(compareVersions("2.1.9", "2.1.10"), -1);
  assert.equal(compareVersions("2.1.322", "2.1.322"), 0);
  assert.equal(compareVersions("2.2.0", "2.1.999"), 1);
});

test("an npm install is recognised and its prefix and package folder found", () => {
  const own = join("prefix", REL, "bin", "claude.exe");
  assert.deepEqual(installOf(own), { kind: "npm", prefix: "prefix", pkgDir: join("prefix", REL) });
  assert.deepEqual(installOf(join("home", ".local", "bin", "claude.exe")), { kind: "native" });
  assert.equal(installOf(""), null);
  if (process.platform !== "win32") assert.deepEqual(installOf(join("usr", "local", "lib", REL, "bin", "claude.exe")), { kind: "npm", prefix: join("usr", "local"), pkgDir: join("usr", "local", "lib", REL) });
});

function session(extra = {}) {
  return { alive: true, state: "idle", lastActive: 0, pending: new Set(), backgroundTasks: 0, bin: null, closed: 0, close() { this.closed += 1; this.alive = false; }, ...extra };
}

/**
 * A fake npm and a fake Claude Code on real files. An "executable" is a text file that starts with `BIN <version>`;
 * npm "installs" by writing one (`copy`: --prefix <dir>, `stage`: -g --prefix <dir>), as a working binary ("ok"), a 500-byte
 * stub with exit 0 ("stub", what npm does when the platform package cannot be downloaded), a working one that is too small
 * ("tiny") or not at all ("fail"). `breakInPlace`: the new version runs in the staging folder but not once it has been moved.
 */
async function setup({ installed = "2.1.309", latest = "2.1.322", copy = "ok", stage = "ok", breakInPlace = false, sessions = [session()], enabled = true, customCommand = false, native = false, processes = { busy: () => false, binsInUse: () => new Set() } } = {}) {
  const root = await mkdtemp(join(tmpdir(), "wh-upd-"));
  const dataDir = join(root, "data");
  const prefix = join(root, "prefix");
  const OWN = native ? join(root, ".local", "bin", "claude.exe") : join(prefix, REL, "bin", "claude.exe");
  const calls = [];
  const gates = [];
  const ctx = { root, dataDir, prefix, OWN, calls, gates, stage, copy, breakInPlace };
  const write = async (path, content) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };
  await write(OWN, real(installed));
  const config = { claudeBin: OWN, dataDir };
  const manager = { sessions: new Map(sessions.map((s, i) => [String(i), s])), hold: (promise) => gates.push(promise) };
  const catalog = { inflight: new Map(), invalidated: 0, invalidate() { this.invalidated += 1; } };
  const run = async (file, args) => {
    if (file !== "npm") { // a Claude Code executable
      calls.push(`run ${file === OWN ? "own" : "other"} ${args.join(" ")}`);
      const version = versionIn(file);
      if (!version || (ctx.breakInPlace && file === OWN && version === latest)) return { code: 1, stdout: "", stderr: "broken" };
      return { code: 0, stdout: `${version} (Claude Code)`, stderr: "" };
    }
    calls.push(`npm ${args.join(" ")}`);
    if (args[0] === "view") return { code: 0, stdout: `${latest}\n`, stderr: "" };
    const wanted = args.find((arg) => arg.startsWith("@anthropic-ai/claude-code@")).split("@").at(-1);
    const dir = args[args.indexOf("--prefix") + 1];
    const global = args.includes("-g");
    const mode = global ? ctx.stage : ctx.copy;
    if (mode === "fail") return { code: 1, stdout: "", stderr: "npm error ETIMEDOUT" };
    const target = global ? join(dir, REL, "bin", "claude.exe") : binIn(dir);
    await ctx.beforeInstall?.(target, wanted);
    await write(target, mode === "stub" ? STUB : mode === "tiny" ? real(wanted, 300) : real(wanted));
    return { code: 0, stdout: "", stderr: "" }; // exit 0 even for a stub: that is the point
  };
  const updater = new ClaudeUpdater({
    config, manager, catalog, profileBin: () => OWN, customCommand: () => customCommand, enabled: () => enabled, run, processes,
    npmCommand: { file: "npm", args: [], shell: false }, locked: async () => false, minBinaryBytes: MIN, progressMs: 10,
    sleep: async () => { updater.onSleep?.(); },
  });
  Object.assign(ctx, { updater, config, manager, catalog, write, done: () => rm(root, { recursive: true, force: true }) });
  ctx.version = (path = OWN) => versionIn(path);
  ctx.leftovers = () => [existsSync(join(prefix, ".wheelhouse-stage")), existsSync(join(prefix, "node_modules", "@anthropic-ai", ".claude-code-wh-old"))];
  return ctx;
}

test("a newer version is used at once for new processes, even while sessions work", async () => {
  const busy = session({ state: "running" });
  const ctx = await setup({ sessions: [busy] });
  const updated = [];
  ctx.updater.on("updated", (event) => updated.push(event));
  let sleeps = 0;
  ctx.updater.onSleep = () => {
    sleeps += 1;
    if (sleeps === 1) {
      // still busy: our copy is already what new processes run, the working session was not touched, and the profile's
      // new version is already installed and checked next to the real one
      assert.equal(ctx.config.claudeBin, binIn(join(ctx.dataDir, "claude-code", "2.1.322")));
      assert.equal(busy.closed, 0);
      assert.equal(ctx.version(), "2.1.309");
      assert.deepEqual(updated, [{ from: "2.1.309", to: "2.1.322" }]);
      assert.equal(ctx.updater.status().phase, "waiting");
      assert.equal(ctx.version(join(ctx.prefix, ".wheelhouse-stage", REL, "bin", "claude.exe")), "2.1.322");
    }
    if (sleeps === 3) busy.state = "idle";
  };
  await ctx.updater.tick();
  assert.ok(sleeps >= 3);
  // then, once quiet, the profile's own install was swapped in and is used again
  assert.equal(busy.closed, 1);
  assert.equal(ctx.version(), "2.1.322");
  assert.equal(ctx.config.claudeBin, ctx.OWN);
  assert.match(ctx.calls.find((call) => call.includes("install -g")), /--prefer-offline/);
  assert.equal(ctx.calls.filter((call) => call.includes("install -g")).length, 1, "one install, into the staging folder");
  assert.deepEqual(ctx.leftovers(), [false, false], "staging folder and backup are gone");
  assert.equal(ctx.gates.length, 1);
  assert.equal(ctx.updater.status().updateAvailable, false);
  assert.equal(ctx.updater.status().error, null);
  await ctx.done();
});

test("without a copy the swap alone is the update: the page is told and the model list reloaded", async () => {
  const ctx = await setup({ customCommand: true });
  const updated = [];
  ctx.updater.on("updated", (event) => updated.push(event));
  await ctx.updater.tick();
  assert.equal(ctx.version(), "2.1.322");
  assert.deepEqual(updated, [{ from: "2.1.309", to: "2.1.322" }]);
  const state = ctx.updater.status();
  assert.equal(state.updatedTo, "2.1.322");
  assert.ok(state.updatedAt > 0);
  assert.ok(ctx.catalog.invalidated >= 1);
  await ctx.done();
});

test("processes that run our copy are not stopped for the swap", async () => {
  const ctx = await setup({ sessions: [] });
  ctx.updater.onSleep = () => {
    if (!ctx.manager.sessions.size) ctx.manager.sessions.set("copy", session({ bin: ctx.config.claudeBin, lastActive: 0 }));
  };
  // make the copy session appear right after activation
  ctx.updater.once("updated", () => ctx.manager.sessions.set("copy", session({ bin: ctx.config.claudeBin })));
  await ctx.updater.tick();
  assert.equal(ctx.manager.sessions.get("copy").closed, 0);
  await ctx.done();
});

test("a new version whose binary is a stub (npm exit 0, platform package missing) never reaches the installed Claude Code", async () => {
  const busy = session({ state: "running" });
  const ctx = await setup({ stage: "stub", sessions: [busy], customCommand: true });
  await ctx.updater.tick({ force: true, now: true });
  const state = ctx.updater.status();
  assert.equal(ctx.version(), "2.1.309", "the old install is untouched");
  assert.equal(busy.closed, 0, "no session was stopped for an update that cannot work");
  assert.equal(ctx.gates.length, 0, "nothing was held");
  assert.deepEqual(ctx.leftovers(), [false, false]);
  assert.match(state.error, /Could not install 2\.1\.322: the native binary is missing.*; kept 2\.1\.309/);
  assert.deepEqual({ kind: state.failure.kind, version: state.failure.version, kept: state.failure.kept }, { kind: "download", version: "2.1.322", kept: "2.1.309" });
  assert.equal(state.failedVersion, "2.1.322");
  assert.equal(ctx.calls.filter((call) => call.includes("install -g")).length, 1, "and no reinstall of the old version from the network");
  await ctx.done();
});

test("a binary below the sanity size counts as broken even when it runs", async () => {
  const ctx = await setup({ stage: "tiny", customCommand: true });
  await ctx.updater.tick({ force: true });
  assert.equal(ctx.version(), "2.1.309");
  assert.match(ctx.updater.status().error, /native binary is missing/);
  await ctx.done();
});

test("a failed npm run leaves the old install and says why", async () => {
  const ctx = await setup({ stage: "fail", customCommand: true });
  await ctx.updater.tick({ force: true });
  assert.equal(ctx.version(), "2.1.309");
  assert.match(ctx.updater.status().error, /Could not install 2\.1\.322: npm error ETIMEDOUT; kept 2\.1\.309/);
  await ctx.done();
});

test("a new version that does not run once it is in place is renamed away and the old folder put back, without the network", async () => {
  const ctx = await setup({ breakInPlace: true, customCommand: true });
  await ctx.updater.tick({ force: true });
  const state = ctx.updater.status();
  assert.equal(ctx.version(), "2.1.309", "old version back");
  assert.equal(await readFile(ctx.OWN, "utf8"), real("2.1.309"), "the very same files");
  assert.deepEqual(ctx.leftovers(), [false, false]);
  assert.equal(ctx.calls.filter((call) => call.includes("install")).length, 1, "only the staging install; the rollback is a rename");
  assert.equal(state.failure.kind, "incomplete");
  assert.match(state.error, /kept 2\.1\.309/);
  assert.equal(ctx.gates.length, 1);
  await ctx.done();
});

test("when the installed files are in use the swap gives up and nothing changes", async () => {
  const ctx = await setup({ customCommand: true });
  const { move } = ctx.updater;
  ctx.updater.move = async (from, to) => { if (to.endsWith("wh-old")) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return move.call(ctx.updater, from, to); };
  await ctx.updater.tick({ force: true });
  assert.equal(ctx.version(), "2.1.309");
  assert.equal(ctx.updater.status().failure.kind, "locked");
  assert.deepEqual(ctx.leftovers(), [false, false]);
  await ctx.done();
});

test("a swap that was interrupted between the two renames is repaired at start", async () => {
  const ctx = await setup({ customCommand: true });
  const live = join(ctx.prefix, REL);
  const backup = join(ctx.prefix, "node_modules", "@anthropic-ai", ".claude-code-wh-old");
  await mkdir(dirname(live), { recursive: true });
  await ctx.write(join(backup, "bin", "claude.exe"), real("2.1.309"));
  await rm(live, { recursive: true, force: true }); // power cut: the live folder is gone, the backup is there
  await ctx.updater.useInstalled();
  assert.equal(ctx.version(), "2.1.309");
  assert.ok(!existsSync(backup));
  // a working install keeps nothing of an old backup or a half staged folder
  await ctx.write(join(backup, "x"), "old");
  await ctx.write(join(ctx.prefix, ".wheelhouse-stage", "x"), "half");
  await ctx.updater.useInstalled();
  assert.deepEqual(ctx.leftovers(), [false, false]);
  assert.equal(ctx.version(), "2.1.309");
  await ctx.done();
});

test("progress is reported from the size of the staging folder while npm runs", async () => {
  const ctx = await setup({ customCommand: true });
  let seen = null;
  ctx.beforeInstall = async (target) => {
    await ctx.write(target, "#".repeat(600)); // 600 of the ~2000 bytes of the installed binary are on disk
    await wait(120);
    seen = ctx.updater.status();
  };
  await ctx.updater.tick({ force: true });
  assert.equal(seen.phase, "downloading");
  assert.equal(seen.target, "2.1.322");
  assert.ok(seen.progress.percent >= 20 && seen.progress.percent < 100, `percent ${seen.progress.percent}`);
  assert.equal(ctx.updater.status().progress, null, "cleared when the run is over");
  assert.equal(ctx.version(), "2.1.322");
  await ctx.done();
});

test("a failed copy install leaves everything as it was", async () => {
  for (const copy of ["fail", "stub"]) {
    const ctx = await setup({ copy });
    await ctx.updater.tick();
    assert.equal(ctx.config.claudeBin, ctx.OWN);
    assert.match(ctx.updater.status().error, /Could not install 2\.1\.322/);
    assert.ok(!ctx.calls.some((call) => call.includes("install -g")));
    assert.ok(!existsSync(join(ctx.dataDir, "claude-code", "2.1.322")), "the broken copy is removed");
    await ctx.done();
  }
});

test("a copy installed earlier is used at start without the network; copies that are stubs are not", async () => {
  const ctx = await setup();
  const dir = join(ctx.dataDir, "claude-code", "2.1.322");
  const broken = join(ctx.dataDir, "claude-code", "2.1.323");
  await ctx.write(binIn(broken), STUB);
  await ctx.write(binIn(dir), real("2.1.322"));
  assert.equal(await ctx.updater.useInstalled(), "2.1.322");
  assert.equal(ctx.config.claudeBin, binIn(dir));
  assert.ok(!ctx.calls.some((call) => call.startsWith("npm")));
  assert.ok(!existsSync(broken), "the stub copy was pruned");
  await ctx.done();
});

test("stub copies of a profile that never uses copies are cleaned up too", async () => {
  const ctx = await setup({ customCommand: true });
  await ctx.write(binIn(join(ctx.dataDir, "claude-code", "2.1.328")), STUB);
  await ctx.updater.useInstalled();
  assert.deepEqual(await readdir(join(ctx.dataDir, "claude-code")), []);
  await ctx.done();
});

test("busy means working, waiting for an answer, background work or activity a moment ago", async () => {
  const ctx = await setup({ sessions: [session({ pending: new Set(["x"]) })] });
  assert.equal(ctx.updater.idle(), false);
  ctx.manager.sessions.set("0", session({ backgroundTasks: 2 }));
  assert.equal(ctx.updater.idle(), false);
  ctx.manager.sessions.set("0", session({ lastActive: Date.now() }));
  assert.equal(ctx.updater.idle(), false);
  ctx.manager.sessions.set("0", session());
  assert.equal(ctx.updater.idle(), true);
  ctx.catalog.inflight.set("cwd", Promise.resolve());
  assert.equal(ctx.updater.idle(), false);
  await ctx.done();
});

test("nothing happens when switched off, unless the user asks for it", async () => {
  const ctx = await setup({ enabled: false });
  await ctx.updater.tick();
  assert.equal(ctx.calls.length, 0);
  await ctx.updater.tick({ force: true });
  assert.equal(ctx.version(), "2.1.322");
  await ctx.done();
});

test("no update when already on the newest version", async () => {
  const ctx = await setup({ installed: "2.1.322" });
  await ctx.updater.tick();
  assert.ok(!ctx.calls.some((call) => call.includes("install")));
  assert.equal(ctx.manager.sessions.get("0").closed, 0);
  await ctx.done();
});

test("“now” stops waiting for a quiet moment and stops the sessions on the old version", async () => {
  const busy = session({ state: "running" });
  const ctx = await setup({ sessions: [busy] });
  let sleeps = 0;
  ctx.updater.onSleep = () => {
    sleeps += 1;
    if (sleeps === 2) ctx.updater.tick({ force: true, now: true }); // the user presses "Update now" while it waits
  };
  await ctx.updater.tick();
  assert.equal(busy.state, "running", "it was still working");
  assert.equal(busy.closed, 1);
  assert.equal(ctx.version(), "2.1.322");
  await ctx.done();
});

test("a profile with its own command or a native install never switches to our copy", async () => {
  for (const options of [{ customCommand: true }, { native: true }]) {
    const ctx = await setup(options);
    ctx.config.claudeBin = ctx.OWN;
    await ctx.updater.tick();
    assert.equal(ctx.config.claudeBin, ctx.OWN);
    assert.ok(!ctx.calls.some((call) => /install --prefix/.test(call)), "no copy installed");
    if (options.native) assert.ok(!ctx.calls.some((call) => call.includes("install")), "a native install updates itself");
    const dir = join(ctx.dataDir, "claude-code", "2.1.322");
    await ctx.write(binIn(dir), real("2.1.322"));
    assert.equal(await ctx.updater.useInstalled(), null);
    await ctx.done();
  }
});

test("older copies are pruned right after a new one is activated, except those still in use", async () => {
  const root = (ctx, name) => join(ctx.dataDir, "claude-code", name);
  let inUse;
  const busy = session({ state: "running" });
  const ctx = await setup({ sessions: [busy], processes: { busy: () => false, binsInUse: () => inUse } });
  inUse = new Set([binIn(root(ctx, "2.1.310"))]);
  for (const name of ["2.1.300", "2.1.310"]) await mkdir(root(ctx, name), { recursive: true });
  let checked = false;
  ctx.updater.onSleep = () => {
    if (checked) { busy.state = "idle"; return; }
    checked = true;
    assert.ok(!existsSync(root(ctx, "2.1.300")), "unused copy removed while waiting");
    assert.ok(existsSync(root(ctx, "2.1.310")), "copy used by another Claude process kept");
  };
  await ctx.updater.tick();
  assert.ok(checked);
  await ctx.done();
});

test("other Claude processes (sign-in, CLI runs) keep the swap waiting", async () => {
  let busy = true;
  const ctx = await setup({ processes: { busy: () => busy, binsInUse: () => new Set() } });
  assert.equal(ctx.updater.idle(), false);
  busy = false;
  assert.equal(ctx.updater.idle(), true);
  await ctx.done();
});

test("npm runs without a shell when npm-cli.js sits next to node, and refuses unsafe paths through cmd", async () => {
  const direct = npmCommand({ platform: "win32", execPath: join("C:", "node", "node.exe"), exists: () => true });
  assert.equal(direct.shell, false);
  assert.match(direct.args[0], /npm-cli\.js$/);
  assert.deepEqual(npmCommand({ platform: "win32", execPath: "node.exe", exists: () => false }), { file: "npm.cmd", args: [], shell: true });
  const calls = [];
  const updater = new ClaudeUpdater({ config: { dataDir: "x" }, manager: { sessions: new Map() }, profileBin: () => join("prefix", REL, "bin", "claude.exe"), npmCommand: { file: "npm.cmd", args: [], shell: true }, run: async (file, args, options) => { calls.push({ file, args, options }); return { code: 0, stdout: "", stderr: "" }; } });
  assert.equal((await updater.npm(["install", "--prefix", "C:/a%PATH%b"])).code, 1);
  assert.equal(calls.length, 0);
  await updater.npm(["install", "--prefix", "C:/Program Files/x"]);
  assert.deepEqual(calls[0].args, ['"install"', '"--prefix"', '"C:/Program Files/x"']);
  assert.equal(calls[0].options.shell, true);
});

test("tracked Claude processes: busy while running, files kept for keepMs", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  trackClaude("a.exe", child);
  let settle;
  trackClaude("b.exe", new Promise((resolve) => { settle = resolve; }));
  const window = new EventEmitter();
  window.exitCode = null;
  trackClaude("c.exe", window, { keepMs: 60_000 });
  assert.equal(claudeBusy(), true);
  assert.deepEqual([...claudeBinsInUse()].sort(), ["a.exe", "b.exe", "c.exe"]);
  child.emit("exit", 0);
  settle();
  await new Promise((resolve) => setImmediate(resolve));
  window.emit("exit", 0);
  assert.equal(claudeBusy(), false);
  assert.deepEqual([...claudeBinsInUse()], ["c.exe"]);
  assert.deepEqual([...claudeBinsInUse(Date.now() + 61_000)], []);
});
