// Settings → Memory: everything Claude Code calls memory, in three tabs.
//   CLAUDE.md   user / project / local instruction files (GET|PUT /api/claude-md)
//   Rules       .claude/rules/**/*.md for the project and the user (/api/memory/rule*)
//   Auto memory Claude's own notes: MEMORY.md index + topic files (/api/memory/auto|file|index)
// Every async load captures what it loaded (scope, file, cwd) and drops responses that arrive
// after the user moved on, so a save can never land in a different file than the one shown.
import { h, toast, errorMessage, confirmDialog, promptDialog, modal } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { app } from "../core/state.js";
import { registerSettingsSection } from "../core/registry.js";
import { renderMarkdown } from "../chat/markdown.js";
import { group, SCOPES, currentCwd, pageHeader, settingRow, toggleControl, editScope, loadScope, listEditor } from "./settings-shared.js";
import { markdownEditor } from "./settings-resources.js";

const FILE_NAMES = { user: "CLAUDE.md", project: "CLAUDE.md", local: "CLAUDE.local.md" };
const STARTER = `# Project notes for Claude

## How to run
-

## Conventions
-

## Things to avoid
-
`;
const TYPES = ["user", "feedback", "project", "reference"];
const TABS = [
  { id: "claude-md", label: () => "CLAUDE.md", icon: "book" },
  { id: "rules", label: () => t("Rules"), icon: "list" },
  { id: "auto", label: () => t("Auto memory"), icon: "brain" },
];
const remembered = { tab: "claude-md", scope: "project" };

/** Returns a checker that is true only while this call is the latest one and `host` is on screen. */
function latest(counter, host) {
  const id = ++counter.n;
  return () => id === counter.n && host.isConnected;
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const withMd = (name) => (/\.md$/i.test(name) ? name : `${name}.md`);
const ltr = (text, tag = "code") => h(tag, { dir: "ltr" }, text);

registerSettingsSection({
  id: "memory",
  title: "Memory",
  icon: "book",
  order: 13,
  render(el, ctx) {
    const page = h("div.mem-page");
    const bar = h("div.tabs-inline.mem-tabs", { role: "tablist" });
    const body = h("div.mem-body");
    page.append(...pageHeader("Memory", "CLAUDE.md files and rules are instructions you write; auto memory holds notes Claude writes for itself. All of them load at the start of a session."), bar, body);
    el.append(page);
    const tabSeq = { n: 0 };

    function show(id) {
      remembered.tab = id;
      bar.replaceChildren(...TABS.map((tab) => h(`button${tab.id === id ? ".active" : ""}`, { type: "button", role: "tab", "aria-selected": String(tab.id === id), onclick: () => show(tab.id) }, icon(tab.icon, 13), tab.label())));
      const host = h("div.mem-tab");
      body.replaceChildren(host);
      const alive = latest(tabSeq, host);
      const render = id === "rules" ? renderRules : id === "auto" ? renderAuto : renderClaudeMd;
      render(host, { ctx, alive });
    }
    show(remembered.tab);
  },
});

// ---- CLAUDE.md -----------------------------------------------------------------------
function renderClaudeMd(host, { ctx }) {
  const bar = h("div.settings-scope-bar");
  const info = h("div.settings-scope-info");
  const notes = h("div.mem-notes");
  const editorHost = h("div.memory-editor");
  host.append(bar, info, notes, editorHost);
  const seq = { n: 0 };

  const drawBar = () => bar.replaceChildren(h("div.seg", SCOPES.map((item) => h(`button${item.id === remembered.scope ? ".active" : ""}`, { type: "button", onclick: () => { remembered.scope = item.id; drawBar(); load(); } }, `${item.label()} · ${FILE_NAMES[item.id]}`))));

  async function load() {
    const scope = remembered.scope; // captured: this load's editor saves here and nowhere else
    const cwd = currentCwd();
    const alive = latest(seq, host);
    editorHost.replaceChildren(h("div.muted", t("Loading…")));
    info.replaceChildren();
    try {
      const file = await api.get("/api/claude-md", { scope, cwd });
      if (!alive()) return;
      info.replaceChildren(h("code.settings-path", { dir: "ltr" }, file.path), h("small.muted", file.exists ? "" : t("file does not exist yet; it is created on first save")));
      const editor = markdownEditor({
        value: file.exists ? file.content : "",
        placeholder: STARTER,
        onSave: async (content) => {
          try {
            await api.put("/api/claude-md", { scope, cwd, content });
            toast(t("Saved"), "ok", 1400);
          } catch (error) {
            toast(errorMessage(error), "error");
            throw error;
          }
          if (alive()) load();
        },
      });
      editorHost.replaceChildren(
        !file.exists ? h("div.banner.info", icon("info", 14), h("span", t("No {name} here yet.", { name: FILE_NAMES[scope] })), h("button.btn.small", { type: "button", onclick: () => { editor.area.value = STARTER; editor.area.dispatchEvent(new Event("input")); editor.area.focus(); } }, icon("plus", 13), t("Start from a template"))) : null,
        editor.el,
        h("div.rule-actions", h("button.btn.small", { type: "button", disabled: !app.currentId, title: t("Ask Claude to analyze the project and write CLAUDE.md"), onclick: () => { ctx.runPrompt("/init"); ctx.toast(t("Sent /init to the current session"), "ok", 1800); } }, icon("sparkles", 13), t("Generate with /init"))),
      );
    } catch (error) {
      if (alive()) editorHost.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
    }
  }

  async function loadNotes() {
    const cwd = currentCwd();
    try {
      const overview = await api.get("/api/memory/overview", { cwd });
      if (!host.isConnected) return;
      const items = [];
      if (overview.dotClaudeMd) items.push(h("div.banner.info", icon("info", 14), h("span", t("This project also has a CLAUDE.md inside .claude/; Claude loads both."), " ", ltr(overview.dotClaudeMd))));
      if (overview.agentsMd.length) {
        items.push(h("div.banner.info", icon("info", 14), h("span", overview.claudeMd
          ? t("This project has AGENTS.md too. With the default setting Claude reads only the CLAUDE.md files, because a CLAUDE.md or CLAUDE.local.md exists here.")
          : t("No CLAUDE.md here, so Claude reads AGENTS.md instead (default setting)."), " ", ...overview.agentsMd.map((path) => ltr(path)))));
      }
      if (overview.excludes.length) items.push(h("div.banner.info", icon("info", 14), h("span", t("claudeMdExcludes skips files matching:"), " ", ...overview.excludes.map((pattern) => h("code.mem-chip", { dir: "ltr" }, pattern)))));
      notes.replaceChildren(...items);
    } catch { /* optional hints */ }
  }

  drawBar();
  load();
  loadNotes();
}

// ---- Rules -----------------------------------------------------------------------------
function renderRules(host, { alive }) {
  const listHost = h("div.mem-rules");
  const editorHost = h("div.mem-editor-host");
  host.append(
    h("p.muted.small", t("Topic-focused instructions in .claude/rules/ (all .md files, also in subfolders). A rule without paths loads in every session; a rule with paths loads only when Claude works with matching files.")),
    listHost,
    editorHost,
  );
  const listSeq = { n: 0 };
  const openSeq = { n: 0 };
  let selected = null; // { scope, rel }

  async function loadList() {
    const cwd = currentCwd();
    const fresh = latest(listSeq, listHost);
    try {
      const data = await api.get("/api/memory/rules", { cwd });
      if (!fresh() || !alive()) return;
      const sections = [];
      if (!cwd) sections.push(h("div.banner.info", icon("info", 14), h("span", t("Open a project to see its rules. User rules are shown below."))));
      for (const scope of ["project", "user"]) {
        const info = data.scopes[scope];
        if (!info) continue;
        sections.push(group(
          scope === "project" ? t("Project rules") : t("User rules"),
          h("div.mem-dir", h("code.settings-path", { dir: "ltr" }, info.dir), info.exists ? null : h("small.muted", t("folder does not exist yet; it is created with the first rule"))),
          h("div.rule-list", info.items.length ? info.items.map((item) => ruleRow(scope, item, cwd)) : h("div.muted.rule-empty", t("No rules files yet."))),
          h("div.rule-actions", h("button.btn.small", { type: "button", onclick: () => create(scope, cwd) }, icon("plus", 13), t("New rule"))),
        ));
      }
      listHost.replaceChildren(...sections);
    } catch (error) {
      if (fresh()) listHost.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
    }
  }

  function ruleRow(scope, item, cwd) {
    const isSel = selected?.scope === scope && selected?.rel === item.rel;
    const badges = [
      item.outside ? h("span.badge.warn", t("link outside the folder")) : item.scoped ? h("span.badge.accent", { title: item.paths.join("\n"), dir: "auto" }, t("Path-scoped · {n}", { n: item.paths.length })) : h("span.badge.ok", t("Always loaded")),
      item.link && !item.outside ? h("span.badge", t("link")) : null,
      item.yamlError ? h("span.badge.danger", { title: item.yamlError }, t("frontmatter unreadable: loads as if it had no paths")) : null,
      item.excludedBy ? h("span.badge.warn", { title: item.excludedBy }, t("excluded by claudeMdExcludes")) : null,
      item.error ? h("span.badge.danger", { title: item.error }, t("cannot read")) : null,
    ];
    const open = () => !item.outside && openRule(scope, item.rel, cwd);
    return h(
      `div.list-row${item.outside ? "" : ".clickable"}${isSel ? ".selected" : ""}`,
      { role: item.outside ? null : "button", tabindex: item.outside ? null : "0", onclick: open, onkeydown: (event) => event.key === "Enter" && open() },
      icon("file-text", 15),
      h("div.grow", h("strong", { dir: "ltr" }, item.rel), h("span.mem-badges", ...badges)),
      item.outside ? null : h("button.icon-btn", { type: "button", title: t("Rename"), "aria-label": t("Rename"), onclick: (event) => { event.stopPropagation(); rename(scope, item.rel, cwd); } }, icon("edit", 14)),
      h("button.icon-btn", { type: "button", title: t("Delete"), "aria-label": t("Delete"), onclick: (event) => { event.stopPropagation(); remove(scope, item.rel, cwd); } }, icon("trash", 14)),
    );
  }

  async function openRule(scope, rel, cwd) {
    selected = { scope, rel };
    const fresh = latest(openSeq, editorHost);
    editorHost.replaceChildren(h("div.muted", t("Loading…")));
    loadList();
    try {
      const file = await api.get("/api/memory/rule", { scope, cwd, rel });
      if (!fresh() || !alive()) return;
      let paths = file.paths.slice();
      const pathsHost = h("div");
      const savePaths = async (next) => {
        try {
          await api.put("/api/memory/rule", { scope, cwd, rel, paths: next });
          paths = next;
          toast(t("Saved"), "ok", 1400);
          if (fresh()) drawPaths();
          loadList();
        } catch (error) {
          toast(errorMessage(error), "error");
        }
      };
      const drawPaths = () => pathsHost.replaceChildren(
        h("div.mem-scope-line", paths.length ? h("span.badge.accent", t("Path-scoped")) : h("span.badge.ok", t("Always loaded")), h("small.muted", paths.length
          ? scope === "user" ? t("Patterns are relative to the session's working directory.") : t("Patterns are relative to the folder that holds .claude/.")
          : t("No paths: this rule loads at the start of every session."))),
        listEditor({ items: paths, onChange: savePaths, placeholder: "src/**/*.{ts,tsx}", addLabel: t("Add pattern"), emptyText: t("No path patterns.") }),
      );
      drawPaths();
      const editor = markdownEditor({
        value: file.body,
        onSave: async (content) => {
          try {
            await api.put("/api/memory/rule", { scope, cwd, rel, body: content });
            toast(t("Saved"), "ok", 1400);
          } catch (error) {
            toast(errorMessage(error), "error");
            throw error;
          }
        },
      });
      editorHost.replaceChildren(
        h("div.resource-title", icon("edit", 14), h("strong", scope === "project" ? t("Project rule") : t("User rule")), h("code", { dir: "ltr" }, file.path)),
        file.yamlError ? h("div.banner.warn", icon("alert", 14), h("span", t("The frontmatter could not be read, so Claude Code loads this rule as if it had no paths."), " ", ltr(file.yamlError))) : null,
        group(t("Paths"), pathsHost),
        editor.el,
      );
    } catch (error) {
      if (fresh()) editorHost.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
    }
  }

  async function create(scope, cwd) {
    const name = await promptDialog({ title: t("New rule"), label: t("File name, e.g. testing or frontend/react (.md is added)"), placeholder: "testing" });
    if (!name?.trim()) return;
    const rel = withMd(name.trim());
    const title = rel.replace(/\.md$/i, "").split("/").pop();
    try {
      await api.put("/api/memory/rule", { scope, cwd, rel, create: true, content: `# ${title}\n\n- \n` });
      await openRule(scope, rel, cwd);
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  async function rename(scope, from, cwd) {
    const name = await promptDialog({ title: t("Rename rule"), label: t("New file name"), value: from });
    if (!name?.trim() || withMd(name.trim()) === from) return;
    try {
      const result = await api.post("/api/memory/rule/rename", { scope, cwd, from, to: withMd(name.trim()) });
      if (selected?.scope === scope && selected?.rel === from) await openRule(scope, result.rel, cwd);
      else loadList();
      toast(t("Renamed"), "ok", 1400);
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  async function remove(scope, rel, cwd) {
    const ok = await confirmDialog({ title: t("Delete rule"), message: t("Delete “{name}”? This cannot be undone.", { name: rel }), confirmLabel: t("Delete"), danger: true });
    if (!ok) return;
    try {
      await api.del("/api/memory/rule", { scope, cwd, rel });
      if (selected?.scope === scope && selected?.rel === rel) {
        selected = null;
        openSeq.n += 1; // drop a pending open of the deleted file
        editorHost.replaceChildren();
      }
      toast(t("Deleted"), "ok", 1400);
      loadList();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  loadList();
}

// ---- Auto memory --------------------------------------------------------------------------
const VIA = {
  git: () => t("derived from the git repository root (shared by all its worktrees and subfolders)"),
  cwd: () => t("derived from the project folder (not a git repository)"),
  env: () => t("named by CLAUDE_CODE_PROJECT_DIR_NAME"),
  setting: () => t("set by autoMemoryDirectory"),
};
const SOURCE = { user: () => t("user settings"), project: () => t("project settings"), local: () => t("local settings"), managed: () => t("managed settings"), flag: () => t("--settings flag") };
const sourceLabel = (source) => (SOURCE[source] ? SOURCE[source]() : source || "");

function renderAuto(host, { alive }) {
  const top = h("div.mem-auto");
  const editorHost = h("div.mem-editor-host");
  host.append(top, editorHost);
  const loadSeq = { n: 0 };
  const openSeq = { n: 0 };
  let selected = null;
  let toggleTarget = "user";

  async function load() {
    const cwd = currentCwd();
    const fresh = latest(loadSeq, top);
    try {
      const [data, local] = await Promise.all([api.get("/api/memory/auto", { cwd }), cwd ? loadScope("local").catch(() => null) : null]);
      if (!fresh() || !alive()) return;
      top.replaceChildren(...locationGroup(data), statusGroup(data, local, cwd), ...(data.dir ? [indexGroup(data, cwd), filesGroup(data, cwd)] : []));
    } catch (error) {
      if (fresh()) top.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
    }
  }

  function locationGroup(data) {
    if (!data.dir) return [group(t("Location"), h("div.banner.info", icon("info", 14), h("span", t("Open a project to see its auto memory folder."))))];
    const setting = data.directorySetting;
    return [group(
      t("Location"),
      h("div.mem-dir", h("code.settings-path", { dir: "ltr" }, data.dir), data.exists ? null : h("small.muted", t("folder does not exist yet; Claude creates it when it saves its first memory"))),
      h("small.muted.mem-via", VIA[data.via]?.() || "", data.via === "setting" && setting ? ` (${sourceLabel(setting.source)})` : "", data.base && data.via !== "setting" ? [" · ", ltr(data.base)] : null),
      setting && data.via === "setting" && (setting.source === "project" || setting.source === "local")
        ? h("div.banner.warn", icon("alert", 14), h("span", t("autoMemoryDirectory comes from this project's settings. Claude Code honors it only after you trust the folder, like hooks.")))
        : null,
      setting && setting.ignored ? h("div.banner.warn", icon("alert", 14), h("span", t("autoMemoryDirectory is set but not usable (it must be an absolute path or start with ~/), so the default folder is used:"), " ", ltr(String(setting.value)))) : null,
    )];
  }

  function statusGroup(data, local, cwd) {
    if (!cwd) toggleTarget = "user";
    const state = data.enabled;
    const how = {
      default: t("on by default"),
      setting: t("set by autoMemoryEnabled in {source}", { source: sourceLabel(state.source) }),
      env: t("forced by the CLAUDE_CODE_DISABLE_AUTO_MEMORY environment variable"),
      "settings-env": t("forced by CLAUDE_CODE_DISABLE_AUTO_MEMORY in a settings env block"),
    }[state.by];
    const localValue = local?.json && typeof local.json.autoMemoryEnabled === "boolean" ? local.json.autoMemoryEnabled : undefined;
    const write = async (scope, mutate) => {
      try {
        await editScope(scope, mutate);
      } catch (error) {
        toast(errorMessage(error), "error");
      }
      if (alive()) load();
    };
    const targetSeg = cwd
      ? h("div.seg.mem-target", [["user", t("User settings")], ["local", t("This project (local)")]].map(([id, label]) => h(`button${toggleTarget === id ? ".active" : ""}`, { type: "button", onclick: () => { toggleTarget = id; load(); } }, label)))
      : null;
    return group(
      t("Status"),
      settingRow(
        state.enabled ? t("Auto memory is on") : t("Auto memory is off"),
        h("span", how, " · ", t("The switch writes autoMemoryEnabled to {target}.", { target: toggleTarget === "local" ? ".claude/settings.local.json" : "settings.json" })),
        toggleControl(state.enabled, (on) => write(toggleTarget, (json) => { json.autoMemoryEnabled = on; })),
      ),
      targetSeg ? h("div.mem-target-row", h("small.muted", t("Save the switch to:")), targetSeg) : null,
      state.by === "env" || state.by === "settings-env" ? h("div.banner.warn", icon("alert", 14), h("span", t("CLAUDE_CODE_DISABLE_AUTO_MEMORY={value} overrides the setting, so the switch has no effect until the variable is removed.", { value: state.value }))) : null,
      localValue !== undefined ? h("div.mem-target-row", h("small.muted", localValue ? t("This project turns it on in settings.local.json.") : t("This project turns it off in settings.local.json.")), h("button.btn.small.ghost", { type: "button", onclick: () => write("local", (json) => { delete json.autoMemoryEnabled; }) }, icon("x", 13), t("Remove project override"))) : null,
      h("small.muted", t("Running sessions keep their current setting; the change applies to new sessions.")),
    );
  }

  function indexGroup(data, cwd) {
    const index = data.index;
    const children = [];
    if (!index) {
      children.push(h("div.mem-dir", h("small.muted", t("No MEMORY.md yet."))), h("div.rule-actions", h("button.btn.small", { type: "button", onclick: () => createIndex(cwd) }, icon("plus", 13), t("Create MEMORY.md"))));
    } else if (index.error) {
      children.push(h("div.banner.error", icon("alert", 14), index.error));
    } else {
      const ratio = Math.max(index.lines / index.maxLines, index.bytes / index.maxBytes);
      children.push(
        h(
          `div.list-row.clickable${selected === "MEMORY.md" ? ".selected" : ""}`,
          { role: "button", tabindex: "0", onclick: () => openIndex(cwd), onkeydown: (event) => event.key === "Enter" && openIndex(cwd) },
          icon("list", 15),
          h("div.grow", h("strong", { dir: "ltr" }, "MEMORY.md"), h("span.muted", t("{lines} / {maxLines} lines · {size} / {max}", { lines: index.lines, maxLines: index.maxLines, size: kb(index.bytes), max: kb(index.maxBytes) }))),
          h("span.mem-meter", { title: `${Math.round(ratio * 100)}%` }, h(`span${index.over ? ".over" : index.near ? ".near" : ""}`, { style: { inlineSize: `${Math.min(100, Math.round(ratio * 100))}%` } })),
        ),
        index.over
          ? h("div.banner.error", icon("alert", 14), h("span", t("MEMORY.md is over the limit: only the first 200 lines or 25 KB load at session start; the rest is dropped. Keep one short line per memory.")))
          : index.near ? h("div.banner.warn", icon("alert", 14), h("span", t("MEMORY.md is close to the limit (200 lines or 25 KB load at session start). Keep one short line per memory and move detail into topic files."))) : null,
      );
    }
    return group(t("Index (MEMORY.md)"), h("p.muted.small", t("Loaded at the start of every session. One line per memory, pointing to its topic file.")), ...children);
  }

  function filesGroup(data, cwd) {
    const rows = data.files.map((file) => {
      const open = () => !file.outside && openTopic(cwd, file.rel);
      return h(
        `div.list-row${file.outside ? "" : ".clickable"}${selected === file.rel ? ".selected" : ""}`,
        { role: file.outside ? null : "button", tabindex: file.outside ? null : "0", onclick: open, onkeydown: (event) => event.key === "Enter" && open() },
        icon("file-text", 15),
        h(
          "div.grow",
          h("span.mem-title-line", h("strong", { dir: "auto" }, file.name || file.rel), file.type ? h(`span.badge.mem-type.t-${TYPES.includes(file.type) ? file.type : "other"}`, typeLabel(file.type)) : null, file.outside ? h("span.badge.warn", t("link outside the folder")) : null),
          file.description ? h("span.mem-desc", { dir: "auto" }, file.description) : null,
          h("span.muted", { dir: "ltr" }, file.rel),
        ),
        !file.indexed && !file.outside ? h("button.btn.small.ghost", { type: "button", title: t("Add a line for this file to MEMORY.md"), onclick: (event) => { event.stopPropagation(); addToIndex(cwd, file); } }, icon("plus", 12), t("Not in index")) : null,
        h("button.icon-btn", { type: "button", title: t("Delete"), "aria-label": t("Delete"), onclick: (event) => { event.stopPropagation(); removeTopic(cwd, file); } }, icon("trash", 14)),
      );
    });
    return group(
      t("Topic files"),
      h("p.muted.small", t("One memory per file. Claude reads these on demand, not at startup.")),
      h("div.rule-list", rows.length ? rows : h("div.muted.rule-empty", t("No memories saved yet."))),
      h("div.rule-actions", h("button.btn.small", { type: "button", onclick: () => createTopic(cwd) }, icon("plus", 13), t("New memory"))),
    );
  }

  async function openIndex(cwd) {
    selected = "MEMORY.md";
    const fresh = latest(openSeq, editorHost);
    try {
      const file = await api.get("/api/memory/file", { cwd, rel: "MEMORY.md" });
      if (!fresh() || !alive()) return;
      const editor = markdownEditor({
        value: file.content,
        onSave: async (content) => {
          try {
            await api.put("/api/memory/file", { cwd, rel: "MEMORY.md", content });
            toast(t("Saved"), "ok", 1400);
          } catch (error) {
            toast(errorMessage(error), "error");
            throw error;
          }
          load();
        },
      });
      editorHost.replaceChildren(h("div.resource-title", icon("edit", 14), h("code", { dir: "ltr" }, file.path)), editor.el);
      load();
    } catch (error) {
      if (fresh()) editorHost.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
    }
  }

  async function createIndex(cwd) {
    try {
      await api.put("/api/memory/file", { cwd, rel: "MEMORY.md", create: true, content: "" });
      await openIndex(cwd);
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  async function openTopic(cwd, rel) {
    selected = rel;
    const fresh = latest(openSeq, editorHost);
    editorHost.replaceChildren(h("div.muted", t("Loading…")));
    load();
    try {
      const file = await api.get("/api/memory/file", { cwd, rel });
      if (!fresh() || !alive()) return;
      editorHost.replaceChildren(topicEditor(file, cwd, rel, fresh));
    } catch (error) {
      if (fresh()) editorHost.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
    }
  }

  function typeSelect(value) {
    const known = TYPES.includes(value) || !value;
    return h("select.input", [["", t("(none)")], ...TYPES.map((type) => [type, typeLabel(type)]), ...(known ? [] : [[value, value]])].map(([optionValue, label]) => h("option", { value: optionValue, selected: optionValue === (value || "") }, label)));
  }

  function topicEditor(file, cwd, rel, fresh) {
    const name = h("input.input", { type: "text", value: file.name, dir: "auto", spellcheck: "false" });
    const description = h("input.input", { type: "text", value: file.description, dir: "auto" });
    const type = typeSelect(file.type);
    const area = h("textarea.input.editor", { dir: "auto", spellcheck: "false", rows: 14 });
    area.value = file.body;
    const rendered = h("div.markdown.editor-preview.hidden");
    const status = h("span.muted.small");
    let saved = { name: file.name, description: file.description, type: file.type, body: file.body };
    const current = () => ({ name: name.value.trim(), description: description.value.trim(), type: type.value, body: area.value });
    const dirty = () => JSON.stringify(current()) !== JSON.stringify({ ...saved, name: saved.name.trim(), description: saved.description.trim() });
    const mark = () => {
      const isDirty = dirty();
      status.textContent = isDirty ? t("Unsaved changes") : "";
      save.disabled = !isDirty;
      revert.disabled = !isDirty;
    };
    const save = h("button.btn.primary.small", { type: "button", onclick: async () => {
      const next = current();
      try {
        await api.put("/api/memory/file", { cwd, rel, meta: { name: next.name, description: next.description, type: next.type }, body: next.body });
        saved = next;
        toast(t("Saved"), "ok", 1400);
        if (fresh()) mark();
        load();
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    } }, icon("check", 13), t("Save"));
    const revert = h("button.btn.ghost.small", { type: "button", onclick: () => { name.value = saved.name; description.value = saved.description; type.value = saved.type || ""; area.value = saved.body; mark(); } }, icon("undo", 13), t("Revert"));
    const toggle = h("button.btn.ghost.small", { type: "button", onclick: () => {
      const showing = rendered.classList.contains("hidden");
      if (showing) rendered.innerHTML = renderMarkdown(area.value);
      rendered.classList.toggle("hidden", !showing);
      area.classList.toggle("hidden", showing);
      toggle.classList.toggle("active", showing);
    } }, icon("eye", 13), t("Preview"));
    for (const field of [name, description, area]) field.addEventListener("input", mark);
    type.addEventListener("change", mark);
    area.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!save.disabled) save.click();
      }
    });
    mark();
    return h(
      "div.mem-topic",
      h("div.resource-title", icon("edit", 14), h("code", { dir: "ltr" }, file.path)),
      file.yamlError ? h("div.banner.warn", icon("alert", 14), h("span", t("Part of the frontmatter could not be read; unknown lines are kept as they are."), " ", ltr(file.yamlError))) : null,
      h("div.mem-fields",
        h("label.field", h("span", t("Name")), name),
        h("label.field", h("span", t("Type")), type),
        h("label.field.mem-wide", h("span", t("Description")), description),
      ),
      h("div.md-editor", area, rendered, h("div.md-editor-bar", status, h("span.grow"), toggle, revert, save)),
    );
  }

  async function createTopic(cwd) {
    const file = h("input.input", { type: "text", placeholder: "feedback_testing", dir: "ltr", spellcheck: "false", autofocus: true });
    const name = h("input.input", { type: "text", dir: "auto" });
    const description = h("input.input", { type: "text", dir: "auto" });
    const type = typeSelect("project");
    const content = h("textarea.input", { rows: 5, dir: "auto" });
    const result = await new Promise((resolve) => {
      let done = false;
      const finish = (value, dialog) => {
        if (done) return;
        done = true;
        resolve(value);
        dialog?.close();
      };
      modal({
        title: t("New memory"),
        width: 520,
        body: h("div",
          h("label.field", h("span", t("File name (.md is added)")), file),
          h("label.field", h("span", t("Name")), name),
          h("label.field", h("span", t("Description")), description),
          h("label.field", h("span", t("Type")), type),
          h("label.field", h("span", t("Content")), content),
        ),
        onClose: () => finish(null),
        actions: [
          { label: t("Cancel"), onClick: (dialog) => finish(null, dialog) },
          { label: t("Create"), variant: "primary", onClick: (dialog) => file.value.trim() && finish({ rel: withMd(file.value.trim()), name: name.value.trim(), description: description.value.trim(), type: type.value, body: content.value }, dialog) },
        ],
      });
    });
    if (!result) return;
    try {
      await api.put("/api/memory/file", { cwd, rel: result.rel, create: true, meta: { name: result.name || result.rel.replace(/\.md$/i, ""), description: result.description, type: result.type }, body: result.body ? `${result.body.replace(/\s+$/, "")}\n` : "" });
      toast(t("Saved"), "ok", 1400);
      const add = await confirmDialog({ title: t("Update MEMORY.md?"), message: t("Add a line for “{name}” to the MEMORY.md index? Claude finds topic files through the index.", { name: result.rel }), confirmLabel: t("Add to index") });
      if (add) await api.post("/api/memory/index", { cwd, op: "add", rel: result.rel, title: result.name || result.rel.replace(/\.md$/i, ""), description: result.description });
      await openTopic(cwd, result.rel);
    } catch (error) {
      toast(errorMessage(error), "error");
      load();
    }
  }

  async function addToIndex(cwd, file) {
    try {
      await api.post("/api/memory/index", { cwd, op: "add", rel: file.rel, title: file.name || file.rel.replace(/\.md$/i, ""), description: file.description });
      toast(t("Added to MEMORY.md"), "ok", 1400);
      load();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  async function removeTopic(cwd, file) {
    const ok = await confirmDialog({ title: t("Delete memory"), message: t("Delete “{name}”? This cannot be undone.", { name: file.rel }), confirmLabel: t("Delete"), danger: true });
    if (!ok) return;
    try {
      await api.del("/api/memory/file", { cwd, rel: file.rel });
      if (selected === file.rel) {
        selected = null;
        openSeq.n += 1;
        editorHost.replaceChildren();
      }
      toast(t("Deleted"), "ok", 1400);
      if (file.indexed) {
        const drop = await confirmDialog({ title: t("Update MEMORY.md?"), message: t("MEMORY.md still lists “{name}”. Remove that line from the index?", { name: file.rel }), confirmLabel: t("Remove line") });
        if (drop) await api.post("/api/memory/index", { cwd, op: "remove", rel: file.rel });
      }
    } catch (error) {
      toast(errorMessage(error), "error");
    }
    load();
  }

  load();
}

function typeLabel(type) {
  return { user: t("User"), feedback: t("Feedback"), project: t("Project"), reference: t("Reference") }[type] || type;
}
