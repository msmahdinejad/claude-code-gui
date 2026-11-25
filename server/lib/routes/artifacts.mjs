// Artifacts backend: visual deliverables Claude writes to <project>/.wheelhouse/artifacts/ (one self-contained .html, .svg,
// .md or .mmd file each) are listed, versioned and served here for the Artifacts pane.
//   - Versions: every time a file is looked at (list / get) and its content differs from the newest stored version, a snapshot
//     is stored in <dataDir>/artifact-versions/<sha1(project)>/<name>/<n>.snap (max 50 per artifact).
//   - Claude's own edits are also caught as they happen: when a session's Write/Edit/MultiEdit of an artifact returns, a
//     version is stored at once, so every revision is kept even while nobody looks at the pane.
//   - /api/artifacts/view serves the bytes with a locked-down CSP (opaque-origin sandbox, no network) so a page can be framed
//     by the app or opened on its own in a browser tab.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(html|htm|svg|md|mmd)$/;
const KIND_BY_EXT = { html: "html", htm: "html", svg: "svg", md: "markdown", mmd: "mermaid" };
const EXT_BY_KIND = { html: "html", svg: "svg", markdown: "md", mermaid: "mmd" };
const SOURCES = new Set(["claude", "manual", "message"]);
export const ARTIFACT_DIR = ".wheelhouse/artifacts";
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const MAX_VERSIONS = 50;
const MAX_LIST = 500;
const MTIME_QUIET_MS = 2000; // a file untouched this long before it was stored cannot hide a same-tick rewrite

const HTML_CSP = [
  "sandbox allow-scripts allow-forms allow-modals allow-popups",
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "font-src data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");
const SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'";

export const kindOfName = (name) => (NAME_RE.test(String(name ?? "")) ? KIND_BY_EXT[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] : null);
const sha1 = (text) => createHash("sha1").update(text).digest("hex");
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** Artifact names a session message writes to: tool_use blocks of Write/Edit/MultiEdit whose path is in the artifacts folder. */
export function artifactWrites(msg) {
  const out = [];
  if (msg?.type !== "assistant" || !Array.isArray(msg.message?.content)) return out;
  for (const block of msg.message.content) {
    if (block?.type !== "tool_use" || !["Write", "Edit", "MultiEdit"].includes(block.name)) continue;
    const path = String(block.input?.file_path ?? "").replace(/\\/g, "/");
    const m = /(?:^|\/)\.wheelhouse\/artifacts\/([^/]+)$/.exec(path);
    if (m && NAME_RE.test(m[1])) out.push({ id: block.id, name: m[1], path: block.input.file_path });
  }
  return out;
}

/** The tool_use ids a session message answers (tool_result blocks of a user message), with whether each one failed. */
export function toolResults(msg) {
  if (msg?.type !== "user" || !Array.isArray(msg.message?.content)) return [];
  return msg.message.content.filter((block) => block?.type === "tool_result" && block.tool_use_id).map((block) => ({ id: block.tool_use_id, error: Boolean(block.is_error) }));
}

export default function register({ route, config, manager, HttpError }) {
  const bad = (message) => new HttpError(400, message);

  async function projectRoot(cwd) {
    if (!cwd || typeof cwd !== "string") throw bad("cwd is required");
    const full = resolve(cwd);
    let info;
    try { info = await stat(full); } catch { throw bad(`not a directory: ${cwd}`); }
    if (!info.isDirectory()) throw bad(`not a directory: ${cwd}`);
    return realpath(full);
  }

  function cleanName(value) {
    const name = String(value ?? "");
    if (!NAME_RE.test(name)) throw bad("invalid artifact name");
    return name;
  }

  /** The artifacts folder of a project, only when it really is <root>/.wheelhouse/artifacts (no symlink out of the project). */
  async function artifactsDir(root, { create = false } = {}) {
    const dir = join(root, ".wheelhouse", "artifacts");
    if (create) await mkdir(dir, { recursive: true });
    let real;
    try { real = await realpath(dir); } catch { return null; }
    if (real !== dir) throw new HttpError(403, "the artifacts folder resolves outside the project");
    return dir;
  }

  /** `{ file, info }` of an artifact: a regular file (never a symlink) of at most 5 MB. */
  async function artifactFile(root, name) {
    const dir = await artifactsDir(root);
    if (!dir) throw new HttpError(404, "not found");
    const file = join(dir, name);
    let info;
    try { info = await lstat(file); } catch { throw new HttpError(404, "not found"); }
    if (info.isSymbolicLink() || !info.isFile()) throw new HttpError(404, "not found");
    if (info.size > MAX_ARTIFACT_BYTES) throw new HttpError(413, "artifact is too large");
    return { file, info };
  }

  // ---- keep .wheelhouse/ out of `git status` (local-only: .git/info/exclude) ----------------------------------------
  const excluded = new Set();
  const gitOut = (cwd, args) => new Promise((done) => execFile("git", args, { cwd, windowsHide: true, encoding: "utf8", timeout: 15_000 }, (error, stdout) => done(error ? "" : String(stdout).trim())));
  async function excludeFromGit(root) {
    if (excluded.has(root)) return;
    excluded.add(root);
    try {
      const top = await gitOut(root, ["rev-parse", "--show-toplevel"]);
      if (!top) return;
      const path = await gitOut(root, ["rev-parse", "--git-path", "info/exclude"]);
      if (!path) return;
      const file = resolve(root, path);
      const current = await readFile(file, "utf8").catch(() => "");
      if (current.split(/\r?\n/).some((line) => line.trim() === ".wheelhouse/")) return;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}.wheelhouse/\n`, "utf8");
    } catch { /* best effort */ }
  }

  // ---- versions ------------------------------------------------------------------------------------------------------
  const versionsRoot = () => join(config.dataDir, "artifact-versions");
  const versionDir = (root, name) => join(versionsRoot(), sha1(root), name);
  const queues = new Map(); // "<root>\0<name>" -> promise tail: snapshots of one artifact never run at the same time

  function serialized(key, task) {
    const run = (queues.get(key) || Promise.resolve()).catch(() => {}).then(task);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
  }

  async function readIndex(dir) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
      if (parsed && Array.isArray(parsed.versions)) return { next: Number(parsed.next) || 1, versions: parsed.versions };
    } catch { /* new */ }
    return { next: 1, versions: [] };
  }

  /** Store the file's current content as a new version when it differs from the newest one. Returns the index. */
  function snapshot(root, name, source = "claude") {
    return serialized(`${root}\0${name}`, async () => {
      const { file, info } = await artifactFile(root, name);
      const dir = versionDir(root, name);
      const index = await readIndex(dir);
      const last = index.versions.at(-1);
      // Unchanged since the newest version (same size and modification time): no need to read and hash it again. Only when
      // the file had been quiet for a while when it was stored: a second write in the same clock tick keeps the same mtime
      // (file systems tick in milliseconds or coarser), and trusting it would drop that revision.
      if (last && last.at && last.at - last.mtime > MTIME_QUIET_MS && last.mtime === Math.round(info.mtimeMs) && last.size === info.size) return index;
      const buffer = await readFile(file);
      const hash = sha256(buffer);
      if (last && last.hash === hash) return index;
      await mkdir(dir, { recursive: true });
      const n = Math.max(index.next, (last?.n || 0) + 1);
      await writeFile(join(dir, `${n}.snap`), buffer);
      index.versions.push({ n, mtime: Math.round(info.mtimeMs), at: Date.now(), size: buffer.length, hash, source: SOURCES.has(source) ? source : "claude" });
      index.next = n + 1;
      while (index.versions.length > MAX_VERSIONS) {
        const dropped = index.versions.shift();
        await rm(join(dir, `${dropped.n}.snap`), { force: true });
      }
      await writeFile(join(dir, "index.json"), JSON.stringify(index));
      return index;
    });
  }

  // ---- versions as Claude writes them ----------------------------------------------------------------------------
  // Every session the manager reports is followed once: a Write/Edit of an artifact is remembered by its tool_use id, and
  // when its tool_result arrives (the file is on disk now) that content is stored as a version.
  const followed = new WeakSet();
  function follow(live) {
    if (!live || followed.has(live) || typeof live.on !== "function") return;
    followed.add(live);
    const pending = new Map(); // tool_use id -> name
    live.on("event", ({ msg } = {}) => {
      for (const write of artifactWrites(msg)) pending.set(write.id, write);
      if (!pending.size) return;
      for (const { id, error } of toolResults(msg)) {
        const write = pending.get(id);
        if (!write) continue;
        pending.delete(id);
        if (error || !live.cwd) continue;
        const folder = dirname(dirname(dirname(resolve(live.cwd, write.path)))); // <project>/.wheelhouse/artifacts/<name>
        projectRoot(folder).then((root) => snapshot(root, write.name, "claude")).catch(() => { /* gone, too large: the next look stores it */ });
      }
      if (pending.size > 200) pending.clear();
    });
  }
  if (manager?.on) {
    manager.on("session.state", (summary) => follow(manager.get?.(summary?.id)));
    for (const live of manager.sessions?.values?.() || []) follow(live);
  }

  const publicVersion = ({ n, mtime, size, source }) => ({ n, mtime, size, source });

  /** Snapshot, then the requested version (default: newest) and its stored bytes. */
  async function loadVersion(root, name, versionParam) {
    const index = await snapshot(root, name);
    const latest = index.versions.at(-1);
    let wanted = latest;
    if (versionParam !== null && versionParam !== undefined && versionParam !== "") {
      const n = Number(versionParam);
      if (!Number.isInteger(n) || n < 1) throw bad("invalid version");
      wanted = index.versions.find((entry) => entry.n === n);
      if (!wanted) throw new HttpError(404, "no such version");
    }
    const buffer = await readFile(join(versionDir(root, name), `${wanted.n}.snap`)).catch(() => { throw new HttpError(404, "version data is missing"); });
    return { index, version: wanted, latest: wanted.n === latest.n, buffer };
  }

  // ---- routes --------------------------------------------------------------------------------------------------------
  route("GET", "/api/artifacts", async ({ query }) => {
    const root = await projectRoot(query.get("cwd"));
    const dir = await artifactsDir(root);
    if (!dir) return { dir: ARTIFACT_DIR, items: [] };
    excludeFromGit(root);
    const items = [];
    for (const entry of (await readdir(dir, { withFileTypes: true })).slice(0, MAX_LIST * 2)) {
      if (!entry.isFile() || !NAME_RE.test(entry.name)) continue; // symlinks are not regular files here
      try {
        const { info } = await artifactFile(root, entry.name);
        const index = await snapshot(root, entry.name);
        items.push({ name: entry.name, kind: kindOfName(entry.name), size: info.size, mtime: Math.round(info.mtimeMs), versions: index.versions.length, updatedAt: new Date(info.mtimeMs).toISOString() });
      } catch { /* too large, vanished: not listed */ }
    }
    items.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    return { dir: ARTIFACT_DIR, items: items.slice(0, MAX_LIST) };
  });

  route("GET", "/api/artifacts/get", async ({ query }) => {
    const root = await projectRoot(query.get("cwd"));
    const name = cleanName(query.get("name"));
    const { index, version, latest, buffer } = await loadVersion(root, name, query.get("version"));
    return { name, kind: kindOfName(name), content: buffer.toString("utf8"), size: version.size, mtime: version.mtime, version: version.n, versions: index.versions.map(publicVersion), latest };
  });

  route("GET", "/api/artifacts/view", async ({ query, res }) => {
    const root = await projectRoot(query.get("cwd"));
    const name = cleanName(query.get("name"));
    const kind = kindOfName(name);
    const { buffer } = await loadVersion(root, name, query.get("version"));
    const headers = {
      "Content-Type": kind === "html" ? "text/html; charset=utf-8" : kind === "svg" ? "image/svg+xml" : "text/plain; charset=utf-8",
      "Content-Length": buffer.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Disposition": query.get("download") === "1" ? `attachment; filename="${basename(name)}"` : "inline",
    };
    if (kind === "html") headers["Content-Security-Policy"] = HTML_CSP;
    else if (kind === "svg") headers["Content-Security-Policy"] = SVG_CSP;
    else headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
    res.writeHead(200, headers);
    res.end(buffer);
    return null; // the response is already out (the router's JSON writer skips a started response)
  });

  const slug = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const pad = (n) => String(n).padStart(2, "0");
  function stamp() {
    const now = new Date();
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  route("POST", "/api/artifacts/save", async ({ body }) => {
    const root = await projectRoot(body?.cwd);
    if (typeof body.content !== "string") throw bad("content required");
    if (Buffer.byteLength(body.content, "utf8") > MAX_ARTIFACT_BYTES) throw new HttpError(413, "artifact is too large");
    let wantedName = body.name ? cleanName(body.name) : "";
    const kind = wantedName ? kindOfName(wantedName) : body.kind;
    if (!EXT_BY_KIND[kind]) throw bad("kind must be html, svg, markdown or mermaid");
    const ext = wantedName ? wantedName.slice(wantedName.lastIndexOf(".") + 1) : EXT_BY_KIND[kind];
    if (!wantedName) wantedName = `${slug(body.title) || `${kind}-${stamp()}`}.${ext}`;
    const stem = wantedName.slice(0, wantedName.lastIndexOf("."));
    const dir = await artifactsDir(root, { create: true });
    let name = wantedName;
    for (let attempt = 2; ; attempt += 1) {
      try {
        if (body.overwrite === true) {
          const existing = await lstat(join(dir, name)).catch(() => null);
          if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new HttpError(409, "cannot overwrite that entry");
          await writeFile(join(dir, name), body.content, "utf8");
        } else {
          await writeFile(join(dir, name), body.content, { encoding: "utf8", flag: "wx" });
        }
        break;
      } catch (error) {
        if (error.code !== "EEXIST" || attempt > 200) throw error;
        name = `${stem}-${attempt}.${ext}`;
        if (!NAME_RE.test(name)) throw bad("artifact name is too long");
      }
    }
    await excludeFromGit(root);
    const index = await snapshot(root, name, SOURCES.has(body.source) ? body.source : "manual");
    return { name, kind: kindOfName(name), version: index.versions.at(-1).n };
  });

  route("POST", "/api/artifacts/delete", async ({ body }) => {
    const root = await projectRoot(body?.cwd);
    const name = cleanName(body.name);
    const dir = await artifactsDir(root);
    if (dir) {
      const info = await lstat(join(dir, name)).catch(() => null);
      if (info && (info.isSymbolicLink() || info.isFile())) await unlink(join(dir, name));
    }
    await serialized(`${root}\0${name}`, () => rm(versionDir(root, name), { recursive: true, force: true }));
    return { ok: true };
  });
}
