// Local filesystem + git helpers behind the Files / Changes panels and @-mentions.
// Everything is read-only except writeTextFile(), which the caller restricts to
// whitelisted paths (CLAUDE.md, settings files).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat, writeFile, mkdir, copyFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const run = promisify(execFile);
const MAX_READ = 2 * 1024 * 1024;
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

export async function readTextFile(path, { max = MAX_READ } = {}) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("not a file");
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXT.has(ext) && ext !== ".svg") {
    return { path, size: info.size, kind: "image", mime: `image/${ext.slice(1) === "jpg" ? "jpeg" : ext.slice(1)}`, base64: (await readFile(path)).toString("base64") };
  }
  const buffer = await readFile(path);
  const sample = buffer.subarray(0, 4096);
  if (sample.includes(0)) return { path, size: info.size, kind: "binary" };
  const truncated = buffer.length > max;
  return {
    path,
    size: info.size,
    mtime: info.mtimeMs,
    kind: "text",
    truncated,
    content: buffer.subarray(0, max).toString("utf8"),
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
    const { stdout } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    files = stdout.split(/\r?\n/).filter(Boolean);
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
  const { stdout } = await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...opts });
  return stdout;
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

export async function gitDiff(cwd, { path, staged = false, base } = {}) {
  const args = ["diff", "--no-color", "--no-ext-diff", "-U4"];
  if (staged) args.push("--cached");
  if (base) args.push(base);
  if (path) args.push("--", path);
  let diff = await git(cwd, args);
  if (path && !diff) {
    // Untracked file: synthesize an all-added diff.
    try {
      const info = await readTextFile(resolve(cwd, path), { max: 400_000 });
      if (info.kind === "text") {
        const lines = info.content.split("\n");
        diff = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
      }
    } catch { /* ignore */ }
  }
  return { diff };
}

export async function gitLog(cwd, limit = 30) {
  const out = await git(cwd, ["log", `-${limit}`, "--pretty=format:%H%x1f%an%x1f%ad%x1f%s", "--date=iso-strict"]);
  return out.split("\n").filter(Boolean).map((line) => {
    const [hash, author, date, subject] = line.split("\x1f");
    return { hash, author, date, subject };
  });
}

export async function gitBranches(cwd) {
  const out = await git(cwd, ["branch", "--format=%(refname:short)%1f%(HEAD)"]);
  return out.split("\n").filter(Boolean).map((line) => {
    const [name, head] = line.split("\x1f");
    return { name, current: head === "*" };
  });
}

export async function gitAction(cwd, action, args = {}) {
  switch (action) {
    case "stage":
      await git(cwd, ["add", "--", ...args.paths]);
      return { ok: true };
    case "unstage":
      await git(cwd, ["restore", "--staged", "--", ...args.paths]);
      return { ok: true };
    case "commit": {
      if (!args.message?.trim()) throw new Error("commit message required");
      const out = await git(cwd, ["commit", "-m", args.message]);
      return { ok: true, output: out };
    }
    case "checkout":
      await git(cwd, ["checkout", args.branch]);
      return { ok: true };
    case "createBranch":
      await git(cwd, ["checkout", "-b", args.branch]);
      return { ok: true };
    default:
      throw new Error(`unknown git action: ${action}`);
  }
}
