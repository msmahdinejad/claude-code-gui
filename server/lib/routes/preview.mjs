// Preview pane backend: `.claude/launch.json` dev-server configurations, port probes and a confined file route for
// HTML / PDF previews. Nothing here executes anything: the commands returned are the ones the project's own launch.json
// defines and the browser hands them to the existing terminal runner (/api/term/run) when the user clicks Start.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { connect } from "node:net";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

export const COMMON_PORTS = [3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888];
export const MAX_LAUNCH_BYTES = 256 * 1024;
export const MAX_HTML_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_BYTES = 100 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 350;
const MAX_CONFIGS = 30;
const FILE_SCAN_DIRS = ["", "public", "dist", "build", "out", "docs", "www", "site"];
const FILE_TYPES = { ".html": "html", ".htm": "html", ".pdf": "pdf" };

// ---- launch.json ---------------------------------------------------------------------------------------------
/** JSON with comments and trailing commas (what Claude Desktop accepts) -> plain JSON text. String-aware. */
export function stripJsonComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i += 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  // trailing commas (outside strings: strings were copied verbatim above, so only structural ones can match here)
  return out.replace(/("(?:[^"\\]|\\.)*")|,(\s*[\]}])/g, (match, str, close) => (str ? str : close));
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isStringArray = (value, max) => Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string" && item.length <= 2000 && !CONTROL.test(item));

/**
 * Validate one raw configuration. Returns `{ name, port, executable, args, cwd, env }` (cwd still raw) or
 * `{ name, error }`. Only what Claude Desktop documents is read: name, runtimeExecutable, runtimeArgs, port, cwd, env,
 * program, args. A configuration that only has a `url` (attach to a running server) cannot be started here.
 */
export function validateConfiguration(raw, { ownPort } = {}) {
  const name = typeof raw?.name === "string" ? raw.name.trim() : "";
  const fail = (error) => ({ name: name || "(unnamed)", error });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("not an object");
  if (!name || name.length > 100 || CONTROL.test(name)) return fail("needs a name of up to 100 characters");
  let port = 3000;
  if (raw.port !== undefined) {
    if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return fail("port must be a whole number from 1 to 65535");
    port = raw.port;
  }
  if (ownPort !== undefined && port === Number(ownPort)) return fail("port is Wheelhouse's own port");
  let executable;
  let args;
  if (raw.program !== undefined) {
    if (typeof raw.program !== "string" || !raw.program.trim() || raw.program.length > 2000 || CONTROL.test(raw.program)) return fail("program must be a script path");
    if (raw.args !== undefined && !isStringArray(raw.args, 100)) return fail("args must be a list of strings");
    executable = "node";
    args = [raw.program, ...(raw.args || [])];
  } else if (raw.runtimeExecutable !== undefined) {
    if (typeof raw.runtimeExecutable !== "string" || !raw.runtimeExecutable.trim() || raw.runtimeExecutable.length > 500 || CONTROL.test(raw.runtimeExecutable)) return fail("runtimeExecutable must be a command name");
    if (raw.runtimeArgs !== undefined && !isStringArray(raw.runtimeArgs, 100)) return fail("runtimeArgs must be a list of strings");
    executable = raw.runtimeExecutable;
    args = raw.runtimeArgs || [];
  } else return fail(raw.url !== undefined ? "url-only configurations cannot be started from Wheelhouse" : "needs runtimeExecutable or program");
  let env = {};
  if (raw.env !== undefined) {
    if (!raw.env || typeof raw.env !== "object" || Array.isArray(raw.env)) return fail("env must be an object");
    for (const [key, value] of Object.entries(raw.env)) {
      if (!ENV_NAME.test(key) || typeof value !== "string" || value.length > 2000 || CONTROL.test(value)) return fail(`env value for "${key}" is not allowed`);
    }
    env = { ...raw.env };
  }
  if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || raw.cwd.length > 1000 || CONTROL.test(raw.cwd))) return fail("cwd must be a path");
  return { name, port, executable, args, cwd: raw.cwd, env };
}

/** Parse launch.json text. Never throws: `{ configs, error? }` where a configuration may be `{ name, error }`. */
export function parseLaunchJson(text, { ownPort } = {}) {
  let data;
  try { data = JSON.parse(stripJsonComments(String(text).replace(/^\uFEFF/, ""))); } catch (error) { return { configs: [], error: `launch.json is not valid JSON (${error.message})` }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { configs: [], error: "launch.json must be an object" };
  if (!Array.isArray(data.configurations)) return { configs: [], error: 'launch.json needs a "configurations" list' };
  const seen = new Set();
  const configs = [];
  for (const raw of data.configurations.slice(0, MAX_CONFIGS)) {
    const config = validateConfiguration(raw, { ownPort });
    if (seen.has(config.name)) { configs.push({ name: config.name, error: "duplicate name" }); continue; }
    seen.add(config.name);
    configs.push(config);
  }
  return { configs, truncated: data.configurations.length > MAX_CONFIGS };
}

/** The shell command the terminal runner executes for a validated configuration (every argument single-quoted). */
export function buildCommand(config, { windows = process.platform === "win32" } = {}) {
  if (windows) {
    // PowerShell also treats the typographic single quotes as quotes: double all of them.
    const q = (value) => `'${String(value).replace(/['\u2018\u2019\u201a\u201b]/g, (m) => m + m)}'`;
    const env = Object.entries(config.env || {}).map(([key, value]) => `$env:${key}=${q(value)}; `).join("");
    return `${env}& ${[config.executable, ...config.args].map(q).join(" ")}`;
  }
  const q = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  const env = Object.entries(config.env || {}).map(([key, value]) => `${key}=${q(value)} `).join("");
  return `${env}${[config.executable, ...config.args].map(q).join(" ")}`;
}

// ---- helpers -------------------------------------------------------------------------------------------------
export const within = (root, target) => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

/** TCP connect probe on loopback (IPv4 first, then IPv6: Node dev servers often bind only ::1). */
export function probePort(port, { timeout = PROBE_TIMEOUT_MS } = {}) {
  const attempt = (host) => new Promise((done) => {
    const socket = connect({ port, host });
    const finish = (value) => { socket.destroy(); done(value); };
    socket.setTimeout(timeout, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
  return attempt("127.0.0.1").then((ok) => ok || attempt("::1"));
}

export const termIdFor = (root, name) => `pv-${createHash("sha1").update(`${root}\0${name}`).digest("hex").slice(0, 20)}`;

export default function register({ route, config, HttpError, stat: statFn = stat }) {
  const ownPort = Number(config?.port) || undefined;
  const bad = (message) => new HttpError(400, message);

  async function projectRoot(cwd) {
    if (!cwd || typeof cwd !== "string") throw bad("cwd is required");
    const full = resolve(cwd);
    let info;
    try { info = await statFn(full); } catch { throw bad(`not a directory: ${cwd}`); }
    if (!info.isDirectory()) throw bad(`not a directory: ${cwd}`);
    return realpath(full);
  }

  /** Read and validate `<root>/.claude/launch.json` (the file itself must resolve inside the project folder). */
  async function loadLaunch(root) {
    const file = resolve(root, ".claude", "launch.json");
    let real;
    try { real = await realpath(file); } catch { return { exists: false, configs: [] }; }
    if (!within(root, real)) return { exists: true, configs: [], error: "launch.json resolves outside the project folder" };
    const info = await statFn(real);
    if (!info.isFile()) return { exists: true, configs: [], error: "launch.json is not a file" };
    if (info.size > MAX_LAUNCH_BYTES) return { exists: true, configs: [], error: "launch.json is too large" };
    const parsed = parseLaunchJson(await readFile(real, "utf8"), { ownPort });
    const configs = [];
    for (const entry of parsed.configs) {
      if (entry.error) { configs.push(entry); continue; }
      let cwd = root;
      if (entry.cwd) {
        const text = entry.cwd.replace(/\$\{workspaceFolder\}/g, () => root);
        try {
          cwd = await realpath(resolve(root, text));
          if (!(await statFn(cwd)).isDirectory()) throw new Error("not a directory");
        } catch { configs.push({ name: entry.name, error: `cwd not found: ${entry.cwd}` }); continue; }
        if (!within(root, cwd)) { configs.push({ name: entry.name, error: "cwd is outside the project folder" }); continue; }
      }
      configs.push({
        name: entry.name, port: entry.port, command: buildCommand(entry), cwd, cwdRel: relative(root, cwd).split(sep).join("/"),
        termId: termIdFor(root, entry.name), envNames: Object.keys(entry.env),
      });
    }
    return { exists: true, configs, error: parsed.error, truncated: parsed.truncated };
  }

  async function listFiles(root) {
    const files = [];
    for (const dir of FILE_SCAN_DIRS) {
      let entries;
      try { entries = await readdir(resolve(root, dir), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!FILE_TYPES[extname(entry.name).toLowerCase()]) continue;
        files.push(dir ? `${dir}/${entry.name}` : entry.name);
      }
    }
    return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 40);
  }

  route("GET", "/api/preview/configs", async ({ query }) => {
    const root = await projectRoot(query.get("cwd"));
    const launch = await loadLaunch(root);
    // Probe only the ports launch.json names and the common dev ports: nothing else is ever connected to.
    const launchPorts = new Set(launch.configs.filter((entry) => entry.port).map((entry) => entry.port));
    const wanted = [...new Set([...launchPorts, ...COMMON_PORTS])].filter((port) => port !== ownPort);
    const open = new Set((await Promise.all(wanted.map(async (port) => ((await probePort(port)) ? port : 0)))).filter(Boolean));
    return {
      root,
      file: ".claude/launch.json",
      exists: launch.exists,
      error: launch.error || null,
      truncated: Boolean(launch.truncated),
      configs: launch.configs.map((entry) => (entry.error ? entry : { ...entry, listening: open.has(entry.port) })),
      suggested: COMMON_PORTS.filter((port) => open.has(port) && !launchPorts.has(port)),
      files: await listFiles(root),
      ownPort: ownPort ?? null,
    };
  });

  route("POST", "/api/preview/probe", async ({ body }) => {
    const port = body?.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad("port must be a whole number from 1 to 65535");
    if (port === ownPort) throw bad("that is Wheelhouse's own port");
    if (!COMMON_PORTS.includes(port)) {
      // Anything else must be a port the project's own launch.json declares.
      const launch = typeof body.cwd === "string" ? await loadLaunch(await projectRoot(body.cwd)) : null;
      if (!launch?.configs.some((entry) => entry.port === port)) throw new HttpError(403, "port is neither a common dev port nor in launch.json");
    }
    return { port, listening: await probePort(port) };
  });

  // Serve one .html/.htm/.pdf of the project folder. HTML is sandboxed by header (opaque origin: it cannot read the
  // app's origin); scripts only when the page asks for them (?scripts=1).
  route("GET", "/api/preview/file", async ({ query, res }) => {
    const root = await projectRoot(query.get("cwd"));
    const wantPath = String(query.get("path") ?? "");
    if (!wantPath || wantPath.length > 2000 || wantPath.includes("\0")) throw bad("path is required");
    const type = FILE_TYPES[extname(wantPath).toLowerCase()];
    if (!type) throw new HttpError(415, "only .html, .htm and .pdf files can be previewed");
    const full = resolve(root, wantPath);
    if (!within(root, full)) throw new HttpError(403, "path is outside the project folder");
    let real;
    try { real = await realpath(full); } catch { throw new HttpError(404, "not found"); }
    if (!within(root, real)) throw new HttpError(403, "path escapes the project folder");
    const info = await statFn(real);
    if (!info.isFile()) throw new HttpError(404, "not a file");
    if (info.size > (type === "pdf" ? MAX_PDF_BYTES : MAX_HTML_BYTES)) throw new HttpError(413, "file is too large to preview");
    const common = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Length": info.size, "Content-Disposition": "inline" };
    if (type === "pdf") {
      // Only real PDFs go out as application/pdf. Chrome's PDF viewer does not run inside a CSP sandbox, so the PDF
      // response carries a locked-down policy instead (nothing to load, framable only by this app).
      const head = Buffer.alloc(5);
      const handle = await open(real, "r");
      try { await handle.read(head, 0, 5, 0); } finally { await handle.close(); }
      if (head.toString("latin1") !== "%PDF-") throw new HttpError(415, `${basename(real)} is not a PDF`);
      res.writeHead(200, { ...common, "Content-Type": "application/pdf", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'" });
    } else {
      res.writeHead(200, { ...common, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": query.get("scripts") === "1" ? "sandbox allow-scripts allow-forms allow-popups allow-modals" : "sandbox" });
    }
    createReadStream(real).on("error", () => res.destroy()).pipe(res);
    return null; // the response is already on its way (the router's JSON writer skips a started response)
  });
}
