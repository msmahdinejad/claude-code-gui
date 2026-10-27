// Settings → Memory: CLAUDE.md (user / project / local) + rules files.
import { h, toast, errorMessage } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { app } from "../core/state.js";
import { registerSettingsSection } from "../core/registry.js";
import { group, SCOPES, currentCwd, pageHeader } from "./settings-shared.js";
import { markdownEditor, resourcePanel } from "./settings-resources.js";

const FILE_NAMES = { user: "CLAUDE.md", project: "CLAUDE.md", local: "CLAUDE.local.md" };
const STARTER = `# Project notes for Claude

## How to run
-

## Conventions
-

## Things to avoid
-
`;

registerSettingsSection({
  id: "memory",
  title: "Memory",
  icon: "book",
  order: 13,
  render(el, ctx) {
    let scope = "project";
    const bar = h("div.settings-scope-bar");
    const info = h("div.settings-scope-info");
    const editorHost = h("div.memory-editor");
    const rulesHost = h("div");
    el.append(...pageHeader("Memory", "CLAUDE.md files are read at the start of every session and shape how Claude works in your project."), bar, info, editorHost, group("Rules", h("p.muted.small", t("Smaller, topic-focused instruction files loaded alongside CLAUDE.md (.claude/rules/*.md).")), rulesHost));

    const drawBar = () => bar.replaceChildren(h("div.seg", SCOPES.map((item) => h(`button${item.id === scope ? ".active" : ""}`, { type: "button", onclick: () => { scope = item.id; drawBar(); load(); } }, `${item.label()} · ${FILE_NAMES[item.id]}`))));

    async function load() {
      editorHost.replaceChildren(h("div.muted", t("Loading…")));
      try {
        const file = await api.get("/api/claude-md", { scope, cwd: currentCwd() });
        info.replaceChildren(h("code.settings-path", { dir: "ltr" }, file.path), h("small.muted", file.exists ? "" : t("file does not exist yet; it is created on first save")));
        const editor = markdownEditor({
          value: file.exists ? file.content : "",
          placeholder: STARTER,
          onSave: async (content) => {
            await api.put("/api/claude-md", { scope, cwd: currentCwd(), content });
            toast(t("Saved"), "ok", 1400);
            load();
          },
        });
        editorHost.replaceChildren(
          !file.exists ? h("div.banner.info", icon("info", 14), h("span", t("No {name} here yet.", { name: FILE_NAMES[scope] })), h("button.btn.small", { type: "button", onclick: () => { editor.area.value = STARTER; editor.area.dispatchEvent(new Event("input")); editor.area.focus(); } }, icon("plus", 13), t("Start from a template"))) : null,
          editor.el,
          h(
            "div.rule-actions",
            h("button.btn.small", { type: "button", disabled: !app.currentId, title: t("Ask Claude to analyze the project and write CLAUDE.md"), onclick: () => { ctx.runPrompt("/init"); ctx.toast(t("Sent /init to the current session"), "ok", 1800); } }, icon("sparkles", 13), t("Generate with /init")),
          ),
        );
      } catch (error) {
        editorHost.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
      }
      drawRules();
    }

    function drawRules() {
      return resourcePanel(rulesHost, { kind: "rules", scope: scope === "user" ? "user" : "project", template: (name) => `# ${name}\n\n- \n`, emptyText: t("No rules files yet.") }).catch((error) => rulesHost.replaceChildren(h("div.banner.error", errorMessage(error))));
    }
    drawBar();
    load();
  },
});
