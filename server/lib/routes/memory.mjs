// Settings → Memory: rules files (.claude/rules/**/*.md for project and user) and auto memory
// (<config>/projects/<project>/memory or autoMemoryDirectory). Every file route is confined to
// one of those folders: relative *.md paths only, no "..", no absolute paths, no symlinks that
// lead outside, size-limited, written via temp file + rename.
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  FILE_MAX_BYTES, INDEX_NAME, autoMemoryState, cleanRelPath, confinedPath, indexHasEntry, indexStats, isInside, matchesAny,
  memoryMeta, parseDoc, removeIndexEntry, replaceBody, resolveAutoMemoryDir, rulePaths, setMemoryMeta, setRulePaths, upsertIndexEntry,
} from "../memory-paths.mjs";

const MAX_LIST = 600;
const MAX_DEPTH = 6;

const nodeFs = {
  kind(target) {
    try {
      const info = lstatSync(target);
      if (info.isSymbolicLink()) return "link";
      return info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
    } catch {
      return null;
    }
  },
  readText(target) {
    try {
      return readFileSync(target, "utf8");
    } catch {
      return null;
    }
  },
  realpath(target) {
    try {
      return realpathSync.native(target);
    } catch {
      return target;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

export default function register({ route, HttpError, cfiles, homedir }) {
  const bad = (error) => new HttpError(400, error.message || String(error));

  function needCwd(cwd) {
    if (!cwd) throw new HttpError(400, "open a project first (cwd is required)");
    return path.resolve(cwd);
  }

  async function effectiveSettings(cwd) {
    const { resolveSettings } = await import("@anthropic-ai/claude-agent-sdk");
    try {
      return await resolveSettings({ cwd: cwd || process.cwd(), settingSources: cwd ? ["user", "project", "local"] : ["user"] });
    } catch {
      return { effective: {}, provenance: {}, sources: [] };
    }
  }

  /** Value + source of one top-level key, highest-precedence source first. */
  function settingOf(resolved, key) {
    const sources = resolved.sources || [];
    for (let index = sources.length - 1; index >= 0; index -= 1) {
      const value = sources[index].settings?.[key];
      if (value !== undefined && value !== null) return { value, source: sources[index].source, path: sources[index].path };
    }
    return undefined;
  }

  // ---- confinement -------------------------------------------------------------------
  async function realOrNull(target) {
    try {
      return await realpath(target);
    } catch {
      return null;
    }
  }

  /** Resolves `rel` inside `root`; the real location (after links) must stay inside the real root. */
  async function locate(root, rel, { create = false } = {}) {
    let full;
    try {
      full = confinedPath(root, rel, path);
    } catch (error) {
      throw bad(error);
    }
    if (create) await mkdir(root, { recursive: true });
    const realRoot = (await realOrNull(root)) || path.resolve(root);
    const info = await lstat(full).catch(() => null);
    if (info) {
      const real = await realOrNull(full);
      if (!real || !isInside(realRoot, real, path)) throw new HttpError(403, "this file is a link to somewhere outside its folder");
      return { full, real, exists: true, link: info.isSymbolicLink(), realRoot };
    }
    if (!create) return { full, real: full, exists: false, link: false, realRoot };
    let parent = path.dirname(full);
    while (!(await lstat(parent).catch(() => null))) parent = path.dirname(parent);
    const realParent = await realOrNull(parent);
    if (!realParent || (realParent !== realRoot && !isInside(realRoot, realParent, path))) throw new HttpError(403, "folder leads outside its root");
    return { full, real: full, exists: false, link: false, realRoot };
  }

  async function readSmall(target) {
    const info = await stat(target);
    if (!info.isFile()) throw new HttpError(400, "not a file");
    if (info.size > FILE_MAX_BYTES) throw new HttpError(413, `file is larger than ${FILE_MAX_BYTES / 1024} KB`);
    return { content: await readFile(target, "utf8"), size: info.size, mtime: info.mtimeMs };
  }

  async function atomicWrite(target, content) {
    if (typeof content !== "string") throw new HttpError(400, "content must be a string");
    if (Buffer.byteLength(content, "utf8") > FILE_MAX_BYTES) throw new HttpError(413, `content is larger than ${FILE_MAX_BYTES / 1024} KB`);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    const info = await stat(target);
    return { size: info.size, mtime: info.mtimeMs };
  }

  /** Recursive *.md listing; links are listed but never followed into. */
  async function walk(root, { skip } = {}) {
    const out = [];
    async function visit(dir, prefix, depth) {
      if (depth > MAX_DEPTH || out.length >= MAX_LIST) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (out.length >= MAX_LIST) return;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(full, rel, depth + 1);
        else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(".md") && rel !== skip) {
          try {
            cleanRelPath(rel);
          } catch {
            continue; // names the editor cannot address safely
          }
          out.push({ rel, full, link: entry.isSymbolicLink() });
        }
      }
    }
    await visit(root, "", 0);
    return out;
  }

  async function describe(item, realRoot) {
    const real = await realOrNull(item.full);
    const inside = Boolean(real) && isInside(realRoot, real, path);
    if (!inside) return { rel: item.rel, path: item.full, link: true, outside: true };
    try {
      const { content, size, mtime } = await readSmall(real);
      return { rel: item.rel, path: item.full, link: item.link, size, mtime, doc: parseDoc(content) };
    } catch (error) {
      return { rel: item.rel, path: item.full, link: item.link, error: error.message };
    }
  }

  // ---- rules ---------------------------------------------------------------------------
  function rulesRoot(scope, cwd) {
    if (scope === "user") return path.join(cfiles.configDir(), "rules");
    if (scope === "project") return path.join(needCwd(cwd), ".claude", "rules");
    throw new HttpError(400, "scope must be user or project");
  }

  route("GET", "/api/memory/rules", async ({ query }) => {
    const cwd = query.get("cwd") || "";
    const resolved = await effectiveSettings(cwd || undefined);
    const excludes = Array.isArray(resolved.effective?.claudeMdExcludes) ? resolved.effective.claudeMdExcludes : [];
    const scopes = {};
    for (const scope of cwd ? ["project", "user"] : ["user"]) {
      const dir = rulesRoot(scope, cwd);
      const realRoot = (await realOrNull(dir)) || dir;
      const items = [];
      for (const item of await walk(dir)) {
        const info = await describe(item, realRoot);
        const paths = info.doc ? rulePaths(info.doc) : [];
        items.push({
          rel: info.rel,
          path: info.path,
          link: Boolean(info.link),
          outside: Boolean(info.outside),
          error: info.error || null,
          size: info.size || 0,
          paths,
          scoped: paths.length > 0,
          yamlError: info.doc?.error || null,
          excludedBy: matchesAny(info.path, excludes, { caseInsensitive: process.platform === "win32" }),
        });
      }
      scopes[scope] = { dir, exists: Boolean(await lstat(dir).catch(() => null)), items };
    }
    return { scopes, excludes };
  });

  route("GET", "/api/memory/rule", async ({ query }) => {
    const root = rulesRoot(query.get("scope"), query.get("cwd"));
    const spot = await locate(root, query.get("rel"));
    if (!spot.exists) throw new HttpError(404, "rule file not found");
    const { content, mtime } = await readSmall(spot.real);
    const doc = parseDoc(content);
    return { path: spot.full, link: spot.link, mtime, content, body: doc.body, paths: rulePaths(doc), yamlError: doc.error };
  });

  // body: { scope, cwd, rel, create?, content? | (paths?, body?) }
  route("PUT", "/api/memory/rule", async ({ body }) => {
    const root = rulesRoot(body.scope, body.cwd);
    const spot = await locate(root, body.rel, { create: true });
    if (body.create && spot.exists) throw new HttpError(409, "a rule with this name already exists");
    let content;
    if (typeof body.content === "string") content = body.content;
    else {
      content = spot.exists ? (await readSmall(spot.real)).content : "";
      if (Array.isArray(body.paths)) content = setRulePaths(content, body.paths.map(String));
      if (typeof body.body === "string") content = replaceBody(content, body.body);
    }
    return { path: spot.full, ...(await atomicWrite(spot.real, content)) };
  });

  route("POST", "/api/memory/rule/rename", async ({ body }) => {
    const root = rulesRoot(body.scope, body.cwd);
    const from = await locate(root, body.from);
    if (!from.exists) throw new HttpError(404, "rule file not found");
    const to = await locate(root, body.to, { create: true });
    if (to.exists) throw new HttpError(409, "a rule with the new name already exists");
    await mkdir(path.dirname(to.full), { recursive: true });
    await rename(from.full, to.full);
    return { path: to.full, rel: cleanRelPath(body.to) };
  });

  route("DELETE", "/api/memory/rule", async ({ query }) => {
    const root = rulesRoot(query.get("scope"), query.get("cwd"));
    const spot = await locate(root, query.get("rel"));
    if (!spot.exists) throw new HttpError(404, "rule file not found");
    await unlink(spot.full); // a link inside the folder: only the link goes
    return { ok: true };
  });

  // ---- auto memory -----------------------------------------------------------------------
  async function memoryInfo(cwd) {
    const resolved = await effectiveSettings(cwd || undefined);
    const dirSetting = settingOf(resolved, "autoMemoryDirectory");
    const where = resolveAutoMemoryDir({ cwd, configDir: cfiles.configDir(), env: process.env, setting: dirSetting, home: homedir(), path, fs: nodeFs });
    const state = autoMemoryState({ env: process.env, settingsEnv: resolved.effective?.env, setting: settingOf(resolved, "autoMemoryEnabled") });
    return { where, state, dirSetting, resolved };
  }

  async function memoryRoot(cwd) {
    const { where } = await memoryInfo(cwd ? path.resolve(cwd) : "");
    if (!where.dir) throw new HttpError(400, "open a project first (cwd is required)");
    return where.dir;
  }

  route("GET", "/api/memory/auto", async ({ query }) => {
    const cwd = query.get("cwd") ? path.resolve(query.get("cwd")) : "";
    const { where, state, dirSetting } = await memoryInfo(cwd);
    const result = {
      dir: where.dir,
      via: where.via,
      base: where.base || null,
      gitRoot: where.gitRoot || null,
      key: where.key || null,
      configDir: cfiles.configDir(),
      directorySetting: dirSetting ? { value: dirSetting.value, source: dirSetting.source, path: dirSetting.path || null, ignored: where.via !== "setting" } : null,
      projectDirName: where.via === "env" ? where.key : null,
      enabled: state,
      exists: false,
      index: null,
      files: [],
    };
    if (!where.dir) return result;
    result.exists = Boolean(await lstat(where.dir).catch(() => null));
    if (!result.exists) return result;
    const realRoot = (await realOrNull(where.dir)) || where.dir;
    let indexText = "";
    const indexPath = path.join(where.dir, INDEX_NAME);
    try {
      const spot = await locate(where.dir, INDEX_NAME);
      if (spot.exists) {
        indexText = (await readSmall(spot.real)).content;
        result.index = { path: indexPath, ...indexStats(indexText) };
      }
    } catch (error) {
      result.index = { path: indexPath, error: error.message };
    }
    for (const item of await walk(where.dir, { skip: INDEX_NAME })) {
      const info = await describe(item, realRoot);
      result.files.push({
        rel: info.rel,
        path: info.path,
        link: Boolean(info.link),
        outside: Boolean(info.outside),
        error: info.error || null,
        size: info.size || 0,
        mtime: info.mtime || 0,
        ...(info.doc ? memoryMeta(info.doc) : { name: "", description: "", type: "" }),
        indexed: indexHasEntry(indexText, info.rel),
      });
    }
    return result;
  });

  route("GET", "/api/memory/file", async ({ query }) => {
    const root = await memoryRoot(query.get("cwd"));
    const spot = await locate(root, query.get("rel"));
    if (!spot.exists) throw new HttpError(404, "memory file not found");
    const { content, mtime } = await readSmall(spot.real);
    const doc = parseDoc(content);
    return { path: spot.full, mtime, content, body: doc.body, hasFrontmatter: doc.hasFrontmatter, yamlError: doc.error, ...memoryMeta(doc) };
  });

  // body: { cwd, rel, create?, content? | (meta?: {name, description, type}, body?) }
  route("PUT", "/api/memory/file", async ({ body }) => {
    const root = await memoryRoot(body.cwd);
    const spot = await locate(root, body.rel, { create: true });
    if (body.create && spot.exists) throw new HttpError(409, "a memory file with this name already exists");
    let content;
    if (typeof body.content === "string") content = body.content;
    else {
      content = spot.exists ? (await readSmall(spot.real)).content : "";
      if (body.meta && typeof body.meta === "object") {
        const pick = (key) => (typeof body.meta[key] === "string" ? body.meta[key].trim() : undefined);
        content = setMemoryMeta(content, { name: pick("name"), description: pick("description"), type: pick("type") });
      }
      if (typeof body.body === "string") content = replaceBody(content, body.body);
    }
    return { path: spot.full, ...(await atomicWrite(spot.real, content)) };
  });

  route("DELETE", "/api/memory/file", async ({ query }) => {
    const root = await memoryRoot(query.get("cwd"));
    const spot = await locate(root, query.get("rel"));
    if (!spot.exists) throw new HttpError(404, "memory file not found");
    await unlink(spot.full);
    return { ok: true };
  });

  // body: { cwd, op: "add" | "remove", rel, title?, description? } → edits MEMORY.md's line for rel
  route("POST", "/api/memory/index", async ({ body }) => {
    const root = await memoryRoot(body.cwd);
    let rel;
    try {
      rel = cleanRelPath(body.rel);
    } catch (error) {
      throw bad(error);
    }
    if (rel === INDEX_NAME) throw new HttpError(400, "MEMORY.md cannot list itself");
    const spot = await locate(root, INDEX_NAME, { create: true });
    const current = spot.exists ? (await readSmall(spot.real)).content : "";
    let next;
    if (body.op === "add") next = upsertIndexEntry(current, { file: rel, title: body.title, description: body.description });
    else if (body.op === "remove") next = removeIndexEntry(current, rel);
    else throw new HttpError(400, "op must be add or remove");
    if (next === current) return { path: spot.full, changed: false, ...indexStats(next) };
    await atomicWrite(spot.real, next);
    return { path: spot.full, changed: true, ...indexStats(next) };
  });

  // CLAUDE.md tab extras: AGENTS.md / .claude/CLAUDE.md presence and claudeMdExcludes.
  route("GET", "/api/memory/overview", async ({ query }) => {
    const cwd = query.get("cwd") ? path.resolve(query.get("cwd")) : "";
    const exists = async (target) => Boolean(await stat(target).catch(() => null));
    const resolved = await effectiveSettings(cwd || undefined);
    const out = { agentsMd: [], dotClaudeMd: null, claudeMd: false, excludes: Array.isArray(resolved.effective?.claudeMdExcludes) ? resolved.effective.claudeMdExcludes : [] };
    if (!cwd) return out;
    for (const target of [path.join(cwd, "AGENTS.md"), path.join(cwd, ".claude", "AGENTS.md")]) if (await exists(target)) out.agentsMd.push(target);
    const dot = path.join(cwd, ".claude", "CLAUDE.md");
    if (await exists(dot)) out.dotClaudeMd = dot;
    out.claudeMd = (await exists(path.join(cwd, "CLAUDE.md"))) || (await exists(path.join(cwd, "CLAUDE.local.md"))) || Boolean(out.dotClaudeMd);
    return out;
  });
}
