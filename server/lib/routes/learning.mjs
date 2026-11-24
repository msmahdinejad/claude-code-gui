// Settings → Learning: a read-mostly view of a "learning loop" kept in the profile's config folder:
//   <config>/learning/inbox.jsonl        lessons caught by hooks (corrections, "remember" requests, skill candidates)
//   <config>/learning/skill-usage.jsonl  one line per Skill call
//   <config>/learning/garden/*.md        upkeep reports
//   <config>/skills/*/SKILL.md           skills; those with `origin: learned` are the learned ones
//   <config>/.git                        a local history of what changed
// Nothing here is required: every part is optional and the page says what is missing. The only write is changing an
// inbox item's status. Paths are fixed names under the config folder; git runs with argument arrays, never a shell.
import { existsSync } from "node:fs";
import { readFile, readdir, stat, writeFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";

const MAX_ITEMS = 300;
const MAX_FILE = 2 * 1024 * 1024;
const USAGE_DAYS = 60;
const STATUSES = new Set(["pending", "applied", "applied-by-session", "skipped"]);

const git = (cwd, args) => new Promise((resolve) => {
  execFile("git", ["-C", cwd, ...args], { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
});

async function readText(file, max = MAX_FILE) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > max) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

const jsonLines = (text) => (text || "").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((row) => row && typeof row === "object");

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || "");
  const out = {};
  if (!match) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv && kv[2] !== "") out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export default function register({ route, HttpError, cfiles }) {
  const base = () => cfiles.configDir();
  const dir = () => path.join(base(), "learning");
  const inboxFile = () => path.join(dir(), "inbox.jsonl");

  async function settingsHooks() {
    const text = await readText(path.join(base(), "settings.json"));
    try {
      const hooks = JSON.parse(text || "{}").hooks || {};
      return Object.entries(hooks).filter(([, list]) => JSON.stringify(list).includes("learn")).map(([event]) => event);
    } catch {
      return [];
    }
  }

  async function skills(usage) {
    const root = path.join(base(), "skills");
    let names;
    try { names = await readdir(root); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
      const text = await readText(path.join(root, name, "SKILL.md"), 512 * 1024);
      if (text === null) continue;
      const meta = frontmatter(text);
      const learned = meta.origin === "learned" || name.startsWith("learned-");
      const used = usage.get(name);
      if (!learned && !used) continue;
      out.push({ name, learned, description: (meta.description || "").slice(0, 300), updated: meta.updated || null, uses: used?.count || 0, failed: used?.failed || 0, lastUsed: used?.last || null });
    }
    return out.sort((a, b) => Number(b.learned) - Number(a.learned) || b.uses - a.uses || a.name.localeCompare(b.name));
  }

  route("GET", "/api/learning", async () => {
    const configDir = base();
    const present = existsSync(dir());
    const inbox = jsonLines(await readText(inboxFile())).slice(-MAX_ITEMS).reverse()
      .map(({ id, ts, type, status, cwd, text }) => ({ id: String(id || ""), ts, type, status, project: cwd ? path.basename(String(cwd)) : "", text: String(text || "").slice(0, 600) }));
    const since = Date.now() - USAGE_DAYS * 86_400_000;
    const usage = new Map();
    for (const row of jsonLines(await readText(path.join(dir(), "skill-usage.jsonl")))) {
      const at = Date.parse(row.ts);
      if (!row.skill || !(at >= since)) continue;
      const entry = usage.get(row.skill) || { count: 0, failed: 0, last: null };
      entry.count += 1;
      if (row.failed) entry.failed += 1;
      if (!entry.last || row.ts > entry.last) entry.last = row.ts;
      usage.set(row.skill, entry);
    }
    let reports = [];
    try {
      reports = (await readdir(path.join(dir(), "garden"))).filter((name) => /^[\w.-]+\.md$/.test(name)).sort().reverse().slice(0, 20);
    } catch { /* none */ }
    const log = existsSync(path.join(configDir, ".git")) ? await git(configDir, ["log", "-n", "40", "--date=iso-strict", "--pretty=format:%h%x09%ad%x09%s"]) : null;
    const history = (log || "").split("\n").filter(Boolean).map((line) => { const [sha, date, ...rest] = line.split("\t"); return { sha, date, subject: rest.join("\t") }; });
    const meta = JSON.parse((await readText(path.join(dir(), "reflect-state.json"))) || "{}");
    return {
      configDir, present, hooks: await settingsHooks(), versioned: log !== null,
      counts: inbox.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {}),
      inbox, skills: await skills(usage), reports, history, lastReflectAt: meta.lastReflectAt || null, usageDays: USAGE_DAYS,
    };
  });

  route("POST", "/api/learning/inbox/([A-Za-z0-9_-]{1,64})", async ({ params, body }) => {
    const status = body?.status;
    if (!STATUSES.has(status)) throw new HttpError(400, "Unknown status");
    const text = await readText(inboxFile());
    if (text === null) throw new HttpError(404, "The inbox is empty");
    let found = false;
    const lines = text.split("\n").map((line) => {
      if (!line.trim()) return line;
      try {
        const row = JSON.parse(line);
        if (row.id !== params[0]) return line;
        found = true;
        return JSON.stringify({ ...row, status });
      } catch {
        return line;
      }
    });
    if (!found) throw new HttpError(404, "No such item");
    const tmp = `${inboxFile()}.${process.pid}.tmp`;
    await writeFile(tmp, lines.join("\n"), "utf8");
    await rename(tmp, inboxFile());
    return { ok: true };
  });

  route("GET", "/api/learning/report/([\\w.-]{1,80}\\.md)", async ({ params }) => {
    const text = await readText(path.join(dir(), "garden", params[0]));
    if (text === null) throw new HttpError(404, "No such report");
    return { name: params[0], text };
  });

  route("GET", "/api/learning/commit/([0-9a-f]{7,40})", async ({ params }) => {
    const out = await git(base(), ["show", "--stat", "--patch", "--no-color", "--format=%h %ad%n%s%n", "--date=iso-strict", params[0], "--", "rules", "skills", "agents", "CLAUDE.md", "projects", "settings.json"]);
    if (out === null) throw new HttpError(404, "No such change");
    return { sha: params[0], text: out.length > 200_000 ? `${out.slice(0, 200_000)}\n…` : out };
  });
}
