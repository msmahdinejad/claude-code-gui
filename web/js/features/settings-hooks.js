// Settings → Hooks: structured editor for settings.hooks + effective view across scopes.
import { h, toast } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { registerSettingsSection } from "../core/registry.js";
import { scopedPage, group, getIn, loadScope, SCOPES, infoBanner, selectControl, textControl } from "./settings-shared.js";

export const HOOK_EVENTS = [
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "UserPromptSubmit", "UserPromptExpansion", "SessionStart", "SessionEnd",
  "Stop", "StopFailure", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "PreModelSwitch", "PostModelSwitch", "PermissionRequest", "PermissionDenied",
  "Setup", "TeammateIdle", "TaskCreated", "TaskCompleted", "Elicitation", "ElicitationResult", "ConfigChange", "WorktreeCreate", "WorktreeRemove",
  "InstructionsLoaded", "CwdChanged", "FileChanged", "DirectoryAdded", "MessageDisplay",
];
const MATCHER_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied", "SessionStart", "Notification", "PreCompact", "FileChanged"]);
const HOOK_TYPES = ["command", "prompt", "agent", "http"];

const TEMPLATES = [
  { title: () => t("Block dangerous shell commands"), event: "PreToolUse", matcher: "Bash", hook: { type: "command", command: "node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const c=(JSON.parse(d).tool_input||{}).command||'';if(/rm\\s+-rf\\s+[\\/~]|git\\s+push\\s+--force/.test(c)){console.error('Blocked dangerous command');process.exit(2)}})\"", timeout: 10 } },
  { title: () => t("Log every Bash command"), event: "PostToolUse", matcher: "Bash", hook: { type: "command", command: "node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>require('fs').appendFileSync(process.env.TEMP+'/claude-bash.log',(JSON.parse(d).tool_input||{}).command+'\\n'))\"", timeout: 10 } },
  { title: () => t("Run Prettier after edits"), event: "PostToolUse", matcher: "Edit|Write|MultiEdit", hook: { type: "command", command: "npx prettier --write \"$CLAUDE_FILE_PATHS\"", timeout: 30 } },
  { title: () => t("Remind the model of project rules"), event: "UserPromptSubmit", matcher: "", hook: { type: "prompt", prompt: "Before answering, check that the request is consistent with CLAUDE.md." } },
  { title: () => t("Notify when Claude stops"), event: "Stop", matcher: "", hook: { type: "command", command: "powershell -NoProfile -Command \"[console]::beep(800,200)\"", shell: "powershell", timeout: 10 } },
];

const FIELD_LABEL = { command: () => t("Command"), prompt: () => t("Prompt"), url: () => t("URL") };

function primaryField(hook) {
  return hook.type === "http" ? "url" : hook.type === "command" ? "command" : "prompt";
}

registerSettingsSection({
  id: "hooks",
  title: "Hooks",
  icon: "zap",
  order: 12,
  async render(el) {
    const effective = group("Effective hooks (all scopes)");
    scopedPage(el, {
      title: "Hooks",
      lead: "Shell commands, prompts or HTTP calls that run automatically at points in Claude's lifecycle.",
      async render(body, { json, edit }) {
        const hooks = getIn(json, "hooks", {});
        const disabled = getIn(json, "disableAllHooks", false);
        if (disabled) body.append(infoBanner(t("disableAllHooks is on in this scope, so none of these hooks run.")));
        const events = Object.keys(hooks);
        if (!events.length) body.append(h("div.muted.rule-empty", t("No hooks in this scope.")));
        for (const event of events) {
          const matchers = hooks[event] || [];
          body.append(
            group(
              event,
              ...matchers.map((entry, mIndex) =>
                h(
                  "div.hook-matcher",
                  h(
                    "div.hook-matcher-head",
                    h("span.muted", t("Matcher")),
                    textControl(entry.matcher || "", (value) => edit((d) => { d.hooks[event][mIndex].matcher = value || undefined; }), { placeholder: t("(all)"), width: 200 }),
                    h("button.icon-btn", { type: "button", title: t("Remove matcher"), onclick: () => edit((d) => removeMatcher(d, event, mIndex)) }, icon("trash", 14)),
                  ),
                  ...(entry.hooks || []).map((hook, hIndex) => hookCard(hook, (mutate) => edit((d) => mutate(d.hooks[event][mIndex].hooks[hIndex])), () => edit((d) => removeHook(d, event, mIndex, hIndex)))),
                ),
              ),
            ),
          );
        }
        body.append(addForm(edit), templatesGroup(edit));
        refreshEffective(effective);
      },
    });
  },
});

function removeMatcher(draft, event, index) {
  draft.hooks[event].splice(index, 1);
  if (!draft.hooks[event].length) delete draft.hooks[event];
  if (!Object.keys(draft.hooks).length) delete draft.hooks;
}

function removeHook(draft, event, mIndex, hIndex) {
  const entry = draft.hooks[event][mIndex];
  entry.hooks.splice(hIndex, 1);
  if (!entry.hooks.length) removeMatcher(draft, event, mIndex);
}

function hookCard(hook, mutate, remove) {
  const field = primaryField(hook);
  const main = h(field === "command" ? "textarea.input.mono" : "textarea.input", { rows: field === "command" ? 2 : 3, dir: field === "prompt" ? "auto" : "ltr", spellcheck: "false" });
  main.value = hook[field] || "";
  main.addEventListener("change", () => mutate((target) => { target[field] = main.value; }));
  const raw = h("textarea.input.mono.hidden", { rows: 8, dir: "ltr", spellcheck: "false" });
  raw.value = JSON.stringify(hook, null, 2);
  raw.addEventListener("change", () => {
    try {
      const parsed = JSON.parse(raw.value);
      mutate((target) => { for (const key of Object.keys(target)) delete target[key]; Object.assign(target, parsed); });
    } catch (error) {
      toast(`${t("Invalid JSON")}: ${error.message}`, "error");
    }
  });
  const extras = [
    hook.type === "command" ? selectControl(hook.shell || "", [["", t("default shell")], ["bash", "bash"], ["powershell", "powershell"]], (value) => mutate((target) => { target.shell = value || undefined; })) : null,
    h("label.hook-num", h("span", t("Timeout (s)")), textControl(hook.timeout ?? "", (value) => mutate((target) => { target.timeout = value ? Number(value) : undefined; }), { type: "number", width: 80 })),
    hook.type === "command" || hook.type === "http" ? selectControl(hook.onFailure || "", [["", t("on failure: default")], ["continue", t("on failure: continue")], ["block", t("on failure: block")]], (value) => mutate((target) => { target.onFailure = value || undefined; })) : null,
    h("label.switch", { title: t("Run only once per session") }, (() => { const i = h("input", { type: "checkbox", checked: Boolean(hook.once) }); i.addEventListener("change", () => mutate((target) => { target.once = i.checked || undefined; })); return i; })(), h("span", t("once"))),
  ].filter(Boolean);
  return h(
    "div.hook-card",
    h("div.hook-card-head", h("span.badge.accent", hook.type), h("span.grow"), h("button.btn.ghost.small", { type: "button", onclick: () => { raw.classList.toggle("hidden"); main.classList.toggle("hidden"); } }, icon("file-text", 13), "JSON"), h("button.icon-btn", { type: "button", title: t("Remove hook"), onclick: remove }, icon("trash", 14))),
    h("div.field-label", FIELD_LABEL[field]()),
    main,
    raw,
    h("div.hook-extras", extras),
  );
}

function addForm(edit) {
  const event = h("select.input", HOOK_EVENTS.map((name) => h("option", { value: name }, name)));
  const matcher = h("input.input.mono", { type: "text", dir: "ltr", placeholder: t("Matcher, e.g. Bash or Edit|Write (optional)") });
  const type = h("select.input", HOOK_TYPES.map((name) => h("option", { value: name }, name)));
  const value = h("textarea.input.mono", { rows: 3, dir: "ltr", spellcheck: "false", placeholder: t("Command, prompt or URL") });
  const syncMatcher = () => { matcher.disabled = !MATCHER_EVENTS.has(event.value); matcher.title = matcher.disabled ? t("This event does not use a matcher.") : ""; };
  event.addEventListener("change", syncMatcher);
  syncMatcher();
  const add = () => {
    if (!value.value.trim()) return toast(t("Enter a command, prompt or URL."), "error");
    const hook = { type: type.value, [type.value === "http" ? "url" : type.value === "command" ? "command" : "prompt"]: value.value.trim() };
    addHook(edit, event.value, matcher.disabled ? "" : matcher.value.trim(), hook);
  };
  return group("Add a hook", h("div.hook-add", h("div.hook-add-row", event, type), matcher, value, h("div.rule-actions", h("button.btn.primary", { type: "button", onclick: add }, icon("plus", 14), t("Add hook")))));
}

function addHook(edit, event, matcher, hook) {
  return edit((draft) => {
    draft.hooks ||= {};
    draft.hooks[event] ||= [];
    const target = draft.hooks[event].find((entry) => (entry.matcher || "") === matcher);
    if (target) target.hooks.push(hook);
    else draft.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [hook] });
  });
}

function templatesGroup(edit) {
  return group(
    "Templates",
    h("p.muted.small", t("Starting points. They are added to the scope selected above; review the command before relying on it.")),
    h("div.chip-row", TEMPLATES.map((tpl) => h("button.btn.small", { type: "button", onclick: () => addHook(edit, tpl.event, tpl.matcher, structuredClone(tpl.hook)) }, icon("plus", 13), tpl.title()))),
  );
}

async function refreshEffective(box) {
  box.querySelectorAll(":scope > :not(h3)").forEach((node) => node.remove());
  const rows = [];
  for (const scope of SCOPES) {
    try {
      const file = await loadScope(scope.id);
      const hooks = getIn(file.json || {}, "hooks", {});
      for (const [event, matchers] of Object.entries(hooks)) {
        for (const entry of matchers) {
          for (const hook of entry.hooks || []) {
            rows.push(h("div.list-row", h("span.badge", scope.label()), h("div.grow", h("strong", { dir: "ltr" }, `${event}${entry.matcher ? ` · ${entry.matcher}` : ""}`), h("span.muted", { dir: "ltr" }, `${hook.type}: ${hook[primaryField(hook)] || ""}`))));
          }
        }
      }
    } catch { /* ignore unreadable scope */ }
  }
  box.append(rows.length ? h("div.rule-list", rows) : h("div.muted", t("No hooks are configured in any scope.")));
}
