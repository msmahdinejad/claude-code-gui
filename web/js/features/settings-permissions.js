// Settings → Permissions: rule lists, default mode, extra directories, bypass switch, per-session tool limits.
import { h, toast } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, setPrefs } from "../core/state.js";
import { registerSettingsSection } from "../core/registry.js";
import * as session from "../session.js";
import { PERMISSION_MODES } from "../ui/pickers.js";
import { scopedPage, group, settingRow, selectControl, toggleControl, listEditor, getIn, setIn, loadScope, dangerBanner, infoBanner, sessionOptions } from "./settings-shared.js";

const TOOL_SUGGESTIONS = [
  "Bash", "Bash(git status)", "Bash(git diff *)", "Bash(git log *)", "Bash(npm run *)", "Bash(npm test)", "Bash(node *)", "Bash(python *)", "Bash(ls *)",
  "PowerShell", "PowerShell(Get-ChildItem *)", "Read", "Read(./.env)", "Read(~/.ssh/**)", "Edit", "Edit(./src/**)", "Write", "NotebookEdit", "Glob", "Grep",
  "WebFetch", "WebFetch(domain:github.com)", "WebSearch", "Agent", "Skill", "TodoWrite", "mcp__server", "mcp__server__tool",
];

async function bypassDisabledBy() {
  for (const scope of ["user", "project", "local"]) {
    try {
      const file = await loadScope(scope);
      if (getIn(file.json || {}, "permissions.disableBypassPermissionsMode") === "disable") return scope;
    } catch { /* unreadable scope */ }
  }
  return null;
}

registerSettingsSection({
  id: "permissions",
  title: "Permissions",
  icon: "shield",
  order: 10,
  async render(el) {
    const disabledBy = await bypassDisabledBy();
    scopedPage(el, {
      title: "Permissions",
      lead: "Rules decide which tool calls run without asking. Deny beats ask, ask beats allow.",
      async render(body, { json, edit }) {
        const perm = (key, fallback) => getIn(json, `permissions.${key}`, fallback);
        const ruleGroup = (key, title, hint) =>
          group(
            title,
            h("p.muted.small", hint),
            listEditor({
              items: perm(key, []),
              suggestions: TOOL_SUGGESTIONS,
              placeholder: t("e.g. Bash(git *)  ·  Edit  ·  mcp__server__tool"),
              onChange: (next) => edit((draft) => setIn(draft, `permissions.${key}`, next)),
            }),
          );

        body.append(
          group(
            "Defaults",
            settingRow(t("Default permission mode"), t("Used when a session starts without an explicit mode."), selectControl(perm("defaultMode", ""), [["", t("(not set)")], ...PERMISSION_MODES.filter((mode) => mode.id !== "bypassPermissions" || !disabledBy).map((mode) => [mode.id, mode.title()])], (value) => edit((draft) => setIn(draft, "permissions.defaultMode", value || undefined)))),
            settingRow(t("Block reads outside the project"), t("Deny file reads outside the working directories."), toggleControl(perm("blockReadsOutsideWorkingDirectories", false), (value) => edit((draft) => setIn(draft, "permissions.blockReadsOutsideWorkingDirectories", value || undefined)))),
          ),
          ruleGroup("allow", "Always allow", t("Matching calls run without a prompt.")),
          ruleGroup("ask", "Always ask", t("Matching calls always prompt, even in permissive modes.")),
          ruleGroup("deny", "Always deny", t("Matching calls are blocked. Use this to protect secrets and destructive commands.")),
          group(
            "Extra directories",
            h("p.muted.small", t("Claude may read and edit these folders in addition to the project.")),
            listEditor({
              items: perm("additionalDirectories", []),
              placeholder: "C:\\data\\shared",
              onChange: (next) => edit((draft) => setIn(draft, "permissions.additionalDirectories", next)),
            }),
          ),
        );
      },
    });

    // ---- bypass switch (UI preference + start option) ----
    const bypass = group(
      "Bypass mode",
      disabledBy ? infoBanner(t("Bypass mode is disabled by permissions.disableBypassPermissionsMode in your {scope} settings.", { scope: disabledBy })) : null,
      dangerBanner(t("Bypass skips every permission prompt: Claude can run any command and edit any file unattended. Only enable it in a disposable sandbox.")),
      settingRow(t("Allow bypass mode"), t("Makes “Bypass permissions” selectable in the composer. It still has to be chosen per session."), (() => {
        const toggle = toggleControl(app.prefs.allowBypass && !disabledBy, (value) => {
          setPrefs({ allowBypass: value });
          toast(value ? t("Bypass mode can now be selected") : t("Bypass mode removed"), value ? "info" : "ok", 2000);
        });
        if (disabledBy) toggle.querySelector("input").disabled = true;
        return toggle;
      })()),
    );
    el.append(bypass, sessionToolsGroup());
  },
});

function sessionToolsGroup() {
  const meta = sessionOptions();
  const state = { allowed: [...(meta.allowedTools || [])], disallowed: [...(meta.disallowedTools || [])], dirs: [...(meta.addDirs || [])] };
  const host = h("div.group");
  const draw = () => {
    host.replaceChildren(
      h("h3", t("This session only")),
      h("p.muted.small", t("Extra limits for the open session. Applying restarts its Claude process in place (history is kept).")),
      h("div.field-label", t("Allowed tools")),
      listEditor({ items: state.allowed, suggestions: TOOL_SUGGESTIONS, placeholder: "Read, Bash(git *)", onChange: (next) => { state.allowed = next; draw(); } }),
      h("div.field-label", t("Disallowed tools")),
      listEditor({ items: state.disallowed, suggestions: TOOL_SUGGESTIONS, placeholder: "WebFetch, Bash(rm *)", onChange: (next) => { state.disallowed = next; draw(); } }),
      h("div.field-label", t("Additional directories")),
      listEditor({ items: state.dirs, placeholder: "C:\\data\\shared", onChange: (next) => { state.dirs = next; draw(); } }),
      h("div.rule-actions", h("button.btn.primary", { type: "button", disabled: !app.currentId, onclick: () => session.applyStartOptions({ allowedTools: state.allowed, disallowedTools: state.disallowed, addDirs: state.dirs }) }, icon("check", 14), t("Apply to this session"))),
    );
  };
  draw();
  return host;
}
