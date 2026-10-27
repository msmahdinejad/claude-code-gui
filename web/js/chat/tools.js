// Tool call cards: one renderer per Claude Code tool (Bash, Edit, Read, Agent, ...).
// Custom renderers can be added with registerToolRenderer() from core/registry.js.
import { h, baseName, formatDuration, shortPath } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { findToolRenderer, registerToolRenderer } from "../core/registry.js";
import { highlight, renderMarkdown, textDirection } from "./markdown.js";
import { toolResultText } from "./reducer.js";

const MAX_LINES = 60;

// ---- small renderers -------------------------------------------------------------
export function codeBlock(text, lang = "", { maxLines = MAX_LINES, cls = "" } = {}) {
  const lines = String(text ?? "").split("\n");
  const wrap = h(`div.code-block.compact${cls ? `.${cls}` : ""}`, { dir: "ltr" });
  const pre = h("pre");
  const code = h("code.hljs");
  pre.append(code);
  const render = (limit) => {
    const slice = limit ? lines.slice(0, limit).join("\n") : lines.join("\n");
    code.innerHTML = lang ? highlight(slice, lang) : escape(slice);
  };
  render(lines.length > maxLines ? maxLines : 0);
  wrap.append(pre);
  if (lines.length > maxLines) {
    const more = h("button.code-more", { type: "button" }, t("Show all {n} lines", { n: lines.length }));
    more.onclick = () => {
      render(0);
      more.remove();
    };
    wrap.append(more);
  }
  return wrap;
}

const escape = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[ch]);

export function lineDiff(before, after) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return [...a.map((text) => ({ t: "del", text })), ...b.map((text) => ({ t: "add", text }))];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: "ctx", text: a[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "del", text: a[i] }); i += 1; }
    else { out.push({ t: "add", text: b[j] }); j += 1; }
  }
  while (i < n) out.push({ t: "del", text: a[i++] });
  while (j < m) out.push({ t: "add", text: b[j++] });
  return out;
}

export function diffView(lines, { startLine, maxLines = 120 } = {}) {
  const box = h("div.diff", { dir: "ltr" });
  let shown = 0;
  let oldNo = startLine || 1;
  let newNo = startLine || 1;
  for (const line of lines) {
    if (shown >= maxLines) {
      box.append(h("div.diff-more", t("… {n} more lines", { n: lines.length - shown })));
      break;
    }
    const sign = line.t === "add" ? "+" : line.t === "del" ? "-" : " ";
    box.append(
      h(`div.diff-line.${line.t}`, h("span.diff-no", line.t === "add" ? "" : String(oldNo)), h("span.diff-no", line.t === "del" ? "" : String(newNo)), h("span.diff-sign", sign), h("span.diff-text", line.text || " ")),
    );
    if (line.t !== "add") oldNo += 1;
    if (line.t !== "del") newNo += 1;
    shown += 1;
  }
  return box;
}

export function filePath(path, extra = "") {
  return h("button.file-chip", { type: "button", title: path, onclick: (event) => { event.stopPropagation(); bus.emit("open-file", { path }); } }, icon("file", 13), h("span", baseName(path) + extra));
}

function textOf(tool) {
  if (!tool.result) return "";
  return tool.result.text ?? toolResultText(tool.result.content);
}

function section(label, content) {
  return h("div.tool-section", label ? h("div.tool-label", label) : null, content);
}

const clip = (value, max = 90) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function resultBlock(tool, lang = "") {
  const text = textOf(tool);
  if (!text) return null;
  return section(tool.status === "error" ? t("Error") : t("Output"), codeBlock(text, lang, { cls: tool.status === "error" ? "error" : "" }));
}

// ---- built-in renderers ----------------------------------------------------------
const bashLike = {
  icon: "terminal",
  title: (tool) => (tool.name === "PowerShell" ? "PowerShell" : "Bash"),
  summary: (tool) => clip(tool.input?.description || String(tool.input?.command || "").split("\n")[0]),
  body(tool) {
    const parts = [];
    if (tool.input?.command) parts.push(section(tool.input.description || "", codeBlock(tool.input.command, tool.name === "PowerShell" ? "powershell" : "bash", { cls: "command" })));
    const s = tool.structured;
    if (s && typeof s === "object" && ("stdout" in s || "stderr" in s)) {
      if (s.stdout) parts.push(section(t("Output"), codeBlock(s.stdout, "")));
      if (s.stderr) parts.push(section(t("Errors"), codeBlock(s.stderr, "", { cls: "error" })));
      if (s.interrupted) parts.push(h("div.tool-note", t("Interrupted")));
    } else {
      const block = resultBlock(tool);
      if (block) parts.push(block);
    }
    if (tool.input?.run_in_background) parts.push(h("div.tool-note", icon("clock", 12), t("Running in background")));
    return parts;
  },
  defaultOpen: (tool) => tool.status === "error" || tool.status === "running",
};
registerToolRenderer(["Bash", "PowerShell", "BashOutput"], bashLike);

registerToolRenderer("Read", {
  icon: "file-text",
  title: () => t("Read"),
  summary: (tool) => {
    const input = tool.input || {};
    const range = input.offset || input.limit ? ` (${input.offset || 1}${input.limit ? `–${(input.offset || 1) + input.limit - 1}` : "+"})` : "";
    return shortPath(input.file_path || input.path || "", 60) + range;
  },
  body: (tool) => [resultBlock(tool)],
  fileOf: (tool) => tool.input?.file_path,
});

registerToolRenderer("Write", {
  icon: "file-plus",
  title: () => t("Write"),
  summary: (tool) => shortPath(tool.input?.file_path || "", 60),
  body(tool) {
    const content = tool.input?.content ?? "";
    const lines = String(content).split("\n").map((text) => ({ t: "add", text }));
    return [diffView(lines, { maxLines: 80 }), tool.status === "error" ? resultBlock(tool) : null];
  },
  defaultOpen: () => false,
});

registerToolRenderer(["Edit", "MultiEdit", "NotebookEdit"], {
  icon: "file-diff",
  title: (tool) => (tool.name === "NotebookEdit" ? t("Edit notebook") : t("Edit")),
  summary: (tool) => shortPath(tool.input?.file_path || tool.input?.notebook_path || "", 60),
  body(tool) {
    const input = tool.input || {};
    const edits = tool.name === "MultiEdit" ? input.edits || [] : [input];
    const parts = [];
    edits.forEach((edit, index) => {
      if (tool.name === "NotebookEdit") {
        parts.push(section(`${edit.edit_mode || "replace"} · ${edit.cell_type || "cell"} ${edit.cell_id || edit.cell_number || ""}`, codeBlock(edit.new_source || "", edit.cell_type === "markdown" ? "markdown" : "python")));
        return;
      }
      if (edits.length > 1) parts.push(h("div.tool-label", `#${index + 1}`));
      parts.push(diffView(lineDiff(edit.old_string ?? "", edit.new_string ?? ""), { maxLines: 80 }));
    });
    if (tool.status === "error") parts.push(resultBlock(tool));
    return parts;
  },
  fileOf: (tool) => tool.input?.file_path,
  defaultOpen: (tool) => tool.status === "error",
});

registerToolRenderer("Grep", {
  icon: "search",
  title: () => t("Search"),
  summary: (tool) => clip(`${tool.input?.pattern || ""}${tool.input?.path ? ` · ${shortPath(tool.input.path, 30)}` : ""}${tool.input?.glob ? ` · ${tool.input.glob}` : ""}`),
  body: (tool) => [resultBlock(tool)],
});

registerToolRenderer("Glob", {
  icon: "folder-open",
  title: () => t("Find files"),
  summary: (tool) => clip(`${tool.input?.pattern || ""}${tool.input?.path ? ` · ${shortPath(tool.input.path, 30)}` : ""}`),
  body(tool) {
    const files = textOf(tool).split("\n").filter(Boolean);
    if (!files.length) return [];
    return [h("div.chip-row", files.slice(0, 60).map((file) => filePath(file)), files.length > 60 ? h("span.muted", `+${files.length - 60}`) : null)];
  },
});

registerToolRenderer("WebFetch", {
  icon: "globe",
  title: () => t("Fetch"),
  summary: (tool) => clip(tool.input?.url || ""),
  body: (tool) => [
    tool.input?.prompt ? section(t("Prompt"), h("div.muted", { dir: "auto" }, tool.input.prompt)) : null,
    textOf(tool) ? section(t("Result"), h("div.markdown", { html: renderMarkdown(textOf(tool)) })) : null,
  ],
});

registerToolRenderer(["WebSearch", "web_search"], {
  icon: "search",
  title: () => t("Web search"),
  summary: (tool) => clip(tool.input?.query || ""),
  body(tool) {
    const text = textOf(tool);
    return [text ? section(t("Result"), h("div.markdown", { html: renderMarkdown(text) })) : null];
  },
});

registerToolRenderer("TodoWrite", {
  icon: "list-todo",
  title: () => t("Update tasks"),
  summary: (tool) => {
    const todos = tool.input?.todos || [];
    const done = todos.filter((todo) => todo.status === "completed").length;
    return `${done}/${todos.length}`;
  },
  body: (tool) => [todoList(tool.input?.todos || [])],
  defaultOpen: () => true,
});

export function todoList(todos) {
  return h(
    "ul.todo-list",
    todos.map((todo) =>
      h(
        `li.todo.${todo.status}`,
        icon(todo.status === "completed" ? "check-circle" : todo.status === "in_progress" ? "loader" : "circle", 15, todo.status === "in_progress" ? "spin" : ""),
        h("span", { dir: "auto" }, todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content),
      ),
    ),
  );
}

registerToolRenderer(["Task", "Agent"], {
  icon: "bot",
  title: (tool) => tool.input?.subagent_type || t("Subagent"),
  summary: (tool) => clip(tool.input?.description || ""),
  body(tool, ctx) {
    const parts = [];
    if (tool.input?.prompt) parts.push(section(t("Prompt"), h("div.muted.pre", { dir: "auto" }, clip(tool.input.prompt, 1200))));
    const task = tool.task;
    if (task) {
      parts.push(
        h(
          "div.task-line",
          icon(task.status === "completed" ? "check-circle" : task.status === "failed" ? "x-circle" : "loader", 14, task.status === "running" ? "spin" : ""),
          h("span", task.summary || task.description || task.status),
          task.lastTool ? h("span.muted", ` · ${task.lastTool}`) : null,
        ),
      );
    }
    if (tool.children?.length) {
      parts.push(
        h(
          "div.sub-tools",
          tool.children.map((id) => {
            const child = ctx.conv.tools.get(id);
            return child ? ctx.toolCard(child) : null;
          }),
        ),
      );
    }
    const text = textOf(tool);
    if (text) parts.push(section(t("Report"), h("div.markdown", { html: renderMarkdown(text) })));
    return parts;
  },
  defaultOpen: (tool) => tool.status === "running",
});

registerToolRenderer("AskUserQuestion", {
  icon: "help",
  title: () => t("Question"),
  summary: (tool) => clip(tool.input?.questions?.[0]?.question || ""),
  body(tool) {
    const answers = tool.structured?.answers || {};
    return [
      h(
        "div.qa-list",
        (tool.input?.questions || []).map((q) =>
          h("div.qa", h("div.qa-q", { dir: "auto" }, q.question), answers[q.question] ? h("div.qa-a", { dir: "auto" }, answers[q.question]) : h("div.muted", t("Waiting for answer…"))),
        ),
      ),
    ];
  },
  defaultOpen: () => true,
});

registerToolRenderer(["ExitPlanMode", "EnterPlanMode"], {
  icon: "list",
  title: (tool) => (tool.name === "ExitPlanMode" ? t("Plan") : t("Enter plan mode")),
  summary: (tool) => (tool.status === "done" ? t("Approved") : tool.status === "denied" ? t("Rejected") : ""),
  body: (tool) => [tool.input?.plan ? h("div.markdown.plan", { html: renderMarkdown(tool.input.plan) }) : null],
  defaultOpen: () => true,
});

registerToolRenderer("Skill", {
  icon: "sparkles",
  title: () => t("Skill"),
  summary: (tool) => clip(`${tool.input?.skill || tool.input?.name || ""} ${tool.input?.args || ""}`),
  body: (tool) => [resultBlock(tool)],
});

registerToolRenderer(/^(Task(Create|Update|Get|List|Stop|Output)|Cron(Create|Delete|List)|ScheduleWakeup|Monitor)$/, {
  icon: "clock",
  title: (tool) => tool.name,
  summary: (tool) => clip(tool.input?.subject || tool.input?.description || tool.input?.prompt || tool.input?.cron || ""),
  body: (tool) => [h("pre.json", { dir: "ltr" }, JSON.stringify(tool.input ?? {}, null, 2)), resultBlock(tool)],
});

registerToolRenderer(/^mcp__/, {
  icon: "plug",
  title: (tool) => {
    const [, server, ...rest] = tool.name.split("__");
    return `${server} · ${rest.join("__")}`;
  },
  summary: (tool) => clip(JSON.stringify(tool.input ?? {})),
  body: (tool) => [section(t("Input"), codeBlock(JSON.stringify(tool.input ?? {}, null, 2), "json")), resultBlock(tool)],
});

const fallback = {
  icon: "wrench",
  title: (tool) => tool.name || t("Tool"),
  summary: (tool) => clip(JSON.stringify(tool.input ?? {})),
  body: (tool) => [section(t("Input"), codeBlock(JSON.stringify(tool.input ?? {}, null, 2), "json")), resultBlock(tool)],
};

// ---- card ------------------------------------------------------------------------
const STATUS_ICON = { running: "loader", streaming: "loader", pending: "clock", done: "check", error: "x-circle", denied: "shield", interrupted: "stop" };

export class ToolCard {
  constructor(tool, ctx) {
    this.tool = tool;
    this.ctx = ctx;
    this.renderedV = -1;
    this.open = undefined;
    this.bodyBuilt = false;
    this.el = h("div.tool");
    this.head = null;
    this.update(tool);
  }

  isOpen() {
    if (this.open !== undefined) return this.open;
    const renderer = findToolRenderer(this.tool.name) || fallback;
    if (this.tool.awaiting) return false; // the docked approval card already shows the details
    if (renderer.defaultOpen) return renderer.defaultOpen(this.tool);
    return Boolean(app.prefs.expandTools);
  }

  update(tool) {
    this.tool = tool;
    if (tool.v === this.renderedV) return this.el;
    this.renderedV = tool.v;
    const renderer = findToolRenderer(tool.name) || fallback;
    const open = this.isOpen();
    this.el.className = `tool status-${tool.status}${tool.awaiting ? " awaiting" : ""}${open ? " open" : ""}`;
    this.el.dataset.tool = tool.name;
    this.el.dataset.id = tool.id;
    const spinning = tool.status === "running" || tool.status === "streaming";
    const title = renderer.title(tool);
    const summary = renderer.summary?.(tool) || "";
    const took = tool.endedAt && tool.startedAt ? tool.endedAt - tool.startedAt : 0;
    const elapsed = took >= 1000 ? formatDuration(took) : tool.progress?.elapsed ? `${Math.round(tool.progress.elapsed)}s` : "";
    const head = h(
      "button.tool-head",
      { type: "button", "aria-expanded": String(open), onclick: () => this.toggle() },
      h("span.tool-icon", icon(renderer.icon || "wrench", 15)),
      h("span.tool-title", title),
      h("span.tool-sub", { dir: "auto" }, summary),
      tool.awaiting ? h("span.badge.warn", t("Needs approval")) : null,
      elapsed ? h("span.tool-meta", elapsed) : null,
      h("span.tool-state", icon(STATUS_ICON[tool.status] || "circle", 14, spinning ? "spin" : "")),
      icon("chevron-down", 14, "tool-chevron"),
    );
    this.head?.replaceWith(head);
    if (!this.head) this.el.prepend(head);
    this.head = head;
    if (open) this.renderBody(renderer);
    else if (this.bodyEl) {
      this.bodyEl.remove();
      this.bodyEl = null;
    }
    return this.el;
  }

  renderBody(renderer) {
    const nodes = (renderer.body?.(this.tool, this.ctx) || []).flat().filter(Boolean);
    const body = h("div.tool-body", nodes.length ? nodes : [h("div.muted", this.tool.status === "running" ? t("Running…") : t("No details"))]);
    if (this.tool.denyMessage) body.append(h("div.tool-note.danger", icon("shield", 12), this.tool.denyMessage));
    this.bodyEl?.replaceWith(body);
    if (!this.bodyEl) this.el.append(body);
    this.bodyEl = body;
  }

  toggle() {
    this.open = !this.isOpen();
    this.renderedV = -1;
    this.update(this.tool);
  }
}

export { fallback as fallbackToolRenderer };
export { textDirection };
