// Real pseudo-terminal for the Terminal inspector tab ("PTY mode"). Optional: needs the `node-pty` package
// (an optionalDependency, loaded lazily). Without it `GET /api/pty/info` says so and the UI keeps using the
// line-based runner in workspace.mjs.
//
// Transport (no WebSocket library in this project): output is Server-Sent Events with base64 chunks and a sequence
// number (resume with ?after=), input / resize / close are plain same-origin JSON requests. The /api same-origin guard
// of server/index.mjs applies to all of them. A PTY is full shell access with the user's privileges, exactly like the
// existing terminal; the same cwd rule applies (must be an existing directory).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

export const MAX_PTYS = 6;
export const SCROLLBACK_BYTES = 256 * 1024;
export const MAX_INPUT_CHARS = 64 * 1024;
export const IDLE_MS = 2 * 60 * 60 * 1000; // no attached viewer and no input for this long: shell is closed
export const EXITED_KEEP_MS = 10 * 60 * 1000; // an exited terminal stays readable this long, then it is dropped
const FLUSH_MS = 8;
const FLUSH_BYTES = 32 * 1024;
const ID_RE = /^pty-[0-9a-f]{18}$/;

// ---- scrollback ring buffer -----------------------------------------------------------
/** Bounded list of { seq, event, data, size }; oldest entries are dropped once `limit` bytes are exceeded. */
export class RingBuffer {
  constructor(limit = SCROLLBACK_BYTES) {
    this.limit = limit;
    this.entries = [];
    this.bytes = 0;
    this.seq = 0;
  }

  push(event, data, size = 0) {
    const entry = { seq: ++this.seq, event, data, size };
    this.entries.push(entry);
    this.bytes += size;
    while (this.bytes > this.limit && this.entries.length > 1) this.bytes -= this.entries.shift().size;
    return entry;
  }

  /** Entries with seq greater than `after`. */
  after(after = 0) {
    return this.entries.filter((entry) => entry.seq > after);
  }

  get oldest() {
    return this.entries.length ? this.entries[0].seq : this.seq + 1;
  }
}

// ---- shells (allow-list; the client only ever sends an id) ----------------------------
export const SHELL_IDS = ["default", "powershell", "pwsh", "bash", "cmd"];
const LABELS = { powershell: "PowerShell", pwsh: "PowerShell 7", bash: "Bash", cmd: "Command Prompt" };

function findOnPath(names, env, exists, platform) {
  const dirs = String(env.PATH || env.Path || "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  for (const dir of dirs) for (const name of names) {
    const full = join(dir, name);
    if (exists(full)) return full;
  }
  return null;
}

/** Git for Windows' bash (never the WSL launcher in System32): next to the git install that is on PATH, or in Program Files. */
function findGitBash(env, exists) {
  const git = findOnPath(["git.exe"], env, exists, "win32");
  const roots = [];
  if (git) roots.push(dirname(dirname(git)), dirname(dirname(dirname(git))));
  for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")]) if (base) roots.push(join(base, "Git"));
  for (const root of roots) for (const rel of ["bin/bash.exe", "usr/bin/bash.exe"]) {
    const full = join(root, rel);
    if (exists(full)) return full;
  }
  return null;
}

/**
 * Resolve a shell id to { id, file, args, label } or null when it is not available on this machine.
 * `defaultShell` (from the configuration, optional) must itself be an allow-list id.
 */
export function resolveShell(id, { platform = process.platform, env = process.env, exists = existsSync, defaultShell = "" } = {}) {
  if (typeof id !== "string" || !SHELL_IDS.includes(id)) return null;
  if (id === "default") {
    const wanted = SHELL_IDS.includes(defaultShell) && defaultShell !== "default" ? defaultShell : platform === "win32" ? "powershell" : "bash";
    return resolveShell(wanted, { platform, env, exists }) || resolveShell(platform === "win32" ? "powershell" : "bash", { platform, env, exists }) || (platform === "win32" ? null : { id: "default", file: "/bin/sh", args: [], label: "sh" });
  }
  if (platform === "win32") {
    if (id === "powershell") return { id, file: findOnPath(["powershell.exe"], env, exists, platform) || "powershell.exe", args: ["-NoLogo"], label: LABELS[id] };
    if (id === "pwsh") { const file = findOnPath(["pwsh.exe"], env, exists, platform); return file ? { id, file, args: ["-NoLogo"], label: LABELS[id] } : null; }
    if (id === "bash") { const file = findGitBash(env, exists); return file ? { id, file, args: ["--login", "-i"], label: LABELS[id] } : null; }
    return { id: "cmd", file: env.ComSpec && exists(env.ComSpec) ? env.ComSpec : "cmd.exe", args: [], label: LABELS.cmd };
  }
  if (id === "cmd" || id === "powershell") return null;
  if (id === "pwsh") { const file = findOnPath(["pwsh"], env, exists, platform); return file ? { id, file, args: ["-NoLogo"], label: LABELS[id] } : null; }
  const file = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"].find((candidate) => exists(candidate)) || findOnPath(["bash"], env, exists, platform);
  return file ? { id: "bash", file, args: ["-i"], label: LABELS.bash } : null;
}

// ---- input validation -----------------------------------------------------------------
const dimension = (value, fallback, min, max, name) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw Object.assign(new Error(`${name} must be an integer between ${min} and ${max}`), { status: 400 });
  return value;
};
export const validateSize = (body = {}, fallback = { cols: 80, rows: 24 }) => ({
  cols: dimension(body.cols, fallback.cols, 2, 500, "cols"),
  rows: dimension(body.rows, fallback.rows, 1, 300, "rows"),
});
export function validateInput(data) {
  if (typeof data !== "string" || data.length === 0) throw Object.assign(new Error("data must be a non-empty string"), { status: 400 });
  if (data.length > MAX_INPUT_CHARS) throw Object.assign(new Error("input too large"), { status: 413 });
  return data;
}

// ---- process tree ---------------------------------------------------------------------
function killTree(entry, platform = process.platform) {
  const pid = entry.proc?.pid;
  if (pid) {
    if (platform === "win32") {
      try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 }); } catch { /* gone */ }
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { /* not a group leader or gone */ }
    }
  }
  // Closes the pseudo console itself. node-pty's kill can throw on a process that is already gone.
  if (!entry.exited) { try { entry.proc.kill(); } catch { /* ignore */ } }
}

// ---- service --------------------------------------------------------------------------
async function realDir(cwd, HttpError) {
  if (!cwd || typeof cwd !== "string") throw new HttpError(400, "cwd is required");
  const full = resolve(cwd);
  let info;
  try { info = await stat(full); } catch { throw new HttpError(400, `not a directory: ${cwd}`); }
  if (!info.isDirectory()) throw new HttpError(400, `not a directory: ${cwd}`);
  return realpath(full);
}

const defaultLoad = async () => {
  const mod = await import("node-pty");
  const api = mod.default && typeof mod.default.spawn === "function" ? mod.default : mod;
  if (typeof api.spawn !== "function") throw new Error("node-pty has no spawn()");
  return api;
};

/**
 * Everything except route wiring, so tests can drive it with a fake `loadPty`.
 * `env()` must return the environment of the active profile (process.env: the profile is applied to the server process).
 */
export function createPtyService({ HttpError, loadPty = defaultLoad, env = () => process.env, platform = process.platform, exists = existsSync, defaultShell = () => "", max = MAX_PTYS, scrollback = SCROLLBACK_BYTES, now = Date.now } = {}) {
  const ptys = new Map();
  let loading = null;
  const load = () => (loading ||= loadPty().then((api) => ({ api }), (error) => ({ error: String(error?.message || error).split("\n")[0] })));

  const shellOptions = () => SHELL_IDS.filter((id) => id !== "default").map((id) => resolveShell(id, { platform, env: env(), exists })).filter(Boolean);

  function sse(res, entry) {
    res.write(`id: ${entry.seq}\nevent: ${entry.event}\ndata: ${entry.data}\n\n`);
  }

  function emit(entry, event, data, size = 64) {
    const item = entry.ring.push(event, JSON.stringify(data), size);
    for (const res of entry.clients) sse(res, item);
  }

  function flush(entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
    if (!entry.pending) return;
    const text = entry.pending;
    entry.pending = "";
    const buffer = Buffer.from(text, "utf8");
    emit(entry, "data", { d: buffer.toString("base64") }, buffer.length);
  }

  function lookup(id) {
    const entry = ID_RE.test(String(id)) ? ptys.get(id) : null;
    if (!entry) throw new HttpError(404, "terminal not found");
    return entry;
  }

  const view = (entry) => ({ id: entry.id, running: !entry.exited, exit: entry.exit, cwd: entry.cwd, shell: entry.shell.id, label: entry.shell.label, cols: entry.cols, rows: entry.rows, seq: entry.ring.seq, oldest: entry.ring.oldest });

  function dispose(entry) {
    clearTimeout(entry.timer);
    ptys.delete(entry.id);
    for (const res of entry.clients) { try { res.end(); } catch { /* closed */ } }
    entry.clients.clear();
  }

  return {
    ptys,

    async info() {
      const loaded = await load();
      if (loaded.error) return { available: false, reason: loaded.error, shells: [], max };
      const shells = shellOptions();
      return { available: shells.length > 0, reason: shells.length ? "" : "no shell found", shells: shells.map(({ id, label }) => ({ id, label })), defaultShell: resolveShell("default", { platform, env: env(), exists, defaultShell: defaultShell() })?.id || null, max, count: [...ptys.values()].filter((p) => !p.exited).length };
    },

    async open(body = {}) {
      const loaded = await load();
      if (loaded.error) throw new HttpError(501, `PTY is not available: ${loaded.error}`);
      const shell = resolveShell(body.shell === undefined || body.shell === "" ? "default" : body.shell, { platform, env: env(), exists, defaultShell: defaultShell() });
      if (!shell) throw new HttpError(400, "shell is not allowed or not installed");
      let size;
      try { size = validateSize(body); } catch (error) { throw new HttpError(400, error.message); }
      const cwd = await realDir(body.cwd, HttpError);
      if ([...ptys.values()].filter((p) => !p.exited).length >= max) throw new HttpError(429, `too many terminals (max ${max}); close one first`);
      const environment = {};
      for (const [key, value] of Object.entries(env())) if (value !== undefined) environment[key] = String(value);
      Object.assign(environment, { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "wheelhouse" });
      let proc;
      try {
        proc = loaded.api.spawn(shell.file, shell.args, { name: "xterm-256color", cols: size.cols, rows: size.rows, cwd, env: environment });
      } catch (error) {
        throw new HttpError(500, `could not start ${shell.label}: ${String(error?.message || error).split("\n")[0]}`);
      }
      const id = `pty-${randomBytes(9).toString("hex")}`;
      const entry = { id, proc, shell, cwd, cols: size.cols, rows: size.rows, ring: new RingBuffer(scrollback), clients: new Set(), pending: "", timer: null, exited: false, exit: null, lastActive: now(), exitedAt: 0 };
      ptys.set(id, entry);
      proc.onData((text) => {
        entry.pending += text;
        if (entry.pending.length >= FLUSH_BYTES) flush(entry);
        else if (!entry.timer) entry.timer = setTimeout(() => flush(entry), FLUSH_MS);
      });
      proc.onExit(({ exitCode, signal }) => {
        flush(entry);
        entry.exited = true;
        entry.exitedAt = now();
        entry.exit = { code: exitCode ?? null, signal: signal || null };
        emit(entry, "exit", entry.exit);
      });
      return view(entry);
    },

    state: (id) => view(lookup(id)),

    stream(req, res, id, after = 0) {
      const entry = lookup(id);
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      // An EventSource reconnect keeps the original ?after= but sends Last-Event-ID: resume from the later one.
      const from = Math.max(Number(after) || 0, Number(req.headers["last-event-id"]) || 0);
      res.write(`event: hello\ndata: ${JSON.stringify(view(entry))}\n\n`);
      for (const item of entry.ring.after(from > entry.ring.seq ? 0 : from)) sse(res, item);
      entry.clients.add(res);
      entry.lastActive = now();
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      ping.unref?.();
      req.on("close", () => {
        clearInterval(ping);
        entry.clients.delete(res);
        entry.lastActive = now();
      });
    },

    input(id, data) {
      const entry = lookup(id);
      const text = validateInput(data);
      if (entry.exited) throw new HttpError(409, "the terminal has exited");
      entry.lastActive = now();
      entry.proc.write(text);
      return { ok: true };
    },

    resize(id, body) {
      const entry = lookup(id);
      if (!body || body.cols === undefined || body.rows === undefined) throw new HttpError(400, "cols and rows are required");
      let size;
      try { size = validateSize(body); } catch (error) { throw new HttpError(400, error.message); }
      entry.lastActive = now();
      if (!entry.exited) {
        try { entry.proc.resize(size.cols, size.rows); } catch { /* process just exited */ }
        entry.cols = size.cols;
        entry.rows = size.rows;
      }
      return { ok: true };
    },

    close(id) {
      const entry = ptys.get(String(id));
      if (entry) {
        killTree(entry, platform);
        dispose(entry);
      }
      return { ok: true };
    },

    /** Drop terminals nobody has looked at for IDLE_MS, and exited ones nobody reads any more. */
    sweep(time = now()) {
      for (const entry of [...ptys.values()]) {
        if (entry.clients.size) continue;
        if (entry.exited ? time - entry.exitedAt > EXITED_KEEP_MS : time - entry.lastActive > IDLE_MS) {
          killTree(entry, platform);
          dispose(entry);
        }
      }
    },

    closeAll() {
      for (const entry of [...ptys.values()]) { killTree(entry, platform); dispose(entry); }
    },
  };
}

export default function register({ route, HttpError, config }) {
  const service = createPtyService({ HttpError, defaultShell: () => config?.terminalShell || "" });
  const timer = setInterval(() => service.sweep(), 60_000);
  timer.unref();
  process.on("exit", () => service.closeAll());

  route("GET", "/api/pty/info", async () => service.info());
  route("POST", "/api/pty/open", async ({ body }) => service.open(body));
  route("GET", "/api/pty/([^/]+)/state", async ({ params }) => service.state(params[0]));
  route("GET", "/api/pty/([^/]+)/stream", async ({ req, res, params, query }) => { service.stream(req, res, params[0], query.get("after")); });
  route("POST", "/api/pty/([^/]+)/input", async ({ params, body }) => service.input(params[0], body.data));
  route("POST", "/api/pty/([^/]+)/resize", async ({ params, body }) => service.resize(params[0], body));
  route("DELETE", "/api/pty/([^/]+)", async ({ params }) => service.close(params[0]));
}
