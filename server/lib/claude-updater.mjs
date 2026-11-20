// Keeps the Claude Code executable of the active profile up to date.
//
// Claude Code lists only the models it knew about when it was built, so a new model (and new features) show up in
// Wheelhouse only after the CLI is updated. A profile that sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC also turns off
// the CLI's own auto-updater, so Wheelhouse does it, in two steps:
//
//   1. As soon as a newer version is published it is installed into Wheelhouse's own folder (<dataDir>/claude-code/<v>)
//      and, once `--version` confirms it runs, used for every new Claude process and for the model list. Nothing that is
//      running is touched: sessions that are working keep their process (and the old version) until it restarts.
//   2. The profile's own installation (what the terminal uses) is updated too. The new version is first installed into a
//      staging folder next to the real one (`npm install -g --prefix <prefix>/.wheelhouse-stage`) and checked there: the
//      native binary must exist, be of a sane size and run `--version`. npm exits 0 and leaves a 500-byte stub when the
//      platform package (the ~350 MB @anthropic-ai/claude-code-<os>-<cpu> optional dependency) cannot be downloaded, so
//      its exit code alone proves nothing. Only a verified stage is used, and only in a quiet moment (no session working,
//      waiting for an answer or running background work): idle processes are stopped for a few seconds (they start again
//      on the next message), the live package folder is renamed to a backup, the staged one is renamed into its place and
//      checked again. On any failure the backup is renamed back, so the rollback never needs the network, and the profile
//      is never left with a stub.
//
// Only an npm-style install (…/node_modules/@anthropic-ai/claude-code) is updated this way; a native install updates
// itself (`claude update`).
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { claudeProcesses } from "./claude-processes.mjs";

const PACKAGE = "@anthropic-ai/claude-code";
const VERSION = /^\d+\.\d+\.\d+$/;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
const IDLE_MS = 2 * 60 * 1000; // no session activity for this long counts as idle
const IDLE_POLL_MS = 30 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const STAGE_TIMEOUT_MS = 60 * 60 * 1000; // slow proxies: the package is ~350 MB
const MIN_BINARY_BYTES = 50 * 1024 * 1024; // the real binary is ~370 MB; the stub that npm leaves behind is 500 bytes
const EXPECTED_BINARY_BYTES = 380 * 1024 * 1024; // for the progress estimate when the installed binary cannot be measured
const PROGRESS_MS = 1500;
const STAGE_DIR = ".wheelhouse-stage"; // inside the npm prefix, so a rename never crosses a volume
const BACKUP_DIR = ".claude-code-wh-old"; // inside node_modules/@anthropic-ai, next to the live package
const EXIT_WAIT_MS = 8000; // the SDK gives a closed process 2 s, then 5 s more before it kills it
const SHELL_SAFE = /^[^"%&|<>^\r\n]+$/; // what may go (quoted) through cmd.exe: no quotes, %VAR%, pipes or escapes

/** -1 / 0 / 1 for dotted numeric versions. */
export function compareVersions(a, b) {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const newer = (a, b) => Boolean(a && (!b || compareVersions(a, b) > 0));

/** How the executable at `binPath` was installed: { kind: "npm", prefix, pkgDir } (global npm package), { kind: "native" } or null. */
export function installOf(binPath, platform = process.platform) {
  if (!binPath) return null;
  const marker = `${sep}node_modules${sep}@anthropic-ai${sep}claude-code${sep}`;
  const haystack = platform === "win32" ? binPath.toLowerCase() : binPath;
  const at = haystack.indexOf(marker);
  if (at > 0) {
    let prefix = binPath.slice(0, at);
    if (platform !== "win32" && prefix.endsWith(`${sep}lib`)) prefix = prefix.slice(0, -4); // Unix: <prefix>/lib/node_modules
    return { kind: "npm", prefix, pkgDir: binPath.slice(0, at + marker.length - 1) };
  }
  return { kind: "native" };
}

/** The executable inside an install made with `npm install --prefix <dir>`. */
export const binIn = (dir) => join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");

/**
 * How to run npm: node + npm-cli.js when npm sits next to this node (no shell involved), otherwise `npm`, which on
 * Windows is npm.cmd and needs a shell.
 */
export function npmCommand({ platform = process.platform, execPath = process.execPath, exists = existsSync } = {}) {
  const base = dirname(execPath);
  const cli = platform === "win32" ? join(base, "node_modules", "npm", "bin", "npm-cli.js") : join(base, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (exists(cli)) return { file: execPath, args: [cli], shell: false };
  return platform === "win32" ? { file: "npm.cmd", args: [], shell: true } : { file: "npm", args: [], shell: false };
}

/** Windows: is `bin` still held by a running process? (An executable that runs cannot be opened for writing.) */
async function locked(bin) {
  if (process.platform !== "win32" || !bin) return false;
  try {
    await (await open(bin, "r+")).close();
    return false;
  } catch (error) {
    return error.code === "EBUSY";
  }
}

const defaultRun = (file, args, { timeoutMs = 120_000, env = process.env, shell = false } = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, env, shell, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || error?.message || "") });
    });
  });

const fileSize = async (path) => (await stat(path).catch(() => null))?.size || 0;
const isDir = async (path) => Boolean((await stat(path).catch(() => null))?.isDirectory());
const lastLine = (text) => String(text || "").trim().split("\n").at(-1).trim();

/** Total size of the files under `dir` (0 when there is none). Never throws. */
async function dirBytes(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await dirBytes(path) : await fileSize(path);
  }
  return total;
}

export class ClaudeUpdater extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.config     Wheelhouse config (claudeBin is what new processes run; dataDir)
   * @param {object} deps.manager    SessionManager (sessions, hold())
   * @param {object} deps.catalog    Catalog (invalidate(), inflight)
   * @param {() => string|null} deps.profileBin  the active profile's own executable (what the terminal runs)
   * @param {() => boolean} [deps.customCommand]  the active profile names its own command (a wrapper, a pinned install)
   * @param {() => boolean} deps.enabled
   * @param {() => string} [deps.channel]  npm dist-tag to follow: "latest" (default) or "stable"
   * @param {Function} [deps.run]    (file, args, options) => { code, stdout, stderr }; injected by tests
   * @param {Function} [deps.sleep]
   * @param {Function} [deps.exists]
   * @param {object} [deps.processes]  other running Claude Code processes: { busy(), binsInUse() }
   * @param {object} [deps.npmCommand]  { file, args, shell } (see npmCommand())
   * @param {Function} [deps.locked]   (bin) => Promise<boolean>: the executable is still in use
   * @param {Function} [deps.size]     (path) => Promise<number>: size of a file (0 when missing)
   * @param {number} [deps.minBinaryBytes]  a Claude Code binary smaller than this is a stub, not a working install
   * @param {number} [deps.progressMs]  how often the size of the staging folder is looked at
   */
  constructor({ config, manager, catalog, profileBin, customCommand = () => false, enabled = () => true, channel = () => "latest", run = defaultRun, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()), exists = existsSync, processes = claudeProcesses, npmCommand: npmCmd = npmCommand(), locked: isLocked = locked, size = fileSize, minBinaryBytes = MIN_BINARY_BYTES, progressMs = PROGRESS_MS }) {
    super();
    Object.assign(this, { config, manager, catalog, profileBin, customCommand, isEnabled: enabled, channel, run, sleep, exists, processes, npmCmd, locked: isLocked, size, minBinaryBytes, progressMs });
    this.state = { installed: null, active: null, latest: null, phase: "idle", checkedAt: 0, updatedAt: 0, updatedFrom: null, updatedTo: null, error: null, failure: null, target: null, progress: null, failedVersion: null, failedAt: 0 };
    this.job = null;
    this.timers = [];
  }

  get root() {
    return join(this.config.dataDir, "claude-code");
  }

  start() {
    const first = setTimeout(() => this.tick().catch(() => {}), FIRST_CHECK_MS);
    const every = setInterval(() => this.tick().catch(() => {}), CHECK_EVERY_MS);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  stop() {
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    this.timers = [];
  }

  status() {
    const own = this.profileBin();
    const install = installOf(own);
    const current = [this.state.active, this.state.installed].filter(Boolean).sort(compareVersions).at(-1);
    return {
      enabled: Boolean(this.isEnabled()),
      supported: Boolean(own),
      install: install?.kind || null,
      channel: this.channel(),
      ...this.state,
      busy: Boolean(this.job),
      usingOwnCopy: Boolean(this.config.claudeBin && own && this.config.claudeBin !== own),
      updateAvailable: newer(this.state.latest, current),
    };
  }

  async version(bin) {
    if (!bin) return null;
    const result = await this.run(bin, ["--version"], { timeoutMs: 30_000, env: process.env });
    return result.code === 0 ? /\d+\.\d+\.\d+/.exec(result.stdout)?.[0] || null : null;
  }

  /**
   * Version of the executable at `bin`, but only when it is a real binary that runs. npm exits 0 and leaves a stub of a
   * few hundred bytes (which cannot run) when the platform package was not downloaded, so size counts as well.
   */
  async healthy(bin) {
    if (!bin || (await this.size(bin)) < this.minBinaryBytes) return null;
    return this.version(bin);
  }

  /** Remember a failed attempt; returns the Error to throw. `kind` lets the page word it in the user's language. */
  failure(kind, version, kept, reason) {
    Object.assign(this.state, { failedVersion: version, failedAt: Date.now(), failure: { kind, version, kept: kept || null, reason } });
    return new Error(`Could not install ${version}: ${reason}${kept ? `; kept ${kept}` : ""}`);
  }

  async readLatest() {
    const tag = /^[a-z]+$/.test(this.channel()) ? this.channel() : "latest";
    const result = await this.npm(["view", `${PACKAGE}@${tag}`, "version"], { timeoutMs: 60_000 });
    const version = result.stdout.trim().split(/\s+/).at(-1);
    return result.code === 0 && VERSION.test(version || "") ? version : null;
  }

  npm(args, { timeoutMs } = {}) {
    const { file, args: head, shell } = this.npmCmd;
    if (!shell) return this.run(file, [...head, ...args], { timeoutMs, env: process.env, shell: false });
    // Through cmd.exe: every argument is a fixed word, a validated version or a path, quoted and checked for what cmd
    // would expand even inside quotes.
    if (!args.every((arg) => SHELL_SAFE.test(arg))) return Promise.resolve({ code: 1, stdout: "", stderr: "A path contains characters that cannot be passed to npm safely." });
    return this.run(file, [...head, ...args.map((arg) => `"${arg}"`)], { timeoutMs, env: process.env, shell: true });
  }

  /**
   * Our own copy only stands in for an npm install that the profile finds by itself: not for a wrapper or a pinned
   * command, and not for a native install (which updates itself).
   */
  copyAllowed() {
    return installOf(this.profileBin())?.kind === "npm" && !this.customCommand();
  }

  /** Versions of the profile's install, of what new processes run, and of the newest release. Never throws. */
  async check() {
    const own = this.profileBin();
    if (!own) { this.state.error = "No Claude Code executable"; return this.status(); }
    const [installed, active, latest] = await Promise.all([this.version(own), this.config.claudeBin && this.config.claudeBin !== own ? this.version(this.config.claudeBin) : null, this.readLatest()]);
    this.state.checkedAt = Date.now();
    if (installed) this.state.installed = installed;
    this.state.active = active || installed || this.state.active;
    if (latest) this.state.latest = latest;
    this.state.error = !installed ? "Could not run claude --version" : !latest ? "Could not reach the npm registry" : null;
    return this.status();
  }

  /** Start using our own copy of `version` (already installed and verified) for new processes and the model list. */
  activate(version, bin, from) {
    if (this.config.claudeBin === bin) return;
    this.config.claudeBin = bin;
    this.config.claudeExecutable = { path: bin, source: "update" };
    Object.assign(this.state, { active: version, updatedAt: Date.now(), updatedFrom: from, updatedTo: version });
    this.catalog?.invalidate();
    this.emit("updated", { from, to: version });
  }

  /** At start: use the newest copy that is already installed (and newer than the profile's), without asking the network. */
  async useInstalled() {
    await this.recover().catch(() => {});
    const own = this.profileBin();
    const installed = await this.version(own);
    if (installed) this.state.installed = installed;
    if (!this.copyAllowed()) { this.state.active = installed; await this.prune(); return null; }
    const names = await readdir(this.root).catch(() => []); // none yet
    const best = names.filter((name) => VERSION.test(name)).sort(compareVersions).reverse();
    for (const version of best) {
      if (!newer(version, installed)) break;
      const bin = binIn(join(this.root, version));
      if (this.exists(bin) && (await this.healthy(bin)) === version) {
        this.activate(version, bin, installed);
        await this.prune();
        return version;
      }
    }
    this.state.active = installed;
    await this.prune(); // also takes away copies that turned out to be stubs
    return null;
  }

  /**
   * At start: a swap that was interrupted (or could not put things back) leaves the old package next to the live one.
   * When the live one does not run, the backup is renamed back; when it runs, the backup and any staging folder go.
   */
  async recover() {
    const own = this.profileBin();
    const install = installOf(own);
    if (install?.kind !== "npm" || this.job) return;
    const backup = join(dirname(install.pkgDir), BACKUP_DIR);
    if (await isDir(backup)) {
      if (await this.healthy(own)) await rm(backup, { recursive: true, force: true }).catch(() => {});
      else {
        await rm(install.pkgDir, { recursive: true, force: true }).catch(() => {});
        await this.move(backup, install.pkgDir);
      }
    }
    await rm(this.stageDir(install), { recursive: true, force: true }).catch(() => {});
  }

  /** Check, install our own copy, then (when quiet) the profile's install. One run at a time; `force` runs with the switch off. */
  tick({ force = false, now = false } = {}) {
    if (now) this.urgent = true; // also ends the wait of a run that is already waiting for a quiet moment
    if (this.job) return this.job;
    if (!force && !this.isEnabled()) return Promise.resolve(this.status());
    this.job = this.update({ force })
      .catch((error) => { this.state.error = error.message; })
      .finally(() => { this.job = null; this.urgent = false; Object.assign(this.state, { phase: "idle", target: null, progress: null }); });
    return this.job;
  }

  async update({ force }) {
    this.state.phase = "checking";
    Object.assign(this.state, { failure: null, progress: null });
    await this.check();
    const { installed, latest } = this.state;
    if (!installed || !latest) return this.status();
    if (!force && this.state.failedVersion === latest && Date.now() - this.state.failedAt < RETRY_AFTER_FAILURE_MS) return this.status();
    this.state.target = latest;

    // Step 1: our own copy, used at once.
    if (newer(latest, this.state.active) && this.copyAllowed()) {
      this.state.phase = "downloading";
      const bin = await this.installCopy(latest);
      this.activate(latest, bin, this.state.active);
      await this.prune(); // older copies nobody runs any more
    }

    // Step 2: the profile's install. A native install updates itself (`claude update`), only an npm one is done here.
    const own = this.profileBin();
    const install = installOf(own);
    if (!newer(latest, installed) || install?.kind !== "npm") return this.status();
    if (this.npmCmd.shell && !SHELL_SAFE.test(install.prefix)) return this.status();
    // Installed and checked next to the real one while everything keeps running; the real one is not touched until it works.
    this.state.phase = "downloading";
    await this.stage(install, own, installed, latest);
    this.state.phase = "waiting";
    while (!this.urgent && !this.idle()) {
      if (!force && !this.isEnabled()) { await this.discardStage(install); return this.status(); }
      await this.sleep(IDLE_POLL_MS);
    }
    this.urgent = false;
    this.state.phase = "installing";
    await this.swap(install, own, installed, latest);
    return this.status();
  }

  /** Why an install did not produce a working binary, in one line. */
  reasonOf(result, size) {
    if (result.code !== 0) return lastLine(result.stderr) || "npm failed";
    if (size < this.minBinaryBytes) return "the native binary is missing (the platform package could not be downloaded)";
    return "it does not run";
  }

  /** Install `version` into <dataDir>/claude-code/<version> (also fills npm's cache) and check that it runs. */
  async installCopy(version) {
    const dir = join(this.root, version);
    const bin = binIn(dir);
    if ((await this.healthy(bin)) === version) return bin;
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const result = await this.npm(["install", "--prefix", dir, `${PACKAGE}@${version}`, "--prefer-offline", "--no-audit", "--no-fund", "--loglevel=error"], { timeoutMs: STAGE_TIMEOUT_MS });
    if (result.code !== 0 || (await this.healthy(bin)) !== version) {
      const reason = this.reasonOf(result, await this.size(bin));
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw this.failure("download", version, this.state.active, reason);
    }
    return bin;
  }

  stageDir(install) {
    return join(install.prefix, STAGE_DIR);
  }

  /** Where the staged package sits: the same place relative to the staging prefix as the live one to the real prefix. */
  stagedPkg(install) {
    return join(this.stageDir(install), relative(install.prefix, install.pkgDir));
  }

  discardStage(install) {
    return rm(this.stageDir(install), { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Install `version` into a staging prefix next to the profile's and check it there. Throws, with the profile's install
   * untouched, when the result is not a working binary. Reports how much of the package is on disk while it runs.
   */
  async stage(install, own, from, version) {
    const dir = this.stageDir(install);
    const bin = join(this.stagedPkg(install), "bin", "claude.exe");
    await this.discardStage(install);
    await mkdir(dir, { recursive: true });
    const live = await this.size(own);
    const total = live >= this.minBinaryBytes ? live : EXPECTED_BINARY_BYTES;
    this.state.progress = { bytes: 0, total, percent: 0 };
    let looking = false;
    const timer = setInterval(async () => {
      if (looking) return;
      looking = true;
      const bytes = await dirBytes(dir);
      looking = false;
      if (this.state.progress) this.state.progress = { bytes, total, percent: Math.min(99, Math.round((bytes / total) * 100)) };
    }, this.progressMs);
    timer.unref?.();
    let result;
    try {
      result = await this.npm(["install", "-g", "--prefix", dir, `${PACKAGE}@${version}`, "--prefer-offline", "--no-audit", "--no-fund", "--loglevel=error"], { timeoutMs: STAGE_TIMEOUT_MS });
    } finally {
      clearInterval(timer);
    }
    const size = await this.size(bin);
    if (result.code !== 0 || (await this.healthy(bin)) !== version) {
      await this.discardStage(install);
      this.state.progress = null;
      throw this.failure("download", version, from, this.reasonOf(result, size));
    }
    this.state.progress = { bytes: total, total, percent: 100 };
  }

  /** True when nothing is working, waiting for an answer, running background work or was active a moment ago. */
  idle(now = Date.now()) {
    if (this.catalog?.inflight?.size || this.processes.busy()) return false;
    for (const session of this.manager.sessions.values()) {
      if (!session.alive) continue;
      if (["running", "starting"].includes(session.state) || session.pending?.size || session.backgroundTasks) return false;
      if (now - (session.lastActive || 0) < IDLE_MS) return false;
    }
    return true;
  }

  /** Rename with a few retries: on Windows a folder cannot move while a process still has a file in it open. */
  async move(from, to) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(from, to);
        return;
      } catch (error) {
        if (attempt >= 5 || !["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(error.code)) throw error;
        await this.sleep(400);
      }
    }
  }

  /**
   * Put the staged package in place of the live one. The live one is renamed to a backup first and only deleted once the
   * new one has been checked in its final place; on any failure the backup is renamed back, without the network.
   */
  async swap(install, own, from, to) {
    const { pkgDir } = install;
    const backup = join(dirname(pkgDir), BACKUP_DIR);
    let release;
    this.manager.hold?.(new Promise((resolve) => { release = resolve; })); // sessions and catalog loads wait while the files change
    try {
      // Only processes that run the profile's executable hold its files; ours (the copy) can keep running. With "now" this
      // also stops sessions that are working on the old version: they continue on the next message.
      const exits = [];
      for (const session of this.manager.sessions.values()) if (session.alive && (!session.bin || session.bin === own)) exits.push(session.close());
      await this.released(exits, own);
      await rm(backup, { recursive: true, force: true });
      try {
        await this.move(pkgDir, backup);
      } catch (error) {
        await this.discardStage(install);
        throw this.failure("locked", to, from, `the installed files are in use (${error.code || error.message})`);
      }
      let ok = false;
      try {
        await this.move(this.stagedPkg(install), pkgDir);
        ok = (await this.healthy(own)) === to;
      } catch { /* put back below */ }
      if (ok) {
        await rm(backup, { recursive: true, force: true }).catch(() => {}); // else the next start removes it
        await this.discardStage(install);
        this.finished(own, from, to);
        await this.prune();
        return;
      }
      await rm(pkgDir, { recursive: true, force: true }).catch(() => {});
      try {
        await this.move(backup, pkgDir);
      } catch (error) {
        throw this.failure("restore", to, null, `the old files could not be put back (${error.code || error.message}); they are in ${backup}`);
      }
      await this.discardStage(install);
      throw this.failure("incomplete", to, from, "the new version did not run once it was in place");
    } finally {
      release?.();
    }
  }

  /** The profile's own executable now runs `to`: use it again, and let the page know. */
  finished(own, from, to) {
    this.state.installed = to;
    this.state.active = to;
    this.state.error = null;
    this.state.failure = null;
    if (this.config.claudeBin !== own) {
      this.config.claudeBin = own;
      this.config.claudeExecutable = { path: own, source: "path" };
    }
    this.catalog?.invalidate(); // the model list comes from the executable that was replaced
    if (this.state.updatedTo !== to) {
      Object.assign(this.state, { updatedAt: Date.now(), updatedFrom: from, updatedTo: to });
      this.emit("updated", { from, to });
    }
  }

  /** Wait (at most EXIT_WAIT_MS) until the stopped processes are gone and nothing holds the executable any more. */
  async released(exits, bin) {
    const deadline = Date.now() + EXIT_WAIT_MS;
    await Promise.race([Promise.all(exits), this.sleep(EXIT_WAIT_MS)]);
    while (Date.now() < deadline && (await this.locked(bin))) await this.sleep(250);
  }

  /** Remove our copies that nothing uses: not the active one, not one a session or another Claude process runs. */
  async prune() {
    if (this.catalog?.inflight?.size) return; // a model-list process may run any copy; next time
    const names = await readdir(this.root).catch(() => []);
    const inUse = this.processes.binsInUse();
    for (const name of names) {
      if (!VERSION.test(name)) continue;
      const bin = binIn(join(this.root, name));
      const used = inUse.has(bin) || [...this.manager.sessions.values()].some((session) => session.alive && session.bin === bin);
      if (!used && this.config.claudeBin !== bin) await rm(join(this.root, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}
