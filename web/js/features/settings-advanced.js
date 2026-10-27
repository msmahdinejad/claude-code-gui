// Settings → Advanced: common keys form, raw settings.json editor, session start options, effective settings.
import { h, toast, errorMessage, confirmDialog } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { app } from "../core/state.js";
import * as session from "../session.js";
import { registerSettingsSection } from "../core/registry.js";
import { lineDiff, diffView } from "../chat/tools.js";
import { scopedPage, group, settingRow, selectControl, toggleControl, textControl, getIn, setIn, saveScope, sessionOptions, currentCwd, infoBanner, dangerBanner } from "./settings-shared.js";

let activeTab = "common";

registerSettingsSection({
  id: "advanced",
  title: "Advanced",
  icon: "sliders",
  order: 90,
  render(el) {
    scopedPage(el, {
      title: "Advanced",
      lead: "Everything else in settings.json, raw access to the file, and options that only apply when a session starts.",
      async render(body, ctx) {
        const tabs = [["common", t("Common settings")], ["raw", t("Raw JSON")], ["session", t("Session options")], ["effective", t("Effective settings")]];
        const panel = h("div.advanced-panel");
        const bar = h("div.tabs-inline");
        const draw = () => {
          bar.replaceChildren(...tabs.map(([id, label]) => h(`button${id === activeTab ? ".active" : ""}`, { type: "button", onclick: () => { activeTab = id; draw(); } }, label)));
          panel.replaceChildren();
          if (activeTab === "common") common(panel, ctx);
          else if (activeTab === "raw") raw(panel, ctx);
          else if (activeTab === "session") sessionForm(panel);
          else effective(panel);
        };
        body.append(bar, panel);
        draw();
      },
    });
  },
});

// ---- common settings -------------------------------------------------------------------
function common(panel, { json, edit }) {
  const set = (path, value) => edit((draft) => setIn(draft, path, value));
  const bool = (path, fallback = false) => toggleControl(getIn(json, path, fallback), (value) => set(path, value === fallback ? undefined : value));
  const num = (path, placeholder) => textControl(getIn(json, path, ""), (value) => set(path, value === "" ? undefined : Number(value)), { type: "number", width: 110, placeholder });
  const attribution = getIn(json, "attribution");
  panel.append(
    group(
      "Model",
      settingRow(t("Default model"), t("Model or alias used when nothing else is chosen (settings.model)."), textControl(getIn(json, "model", ""), (value) => set("model", value.trim() || undefined), { placeholder: "sonnet / claude-sonnet-5-5", width: 220 })),
      settingRow(t("Fallback models"), t("Comma separated; tried in order when the primary is overloaded."), textControl((getIn(json, "fallbackModel", []) || []).join(", "), (value) => set("fallbackModel", value.split(",").map((item) => item.trim()).filter(Boolean)), { placeholder: "haiku", width: 220 })),
    ),
    group(
      "Behavior",
      settingRow(t("Include git instructions"), t("Add git workflow guidance to the system prompt."), bool("includeGitInstructions", true)),
      settingRow(t("Co-author commits"), t("Add a “Co-Authored-By: Claude” trailer to commits."), bool("includeCoAuthoredBy", true)),
      settingRow(t("Attribution"), typeof attribution === "object" && attribution ? t("Customized (edit in Raw JSON).") : t("Mention Claude in commit messages and PR descriptions."), typeof attribution === "object" && attribution ? h("span.badge", t("custom")) : bool("attribution", true)),
      settingRow(t("Respect .gitignore"), t("Hide ignored files from file suggestions and searches."), bool("respectGitignore", true)),
      settingRow(t("Auto-approve project MCP servers"), t("Enable every server from .mcp.json without asking."), bool("enableAllProjectMcpServers", false)),
      settingRow(t("Disable all hooks"), t("Temporarily turn every hook off."), bool("disableAllHooks", false)),
      settingRow(t("Disable skill shell execution"), t("Block ! shell blocks inside skills."), bool("disableSkillShellExecution", false)),
      settingRow(t("Default shell"), null, selectControl(getIn(json, "defaultShell", ""), [["", t("(auto)")], ["bash", "bash"], ["powershell", "powershell"]], (value) => set("defaultShell", value || undefined))),
    ),
    group(
      "Limits & housekeeping",
      settingRow(t("Keep transcripts for (days)"), t("Older sessions are cleaned up automatically (cleanupPeriodDays)."), num("cleanupPeriodDays", "30")),
      settingRow(t("Bash output limit (chars)"), null, num("bashOutputMaxChars", "30000")),
      settingRow(t("Background task output limit (chars)"), null, num("taskOutputMaxChars", "")),
    ),
    group(
      "Status line",
      h("p.muted.small", t("A command whose output is shown as the status line in the terminal UI. Receives session JSON on stdin.")),
      settingRow(t("Command"), null, textControl(getIn(json, "statusLine.command", ""), (value) => edit((draft) => { if (value.trim()) setIn(draft, "statusLine", { ...(getIn(draft, "statusLine", {})), type: "command", command: value.trim() }); else setIn(draft, "statusLine", undefined); }), { width: 320, placeholder: "node ~/statusline.js" })),
      settingRow(t("Padding"), null, num("statusLine.padding", "0")),
    ),
  );
}

// ---- raw JSON ---------------------------------------------------------------------------
function locate(text, error) {
  const message = error.message || "";
  let position = null;
  const direct = /position (\d+)/.exec(message);
  if (direct) position = Number(direct[1]);
  else if (/end of JSON input/i.test(message)) position = text.length;
  else {
    // Chrome: Unexpected token '}', "...b": }" is not valid JSON — find the quoted context in the text.
    const quoted = /^Unexpected (?:token )?'(.)', (?:\.\.\.)?"([\s\S]*)"(?:\.\.\.)? is not valid JSON$/.exec(message);
    if (quoted) {
      const snippet = quoted[2];
      const at = text.indexOf(snippet);
      if (at >= 0) position = at + Math.max(0, snippet.indexOf(quoted[1], Math.max(0, Math.floor(snippet.length / 2) - 3)));
    }
  }
  if (position === null) return null;
  const before = text.slice(0, position).split("\n");
  return { line: before.length, column: before.at(-1).length + 1 };
}

function raw(panel, { file, scope, path, reload }) {
  const original = file.exists ? file.text : "{}\n";
  const area = h("textarea.input.editor", { dir: "ltr", spellcheck: "false", rows: 18 });
  area.value = original;
  const message = h("div.json-status");
  const diffHost = h("div");
  const validate = () => {
    try {
      const parsed = JSON.parse(area.value);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings must be a JSON object");
      message.className = "json-status ok";
      message.replaceChildren(icon("check-circle", 14), t("Valid JSON"));
      return parsed;
    } catch (error) {
      const where = locate(area.value, error);
      message.className = "json-status bad";
      message.replaceChildren(icon("alert", 14), `${error.message}${where ? ` — ${t("line {line}, column {column}", where)}` : ""}`);
      return null;
    }
  };
  area.addEventListener("input", () => { validate(); diffHost.replaceChildren(); });
  const format = () => { const parsed = validate(); if (parsed) area.value = `${JSON.stringify(parsed, null, 2)}\n`; };
  const showDiff = () => {
    if (!validate()) return;
    const before = JSON.stringify(JSON.parse(original || "{}"), null, 2).split("\n").join("\n");
    const after = JSON.stringify(JSON.parse(area.value), null, 2);
    const lines = lineDiff(before, after).filter((line, index, all) => line.t !== "ctx" || all.slice(Math.max(0, index - 2), index + 3).some((near) => near.t !== "ctx"));
    diffHost.replaceChildren(lines.length && lines.some((line) => line.t !== "ctx") ? diffView(lines) : h("div.muted", t("No changes.")));
  };
  const save = async () => {
    const parsed = validate();
    if (!parsed) return toast(t("Fix the JSON errors first."), "error");
    try {
      await saveScope(scope, parsed);
      toast(t("Saved"), "ok", 1400);
      reload();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  };
  const reset = async () => {
    const ok = await confirmDialog({ title: t("Reset this file"), message: t("Replace {path} with an empty object? A .wheelhouse-backup copy is kept next to it.", { path }), confirmLabel: t("Reset"), danger: true });
    if (!ok) return;
    try {
      await saveScope(scope, {});
      toast(t("Reset"), "ok", 1400);
      reload();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  };
  panel.append(
    area,
    message,
    h("div.rule-actions", h("button.btn.primary.small", { type: "button", onclick: save }, icon("check", 13), t("Save")), h("button.btn.small", { type: "button", onclick: format }, icon("wand", 13), t("Format")), h("button.btn.small", { type: "button", onclick: showDiff }, icon("file-diff", 13), t("Show changes")), h("button.btn.ghost.small", { type: "button", onclick: () => { area.value = original; validate(); diffHost.replaceChildren(); } }, icon("undo", 13), t("Revert")), h("span.grow"), h("button.btn.danger-outline.small", { type: "button", onclick: reset }, icon("trash", 13), t("Reset file"))),
    diffHost,
  );
  validate();
}

// ---- session start options ------------------------------------------------------------
const START_KEYS = ["appendPrompt", "fallbackModel", "maxTurns", "maxBudgetUsd", "betas", "strictMcpConfig", "worktree", "agent", "extraArgs"];

function sessionForm(panel) {
  const meta = sessionOptions();
  const state = {
    appendPrompt: meta.appendPrompt,
    fallbackModel: meta.fallbackModel || "",
    maxTurns: meta.maxTurns || "",
    maxBudgetUsd: meta.maxBudgetUsd || "",
    betas: (meta.betas || []).join(", "),
    strictMcpConfig: Boolean(meta.strictMcpConfig),
    worktree: meta.worktree === true ? "" : meta.worktree || "",
    useWorktree: Boolean(meta.worktree),
    agent: meta.agent || "",
    extraArgs: meta.extraArgs ? Object.entries(meta.extraArgs).map(([key, value]) => (value === null ? `--${key}` : `--${key} ${value}`)).join("\n") : "",
  };
  const appendArea = h("textarea.input", { rows: 4, dir: "auto", placeholder: t("Leave empty to use the built-in Persian-friendly default. Type a single space to send no extra prompt.") });
  appendArea.value = typeof state.appendPrompt === "string" ? state.appendPrompt : "";
  const extraArea = h("textarea.input.mono", { rows: 3, dir: "ltr", spellcheck: "false", placeholder: "--some-flag value" });
  extraArea.value = state.extraArgs;
  const input = (key, opts) => textControl(state[key], (value) => { state[key] = value; }, opts);
  const agents = (app.catalog?.agents || []).map((agent) => [agent.name, agent.name]);

  const apply = async () => {
    const patch = {
      appendPrompt: appendArea.value === " " ? "" : appendArea.value.trim() || undefined,
      fallbackModel: String(state.fallbackModel).trim() || undefined,
      maxTurns: Number(state.maxTurns) || undefined,
      maxBudgetUsd: Number(state.maxBudgetUsd) || undefined,
      betas: String(state.betas).split(",").map((item) => item.trim()).filter(Boolean),
      strictMcpConfig: state.strictMcpConfig || undefined,
      worktree: state.useWorktree ? String(state.worktree).trim() || true : undefined,
      agent: state.agent || undefined,
      extraArgs: parseExtraArgs(extraArea.value),
    };
    // undefined is dropped by JSON; send null so cleared options really clear.
    await session.applyStartOptions(Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined || (Array.isArray(value) && !value.length) ? null : value])));
  };

  panel.append(
    infoBanner(t("These options are read when the Claude process starts. Applying them restarts the open session's process; the conversation continues.")),
    group(
      "System prompt",
      h("div.field-label", t("Extra instructions appended to Claude Code's prompt")),
      appendArea,
    ),
    group(
      "Limits",
      settingRow(t("Fallback model"), t("Used if the primary model is unavailable."), input("fallbackModel", { placeholder: "haiku" })),
      settingRow(t("Max turns"), t("Stop after this many agentic turns."), input("maxTurns", { type: "number", width: 100 })),
      settingRow(t("Max budget (USD)"), t("Stop when the session cost reaches this."), input("maxBudgetUsd", { type: "number", width: 100 })),
    ),
    group(
      "Session shape",
      settingRow(t("Agent"), t("Run the whole session as this subagent definition."), selectControl(state.agent, [["", t("(none)")], ...agents], (value) => { state.agent = value; })),
      settingRow(t("Beta features"), t("Comma separated beta headers."), input("betas", { placeholder: "context-1m-2025-08-07" })),
      settingRow(t("Strict MCP config"), t("Ignore MCP servers from settings files."), toggleControl(state.strictMcpConfig, (value) => { state.strictMcpConfig = value; })),
      settingRow(t("Git worktree"), t("Work in an isolated git worktree (optionally named)."), h("div.inline-controls", toggleControl(state.useWorktree, (value) => { state.useWorktree = value; }), input("worktree", { placeholder: t("name (optional)"), width: 150 }))),
      h("div.field-label", t("Extra CLI flags (one per line)")),
      extraArea,
    ),
    h(
      "div.rule-actions",
      h("button.btn.primary", { type: "button", disabled: !app.currentId, onclick: apply }, icon("check", 14), t("Apply to this session")),
      h("button.btn.ghost", { type: "button", disabled: !app.currentId, onclick: async () => { await session.applyStartOptions(Object.fromEntries(START_KEYS.map((key) => [key, null]))); panel.replaceChildren(); sessionForm(panel); } }, icon("undo", 14), t("Reset to defaults")),
    ),
    dangerBanner(t("Extra CLI flags are passed straight to claude. A wrong flag can stop the session from starting.")),
  );
}

function parseExtraArgs(text) {
  const result = {};
  for (const line of text.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const match = /^--?([\w-]+)(?:[ =](.*))?$/.exec(line);
    if (match) result[match[1]] = match[2] === undefined ? null : match[2];
  }
  return Object.keys(result).length ? result : undefined;
}

// ---- effective settings ----------------------------------------------------------------
async function effective(panel) {
  panel.replaceChildren(h("div.muted", t("Loading…")));
  try {
    const result = await api.get("/api/settings-effective", { cwd: currentCwd() });
    const prov = result.provenance || {};
    panel.replaceChildren(
      h("p.muted.small", t("The merged result of user, project, local and any managed policy settings, with the source of each top-level key.")),
      h("div.list-row-stack", result.sources.map((source) => h("div.list-row", h("span.badge.accent", source.source), h("div.grow", h("strong", { dir: "ltr" }, source.path || t("(built-in)")), h("span.muted", { dir: "ltr" }, source.keys.join(", ") || "—"))))),
      h("pre.json.effective", { dir: "ltr" }, JSON.stringify(result.effective, null, 2)),
      group("Where each key comes from", h("dl.kv", Object.entries(prov).flatMap(([key, entry]) => [h("dt", { dir: "ltr" }, key), h("dd", { dir: "ltr" }, typeof entry === "string" ? entry : entry?.source || JSON.stringify(entry))]))),
    );
  } catch (error) {
    panel.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
  }
}
