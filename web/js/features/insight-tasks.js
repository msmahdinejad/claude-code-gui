// Tasks tab: todo list, background tasks / subagents (stop, background, transcripts), scheduled jobs.
import { h, modal, formatTokens, formatDuration, spinner, ibtn, btn, toast, errorMessage, formatTime } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { registerInspectorTab } from "../core/registry.js";
import { api } from "../core/api.js";
import { createConversation, loadHistory } from "../chat/reducer.js";
import { ChatView } from "../chat/view.js";
import { todoList } from "../chat/tools.js";
import { liveControl, isAlive } from "./insight-shared.js";

const AGENT_TOOLS = new Set(["Task", "Agent"]);
const SCHEDULE_TOOLS = /^(Cron(Create|Delete|List)|ScheduleWakeup)$/;

function activeCount(conv) {
  if (!conv) return 0;
  let n = 0;
  for (const task of conv.tasks.values()) if (task.status === "running" || task.status === "in_progress" || task.status === "pending") n += 1;
  for (const tool of conv.tools.values()) if (AGENT_TOOLS.has(tool.name) && (tool.status === "running" || tool.status === "streaming") && !tool.task) n += 1;
  return n;
}

const STATUS_ICON = { running: "loader", in_progress: "loader", pending: "clock", completed: "check-circle", failed: "x-circle", killed: "stop", stopped: "stop" };

function taskCard(task, conv) {
  const running = task.status === "running" || task.status === "in_progress" || task.status === "pending";
  const tool = task.toolUseId ? conv.tools.get(task.toolUseId) : null;
  const tokens = task.usage?.total_tokens ?? ((task.usage?.input_tokens || 0) + (task.usage?.output_tokens || 0));
  return h(
    `div.task-card.${task.status || "running"}`,
    h("div.row-inline", icon(STATUS_ICON[task.status] || "loader", 15, running ? "spin" : ""), h("strong.grow", { dir: "auto" }, task.description || tool?.input?.description || task.id), h("span.badge", task.taskType || tool?.input?.subagent_type || t("task"))),
    task.summary ? h("div.muted.small", { dir: "auto" }, task.summary) : null,
    h("div.row-inline.small.muted", task.lastTool ? h("span", icon("wrench", 11), ` ${task.lastTool}`) : null, tokens ? h("span", `${formatTokens(tokens)} ${t("tokens")}`) : null, task.startedAt ? h("span", running ? formatDuration(Date.now() - task.startedAt) : formatTime(task.startedAt)) : null),
    running
      ? h("div.row-inline", btn(t("Stop"), async () => {
          try { await liveControl("stopTask", { taskId: task.id }); } catch (error) { toast(errorMessage(error), "error"); }
        }, { iconName: "stop", variant: "small danger-outline" }))
      : null,
  );
}

function openSubagentTranscript(agentId) {
  const conv = createConversation(`sub-${agentId}`);
  const root = h("div.sub-chat");
  const dialog = modal({ title: `${t("Subagent transcript")} · ${agentId.slice(0, 8)}`, width: 820, body: root, className: "sub-modal" });
  const view = new ChatView(root, {});
  view.setConversation(conv);
  api.get(`/api/sessions/${app.currentId}/subagent/${agentId}`, { cwd: app.currentCwd })
    .then(({ messages }) => {
      // Subagent messages all point at their parent Agent call; render them as a top-level conversation.
      loadHistory(conv, (messages || []).map((message) => ({ ...message, parent_tool_use_id: null })));
      view.setConversation(conv);
      if (!conv.items.length) root.append(h("div.empty", h("p", t("The transcript is empty."))));
    })
    .catch((error) => root.append(h("div.banner.error", errorMessage(error))));
  return dialog;
}

registerInspectorTab({
  id: "tasks",
  title: "Tasks",
  icon: "list-todo",
  order: 22,
  badge: () => activeCount(app.convs.get(app.currentId)) || null,
  render(container) {
    let alive = true;
    let subagents = null;
    let timer = null;

    async function loadSubagents() {
      if (!app.currentId) return;
      try {
        subagents = (await api.get(`/api/sessions/${app.currentId}/subagents`, { cwd: app.currentCwd })).agents || [];
      } catch {
        subagents = [];
      }
      if (alive) paint();
    }

    function paint() {
      if (!alive) return;
      const conv = app.convs.get(app.currentId);
      if (!conv) return container.replaceChildren(h("div.empty", h("p", t("No session."))));
      const body = [];
      const todos = conv.todos || [];
      const done = todos.filter((todo) => todo.status === "completed").length;
      body.push(
        h("div.panel-section", h("div.panel-head", h("h4.grow", t("Plan")), todos.length ? h("span.badge", `${done}/${todos.length}`) : null), todos.length ? [bar(done, todos.length), todoList(todos)] : h("div.muted.small", t("Claude has not made a task list in this session."))),
      );

      const tasks = [...conv.tasks.values()].reverse();
      const orphanAgents = [...conv.tools.values()].filter((tool) => AGENT_TOOLS.has(tool.name) && !tool.task);
      const running = activeCount(conv);
      body.push(
        h(
          "div.panel-section",
          h("div.panel-head", h("h4.grow", t("Background tasks & subagents")), running ? h("span.badge.accent", t("{n} running", { n: running })) : null, running && isAlive() ? btn(t("Send to background"), async () => {
            try { const result = await liveControl("backgroundTasks", {}); toast(result.backgrounded ? t("Moved to background") : t("Nothing to background"), "ok"); } catch (error) { toast(errorMessage(error), "error"); }
          }, { variant: "small", iconName: "layers" }) : null),
          tasks.length || orphanAgents.length ? [...tasks.map((task) => taskCard(task, conv)), ...orphanAgents.map((tool) => taskCard({ id: tool.id, description: tool.input?.description, status: tool.status === "running" ? "running" : tool.status === "done" ? "completed" : tool.status, taskType: tool.input?.subagent_type, startedAt: tool.startedAt }, conv))] : h("div.muted.small", t("No subagents or background commands yet.")),
        ),
      );

      body.push(
        h(
          "div.panel-section",
          h("div.panel-head", h("h4.grow", t("Subagent transcripts")), ibtn("refresh", t("Refresh"), loadSubagents, { size: 14 })),
          subagents === null ? spinner(14) : subagents.length ? subagents.map((agentId) => h("button.list-row.clickable", { type: "button", onclick: () => openSubagentTranscript(agentId) }, icon("bot", 15), h("div.grow", h("span", agentId.slice(0, 18)), h("span.muted", t("Open transcript"))), icon("chevron-right", 14))) : h("div.muted.small", t("None recorded for this session.")),
        ),
      );

      const scheduled = [...conv.tools.values()].filter((tool) => SCHEDULE_TOOLS.test(tool.name));
      if (scheduled.length) {
        body.push(
          h(
            "div.panel-section",
            h("h4", t("Scheduled jobs")),
            scheduled.map((tool) => h("div.list-row", icon("clock", 15), h("div.grow", h("span", tool.name), h("span.muted", { dir: "auto" }, tool.input?.cron || tool.input?.prompt || tool.input?.description || JSON.stringify(tool.input || {}).slice(0, 80))), h(`span.badge${tool.status === "done" ? ".ok" : ""}`, tool.status))),
          ),
        );
      }
      container.replaceChildren(h("div.panel.tasks", body));
    }

    const bar = (done, total) => h("div.progress", h("i", { style: { width: `${total ? (done / total) * 100 : 0}%` } }));
    const offs = [bus.on("conv:update", (id) => id === app.currentId && paint())];
    timer = setInterval(paint, 5000);
    paint();
    loadSubagents();
    return () => {
      alive = false;
      clearInterval(timer);
      offs.forEach((off) => off());
    };
  },
});
