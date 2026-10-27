// Context tab: where the context window goes (control op `context`) + cached percent for the topbar.
import { h, formatTokens, baseName, toast, errorMessage, spinner, ibtn, btn } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { registerInspectorTab } from "../core/registry.js";
import { api } from "../core/api.js";
import { isBusy } from "../chat/reducer.js";
import { liveControl, isAlive, bar, pct, num } from "./insight-shared.js";

/** Latest context usage for the current session (also on app.contextUsage). */
export function contextPercent() {
  const usage = app.contextUsage;
  return usage && usage.sessionId === app.currentId ? usage.percentage : null;
}

const CAT_COLORS = {
  system_prompt: "#8a5db5",
  system_tools: "#2d6cb5",
  system_tools_deferred: "#7a9cc6",
  mcp_tools: "#2f9d8f",
  mcp_tools_deferred: "#7fc2b8",
  mcp_instructions: "#1f8a7a",
  custom_agents: "#b5632a",
  memory_files: "#b0476b",
  skills: "#d9a441",
  messages: "#c96442",
  autocompact_buffer: "#9a978c",
  compact_buffer: "#9a978c",
  free_space: "transparent",
};

const CAT_TITLES = {
  system_prompt: "System prompt",
  system_tools: "System tools",
  system_tools_deferred: "System tools (deferred)",
  mcp_tools: "MCP tools",
  mcp_tools_deferred: "MCP tools (deferred)",
  mcp_instructions: "MCP server instructions",
  custom_agents: "Custom agents",
  memory_files: "Memory files",
  skills: "Skills",
  messages: "Messages",
  autocompact_buffer: "Autocompact buffer",
  compact_buffer: "Compact buffer",
  free_space: "Free space",
};

const colorOf = (category) => CAT_COLORS[category.id] || "#9a978c";
const titleOf = (category) => (CAT_TITLES[category.id] ? t(CAT_TITLES[category.id]) : category.name);

let refreshing = false;
let lastRefresh = 0;

/** Fetch usage when the process is alive; keeps app.contextUsage fresh for other UI. */
export async function refreshContextUsage({ start = false, detail } = {}) {
  const id = app.currentId;
  if (!id || refreshing) return app.contextUsage;
  if (!start && !isAlive()) return app.contextUsage;
  refreshing = true;
  try {
    const data = start ? await liveControl("context", detail ? { detail } : {}) : await api.control(id, "context", detail ? { detail } : {});
    app.contextUsage = { ...data, sessionId: id, at: Date.now() };
    lastRefresh = Date.now();
    bus.emit("context:usage", app.contextUsage);
  } catch {
    /* process busy or gone: keep the previous value */
  } finally {
    refreshing = false;
  }
  return app.contextUsage;
}

// Keep the cached value fresh after every finished turn.
bus.on("conv:update", (id) => {
  if (id !== app.currentId) return;
  const conv = app.convs.get(id);
  const last = conv?.items.at(-1);
  if (last?.kind === "result" && last.v === 1 && Date.now() - lastRefresh > 800) refreshContextUsage();
});
bus.on("current", () => {
  app.contextUsage = app.contextUsage?.sessionId === app.currentId ? app.contextUsage : null;
  setTimeout(() => refreshContextUsage(), 600);
});
bus.on("live", (id) => {
  if (id === app.currentId && app.live.get(id)?.state === "idle") refreshContextUsage();
});

function stackedBar(data) {
  const max = data.maxTokens || 1;
  const wrap = h("div.ctx-bar", { role: "img", "aria-label": `${pct(data.percentage)}` });
  for (const category of data.categories) {
    if (category.kind === "deferred" || !category.tokens) continue;
    const width = (category.tokens / max) * 100;
    if (width < 0.05) continue;
    wrap.append(h(`i.ctx-seg.${category.kind}`, { style: { width: `${width}%`, background: category.kind === "free" ? "transparent" : colorOf(category) }, title: `${titleOf(category)} · ${num(category.tokens)}` }));
  }
  if (data.autoCompactThreshold) {
    const left = Math.min(100, (data.autoCompactThreshold / max) * 100);
    wrap.append(h("span.ctx-threshold", { style: { insetInlineStart: `${left}%` }, title: `${t("Auto-compact at")} ${num(data.autoCompactThreshold)}` }));
  }
  return wrap;
}

function grid(data) {
  const colors = new Map(data.categories.map((category) => [category.name, colorOf(category)]));
  const box = h("div.ctx-grid", { dir: "ltr" });
  for (const row of data.gridRows || []) {
    const line = h("div.ctx-grid-row");
    for (const cell of row) {
      const color = colors.get(cell.categoryName);
      line.append(h("i.ctx-cell", { title: `${cell.categoryName} · ${num(cell.tokens)}`, style: { background: cell.isFilled && color ? color : "var(--surface-3)", opacity: cell.isFilled ? String(Math.max(0.35, cell.squareFullness ?? 1)) : "1" } }));
    }
    box.append(line);
  }
  return box;
}

function legend(data) {
  const used = data.categories.filter((category) => category.kind !== "deferred");
  const deferred = data.categories.filter((category) => category.kind === "deferred");
  const row = (category) =>
    h(
      `li.ctx-legend-row${category.kind === "deferred" ? ".deferred" : ""}`,
      h("i.ctx-swatch", { style: { background: category.kind === "free" ? "var(--surface-3)" : colorOf(category) } }),
      h("span.grow", titleOf(category)),
      category.kind === "deferred" ? h("span.badge", t("deferred")) : null,
      h("span.num", formatTokens(category.tokens)),
      h("span.num.muted", pct((category.tokens / (data.maxTokens || 1)) * 100)),
    );
  return h("ul.ctx-legend", used.map(row), deferred.length ? h("li.ctx-sep", t("Not counted (loaded on demand)")) : null, deferred.map(row));
}

function details(title, count, children, open = false) {
  if (!children || (Array.isArray(children) && !children.length)) return null;
  return h("details.ctx-details", { open }, h("summary", icon("chevron-right", 13, "chev"), h("span.grow", title), count !== undefined ? h("span.badge", String(count)) : null), h("div.ctx-details-body", children));
}

function tokenRow(label, tokens, extra, onclick) {
  const content = [h("span.grow", { dir: "auto", title: label }, label), extra ? h("span.muted.small", extra) : null, h("span.num", formatTokens(tokens))];
  return onclick ? h("button.ctx-row.clickable", { type: "button", onclick }, content) : h("div.ctx-row", content);
}

function sections(data) {
  const out = [];
  out.push(details(t("Memory files"), data.memoryFiles?.length, (data.memoryFiles || []).map((file) => tokenRow(baseName(file.path), file.tokens, file.type, () => bus.emit("open-file", { path: file.path })))));
  const skills = data.skills?.skillFrontmatter || [];
  out.push(details(t("Skills"), `${data.skills?.includedSkills ?? skills.length}/${data.skills?.totalSkills ?? skills.length}`, [...skills].sort((a, b) => b.tokens - a.tokens).map((skill) => tokenRow(skill.name, skill.tokens, skill.pluginName || skill.source, skill.path ? () => bus.emit("open-file", { path: skill.path }) : null))));
  out.push(details(t("Agents"), data.agents?.length, (data.agents || []).map((agent) => tokenRow(agent.agentType, agent.tokens, agent.source, agent.path ? () => bus.emit("open-file", { path: agent.path }) : null))));
  const byServer = new Map();
  for (const tool of data.mcpTools || []) {
    if (!byServer.has(tool.serverName)) byServer.set(tool.serverName, []);
    byServer.get(tool.serverName).push(tool);
  }
  const mcp = [...byServer].map(([server, tools]) => details(`${server}`, tools.length, tools.map((tool) => tokenRow(tool.name, tool.tokens, tool.isLoaded === false ? t("not loaded") : "")), false));
  out.push(details(t("MCP tools"), data.mcpTools?.length, mcp.filter(Boolean)));
  out.push(details(t("MCP server instructions"), data.mcpInstructions?.length, (data.mcpInstructions || []).map((entry) => tokenRow(entry.serverName, entry.tokens))));
  out.push(details(t("System tools"), data.systemTools?.length, (data.systemTools || []).sort((a, b) => b.tokens - a.tokens).map((tool) => tokenRow(tool.name, tool.tokens))));
  out.push(details(t("System prompt sections"), data.systemPromptSections?.length, (data.systemPromptSections || []).map((section) => tokenRow(section.name, section.tokens))));
  const m = data.messageBreakdown;
  if (m) {
    const rows = [
      [t("Tool calls"), m.toolCallTokens],
      [t("Tool results"), m.toolResultTokens],
      [t("Attachments"), m.attachmentTokens],
      [t("Assistant messages"), m.assistantMessageTokens],
      [t("User messages"), m.userMessageTokens],
      [t("Redirected context"), m.redirectedContextTokens],
      [t("Unattributed"), m.unattributedTokens],
    ].filter(([, tokens]) => tokens);
    out.push(details(t("Messages breakdown"), undefined, [...rows.map(([label, tokens]) => tokenRow(label, tokens)), (m.toolCallsByType || []).length ? h("div.ctx-sub", t("By tool")) : null, ...(m.toolCallsByType || []).map((tool) => tokenRow(tool.name, tool.callTokens + tool.resultTokens, `${formatTokens(tool.callTokens)} ${t("call")} · ${formatTokens(tool.resultTokens)} ${t("result")}`)), (m.attachmentsByType || []).length ? h("div.ctx-sub", t("Attachments")) : null, ...(m.attachmentsByType || []).map((a) => tokenRow(a.name, a.tokens))], true));
  }
  return out.filter(Boolean);
}

async function compactNow(ctx) {
  const conv = app.convs.get(app.currentId);
  if (conv && isBusy(conv)) return toast(t("Wait for the current response to finish."), "error");
  await ctx.runPrompt("/compact");
  toast(t("Compacting…"), "ok", 1800);
}

function autoCompactControls(ctx, data) {
  const input = h("input.input", { type: "text", inputmode: "numeric", placeholder: t("auto or 100000–1000000"), dir: "ltr", value: "" });
  const apply = btn(t("Apply"), async () => {
    const value = input.value.trim();
    if (!value) return;
    if (!/^(auto|\d{5,7})$/i.test(value)) return toast(t("Use “auto” or a number between 100000 and 1000000."), "error");
    await ctx.runPrompt(`/autocompact ${value.toLowerCase()}`);
    setTimeout(() => ctx.bus.emit("insp:refresh"), 2500);
  }, { variant: "small" });
  return h(
    "div.panel-section",
    h("h4", t("Auto-compact")),
    h("dl.kv", h("dt", t("Status")), h("dd", h(`span.badge.${data.isAutoCompactEnabled ? "ok" : ""}`, data.isAutoCompactEnabled ? t("on") : t("off"))), h("dt", t("Threshold")), h("dd", data.autoCompactThreshold ? `${num(data.autoCompactThreshold)} ${t("tokens")}${data.autocompactSource ? ` · ${data.autocompactSource}` : ""}` : "—")),
    h("div.row-inline", input, apply),
    h("small.muted", t("Changes the window with the built-in /autocompact command (saved to your Claude settings).")),
  );
}

registerInspectorTab({
  id: "context",
  title: "Context",
  icon: "gauge",
  order: 20,
  badge: () => null,
  async render(container, ctx) {
    let mode = "bar";
    let data = app.contextUsage?.sessionId === app.currentId ? app.contextUsage : null;
    let loading = false;
    let error = null;
    let alive = true;

    async function load(start) {
      loading = true;
      paint();
      try {
        data = await refreshContextUsage({ start, detail: "full" });
        error = null;
      } catch (e) {
        error = errorMessage(e);
      }
      loading = false;
      if (alive) paint();
    }

    function paint() {
      if (!alive) return;
      const body = [];
      body.push(
        h("div.panel-head", h("h3", t("Context window")), loading ? spinner(14) : null, ibtn("refresh", t("Refresh"), () => load(true), { size: 14 })),
      );
      if (!data) {
        body.push(h("div.empty", icon("gauge", 26), h("strong", t("No measurement yet")), h("p", t("Start the session process to measure what fills the context window.")), btn(t("Measure now"), () => load(true), { variant: "primary" })));
        if (error) body.push(h("div.banner.error", error));
        container.replaceChildren(h("div.panel.ctx", body));
        return;
      }
      const stale = Date.now() - (data.at || 0) > 120_000;
      body.push(
        h("div.ctx-summary", h("div.ctx-big", h("strong", pct(data.percentage)), h("span.muted", `${formatTokens(data.totalTokens)} / ${formatTokens(data.maxTokens)} ${t("tokens")}`)), h("span.muted.small", data.model || ""), stale ? h("span.badge.warn", t("may be outdated")) : null),
        bar(data.percentage, data.percentage > 85 ? "danger" : data.percentage > 65 ? "warn" : ""),
        h("div.seg", h(`button${mode === "bar" ? ".active" : ""}`, { type: "button", onclick: () => { mode = "bar"; paint(); } }, t("Bar")), h(`button${mode === "grid" ? ".active" : ""}`, { type: "button", onclick: () => { mode = "grid"; paint(); } }, t("Grid"))),
        mode === "bar" ? stackedBar(data) : grid(data),
        legend(data),
        h("div.panel-section", h("h4", t("Actions")), h("div.row-inline", btn(t("Compact now"), () => compactNow(ctx), { iconName: "layers", title: "/compact" }), btn(t("Clear (new session)"), () => ctx.session.newSession({}), { iconName: "plus" }))),
        autoCompactControls(ctx, data),
        h("div.panel-section", h("h4", t("Details")), ...sections(data)),
      );
      if (data.apiUsage) {
        const u = data.apiUsage;
        body.push(h("div.panel-section", h("h4", t("Last API call")), h("dl.kv", h("dt", t("Input")), h("dd", num(u.input_tokens)), h("dt", t("Output")), h("dd", num(u.output_tokens)), h("dt", t("Cache read")), h("dd", num(u.cache_read_input_tokens)), h("dt", t("Cache write")), h("dd", num(u.cache_creation_input_tokens)))));
      }
      container.replaceChildren(h("div.panel.ctx", body));
    }

    const off = bus.on("context:usage", (usage) => {
      if (usage.sessionId === app.currentId) {
        data = usage;
        paint();
      }
    });
    paint();
    if (isAlive()) load(false);
    else if (app.convs.get(app.currentId)?.items.length) load(true);
    return () => {
      alive = false;
      off();
    };
  },
});
