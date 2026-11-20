// Prompt history across sessions: reads Claude Code's own <config dir>/history.jsonl (one JSON object per line:
// { display, pastedContents, timestamp, project, sessionId }) so the composer's Ctrl+R can offer earlier prompts.
// Only that one file is read, only its tail, and only the text of each prompt leaves the server.
import { open } from "node:fs/promises";
import { join } from "node:path";

const TAIL_BYTES = 4 * 1024 * 1024; // the newest prompts are at the end; a big history is never read whole
const MAX_TEXT = 4000; // characters of one prompt sent to the browser
const MAX_QUERY = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const normalizeProject = (value) => {
  const path = String(value || "").replaceAll("\\", "/").replace(/\/+$/, "");
  // A Windows folder (drive letter) compares case-insensitively wherever the server runs, e.g. a history file copied from Windows.
  return process.platform === "linux" && !/^[A-Za-z]:\//.test(path) ? path : path.toLowerCase();
};

async function readTail(file, bytes) {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return { text: "", partial: false };
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    let text = buffer.subarray(0, filled).toString("utf8");
    if (start > 0) { // the window starts mid-line: drop the cut first line
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
    return { text, partial: start > 0 };
  } finally {
    await handle.close();
  }
}

/**
 * The newest prompts of a history file, newest first and without repeats.
 * `project` limits them to one folder, `q` is a case-insensitive text filter. Malformed lines are skipped.
 */
export async function readHistory(file, { project = "", q = "", limit = DEFAULT_LIMIT, tailBytes = TAIL_BYTES } = {}) {
  const max = Math.min(Math.max(Math.floor(Number(limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const wantProject = normalizeProject(project);
  const needle = String(q || "").slice(0, MAX_QUERY).toLowerCase();
  const { text, partial } = await readTail(file, tailBytes);
  const lines = text.split("\n");
  const seen = new Set();
  const entries = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < max; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const display = row && typeof row === "object" && typeof row.display === "string" ? row.display.trim() : "";
    if (!display) continue;
    const rowProject = typeof row.project === "string" ? row.project : "";
    if (wantProject && normalizeProject(rowProject) !== wantProject) continue;
    if (needle && !display.toLowerCase().includes(needle)) continue;
    if (seen.has(display)) continue;
    seen.add(display);
    entries.push({
      text: display.length > MAX_TEXT ? display.slice(0, MAX_TEXT) : display,
      truncated: display.length > MAX_TEXT,
      project: rowProject,
      timestamp: Number.isFinite(row.timestamp) ? row.timestamp : null,
      sessionId: typeof row.sessionId === "string" ? row.sessionId : null,
    });
  }
  return { entries, partial };
}

export default function register({ route, cfiles }) {
  route("GET", "/api/history", async ({ query }) => {
    const file = join(cfiles.configDir(), "history.jsonl");
    return readHistory(file, { project: query.get("project") || "", q: query.get("q") || "", limit: query.get("limit") });
  });
}
