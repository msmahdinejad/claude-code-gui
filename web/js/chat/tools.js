// Tool call cards: one renderer per Claude Code tool (Bash, Edit, Read, Agent, ...).
// Custom renderers can be added with registerToolRenderer() from core/registry.js.
import { h, baseName, formatDuration, shortPath } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { findToolRenderer, registerToolRenderer } from "../core/registry.js";
import { highlight, renderMarkdown, textDirection, decorateMarkdown } from "./markdown.js";
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
  // data-file-path: a click opens the file beside the chat and a right click shows the file menu (features/file-actions.js).
  return h("button.file-chip", { type: "button", title: path, dataset: { filePath: path }, onclick: (event) => { event.stopPropagation(); bus.emit("open-file", { path }); } }, icon("file", 13), h("span", baseName(path) + extra));
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

/** Pictures a tool returned (Read of an image, screenshots from MCP tools): thumbnails, a click shows them full size. */
export function resultImages(tool) {
  const images = tool.result?.images || [];
  if (!images.length) return null;
  return h(
    "div.thumbs.result-thumbs",
    images.map((image) =>
      image.data
        ? h("img.thumb", { src: `data:${image.mediaType};base64,${image.data}`, alt: t("Image"), title: t("Show full size"), onclick: (event) => { event.stopPropagation(); bus.emit("view-image", image); } })
        : h("div.thumb-omitted", icon("image", 14), image.omitted === "count" ? t("More images not shown") : t("Image too large to show")),
    ),
  );
}

function resultBlock(tool, lang = "") {
  const text = textOf(tool);
  const images = resultImages(tool);
  const block = text ? section(tool.status === "error" ? t("Error") : t("Output"), codeBlock(text, lang, { cls: tool.status === "error" ? "error" : "" })) : null;
  return images ? [images, block] : block;
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
  defaultOpen: (tool) => Boolean(tool.result?.images?.length || app.prefs.expandTools),
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
    textOf(tool) ? section(t("Result"), decorateMarkdown(h("div.markdown", { html: renderMarkdown(textOf(tool)) }))) : null,
  ],
});

registerToolRenderer(["WebSearch", "web_search"], {
  icon: "search",
  title: () => t("Web search"),
  summary: (tool) => clip(tool.input?.query || ""),
  body(tool) {
    const text = textOf(tool);
    return [text ? section(t("Result"), decorateMarkdown(h("div.markdown", { html: renderMarkdown(text) }))) : null];
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

/** Status of a subagent: its background task when there is one (the Agent call itself returns at once when backgrounded). */
export function agentStatus(tool) {
  const status = tool.task?.status;
  if (!status) return null;
  if (["running", "pending", "in_progress"].includes(status)) return "running";
  if (status === "completed") return "done";
  if (["failed", "error"].includes(status)) return "error";
  if (["killed", "stopped", "cancelled"].includes(status)) return "interrupted";
  return null;
}

/** "17 tools · 19m 32s" from a task's progress counters. */
export function taskMeta(task) {
  const usage = task?.usage || {};
  const bits = [];
  if (usage.tool_uses) bits.push(t("{n} tools", { n: usage.tool_uses }));
  if (usage.duration_ms) bits.push(formatDuration(usage.duration_ms));
  return bits.join(" · ");
}

registerToolRenderer(["Task", "Agent"], {
  icon: "bot",
  title: (tool) => tool.input?.subagent_type || t("Subagent"),
  status: agentStatus,
  // While it works, show what it is doing now next to what it was asked to do.
  summary: (tool) => {
    const what = tool.input?.description || "";
    const now = agentStatus(tool) === "running" ? tool.task?.summary : "";
    return clip(now && now !== what ? `${what} — ${now}` : what);
  },
  meta: (tool) => (tool.task ? taskMeta(tool.task) || null : null),
  body(tool, ctx) {
    const parts = [];
    if (tool.input?.prompt) parts.push(section(t("Prompt"), h("div.muted.pre", { dir: "auto" }, clip(tool.input.prompt, 1200))));
    parts.push(taskLine(tool));
    // What the subagent wrote along the way (its own messages, not the final report).
    if (tool.notes?.length) {
      parts.push(section(t("Subagent messages"), h("div.sub-notes", tool.notes.slice(-4).map((note) => decorateMarkdown(h("div.markdown", { html: renderMarkdown(note) }))))));
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
    // A backgrounded subagent's call only answers "launched"; its work is what is shown above.
    if (text && !/^\s*Async agent launched/i.test(text)) parts.push(section(t("Report"), decorateMarkdown(h("div.markdown", { html: renderMarkdown(text) }))));
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
  body: (tool) => [tool.input?.plan ? decorateMarkdown(h("div.markdown.plan", { html: renderMarkdown(tool.input.plan) })) : null],
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

// ---- newer built-in tools (field names from sdk-tools.d.ts) --------------------------
const structuredOf = (tool) => (tool.structured && typeof tool.structured === "object" ? tool.structured : null);
const httpUrl = (value) => (typeof value === "string" && /^https?:\/\//i.test(value) ? value : null);
const externalLink = (url, label) => h("a.btn.small", { href: url, target: "_blank", rel: "noreferrer noopener", onclick: (event) => event.stopPropagation() }, icon("external", 13), label);

/** One line for a background task (a workflow run, a subagent): state icon, its status line and counters. */
function taskLine(tool) {
  const task = tool.task;
  if (!task) return null;
  const state = agentStatus(tool);
  return h(
    "div.task-line",
    icon(state === "done" ? "check-circle" : state === "error" ? "x-circle" : state === "interrupted" ? "stop" : "loader", 14, state === "running" ? "spin" : ""),
    h("span", { dir: "auto" }, task.summary || task.description || task.status),
    task.lastTool ? h("span.muted", ` · ${task.lastTool}`) : null,
    taskMeta(task) ? h("span.muted", ` · ${taskMeta(task)}`) : null,
  );
}

registerToolRenderer("Workflow", {
  icon: "layers",
  title: () => t("Workflow"),
  status: agentStatus, // the call returns at once ("async_launched"); the run is a background task
  summary: (tool) => {
    const out = structuredOf(tool);
    const name = out?.workflowName || tool.task?.workflowName || tool.input?.name || (tool.input?.scriptPath ? baseName(tool.input.scriptPath) : "");
    const now = agentStatus(tool) === "running" ? tool.task?.summary : "";
    return clip(now ? `${name} — ${now}` : name);
  },
  meta: (tool) => (tool.task ? taskMeta(tool.task) || null : null),
  body(tool) {
    const out = structuredOf(tool);
    const input = tool.input || {};
    const parts = [taskLine(tool)];
    if (out?.error) parts.push(h("div.tool-note.danger", icon("alert", 12), h("span", { dir: "auto" }, out.error)));
    if (out?.warning) parts.push(h("div.tool-note", icon("alert", 12), h("span", { dir: "auto" }, out.warning)));
    if (out?.summary && out.summary !== tool.task?.summary) parts.push(h("div.muted", { dir: "auto" }, out.summary));
    const files = [input.scriptPath || out?.scriptPath, out?.transcriptDir].filter(Boolean);
    if (files.length || httpUrl(out?.sessionUrl)) parts.push(h("div.chip-row", files.map((path) => filePath(path)), httpUrl(out?.sessionUrl) ? externalLink(out.sessionUrl, t("Open remote session")) : null));
    if (input.args && Object.keys(input.args).length) parts.push(section(t("Input"), codeBlock(JSON.stringify(input.args, null, 2), "json", { maxLines: 20 })));
    if (input.script) parts.push(section(t("Script"), codeBlock(input.script, "javascript", { maxLines: 20 })));
    if (!out) parts.push(resultBlock(tool));
    return parts;
  },
  defaultOpen: (tool) => tool.status === "error",
});

registerToolRenderer("PushNotification", {
  icon: "bell",
  title: () => t("Notification"),
  summary: (tool) => clip(tool.input?.message || ""),
  body(tool) {
    const out = structuredOf(tool);
    const reasons = { config_off: t("notifications are turned off"), user_present: t("you were at the computer"), no_transport: t("no device to notify") };
    const sent = out && (out.pushSent || out.localSent);
    return [
      h("div", { dir: "auto" }, tool.input?.message || ""),
      out ? h("div.tool-note", icon(sent ? "check" : "info", 12), sent ? t("Sent") : out.disabledReason ? t("Not sent: {reason}", { reason: reasons[out.disabledReason] || out.disabledReason }) : t("Not sent")) : null,
      tool.status === "error" ? resultBlock(tool) : null,
    ];
  },
});

const ARTIFACT_ACTIONS = { publish: () => t("Publish"), list: () => t("List"), read: () => t("Read"), pin: () => t("Pin"), unpin: () => t("Unpin") };
registerToolRenderer("Artifact", {
  icon: "globe",
  title: () => t("Artifact"),
  summary: (tool) => {
    const input = tool.input || {};
    const out = structuredOf(tool);
    const action = (ARTIFACT_ACTIONS[input.action || "publish"] || (() => input.action))();
    return clip(`${action} · ${out?.title || input.title || (input.file_path ? baseName(input.file_path) : "") || input.url || ""}`);
  },
  body(tool) {
    const input = tool.input || {};
    const out = structuredOf(tool);
    const parts = [];
    if (input.file_path) parts.push(h("div.chip-row", filePath(input.file_path)));
    if (httpUrl(out?.url)) parts.push(h("div.chip-row", externalLink(out.url, out.title || t("Open artifact")), out.version ? h("span.muted.small", `v${out.version}`) : null));
    if (Array.isArray(out?.artifacts)) {
      parts.push(h("ul.artifact-list", out.artifacts.map((entry) => h("li", httpUrl(entry.url) ? h("a", { href: entry.url, target: "_blank", rel: "noreferrer noopener", dir: "auto" }, entry.title || entry.url) : h("span", { dir: "auto" }, entry.title || ""), entry.rel === "shared" ? h("span.badge", t("Shared")) : null))));
    }
    for (const warning of out?.warnings || []) parts.push(h("div.tool-note", icon("alert", 12), h("span", { dir: "auto" }, warning)));
    if (!out || tool.status === "error") parts.push(resultBlock(tool));
    return parts;
  },
  defaultOpen: (tool) => Boolean(httpUrl(structuredOf(tool)?.url)),
});

/** Paths a SendUserFile call names (its input schema is not published: accept the usual shapes). */
function sentFiles(input = {}) {
  const list = [input.file_path, input.path, ...(Array.isArray(input.file_paths) ? input.file_paths : []), ...(Array.isArray(input.paths) ? input.paths : []), ...(Array.isArray(input.files) ? input.files : [])];
  return list.map((entry) => (typeof entry === "string" ? entry : entry?.path || entry?.file_path)).filter((entry) => typeof entry === "string" && entry);
}

registerToolRenderer("SendUserFile", {
  icon: "paperclip",
  title: () => t("Send file"),
  summary: (tool) => clip(sentFiles(tool.input).map((path) => baseName(path)).join(", ")),
  body(tool) {
    const files = sentFiles(tool.input);
    const note = tool.input?.message || tool.input?.caption || tool.input?.description;
    return [files.length ? h("div.chip-row", files.map((path) => filePath(path))) : null, note ? h("div", { dir: "auto" }, note) : null, resultBlock(tool)];
  },
  defaultOpen: () => true,
});

const OUTCOME = { fixed: () => t("Fixed"), skipped: () => t("Skipped"), no_change_needed: () => t("No change needed") };
registerToolRenderer("ReportFindings", {
  icon: "search",
  title: () => t("Findings"),
  summary: (tool) => {
    const findings = tool.input?.findings || [];
    return findings.length ? t("{n} findings", { n: findings.length }) : t("No findings");
  },
  body(tool) {
    const findings = tool.input?.findings || structuredOf(tool)?.findings || [];
    if (!findings.length) return [h("div.muted", t("No findings"))];
    return [
      h(
        "ol.findings",
        findings.map((finding) => {
          const where = `${finding.file || ""}${finding.line ? `:${finding.line}` : ""}`;
          const fix = () =>
            bus.emit("composer:fill", t("Fix this finding in {where}: {summary}\nFailure scenario: {scenario}", { where, summary: finding.summary || "", scenario: finding.failure_scenario || "" }));
          return h(
            "li.finding",
            h(
              "div.finding-head",
              finding.file ? filePath(finding.file, finding.line ? `:${finding.line}` : "") : null,
              finding.category ? h("span.badge", { dir: "ltr" }, finding.category) : null,
              finding.verdict ? h(`span.badge${finding.verdict === "CONFIRMED" ? ".ok" : ""}`, finding.verdict === "CONFIRMED" ? t("Confirmed") : t("Plausible")) : null,
              finding.outcome ? h("span.badge", (OUTCOME[finding.outcome] || (() => finding.outcome))()) : null,
              finding.outcome ? null : h("button.btn.small.finding-fix", { type: "button", title: t("Ask Claude to fix this"), onclick: (event) => { event.stopPropagation(); fix(); } }, icon("wrench", 12), t("Fix this")),
            ),
            h("div.finding-summary", { dir: "auto" }, finding.summary || finding.short_summary || ""),
            finding.failure_scenario ? h("div.finding-scenario.muted", { dir: "auto" }, finding.failure_scenario) : null,
          );
        }),
      ),
    ];
  },
  defaultOpen: () => true,
});

registerToolRenderer("ProposeGoal", {
  icon: "circle-dot",
  title: () => t("Goal"),
  summary: (tool) => clip(tool.input?.condition || ""),
  body(tool) {
    const asked = tool.input?.ask_user !== false;
    const state = tool.status === "done" ? (asked ? t("Goal set") : t("Goal set without asking; clear it with /goal clear")) : tool.status === "denied" ? t("Declined") : asked ? t("Waiting for your approval") : "";
    return [
      h("div.goal-condition", { dir: "auto" }, tool.input?.condition || ""),
      state ? h("div.tool-note", icon(tool.status === "done" ? "check" : tool.status === "denied" ? "x" : "clock", 12), state) : null,
      tool.status === "error" ? resultBlock(tool) : null,
    ];
  },
  defaultOpen: () => true,
});

registerToolRenderer(["EnterWorktree", "ExitWorktree"], {
  icon: "git-branch",
  title: (tool) => (tool.name === "EnterWorktree" ? t("Enter worktree") : t("Leave worktree")),
  summary: (tool) => {
    const out = structuredOf(tool);
    if (tool.name === "ExitWorktree") return clip(`${tool.input?.action === "remove" ? t("Remove it") : t("Keep it")}${out?.worktreeBranch ? ` · ${out.worktreeBranch}` : ""}`);
    return clip(out?.worktreeBranch || tool.input?.name || (tool.input?.path ? baseName(tool.input.path) : ""));
  },
  body(tool) {
    const out = structuredOf(tool);
    if (!out) return [resultBlock(tool)];
    const discarded = (out.discardedFiles || 0) + (out.discardedCommits || 0);
    return [
      h("div.chip-row", out.worktreeBranch ? h("span.badge", { dir: "ltr" }, icon("git-branch", 11), out.worktreeBranch) : null, out.worktreePath ? h("span.muted.small", { dir: "ltr", title: out.worktreePath }, shortPath(out.worktreePath, 60)) : null),
      out.message ? h("div.muted", { dir: "auto" }, out.message) : null,
      discarded ? h("div.tool-note.danger", icon("trash", 12), t("Discarded {files} file(s) and {commits} commit(s)", { files: out.discardedFiles || 0, commits: out.discardedCommits || 0 })) : null,
      tool.status === "error" ? resultBlock(tool) : null,
    ];
  },
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
    // A renderer can report a status other than the tool call's own (a background subagent outlives its Agent call).
    const status = renderer.status?.(tool) || tool.status;
    this.el.className = `tool status-${status}${tool.awaiting ? " awaiting" : ""}${open ? " open" : ""}`;
    this.el.dataset.tool = tool.name;
    this.el.dataset.id = tool.id;
    const spinning = status === "running" || status === "streaming";
    const title = renderer.title(tool);
    const summary = renderer.summary?.(tool) || "";
    const took = tool.endedAt && tool.startedAt ? tool.endedAt - tool.startedAt : 0;
    const elapsed = renderer.meta?.(tool) ?? (took >= 1000 ? formatDuration(took) : tool.progress?.elapsed ? `${Math.round(tool.progress.elapsed)}s` : "");
    const head = h(
      "button.tool-head",
      { type: "button", "aria-expanded": String(open), onclick: () => this.toggle() },
      h("span.tool-icon", icon(renderer.icon || "wrench", 15)),
      h("span.tool-title", title),
      h("span.tool-sub", { dir: "auto" }, summary),
      tool.awaiting ? h("span.badge.warn", t("Needs approval")) : null,
      elapsed ? h("span.tool-meta", elapsed) : null,
      h("span.tool-state", icon(STATUS_ICON[status] || "circle", 14, spinning ? "spin" : "")),
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
