// Locations of Claude Code's config files (user / project / local scope), plus generic
// CRUD for resource folders (agents, skills, commands, output styles) and CLAUDE.md.
import { readdir, readFile, rm, stat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listDir, readTextFile, writeTextFile } from "./fs-git.mjs";

export function configDir() {
  return resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
}

function scopeRoot(scope, cwd) {
  if (scope === "user") return configDir();
  if (!cwd) throw new Error("cwd is required for project/local scope");
  return join(resolve(cwd), ".claude");
}

export function settingsPath(scope, cwd) {
  if (scope === "user") return join(configDir(), "settings.json");
  if (scope === "project") return join(scopeRoot(scope, cwd), "settings.json");
  if (scope === "local") return join(scopeRoot(scope, cwd), "settings.local.json");
  throw new Error(`bad scope: ${scope}`);
}

export function claudeMdPath(scope, cwd) {
  if (scope === "user") return join(configDir(), "CLAUDE.md");
  if (!cwd) throw new Error("cwd is required");
  if (scope === "project") return join(resolve(cwd), "CLAUDE.md");
  if (scope === "local") return join(resolve(cwd), "CLAUDE.local.md");
  throw new Error(`bad scope: ${scope}`);
}

export async function readSettings(scope, cwd) {
  const path = settingsPath(scope, cwd);
  try {
    const text = await readFile(path, "utf8");
    return { path, exists: true, text, json: safeParse(text) };
  } catch (error) {
    if (error.code === "ENOENT") return { path, exists: false, text: "{}\n", json: {} };
    throw error;
  }
}

export async function writeSettings(scope, cwd, text) {
  const parsed = JSON.parse(text); // reject invalid JSON before touching disk
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings must be a JSON object");
  return writeTextFile(settingsPath(scope, cwd), `${JSON.stringify(parsed, null, 2)}\n`);
}

export async function readClaudeMd(scope, cwd) {
  const path = claudeMdPath(scope, cwd);
  try {
    const info = await readTextFile(path);
    return { path, exists: true, content: info.content };
  } catch (error) {
    if (error.code === "ENOENT") return { path, exists: false, content: "" };
    throw error;
  }
}

export async function writeClaudeMd(scope, cwd, content) {
  return writeTextFile(claudeMdPath(scope, cwd), content);
}

const KINDS = {
  agents: { dir: "agents", ext: ".md", flat: true },
  commands: { dir: "commands", ext: ".md", flat: true },
  "output-styles": { dir: "output-styles", ext: ".md", flat: true },
  skills: { dir: "skills", ext: null, flat: false }, // skills/<name>/SKILL.md
  rules: { dir: "rules", ext: ".md", flat: true },
};

function kindInfo(kind) {
  const info = KINDS[kind];
  if (!info) throw new Error(`unknown resource kind: ${kind}`);
  return info;
}

function safeName(name) {
  if (!/^[\w][\w .-]{0,80}$/.test(name) || name.includes("..")) throw new Error(`invalid name: ${name}`);
  return name;
}

export async function listResources(kind, scope, cwd) {
  const info = kindInfo(kind);
  const dir = join(scopeRoot(scope, cwd), info.dir);
  let entries;
  try {
    entries = await listDir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return { dir, items: [] };
    throw error;
  }
  const items = [];
  for (const entry of entries) {
    if (info.flat && !entry.dir && entry.name.endsWith(info.ext)) {
      items.push({ name: entry.name.slice(0, -info.ext.length), path: entry.path });
    } else if (!info.flat && entry.dir) {
      const file = join(entry.path, "SKILL.md");
      try {
        await stat(file);
        items.push({ name: entry.name, path: file });
      } catch { /* not a skill dir */ }
    }
  }
  return { dir, items };
}

function resourcePath(kind, scope, cwd, name) {
  const info = kindInfo(kind);
  const base = join(scopeRoot(scope, cwd), info.dir);
  return info.flat ? join(base, `${safeName(name)}${info.ext}`) : join(base, safeName(name), "SKILL.md");
}

export async function readResource(kind, scope, cwd, name) {
  const path = resourcePath(kind, scope, cwd, name);
  const info = await readTextFile(path);
  return { path, content: info.content };
}

export async function writeResource(kind, scope, cwd, name, content) {
  const path = resourcePath(kind, scope, cwd, name);
  await mkdir(dirname(path), { recursive: true });
  return writeTextFile(path, content);
}

export async function deleteResource(kind, scope, cwd, name) {
  const path = resourcePath(kind, scope, cwd, name);
  const info = kindInfo(kind);
  await rm(info.flat ? path : dirname(path), { recursive: !info.flat, force: true });
  return { ok: true };
}

export async function listDirSafe(path) {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
