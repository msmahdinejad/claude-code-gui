// Routes for the insight panels (stderr tail, raw message buffer, project token usage).
import { listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { deriveTitle } from "../title.mjs";

const usageCache = new Map(); // sessionId -> { mtime, usage }

function tally(messages) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, models: {} };
  const seen = new Set();
  for (const entry of messages) {
    if (entry.type !== "assistant") continue;
    const message = entry.message || {};
    const usage = message.usage;
    if (!usage || (message.id && seen.has(message.id))) continue;
    if (message.id) seen.add(message.id);
    total.input += usage.input_tokens || 0;
    total.output += usage.output_tokens || 0;
    total.cacheRead += usage.cache_read_input_tokens || 0;
    total.cacheWrite += usage.cache_creation_input_tokens || 0;
    total.turns += 1;
    const model = message.model || "unknown";
    total.models[model] = (total.models[model] || 0) + (usage.output_tokens || 0);
  }
  return total;
}

export default function register({ route, manager, HttpError }) {
  route("GET", "/api/sessions/([^/]+)/stderr", async ({ params }) => {
    const target = manager.get(params[0]);
    if (!target) throw new HttpError(404, "session not found");
    return { lines: target.stderr.slice(-300), state: target.state, startError: target.startError };
  });

  // Last N raw SDK messages (stream_event deltas omitted) for the Activity tab's raw inspector.
  route("GET", "/api/sessions/([^/]+)/raw", async ({ params, query }) => {
    const target = manager.get(params[0]);
    if (!target) throw new HttpError(404, "session not found");
    const limit = Math.min(Number(query.get("limit")) || 200, 600);
    const entries = target.buffer.filter((entry) => entry.msg.type !== "stream_event").slice(-limit);
    return { entries, seq: target.seq };
  });

  // Token totals across the project's most recent sessions (cost is not stored in transcripts).
  route("GET", "/api/insight/project-usage", async ({ query }) => {
    const dir = query.get("cwd") || undefined;
    const infos = (await listSessions({ dir, limit: 60, includeWorktrees: true }).catch(() => [])).slice(0, 40);
    const sessions = [];
    const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
    for (const info of infos) {
      let cached = usageCache.get(info.sessionId);
      if (!cached || cached.mtime !== info.lastModified) {
        const messages = await getSessionMessages(info.sessionId, { dir: info.cwd || dir }).catch(() => []);
        cached = { mtime: info.lastModified, usage: tally(messages) };
        usageCache.set(info.sessionId, cached);
      }
      const usage = cached.usage;
      sessions.push({ id: info.sessionId, title: info.customTitle || deriveTitle(info.firstPrompt), lastModified: info.lastModified, ...usage });
      for (const key of Object.keys(sum)) sum[key] += usage[key];
    }
    return { sessions, total: sum, scanned: infos.length };
  });
}
