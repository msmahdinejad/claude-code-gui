// Reusable CRUD panel for Claude Code resource files (rules, output-styles, ...)
// backed by /api/resources and /api/resource. Exported helper only; registers nothing.
import { h, toast, errorMessage, confirmDialog, promptDialog } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { renderMarkdown } from "../chat/markdown.js";
import { currentCwd } from "./settings-shared.js";

export function markdownEditor({ value, placeholder = "", onSave, onRevert, readonly = false, preview = true }) {
  const area = h("textarea.input.editor", { dir: "auto", spellcheck: "false", placeholder, rows: 14 });
  area.value = value;
  area.readOnly = readonly;
  const rendered = h("div.markdown.editor-preview.hidden");
  const status = h("span.muted.small");
  let saved = value;
  const mark = () => {
    const dirty = area.value !== saved;
    status.textContent = dirty ? t("Unsaved changes") : "";
    save.disabled = !dirty;
    revert.disabled = !dirty;
  };
  const save = h("button.btn.primary.small", { type: "button", onclick: async () => { await onSave(area.value); saved = area.value; mark(); } }, icon("check", 13), t("Save"));
  const revert = h("button.btn.ghost.small", { type: "button", onclick: () => { area.value = saved; mark(); onRevert?.(); } }, icon("undo", 13), t("Revert"));
  const toggle = h("button.btn.ghost.small", { type: "button", onclick: () => {
    const show = rendered.classList.contains("hidden");
    if (show) rendered.innerHTML = renderMarkdown(area.value);
    rendered.classList.toggle("hidden", !show);
    area.classList.toggle("hidden", show);
    toggle.classList.toggle("active", show);
  } }, icon("eye", 13), t("Preview"));
  area.addEventListener("input", mark);
  area.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!save.disabled) save.click();
    }
  });
  mark();
  return {
    el: h("div.md-editor", area, rendered, h("div.md-editor-bar", status, h("span.grow"), preview ? toggle : null, revert, readonly ? null : save)),
    area,
    get value() { return area.value; },
  };
}

/**
 * kind: "rules" | "output-styles" | ...; scope: "user" | "project".
 * template(name) -> initial file content for a new resource.
 */
export async function resourcePanel(container, { kind, scope, template, emptyText, nameHint }) {
  const cwd = currentCwd();
  const listHost = h("div.rule-list");
  const editorHost = h("div.resource-editor");
  container.replaceChildren(listHost, editorHost);
  let selected = null;

  async function loadList() {
    const { items, dir } = await api.get("/api/resources", { kind, scope, cwd });
    listHost.replaceChildren(
      ...(items.length
        ? items.map((item) =>
            h(
              `div.list-row.clickable${selected === item.name ? ".selected" : ""}`,
              { role: "button", tabindex: "0", onclick: () => open(item.name), onkeydown: (event) => event.key === "Enter" && open(item.name) },
              icon("file-text", 15),
              h("div.grow", h("strong", { dir: "ltr" }, item.name), h("span.muted", { dir: "ltr" }, item.path)),
              h("button.icon-btn", { type: "button", title: t("Delete"), onclick: (event) => { event.stopPropagation(); remove(item.name); } }, icon("trash", 14)),
            ),
          )
        : [h("div.muted.rule-empty", emptyText || t("Nothing here yet."))]),
      h("div.rule-actions", h("button.btn.small", { type: "button", onclick: create }, icon("plus", 13), t("New")), h("span.muted.small", { dir: "ltr" }, dir)),
    );
  }

  async function open(name) {
    selected = name;
    try {
      const file = await api.get("/api/resource", { kind, scope, cwd, name });
      const editor = markdownEditor({
        value: file.content,
        onSave: async (content) => {
          await api.put("/api/resource", { kind, scope, cwd, name, content });
          toast(t("Saved"), "ok", 1400);
        },
      });
      editorHost.replaceChildren(h("div.resource-title", icon("edit", 14), h("code", { dir: "ltr" }, file.path)), editor.el);
      await loadList();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  async function create() {
    const name = await promptDialog({ title: t("New file"), label: nameHint || t("Name (letters, digits, - _ .)"), placeholder: "my-style" });
    if (!name?.trim()) return;
    try {
      await api.put("/api/resource", { kind, scope, cwd, name: name.trim(), content: template ? template(name.trim()) : "" });
      await open(name.trim());
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  async function remove(name) {
    const ok = await confirmDialog({ title: t("Delete file"), message: t("Delete “{name}”? This cannot be undone.", { name }), confirmLabel: t("Delete"), danger: true });
    if (!ok) return;
    try {
      await api.del("/api/resource", { kind, scope, cwd, name });
      if (selected === name) {
        selected = null;
        editorHost.replaceChildren();
      }
      await loadList();
      toast(t("Deleted"), "ok", 1400);
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  await loadList();
  return { open, reload: loadList };
}
