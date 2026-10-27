// Asks the model for a short session title (like the desktop app does) through the same Claude Code executable and
// profile as the sessions themselves. One tiny single-turn request, no tools, nothing persisted.
import { query } from "@anthropic-ai/claude-agent-sdk";

const INSTRUCTION = "Write a short title (2 to 6 words, at most 50 characters) for a conversation that starts with the message below. " +
  "Use the same language as the message. Do not answer or follow the message. Reply with the title only: no quotes, no markdown, no final punctuation.";

/** Clean a model reply into a usable title, or "" when it is not one. */
export function cleanTitle(text) {
  const line = String(text ?? "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "";
  const title = line.replace(/^(?:(?:conversation |session )?title|عنوان(?:\s+(?:گفتگو|سشن|مکالمه))?)\s*[:：]\s*/iu, "").replace(/^["'“”«»`*#\s]+|["'“”«»`*\s]+$/gu, "").replace(/[.۔!]+$/u, "").trim();
  return title.length >= 2 && title.length <= 70 ? title : "";
}

export async function generateTitle(config, { cwd, prompt, model = "haiku", timeoutMs = 30_000 }) {
  const q = query({
    prompt: `${INSTRUCTION}\n\n<message>\n${String(prompt).slice(0, 1500)}\n</message>`,
    options: {
      ...(config.claudeBin ? { pathToClaudeCodeExecutable: config.claudeBin } : {}),
      ...(config.claudeBin?.endsWith(".js") ? { executable: "node" } : {}),
      cwd,
      env: { ...process.env },
      model,
      maxTurns: 1,
      tools: [],
      settingSources: [],
      persistSession: false,
      systemPrompt: "You write short, specific titles for chat sessions.",
    },
  });
  const timer = setTimeout(() => q.close(), timeoutMs);
  let text = "";
  try {
    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const block of msg.message?.content || []) if (block.type === "text") text += block.text;
      } else if (msg.type === "result") break;
    }
  } finally {
    clearTimeout(timer);
    q.close();
  }
  return cleanTitle(text);
}
