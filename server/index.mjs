// Wheelhouse server: HTTP + SSE front for SDK-backed Claude Code sessions.
// Bound to loopback only. No request to the model API is made here: everything goes through the real
// Claude Code executable of the active profile (see docs/CONFIGURATION.md), exactly as the CLI would run it.
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { stat, readdir, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve, relative, isAbsolute, sep, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import {
  listSessions,
  getSessionMessages,
  renameSession,
  tagSession,
  deleteSession,
  forkSession,
  getSessionInfo,
  getSubagentMessages,
  listSubagents,
} from "@anthropic-ai/claude-agent-sdk";
import { SessionManager } from "./lib/session-manager.mjs";
import { Catalog } from "./lib/catalog.mjs";
import { UiStore } from "./lib/ui-store.mjs";
import { applyProfile, loadConfig, profileSummary, testProfile } from "./lib/config.mjs";
import * as fsgit from "./lib/fs-git.mjs";
import * as cfiles from "./lib/claude-files.mjs";
import { openUi } from "./lib/ui-launch.mjs";
import { startTray } from "./lib/tray.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "..", "web");
const PACKAGE = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const config = loadConfig();
const PORT = config.port;
const HOST = config.host;

if (config.help) {
  console.log(`Wheelhouse ${PACKAGE.version} - a graphical front end for Claude Code

Usage: wheelhouse [options]
  --port <n>        port to listen on (default 4173, loopback only)
  --config <file>   configuration file (default: ./wheelhouse.config.json or ~/.wheelhouse/config.json)
  --cwd <dir>       default working directory
  --data-dir <dir>  where Wheelhouse keeps its own state (default ~/.wheelhouse)
  --open            open the UI in your browser
  --app             open the UI in a standalone app-style window (Chrome/Edge)
  --tray            keep a system tray icon with open/quit menu and global shortcuts (Windows)
  --version, --help

Docs: ${PACKAGE.homepage}`);
  process.exit(0);
}
if (config.version) {
  console.log(PACKAGE.version);
  process.exit(0);
}

const store = await new UiStore(join(config.dataDir, "ui-state.json")).load();
const savedProfile = store.data.prefs.activeProfile;
applyProfile(config, config.profiles[savedProfile] ? savedProfile : config.defaultProfile);
const manager = new SessionManager(config);
const catalog = new Catalog(config, manager);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const CSP = "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'";

// ---- helpers -----------------------------------------------------------------------
function json(res, status, body) {
  if (res.headersSent) return; // route already took over the response (SSE streams)
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req, limit = 40 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function isLocalHost(hostHeader = "") {
  const host = hostHeader.split(":")[0].replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function sameOrigin(req) {
  if (!isLocalHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (!origin) return req.method === "GET" || req.method === "HEAD";
  try {
    const url = new URL(origin);
    return isLocalHost(url.host) && String(url.port || 80) === String(PORT);
  } catch {
    return false;
  }
}

function session(id, { create = false, cwd } = {}) {
  let found = manager.get(id);
  if (!found && create) {
    found = manager.open({ id, cwd: cwd || config.defaultCwd, persisted: true, meta: store.sessionMeta(id) });
  }
  if (!found) throw new HttpError(404, "session not found");
  return found;
}

function runClaudeCli(args, { cwd, timeout = 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    execFile(config.claudeBin || "claude", args, { cwd: cwd || config.defaultCwd, env: { ...process.env }, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

const CLI_ALLOW = {
  mcp: new Set(["list", "get", "add", "add-json", "remove", "reset-project-choices", "enable", "disable", "login", "logout"]),
  plugin: new Set(["list", "install", "uninstall", "enable", "disable", "update", "marketplace", "validate", "details"]),
  plugins: new Set(["list", "install", "uninstall", "enable", "disable", "update", "marketplace", "validate", "details"]),
  auth: new Set(["status"]),
  doctor: new Set([]),
};

function validateCliArgs(args) {
  if (!Array.isArray(args) || !args.length || args.some((item) => typeof item !== "string" || item.includes("\0"))) {
    throw new HttpError(400, "args must be a non-empty string array");
  }
  const [command, sub] = args;
  const allowed = CLI_ALLOW[command];
  if (!allowed) throw new HttpError(403, `claude ${command} is not allowed here`);
  if (allowed.size && !allowed.has(sub)) throw new HttpError(403, `claude ${command} ${sub} is not allowed here`);
}

function normalizeSessionInfo(info) {
  const meta = store.sessionMeta(info.sessionId);
  const live = manager.get(info.sessionId);
  return {
    id: info.sessionId,
    title: info.customTitle || meta.title || info.summary || info.firstPrompt || "",
    summary: info.summary,
    firstPrompt: info.firstPrompt,
    cwd: info.cwd,
    gitBranch: info.gitBranch,
    tag: info.tag,
    lastModified: info.lastModified,
    createdAt: info.createdAt,
    fileSize: info.fileSize,
    pinned: store.data.pins.includes(info.sessionId),
    archived: store.data.archived.includes(info.sessionId),
    state: live?.state || "closed",
    pending: live ? live.pending.size : 0,
  };
}

// ---- API routes --------------------------------------------------------------------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });

route("GET", "/api/health", async () => ({ ok: true, port: PORT, version: 1 }));

// Lightweight live status for the tray icon: how many sessions are running or waiting for the user.
route("GET", "/api/status", async () => {
  let live = 0, running = 0, waiting = 0;
  for (const current of manager.sessions.values()) {
    if (!current.alive) continue;
    live += 1;
    if (current.state === "running") running += 1;
    if (current.pending.size) waiting += 1;
  }
  return { ok: true, version: PACKAGE.version, live, running, waiting };
});

// Stops the server (and every Claude Code process it started). Same-origin POST only, like every API call.
route("POST", "/api/shutdown", async () => {
  setTimeout(shutdown, 100).unref(); // after the response is out; SIGTERM handlers are not delivered on Windows
  return { ok: true };
});

/** Where "new folder" sessions live (like Claude Desktop's default location); overridable in Settings. */
let documentsDir;
function documentsFolder() {
  if (documentsDir) return documentsDir;
  documentsDir = join(homedir(), "Documents");
  if (process.platform === "win32") {
    try {
      // Honours redirected/OneDrive Documents folders.
      const real = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('MyDocuments')"], { encoding: "utf8", timeout: 8000, windowsHide: true }).trim();
      if (real) documentsDir = real;
    } catch { /* keep the default */ }
  }
  return documentsDir;
}

function workspaceRoot() {
  return resolve(store.data.prefs.workspaceRoot || config.workspaceRoot || join(documentsFolder(), "Claude"));
}

const pad = (n) => String(n).padStart(2, "0");
async function createScratchFolder() {
  const now = new Date();
  const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const root = workspaceRoot();
  await mkdir(root, { recursive: true });
  for (let i = 0; i < 100; i += 1) {
    const path = join(root, i ? `${base} (${i + 1})` : base);
    try {
      await mkdir(path);
      return path;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not create a session folder");
}

/** A session started with "new folder" gets its folder the moment it is first used (no empty folders left behind). */
async function materializeScratch(target) {
  if (!target.meta.scratch || target.alive || target.persisted) return;
  target.cwd = await createScratchFolder();
  delete target.meta.scratch;
  target.meta.scratchFolder = target.cwd;
  store.touchProject(target.cwd);
  manager.emit("session.state", target.summary());
}

route("POST", "/api/workspaces/new", async () => ({ path: await createScratchFolder() }));

// Native "choose folder" dialog (Windows, macOS, Linux with zenity/kdialog). Resolves with the chosen path or null.
const execText = (file, args, options = {}) => new Promise((resolvePromise, reject) => {
  execFile(file, args, { timeout: 5 * 60_000, windowsHide: true, encoding: "utf8", ...options }, (error, stdout) => {
    if (error && error.code !== 1) return reject(error); // exit code 1 = cancelled for zenity/kdialog
    resolvePromise(error ? "" : String(stdout).trim());
  });
});

async function nativeFolderDialog(start, title) {
  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "[System.Windows.Forms.Application]::EnableVisualStyles()",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.StartPosition = 'CenterScreen'; $owner.Show(); $owner.Activate()",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = $env:WHEELHOUSE_PICK_TITLE; $dialog.UseDescriptionForTitle = $true; $dialog.ShowNewFolderButton = $true",
      "if ($env:WHEELHOUSE_PICK_START -and (Test-Path -LiteralPath $env:WHEELHOUSE_PICK_START)) { $dialog.SelectedPath = $env:WHEELHOUSE_PICK_START }",
      "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Out.Write($dialog.SelectedPath) }",
      "$owner.Dispose()",
    ].join("; ");
    return execText("powershell.exe", ["-NoProfile", "-STA", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, WHEELHOUSE_PICK_START: start, WHEELHOUSE_PICK_TITLE: title },
    });
  }
  if (process.platform === "darwin") {
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(title)}${start ? ` default location (POSIX file ${JSON.stringify(start)})` : ""})`;
    return (await execText("osascript", ["-e", script])).replace(/\/$/, "");
  }
  for (const [bin, args] of [["zenity", ["--file-selection", "--directory", `--title=${title}`, ...(start ? [`--filename=${start}/`] : [])]], ["kdialog", ["--getexistingdirectory", start || homedir(), "--title", title]]]) {
    try {
      return await execText(bin, args);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new HttpError(501, "no native folder dialog available (install zenity or kdialog)");
}

route("POST", "/api/pick-folder", async ({ body }) => {
  const start = body.start ? resolve(String(body.start)) : "";
  try {
    return { path: (await nativeFolderDialog(start, String(body.title || "Choose a project folder"))) || null };
  } catch (error) {
    throw error instanceof HttpError ? error : new HttpError(500, "folder dialog failed");
  }
});

// ---- connection profiles (which Claude Code executable + environment to use) ----------
let profileStatus = { at: 0, value: null };
route("GET", "/api/profile", async () => profileSummary(config));
route("GET", "/api/profile/status", async ({ query }) => {
  if (query.get("force") !== "1" && profileStatus.value && Date.now() - profileStatus.at < 30_000) return profileStatus.value;
  profileStatus = { at: Date.now(), value: { profile: config.activeProfile, ...(await testProfile(config, config.activeProfile)) } };
  return profileStatus.value;
});
route("POST", "/api/profile/test", async ({ body }) => ({ profile: body.name, ...(await testProfile(config, body.name || config.activeProfile)) }));
route("POST", "/api/profile/switch", async ({ body }) => {
  if (!config.profiles[body.name]) throw new HttpError(404, "unknown profile");
  manager.closeSessions();
  applyProfile(config, body.name);
  catalog.invalidate();
  profileStatus = { at: 0, value: null };
  await store.setPrefs({ activeProfile: body.name });
  manager.emit("sessions.changed");
  return profileSummary(config);
});

route("GET", "/api/config", async () => ({
  version: PACKAGE.version,
  defaults: config.defaults,
  configFile: config.file,
  workspaceRoot: workspaceRoot(),
  defaultCwd: config.defaultCwd,
  claudeBin: config.claudeBin || "(bundled with the SDK)",
  cli: config.profiles[config.activeProfile].cli,
  profile: config.activeProfile,
  configDir: cfiles.configDir(),
  home: homedir(),
  platform: process.platform,
  prefs: store.data.prefs,
  recentProjects: store.data.recentProjects,
  proxy: { http: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY), noProxy: process.env.NO_PROXY || "" },
  gateway: /^https?:\/\/api\.anthropic\.com\/?$/.test(process.env.ANTHROPIC_BASE_URL || "") ? null : process.env.ANTHROPIC_BASE_URL || null,
}));

route("PUT", "/api/prefs", async ({ body }) => {
  await store.setPrefs(body || {});
  return store.data.prefs;
});

route("GET", "/api/catalog", async ({ query }) => catalog.get(query.get("cwd") || config.defaultCwd, { force: query.get("force") === "1" }));

route("GET", "/api/sessions", async ({ query }) => {
  const dir = query.get("cwd") || undefined;
  const infos = await listSessions({ dir, limit: Number(query.get("limit") || 300), includeWorktrees: true }).catch(() => []);
  const seen = new Set(infos.map((info) => info.sessionId));
  const list = infos.map(normalizeSessionInfo);
  // Draft/new sessions that are alive but have no transcript yet.
  for (const live of manager.sessions.values()) {
    if (seen.has(live.id) || (dir && live.cwd !== dir)) continue;
    if (!live.alive && !live.buffer.length && !live.meta.title) continue; // untouched draft
    list.push({
      id: live.id, title: live.meta.title || "", cwd: live.cwd, lastModified: live.lastActive, state: live.state,
      pending: live.pending.size, pinned: false, archived: false, draft: true,
    });
  }
  list.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  return { sessions: list };
});

route("POST", "/api/sessions", async ({ body }) => {
  const scratch = Boolean(body.meta?.scratch);
  const cwd = scratch ? workspaceRoot() : resolve(body.cwd || config.defaultCwd);
  if (scratch) await mkdir(cwd, { recursive: true });
  const info = await stat(cwd).catch(() => null);
  if (!info?.isDirectory()) throw new HttpError(400, `cwd is not a directory: ${cwd}`);
  const created = manager.create({ cwd, meta: { ...(body.meta || {}) } });
  if (!scratch) store.touchProject(cwd);
  if (body.start) await created.start();
  return created.summary();
});

route("GET", "/api/sessions/([^/]+)", async ({ params, query }) => {
  const [id] = params;
  const cwd = query.get("cwd") || undefined;
  const live = manager.get(id);
  let history = [];
  let info = null;
  try {
    history = await getSessionMessages(id, { dir: cwd, includeSystemMessages: true });
  } catch { /* draft or no transcript */ }
  try {
    info = await getSessionInfo(id, { dir: cwd });
  } catch { /* ignore */ }
  const meta = { ...store.sessionMeta(id), ...(live?.meta || {}) };
  const entries = live
    ? live.buffer.filter((entry) => entry.msg.type !== "stream_event" || entry.seq > live.seq - 80)
    : [];
  return {
    id,
    cwd: info?.cwd || live?.cwd || cwd || config.defaultCwd,
    info: info ? normalizeSessionInfo(info) : null,
    meta,
    history,
    live: live ? live.summary() : null,
    buffer: entries.slice(-800),
    seq: live?.seq || 0,
  };
});

route("GET", "/api/sessions/([^/]+)/subagent/([^/]+)", async ({ params, query }) => {
  const [id, agentId] = params;
  const messages = await getSubagentMessages(id, agentId, { dir: query.get("cwd") || undefined });
  return { messages };
});

route("GET", "/api/sessions/([^/]+)/subagents", async ({ params, query }) => ({ agents: await listSubagents(params[0], { dir: query.get("cwd") || undefined }) }));

route("POST", "/api/sessions/([^/]+)/messages", async ({ params, body }) => {
  const target = session(params[0], { create: true, cwd: body.cwd });
  if (body.meta) Object.assign(target.meta, body.meta);
  await materializeScratch(target);
  if (body.cwd && !target.alive && !target.meta.scratchFolder) target.cwd = resolve(body.cwd);
  store.touchProject(target.cwd);
  if (body.meta) Object.assign(target.meta, body.meta);
  return target.sendUser({ text: body.text || "", images: body.images || [], priority: body.priority, uuid: body.uuid });
});

route("POST", "/api/sessions/([^/]+)/start", async ({ params, body }) => {
  const target = session(params[0], { create: true, cwd: body.cwd });
  if (body.meta) Object.assign(target.meta, body.meta);
  await materializeScratch(target);
  await target.ensureStarted();
  return target.summary();
});

route("POST", "/api/sessions/([^/]+)/interrupt", async ({ params }) => session(params[0]).interrupt());

route("POST", "/api/sessions/([^/]+)/control", async ({ params, body }) => {
  const target = session(params[0]);
  const result = await target.control(body.op, body.args || {});
  if (["setModel", "setPermissionMode", "setEffort"].includes(body.op)) {
    await store.patchSessionMeta(target.id, { model: target.meta.model, permissionMode: target.meta.permissionMode, effort: target.meta.effort });
  }
  return result ?? { ok: true };
});

route("POST", "/api/sessions/([^/]+)/respond", async ({ params, body }) => {
  session(params[0]).respond(body.id, body.answer);
  return { ok: true };
});

route("POST", "/api/sessions/([^/]+)/meta", async ({ params, body }) => {
  const id = params[0];
  const live = manager.get(id);
  if (live) Object.assign(live.meta, body.patch || {});
  await store.patchSessionMeta(id, body.patch || {});
  return { ok: true, meta: { ...store.sessionMeta(id), ...(live?.meta || {}) } };
});

route("POST", "/api/sessions/([^/]+)/restart", async ({ params, body }) => {
  const target = session(params[0], { create: true, cwd: body.cwd });
  await target.restart(body.patch || {});
  await store.patchSessionMeta(target.id, body.patch || {});
  return target.summary();
});

route("POST", "/api/sessions/([^/]+)/close", async ({ params }) => {
  manager.get(params[0])?.close();
  return { ok: true };
});

route("POST", "/api/sessions/([^/]+)/rename", async ({ params, body }) => {
  const id = params[0];
  const title = String(body.title || "").trim();
  if (!title) throw new HttpError(400, "title required");
  try {
    await renameSession(id, title, { dir: body.cwd });
  } catch {
    await store.patchSessionMeta(id, { title }); // draft without transcript yet
  }
  const live = manager.get(id);
  if (live) live.meta.title = title;
  manager.emit("sessions.changed");
  return { ok: true };
});

route("POST", "/api/sessions/([^/]+)/tag", async ({ params, body }) => {
  await tagSession(params[0], body.tag || null, { dir: body.cwd });
  manager.emit("sessions.changed");
  return { ok: true };
});

route("POST", "/api/sessions/([^/]+)/pin", async ({ params, body }) => {
  await store.setPinned(params[0], Boolean(body.pinned));
  manager.emit("sessions.changed");
  return { ok: true };
});

route("POST", "/api/sessions/([^/]+)/archive", async ({ params, body }) => {
  await store.setArchived(params[0], Boolean(body.archived));
  manager.emit("sessions.changed");
  return { ok: true };
});

route("POST", "/api/sessions/([^/]+)/fork", async ({ params, body }) => {
  const result = await forkSession(params[0], { dir: body.cwd, upToMessageId: body.upToMessageId, title: body.title });
  manager.emit("sessions.changed");
  return result;
});

route("DELETE", "/api/sessions/([^/]+)", async ({ params, query }) => {
  const id = params[0];
  manager.get(id)?.close();
  manager.sessions.delete(id);
  await deleteSession(id, { dir: query.get("cwd") || undefined }).catch(() => {});
  manager.emit("sessions.changed");
  return { ok: true };
});

// ---- filesystem / git ----------------------------------------------------------------
route("GET", "/api/fs/list", async ({ query }) => ({ entries: await fsgit.listDir(resolve(query.get("path") || config.defaultCwd)) }));
route("GET", "/api/fs/read", async ({ query }) => fsgit.readTextFile(resolve(query.get("path") || "")));
route("GET", "/api/fs/search", async ({ query }) => ({ files: await fsgit.searchFiles(resolve(query.get("cwd") || config.defaultCwd), query.get("q") || "") }));
route("GET", "/api/fs/home", async () => ({ home: homedir(), cwd: config.defaultCwd }));
route("GET", "/api/git/info", async ({ query }) => fsgit.gitInfo(resolve(query.get("cwd") || config.defaultCwd)));
route("GET", "/api/git/diff", async ({ query }) =>
  fsgit.gitDiff(resolve(query.get("cwd") || config.defaultCwd), { path: query.get("path") || undefined, staged: query.get("staged") === "1", base: query.get("base") || undefined }));
route("GET", "/api/git/log", async ({ query }) => ({ commits: await fsgit.gitLog(resolve(query.get("cwd") || config.defaultCwd)) }));
route("GET", "/api/git/branches", async ({ query }) => ({ branches: await fsgit.gitBranches(resolve(query.get("cwd") || config.defaultCwd)) }));
route("POST", "/api/git/action", async ({ body }) => fsgit.gitAction(resolve(body.cwd || config.defaultCwd), body.action, body.args || {}));

// ---- Claude Code config --------------------------------------------------------------
route("GET", "/api/settings", async ({ query }) => cfiles.readSettings(query.get("scope") || "user", query.get("cwd") || config.defaultCwd));
route("PUT", "/api/settings", async ({ body }) => {
  const result = await cfiles.writeSettings(body.scope || "user", body.cwd || config.defaultCwd, body.text);
  catalog.invalidate();
  return result;
});
route("GET", "/api/claude-md", async ({ query }) => cfiles.readClaudeMd(query.get("scope") || "user", query.get("cwd") || config.defaultCwd));
route("PUT", "/api/claude-md", async ({ body }) => cfiles.writeClaudeMd(body.scope || "user", body.cwd || config.defaultCwd, String(body.content ?? "")));
route("GET", "/api/resources", async ({ query }) => cfiles.listResources(query.get("kind"), query.get("scope") || "user", query.get("cwd") || config.defaultCwd));
route("GET", "/api/resource", async ({ query }) => cfiles.readResource(query.get("kind"), query.get("scope") || "user", query.get("cwd") || config.defaultCwd, query.get("name")));
route("PUT", "/api/resource", async ({ body }) => {
  const result = await cfiles.writeResource(body.kind, body.scope || "user", body.cwd || config.defaultCwd, body.name, String(body.content ?? ""));
  catalog.invalidate();
  return result;
});
route("DELETE", "/api/resource", async ({ query }) => {
  const result = await cfiles.deleteResource(query.get("kind"), query.get("scope") || "user", query.get("cwd") || config.defaultCwd, query.get("name"));
  catalog.invalidate();
  return result;
});

route("POST", "/api/cli", async ({ body }) => {
  validateCliArgs(body.args);
  const result = await runClaudeCli(body.args, { cwd: body.cwd, timeout: Math.min(Number(body.timeout) || 60_000, 180_000) });
  catalog.invalidate();
  return result;
});

route("GET", "/api/usage-summary", async () => {
  const sessions = manager.list();
  return { sessions: sessions.map((item) => ({ id: item.id, state: item.state, lastResult: item.lastResult })) };
});

// ---- extension routes + feature discovery -------------------------------------------
// Drop a module in server/lib/routes/*.mjs exporting default ({route, config, manager, catalog, store, ...}) => void
const routeCtx = { route, config, manager, catalog, store, HttpError, fsgit, cfiles, runClaudeCli, session, stat, resolve, join, homedir };
const routesDir = join(HERE, "lib", "routes");
for (const file of (await readdir(routesDir).catch(() => [])).filter((name) => name.endsWith(".mjs")).sort()) {
  try {
    const mod = await import(pathToFileURL(join(routesDir, file)).href);
    await mod.default?.(routeCtx);
  } catch (error) {
    console.error(`[wheelhouse] failed to load routes/${file}: ${error.stack || error}`);
  }
}

route("GET", "/api/features", async () => {
  const list = async (dir, ext, skip = []) => (await readdir(join(WEB_DIR, dir)).catch(() => [])).filter((name) => name.endsWith(ext) && !skip.includes(name)).sort().map((name) => `/${dir}/${name}`);
  return { js: await list("js/features", ".js", ["core.js"]), css: await list("css/features", ".css"), i18n: await list("js/i18n/fa", ".js") };
});

// ---- SSE -----------------------------------------------------------------------------
function sseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function sseWrite(res, event, data, id) {
  res.write(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const globalClients = new Set();
function broadcast(event, data) {
  for (const res of globalClients) sseWrite(res, event, data);
}
manager.on("session.state", (summary) => broadcast("session.state", summary));
manager.on("session.attention", (payload) => broadcast("session.attention", payload));
manager.on("sessions.changed", () => broadcast("sessions.changed", {}));

function handleGlobalEvents(req, res) {
  sseHeaders(res);
  sseWrite(res, "hello", { live: manager.list() });
  globalClients.add(res);
  req.on("close", () => globalClients.delete(res));
}

function handleSessionStream(req, res, id, after) {
  const target = manager.get(id);
  sseHeaders(res);
  if (!target) {
    sseWrite(res, "gone", {});
    return res.end();
  }
  for (const entry of target.eventsAfter(after)) sseWrite(res, "msg", entry, entry.seq);
  const listener = (entry) => sseWrite(res, "msg", entry, entry.seq);
  target.on("event", listener);
  req.on("close", () => target.off("event", listener));
}

setInterval(() => {
  for (const res of globalClients) res.write(": ping\n\n");
}, 20_000).unref();

// ---- static --------------------------------------------------------------------------
async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = resolve(WEB_DIR, `.${requested}`);
  const rel = relative(WEB_DIR, filePath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return json(res, 403, { error: "forbidden" });
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not file");
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-cache",
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(filePath).pipe(res);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) {
      if (!sameOrigin(req)) return json(res, 403, { error: "only same-origin localhost requests are allowed" });
      if (req.method === "GET" && url.pathname === "/api/events") return handleGlobalEvents(req, res);
      const streamMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
      if (req.method === "GET" && streamMatch) {
        return handleSessionStream(req, res, streamMatch[1], Number(url.searchParams.get("after") || req.headers["last-event-id"] || 0));
      }
      for (const entry of routes) {
        if (entry.method !== req.method) continue;
        const match = url.pathname.match(entry.pattern);
        if (!match) continue;
        const body = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) ? await readBody(req) : {};
        const result = await entry.handler({ req, res, params: match.slice(1).map(decodeURIComponent), query: url.searchParams, body });
        return json(res, 200, result);
      }
      return json(res, 404, { error: "unknown endpoint" });
    }
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, url.pathname);
    json(res, 405, { error: "method not allowed" });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(`[wheelhouse] ${req.method} ${req.url}: ${error.stack || error}`);
    json(res, status, { error: error.message || "unexpected error" });
  }
});

server.on("error", async (error) => {
  if (error.code === "EADDRINUSE" && (config.open || config.appWindow)) {
    // Running `wheelhouse --app` again while it is already up just brings the window forward.
    const running = await fetch(`http://${HOST}:${PORT}/api/health`).then((response) => response.ok).catch(() => false);
    if (running) {
      console.log(`Wheelhouse is already running at http://${HOST}:${PORT}; opening it.`);
      openUi(`http://${HOST}:${PORT}`, { appWindow: config.appWindow, profileDir: join(config.dataDir, "app-profile") });
      setTimeout(() => process.exit(0), 3000); // let the helper start first
      return;
    }
  }
  console.error(error.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Start with --port <n> or stop the other instance.` : `Server error: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Wheelhouse ${PACKAGE.version} is running at ${url}`);
  console.log(`  profile:     ${config.activeProfile}${config.file ? ` (config: ${config.file})` : " (no config file)"}`);
  console.log(`  claude:      ${config.claudeBin || "bundled with the SDK"}`);
  console.log(`  default cwd: ${config.defaultCwd}`);
  if (config.tray.enabled) startTray({ config, url }); // the tray watches this process and cleans up after it
  if (config.open || config.appWindow) openUi(url, { appWindow: config.appWindow, profileDir: join(config.dataDir, "app-profile") });
});

async function shutdown() {
  manager.closeAll();
  await store.save();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
