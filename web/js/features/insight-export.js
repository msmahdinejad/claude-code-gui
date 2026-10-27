// Conversation export (Markdown / JSON / clipboard) + commands.
import { copyText, toast } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { app } from "../core/state.js";
import { registerCommand } from "../core/registry.js";
import { toolResultText } from "../chat/reducer.js";
import { download, safeFileName } from "./insight-shared.js";

function resultOf(tool) {
  return tool.result ? tool.result.text ?? toolResultText(tool.result.content) : "";
}

const clip = (text, lines = 20) => {
  const all = String(text ?? "").split("\n");
  return all.length > lines ? `${all.slice(0, lines).join("\n")}\n… (${all.length - lines} more lines)` : all.join("\n");
};

function toolLine(tool) {
  const input = tool.input || {};
  const target = input.command || input.file_path || input.notebook_path || input.pattern || input.url || input.query || input.description || input.prompt || "";
  return `${tool.name}${target ? `: ${String(target).split("\n")[0].slice(0, 160)}` : ""}`;
}

function title(conv) {
  return app.sessions.find((session) => session.id === conv.id)?.title || conv.title || conv.items.find((item) => item.kind === "user")?.text?.split("\n")[0] || "conversation";
}

export function conversationToMarkdown(conv) {
  const live = app.live.get(conv.id);
  const out = [`# ${title(conv)}`, ""];
  out.push(`- ${t("Session")}: \`${conv.id}\``);
  if (conv.cwd) out.push(`- ${t("Folder")}: \`${conv.cwd}\``);
  const model = live?.init?.model || conv.init?.model;
  if (model) out.push(`- ${t("Model")}: \`${model}\``);
  out.push(`- ${t("Exported")}: ${new Date().toISOString()}`, "");
  for (const item of conv.items) {
    if (item.kind === "user") {
      out.push(`## ${t("You")}`, "");
      if (item.command) out.push(`\`${item.command.name}\` ${item.command.args || ""}`.trim(), "");
      if (item.text) out.push(item.text, "");
      if (item.images?.length) out.push(`_${item.images.length} ${t("image(s) attached")}_`, "");
    } else if (item.kind === "assistant") {
      out.push(`## Claude`, "");
      for (const block of item.blocks) {
        if (block.type === "text" && block.text) out.push(block.text, "");
        else if (block.type === "thinking" && block.text) out.push(`<details><summary>${t("Thinking")}</summary>`, "", block.text, "", "</details>", "");
        else if (block.type === "tool") {
          const tool = conv.tools.get(block.toolUseId);
          if (!tool) continue;
          out.push(`> **${t("Tool")}** \`${toolLine(tool).replace(/`/g, "'")}\` — ${tool.status}`, "");
          const text = resultOf(tool);
          if (text && ["Bash", "PowerShell", "Grep", "Glob", "Read"].includes(tool.name)) out.push("```", clip(text, 15), "```", "");
        }
      }
    } else if (item.kind === "notice") {
      out.push(`> ⚠ ${item.text}${item.detail ? ` — ${String(item.detail).split("\n")[0]}` : ""}`, "");
    } else if (item.kind === "boundary") {
      out.push(`---`, `_${item.text}_`, `---`, "");
    } else if (item.kind === "output") {
      out.push("```", clip(item.text, 30), "```", "");
    }
  }
  return `${out.join("\n").trim()}\n`;
}

export function conversationToJson(conv) {
  const live = app.live.get(conv.id);
  const items = conv.items.map((item) => {
    if (item.kind === "assistant") {
      return {
        kind: "assistant",
        messageId: item.messageId,
        model: item.model,
        usage: item.usage,
        stopReason: item.stopReason,
        blocks: item.blocks.map((block) => {
          if (block.type !== "tool") return { type: block.type, text: block.text };
          const tool = conv.tools.get(block.toolUseId);
          return { type: "tool", id: tool?.id, name: tool?.name, input: tool?.input, status: tool?.status, result: tool?.result ? { isError: tool.result.isError, text: resultOf(tool) } : null };
        }),
      };
    }
    if (item.kind === "user") return { kind: "user", uuid: item.uuid, text: item.text, command: item.command, images: item.images?.length || 0, at: item.at };
    const { key, v, ...rest } = item;
    return rest;
  });
  return JSON.stringify({ session: { id: conv.id, cwd: conv.cwd, title: title(conv), model: live?.init?.model || conv.init?.model || null }, exportedAt: new Date().toISOString(), items }, null, 2);
}

function current() {
  const conv = app.convs.get(app.currentId);
  if (!conv?.items.length) {
    toast(t("There is nothing to export yet."), "error");
    return null;
  }
  return conv;
}

export function exportMarkdown() {
  const conv = current();
  if (conv) download(`${safeFileName(title(conv))}.md`, conversationToMarkdown(conv), "text/markdown");
}

export function exportJson() {
  const conv = current();
  if (conv) download(`${safeFileName(title(conv))}.json`, conversationToJson(conv), "application/json");
}

export function copyMarkdown() {
  const conv = current();
  if (conv) copyText(conversationToMarkdown(conv), t("Copied as Markdown"));
}

registerCommand({ id: "export-md", title: "Export conversation (Markdown)", icon: "download", keywords: ["save", "download", "md"], slash: "export", run: exportMarkdown });
registerCommand({ id: "export-json", title: "Export conversation (JSON)", icon: "download", keywords: ["save", "download"], run: exportJson });
registerCommand({ id: "copy-md", title: "Copy conversation as Markdown", icon: "copy", run: copyMarkdown });
