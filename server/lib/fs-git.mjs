// Local filesystem + git helpers behind the Files / Changes panels and @-mentions.
// Everything is read-only except writeTextFile(), which the caller restricts to
// whitelisted paths (CLAUDE.md, settings files).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat, writeFile, mkdir, copyFile, open } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const run = promisify(execFile);
const MAX_READ = 2 * 1024 * 1024;
const MAX_READ_CAP = 8 * 1024 * 1024; // hard upper bound for any caller-supplied `max`
const MAX_IMAGE = 15 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "__pycache__", ".venv", "venv", ".cache", "target"]);

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".svg"]);

export function resolveInside(root, target) {
  const full = isAbsolute(target) ? resolve(target) : resolve(root, target);
  return full;
}

export async function listDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    out.push({ name: entry.name, dir: entry.isDirectory(), path: join(dir, entry.name) });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return out;
}

/** Read at most `max` bytes from the start of a file (never the whole file when it is larger). */
async function readHead(path, max) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(max);
    let filled = 0;
    while (filled < max) {
      const { bytesRead } = await handle.read(buffer, filled, max - filled, filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

export async function readTextFile(path, { max = MAX_READ } = {}) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("not a file");
  const limit = Math.min(Math.max(Math.floor(Number(max)) || MAX_READ, 1), MAX_READ_CAP);
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXT.has(ext) && ext !== ".svg") {
    if (info.size > MAX_IMAGE) return { path, size: info.size, kind: "binary" };
    return { path, size: info.size, kind: "image", mime: `image/${ext.slice(1) === "jpg" ? "jpeg" : ext.slice(1)}`, base64: (await readFile(path)).toString("base64") };
  }
  const buffer = await readHead(path, Math.min(limit, info.size));
  const sample = buffer.subarray(0, 4096);
  if (sample.includes(0)) return { path, size: info.size, kind: "binary" };
  return {
    path,
    size: info.size,
    mtime: info.mtimeMs,
    kind: "text",
    truncated: info.size > limit,
    content: buffer.toString("utf8"),
  };
}

export async function writeTextFile(path, content, { backup = true } = {}) {
  await mkdir(dirname(path), { recursive: true });
  if (backup) {
    try {
      await stat(path);
      await copyFile(path, `${path}.wheelhouse-backup`);
    } catch { /* new file */ }
  }
  await writeFile(path, content, "utf8");
  const info = await stat(path);
  return { path, size: info.size, mtime: info.mtimeMs };
}

// Fuzzy-ish file search for @-mentions. Prefers git's file list (respects .gitignore).
export async function searchFiles(cwd, query, limit = 40) {
  let files;
  try {
    // -z: raw (unquoted, UTF-8) names, so non-ASCII paths are not returned as "\330\263…" escapes.
    const { stdout } = await run("git", ["-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" });
    files = [...new Set(stdout.split("\0").filter(Boolean))];
  } catch {
    files = await walk(cwd, 6000);
  }
  const needle = query.toLowerCase();
  if (!needle) return files.slice(0, limit).map((file) => ({ path: file }));
  const scored = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = basename(lower);
    let score = -1;
    if (base === needle) score = 1000;
    else if (base.startsWith(needle)) score = 800 - base.length;
    else if (base.includes(needle)) score = 600 - base.length;
    else if (lower.includes(needle)) score = 400 - lower.length;
    else if (isSubsequence(needle, lower)) score = 100 - lower.length;
    if (score >= 0) scored.push({ path: file, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ path }) => ({ path }));
}

function isSubsequence(needle, haystack) {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

async function walk(root, max) {
  const out = [];
  async function visit(dir) {
    if (out.length >= max) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= max) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await visit(join(dir, entry.name));
      } else {
        out.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
      }
    }
  }
  await visit(root);
  return out;
}

async function git(cwd, args, opts = {}) {
  const { stdout } = await run("git", ["-c", "core.quotepath=false", "-c", "color.ui=never", ...args], { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf8", ...opts });
  return stdout;
}

class GitArgError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/**
 * A branch / ref name as accepted by `git check-ref-format --allow-onelevel`, minus anything that
 * could be read as an option ("-x") or a pathspec ("." / "..").
 */
export function checkRefName(name) {
  const value = String(name ?? "").trim();
  const bad = !value
    || value.startsWith("-")
    || value === "@"
    || /[\x00-\x20\x7f~^:?*[\\]/.test(value)
    || value.includes("..")
    || value.includes("@{")
    || value.includes("//")
    || value.endsWith("/")
    || value.endsWith(".")
    || value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"));
  if (bad) throw new GitArgError("invalid branch name");
  return value;
}

export async function gitInfo(cwd) {
  try {
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
    const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const files = [];
    const parts = status.split("\0").filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      const entry = parts[i];
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      if (code[0] === "R" || code[0] === "C") i += 1; // skip original path
      files.push({ path, index: code[0], worktree: code[1], untracked: code === "??" });
    }
    let ahead = 0;
    let behind = 0;
    try {
      const counts = (await git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])).trim().split(/\s+/);
      behind = Number(counts[0]);
      ahead = Number(counts[1]);
    } catch { /* no upstream */ }
    return { isRepo: true, root, branch, files, ahead, behind };
  } catch (error) {
    return { isRepo: false, error: String(error.message || error).split("\n")[0] };
  }
}
