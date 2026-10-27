// Activity tab: developer log (hooks, denials, retries, rate limits, elicitations), raw SDK messages, stderr.
import { h, copyText, debounce, ibtn, spinner, errorMessage } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { registerInspectorTab } from "../core/registry.js";
import { api } from "../core/api.js";

const CATEGORY = {
  hook: ["hook_started", "hook_progress", "hook_response"],
  tasks: ["task_started", "task_progress", "task_updated", "task_notification", "background_tasks_changed"],
  limits: ["rate_limit_event"],
  errors: ["api_retry", "wh_error", "wh_closed", "permission_denied"],
  requests: ["wh_request", "wh_request_resolved"],
};

function describe(entry) {
  const msg = entry.msg;
  const sub = msg.subtype ? `${msg.type}/${msg.subtype}` : msg.type;
  const key = msg.subtype || msg.type;
  let category = "other";
  for (const [name, keys] of Object.entries(CATEGORY)) if (keys.includes(key)) category = name;
  let iconName = "circle";
  let text;
  let level = "";
  switch (key) {
    case "hook_started":
    case "hook_progress":
    case "hook_response":
      iconName = "wrench";
      text = `${msg.hook_event || msg.hook_event_name || ""} · ${msg.hook_name || ""}${msg.outcome ? ` → ${msg.outcome}` : ""}${msg.exit_code !== undefined ? ` (exit ${msg.exit_code})` : ""}`;
      if (msg.outcome === "error" || msg.exit_code > 0) level = "error";
      break;
    case "api_retry":
      iconName = "refresh";
      level = "warn";
      text = `${t("API retry")} ${msg.attempt ?? ""}/${msg.max_retries ?? ""} ${msg.error_status ?? msg.error ?? ""}`;
      break;
    case "rate_limit_event":
      iconName = "gauge";
      text = `${msg.rate_limit_info?.status || ""} ${msg.rate_limit_info?.rateLimitType || ""}`;
      if (msg.rate_limit_info?.status && msg.rate_limit_info.status !== "allowed") level = "warn";
      break;
    case "permission_denied":
      iconName = "shield";
      level = "warn";
      text = `${t("Denied")}: ${msg.tool_name || ""} ${msg.message || ""}`;
      break;
    case "wh_request":
      iconName = msg.request.kind === "permission" ? "shield" : "plug";
      text = msg.request.kind === "permission" ? `${t("Permission requested")}: ${msg.request.toolName}` : `${msg.request.kind}: ${msg.request.serverName || msg.request.dialogKind || ""} ${msg.request.message || ""}`;
      break;
    case "wh_request_resolved":
      iconName = "check";
      text = msg.cancelled ? t("Request cancelled") : `${t("Request answered")}: ${msg.answer?.behavior || msg.answer?.action || ""}`;
      break;
    case "wh_error":
      iconName = "alert";
      level = "error";
      text = `${msg.where}: ${msg.message}`;
      break;
    case "wh_closed":
      iconName = "x-circle";
      text = t("Session process ended");
      break;
    case "result":
      iconName = "check-circle";
      text = `${msg.subtype}${msg.is_error ? " (error)" : ""} · ${msg.num_turns} ${t("turns")}${msg.permission_denials?.length ? ` · ${msg.permission_denials.length} ${t("denied")}` : ""}`;
      if (msg.is_error) level = "error";
      category = "errors";
      break;
    case "init":
      iconName = "play";
      text = `${t("Session started")} · ${msg.model} · ${msg.permissionMode}`;
      break;
    case "compact_boundary":
      iconName = "layers";
      text = t("Conversation compacted");
      break;
    case "status":
      iconName = "loader";
      text = `${t("Status")}: ${msg.status || "idle"}`;
      break;
    case "background_tasks_changed":
      iconName = "bot";
      text = `${t("Tasks")}: ${t("{n} running", { n: msg.tasks?.length || 0 })}`;
      break;
    default:
      if (CATEGORY.tasks.includes(key)) {
        iconName = "bot";
        text = `${key.replace("task_", "")}: ${msg.description || msg.summary || msg.task_id || ""}`;
      } else {
        text = sub;
      }
  }
  return { sub, category, iconName, text: text.trim() || sub, level, seq: entry.seq, msg };
}

registerInspectorTab({
  id: "activity",
  title: "Activity",
  icon: "history",
  order: 23,
  render(container) {
    let alive = true;
    let view = "events"; // events | raw | stderr
    let filter = new Set(["hook", "tasks", "limits", "errors", "requests"]);
    let rawFilter = "";
    let entries = [];
    let stderr = [];
    let loading = false;
    let error = null;
    let showNoise = false;

    async function load() {
      const id = app.currentId;
      if (!id) return;
      loading = true;
      error = null;
      paint();
      try {
        const [raw, err] = await Promise.all([
          api.get(`/api/sessions/${id}/raw`, { limit: 300 }).catch(() => ({ entries: [] })),
          api.get(`/api/sessions/${id}/stderr`).catch(() => ({ lines: [] })),
        ]);
        entries = raw.entries || [];
        stderr = err.lines || [];
      } catch (e) {
        error = errorMessage(e);
      }
      loading = false;
      if (alive) paint();
    }

    function eventsView() {
      const rows = entries.map(describe).filter((row) => (showNoise ? true : row.category !== "other" || row.sub === "system/init" || row.sub === "system/compact_boundary") && (row.category === "other" ? true : filter.has(row.category)));
      const conv = app.convs.get(app.currentId);
      // Fall back to conversation data when the process buffer is gone (server restart).
      const fallback = !rows.length && conv ? conv.hookEvents.map((e) => describe({ seq: 0, msg: { type: "system", ...e } })) : [];
      const list = [...rows, ...fallback].reverse();
      return [
        h("div.sb-filters", ...Object.keys(CATEGORY).map((name) => h(`button.chip${filter.has(name) ? ".active" : ""}`, { type: "button", onclick: () => { filter.has(name) ? filter.delete(name) : filter.add(name); paint(); } }, t(name === "hook" ? "Hooks" : name === "tasks" ? "Tasks" : name === "limits" ? "Limits" : name === "errors" ? "Errors & denials" : "Requests"))), h(`button.chip${showNoise ? ".active" : ""}`, { type: "button", onclick: () => { showNoise = !showNoise; paint(); } }, t("Everything"))),
        list.length
          ? h("ul.act-list", list.map((row) => h(`li.act-row${row.level ? `.${row.level}` : ""}`, { onclick: () => copyText(JSON.stringify(row.msg, null, 2), t("Copied JSON")) }, icon(row.iconName, 14), h("span.act-text", { dir: "auto" }, row.text), h("span.act-seq.muted", row.seq ? `#${row.seq}` : ""))))
          : h("div.empty", icon("history", 24), h("p", t("Nothing logged yet. Events appear while the session process is running."))),
      ];
    }

    function rawView() {
      const needle = rawFilter.toLowerCase();
      const list = entries.filter((entry) => !needle || JSON.stringify(entry.msg).toLowerCase().includes(needle) || (entry.msg.type + (entry.msg.subtype || "")).toLowerCase().includes(needle)).slice(-200).reverse();
      const input = h("input.input", { type: "search", placeholder: t("Filter by type or text"), dir: "auto", value: rawFilter });
      input.addEventListener("input", debounce(() => { rawFilter = input.value; paint(); input.focus(); }, 250));
      return [
        h("div.row-inline", input, h("button.btn.small", { type: "button", onclick: () => copyText(JSON.stringify(list.map((e) => e.msg), null, 2), t("Copied JSON")) }, icon("copy", 13), t("Copy as JSON"))),
        h("div.muted.small", t("Last {n} raw SDK messages (streaming deltas omitted).", { n: list.length })),
        h("ul.raw-list", list.map((entry) => h("li", h("details", h("summary", h("span.badge", `#${entry.seq}`), h("code", entry.msg.type + (entry.msg.subtype ? `/${entry.msg.subtype}` : "")), h("button.mini", { type: "button", title: t("Copy"), onclick: (event) => { event.preventDefault(); copyText(JSON.stringify(entry.msg, null, 2), t("Copied JSON")); } }, icon("copy", 12))), h("pre.json", { dir: "ltr" }, JSON.stringify(entry.msg, null, 2).slice(0, 12000)))))),
      ];
    }

    function stderrView() {
      return [
        h("div.row-inline", h("span.grow.muted.small", t("Last {n} lines written by the claude process to stderr.", { n: stderr.length })), h("button.btn.small", { type: "button", onclick: () => copyText(stderr.join("\n")) }, icon("copy", 13), t("Copy"))),
        stderr.length ? h("pre.json.stderr", { dir: "ltr" }, stderr.join("\n")) : h("div.empty", icon("check-circle", 24), h("p", t("stderr is empty."))),
      ];
    }

    function paint() {
      if (!alive) return;
      const views = [["events", t("Events")], ["raw", t("Raw messages")], ["stderr", t("stderr")]];
      container.replaceChildren(
        h(
          "div.panel.activity",
          h("div.panel-head", h("h3", t("Activity")), loading ? spinner(14) : null, ibtn("refresh", t("Refresh"), load, { size: 14 })),
          h("div.tabs-inline", views.map(([id, label]) => h(`button${view === id ? ".active" : ""}`, { type: "button", onclick: () => { view = id; paint(); } }, label))),
          error ? h("div.banner.error", error) : null,
          ...(view === "events" ? eventsView() : view === "raw" ? rawView() : stderrView()),
        ),
      );
    }

    const refresh = debounce(() => alive && view !== "raw" && load(), 1200);
    const offs = [bus.on("conv:update", (id) => id === app.currentId && refresh()), bus.on("current", load)];
    paint();
    load();
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  },
});
