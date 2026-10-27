// Skills, slash commands and subagents: list (user / project / built-in / plugin), create from
// templates, edit with a frontmatter-aware editor, delete, "try it".
import { h, toast, errorMessage, confirmDialog, promptDialog, modal } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { registerSettingsSection } from "../core/registry.js";
import { refreshExtensions, busyButton, sectionTitle, emptyNote, loading, currentScopeLabel, parseFrontmatter, buildFile, EXT_CHANGED } from "./ext-common.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AGENT_COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"];

const KINDS = {
  skills: {
    id: "skills", section: "skills", title: "Skills", icon: "sparkles", order: 32, control: "reloadSkills", singular: "skill",
    lead: () => t("Skills are folders with a SKILL.md that Claude loads when relevant, or that you run as /name."),
    fields: [
      { key: "name", label: () => t("Name"), required: true, readonlyOnEdit: true },
      { key: "description", label: () => t("Description"), required: true, multiline: true, help: () => t("Say what it does and when Claude should use it.") },
      { key: "allowed-tools", label: () => t("Allowed tools"), help: () => t("Comma-separated, e.g. Read, Grep, Bash(git status:*)") },
    ],
    template: (name) => ({ data: { name, description: "" }, order: ["name", "description", "allowed-tools"], body: `# ${name}\n\n${"Describe the steps Claude should follow."}\n` }),
    nameFromFm: true,
  },
  commands: {
    id: "commands", section: "commands", title: "Slash commands", icon: "slash", order: 33, control: "reloadPlugins", singular: "command",
    lead: () => t("Custom slash commands are Markdown prompts. $ARGUMENTS is replaced with what you type after the name."),
    fields: [
      { key: "description", label: () => t("Description"), help: () => t("Shown in the / popup.") },
      { key: "argument-hint", label: () => t("Argument hint"), help: () => t("e.g. [issue-number]") },
      { key: "allowed-tools", label: () => t("Allowed tools"), help: () => t("Comma-separated, e.g. Bash(git add:*), Bash(git commit:*)") },
      { key: "model", label: () => t("Model"), models: true },
    ],
    template: () => ({ data: { description: "" }, order: ["description", "argument-hint", "allowed-tools", "model"], body: "Do the following for: $ARGUMENTS\n" }),
  },
  agents: {
    id: "agents", section: "agents", title: "Agents", icon: "bot", order: 34, control: "reloadPlugins", singular: "agent",
    lead: () => t("Subagents run in their own context with their own prompt, tools and model. Claude delegates to them or you can ask for one by name."),
    fields: [
      { key: "name", label: () => t("Name"), required: true, readonlyOnEdit: true },
      { key: "description", label: () => t("Description"), required: true, multiline: true, help: () => t("Tell Claude when to delegate to this agent.") },
      { key: "tools", label: () => t("Tools"), help: () => t("Comma-separated; leave empty to inherit all tools.") },
      { key: "model", label: () => t("Model"), models: true, agent: true },
      { key: "color", label: () => t("Color"), colors: true },
    ],
    template: (name) => ({ data: { name, description: "", model: "inherit", color: "blue" }, order: ["name", "description", "tools", "model", "color"], body: "You are a specialist. Describe your role, process and output format here.\n" }),
    nameFromFm: true,
  },
};

function modelOptions(agent) {
  const list = (app.catalog?.models || []).map((model) => model.value).filter((value) => value !== "default");
  return ["", ...(agent ? ["inherit"] : []), ...new Set(["sonnet", "opus", "haiku", ...list])];
}

function section(kindId) {
  const kind = KINDS[kindId];
  return {
    id: kind.id, title: kind.title, icon: kind.icon, order: kind.order,
    render(el, ctx) {
      const host = h("div.ext-page");
      el.append(h("h2", t(kind.title)), h("p.lead", kind.lead()), host);
      return mount(host, ctx, kind);
    },
  };
}

function mount(host, ctx, kind) {
  let alive = true;
  let items = [];

  async function load() {
    host.replaceChildren(loading());
    try {
      const [{ items: files }] = await Promise.all([ctx.api.get("/api/ext/resources", { kind: kind.id, cwd: ctx.cwd }), app.catalog ? null : ctx.session.ensureCatalog(ctx.cwd)]);
      items = files;
    } catch (error) {
      host.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
      return;
    }
    if (alive) drawList();
  }

  const reloadAll = async () => {
    await refreshExtensions(ctx, { control: kind.control });
    await load();
  };

  function tryIt(item) {
    const text = kind.id === "agents" ? t("Use the {name} agent to ", { name: item.name }) : `/${item.name} `;
    ctx.fillComposer(text);
    toast(t("Inserted into the composer"), "ok", 1500);
  }

  function row(item) {
    return h("div.ext-card",
      h("div.ext-card-head", icon(kind.icon, 16),
        h("div.grow", h("strong", { dir: "ltr" }, kind.id === "commands" ? `/${item.name}` : item.name), h("span.muted", { dir: "auto" }, item.description || "—")),
        h("span.badge", item.scope === "user" ? t("User") : t("Project")),
        item.model ? h("span.badge.accent", item.model) : null),
      h("div.ext-actions",
        h("button.btn.small", { type: "button", onclick: () => tryIt(item) }, icon("play", 13), t("Try it")),
        h("button.btn.small", { type: "button", onclick: () => edit(item) }, icon("edit", 13), t("Edit")),
        busyButton(t("Delete"), "trash", async () => {
          const ok = await confirmDialog({ title: t("Delete {kind}", { kind: t(kind.singular) }), message: t("Delete “{name}” from {scope}? This removes its file.", { name: item.name, scope: item.scope === "user" ? t("User") : t("Project") }), confirmLabel: t("Delete"), danger: true });
          if (!ok) return;
          await ctx.api.del("/api/resource", { kind: kind.id, scope: item.scope, cwd: ctx.cwd, name: item.name });
          toast(t("Deleted {name}", { name: item.name }), "ok", 2000);
          await reloadAll();
        }, { variant: "danger-outline" })),
    );
  }

  function catalogRows() {
    const catalog = app.catalog;
    if (!catalog) return [];
    const known = new Set(items.map((item) => item.name));
    if (kind.id === "agents") {
      return (catalog.agents || []).filter((agent) => !known.has(agent.name)).map((agent) => h("div.ext-card",
        h("div.ext-card-head", icon("bot", 16), h("div.grow", h("strong", agent.name), h("span.muted", { dir: "auto" }, (agent.description || "").slice(0, 200))), agent.model ? h("span.badge.accent", agent.model) : null, h("span.badge", agent.name.includes(":") ? t("Plugin") : t("Built-in"))),
        h("div.ext-actions", h("button.btn.small", { type: "button", onclick: () => tryIt(agent) }, icon("play", 13), t("Try it")))));
    }
    const wantBuiltin = kind.id === "commands";
    return (catalog.commands || [])
      .filter((command) => !known.has(command.name) && Boolean(command.builtin) === wantBuiltin)
      .map((command) => h("div.ext-card.compact",
        h("div.ext-card-head", icon(wantBuiltin ? "command" : "sparkles", 15), h("div.grow", h("strong", { dir: "ltr" }, `/${command.name}`), h("span.muted", { dir: "auto" }, (command.description || "").slice(0, 200))),
          command.argumentHint ? h("code.muted", command.argumentHint) : null,
          h("span.badge", wantBuiltin ? t("Built-in") : command.name.includes(":") ? t("Plugin") : t("Bundled")),
          h("button.btn.ghost.small", { type: "button", onclick: () => tryIt(command) }, icon("play", 13), t("Try it")))));
  }

  function drawList() {
    const projectItems = items.filter((item) => item.scope === "project");
    const userItems = items.filter((item) => item.scope === "user");
    const other = catalogRows();
    host.replaceChildren(
      sectionTitle(t("Yours"), h("div.ext-actions",
        busyButton(t("Reload"), "refresh", reloadAll, { variant: "ghost" }),
        h("button.btn.primary.small", { type: "button", onclick: () => create() }, icon("plus", 14), t("New {kind}", { kind: t(kind.singular) })))),
      h("h4.ext-sub", `${currentScopeLabel("project")} — ${ctx.cwd}`), ...(projectItems.length ? projectItems.map(row) : [emptyNote(t("None in this project."))]),
      h("h4.ext-sub", currentScopeLabel("user")), ...(userItems.length ? userItems.map(row) : [emptyNote(t("None yet."))]),
      other.length ? sectionTitle(kind.id === "agents" ? t("Built-in & plugin agents") : kind.id === "commands" ? t("Built-in commands") : t("Bundled & plugin skills")) : null,
      ...other,
    );
  }

  async function create() {
    const scope = await chooseScope();
    if (!scope) return;
    const name = await promptDialog({ title: t("New {kind}", { kind: t(kind.singular) }), label: t("Name (lowercase letters, digits, dashes)"), placeholder: kind.id === "commands" ? "review" : "my-" + kind.singular, confirmLabel: t("Create") });
    if (name === null) return;
    const clean = name.trim().replace(/^\//, "");
    if (!NAME_RE.test(clean)) return toast(t("Use lowercase letters, digits and dashes only."), "error");
    if (items.some((item) => item.name === clean && item.scope === scope)) return toast(t("That name already exists in this scope."), "error");
    const template = kind.template(clean);
    openEditor({ name: clean, scope, isNew: true, ...template });
  }

  function chooseScope() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value, dialog) => { if (done) return; done = true; resolve(value); dialog?.close(); };
      const dialog = modal({
        title: t("Where should it live?"), width: 440, onClose: () => finish(null),
        body: h("div.ext-choices",
          ["project", "user"].map((scope) => h("button.ext-choice", { type: "button", onclick: () => finish(scope, dialog) }, icon(scope === "project" ? "folder" : "user", 18), h("div", h("strong", currentScopeLabel(scope)), h("span.muted", scope === "project" ? ctx.cwd : t("Available in every project")))))),
      });
    });
  }

  async function edit(item) {
    host.replaceChildren(loading());
    try {
      const res = await ctx.api.get("/api/resource", { kind: kind.id, scope: item.scope, cwd: ctx.cwd, name: item.name });
      const parsed = parseFrontmatter(res.content);
      openEditor({ name: item.name, scope: item.scope, isNew: false, data: parsed.data, order: parsed.order, body: parsed.body, rawText: res.content, parseError: parsed.error });
    } catch (error) {
      toast(errorMessage(error), "error");
      drawList();
    }
  }

  function openEditor(entry) {
    let { data, order, body } = entry;
    let mode = "form";
    const errors = h("div.ext-errors");
    const formHost = h("div.ext-fields");
    const rawArea = h("textarea.input.editor.hidden", { rows: 18, spellcheck: "false", dir: "ltr" });
    const bodyArea = h("textarea.input.editor", { rows: 14, spellcheck: "false", dir: "auto" }, body);
    const bodyField = h("label.field", h("span", kind.id === "agents" ? t("System prompt") : t("Instructions")), bodyArea);
    const modeSeg = h("div.seg");

    const currentText = () => (mode === "raw" ? rawArea.value : buildFile(data, order, bodyArea.value));

    function validate() {
      const text = currentText();
      const parsed = parseFrontmatter(text);
      const problems = [];
      if (parsed.error) problems.push(parsed.error);
      const fm = parsed.data;
      if (kind.id !== "commands" && !parsed.hasFm) problems.push(t("Frontmatter (--- … ---) is required."));
      for (const field of kind.fields) {
        if (field.required && !String(fm[field.key] || "").trim()) problems.push(t("“{key}” is required.", { key: field.key }));
      }
      if (fm.name && kind.nameFromFm && !NAME_RE.test(fm.name)) problems.push(t("“name” must be lowercase letters, digits and dashes."));
      if (fm.name && kind.nameFromFm && fm.name !== entry.name) problems.push(t("“name” should match the file name “{name}”.", { name: entry.name }));
      if (fm.description && fm.description.length > 1024) problems.push(t("Description is longer than 1024 characters."));
      if (kind.id === "agents" && fm.color && !AGENT_COLORS.includes(fm.color)) problems.push(t("Unknown color “{color}”.", { color: fm.color }));
      if (!bodyArea.value.trim() && mode === "form") problems.push(t("The body is empty."));
      errors.replaceChildren(...problems.map((problem) => h("div.banner.warn", icon("alert", 14), h("span", { dir: "auto" }, problem))));
      return problems;
    }

    function drawForm() {
      formHost.replaceChildren(...kind.fields.map((field) => {
        let input;
        const value = data[field.key] ?? "";
        if (field.models) {
          input = h("select.input", modelOptions(field.agent).map((option) => h("option", { value: option, selected: option === value }, option || t("(default)"))));
          if (value && !modelOptions(field.agent).includes(value)) input.append(h("option", { value, selected: true }, value));
        } else if (field.colors) {
          input = h("select.input", ["", ...AGENT_COLORS].map((option) => h("option", { value: option, selected: option === value }, option || t("(none)"))));
        } else if (field.multiline) {
          input = h("textarea.input", { rows: 3, dir: "auto" }, value);
        } else {
          input = h("input.input", { type: "text", value, dir: "auto", spellcheck: "false", disabled: field.readonlyOnEdit && !entry.isNew ? true : undefined });
        }
        if (field.key === "name" && entry.isNew) input.disabled = true;
        const onChange = () => {
          data = { ...data, [field.key]: input.value };
          if (!order.includes(field.key)) order = [...order, field.key];
          validate();
        };
        input.addEventListener("input", onChange);
        input.addEventListener("change", onChange);
        return h("label.field", h("span", `${field.label()}${field.required ? " *" : ""}`), input, field.help ? h("small", field.help()) : null);
      }));
    }

    function setMode(next) {
      if (next === mode) return;
      if (next === "raw") {
        rawArea.value = buildFile(data, order, bodyArea.value);
        formHost.classList.add("hidden");
        bodyField.classList.add("hidden");
        rawArea.classList.remove("hidden");
      } else {
        const parsed = parseFrontmatter(rawArea.value);
        data = parsed.data;
        order = parsed.order;
        bodyArea.value = parsed.body;
        drawForm();
        formHost.classList.remove("hidden");
        bodyField.classList.remove("hidden");
        rawArea.classList.add("hidden");
      }
      mode = next;
      paintSeg();
      validate();
    }

    function paintSeg() {
      modeSeg.replaceChildren(...[["form", t("Form")], ["raw", t("Raw file")]].map(([id, label]) => h(`button${mode === id ? ".active" : ""}`, { type: "button", onclick: () => setMode(id) }, label)));
    }

    const save = busyButton(t("Save"), "check", async () => {
      const problems = validate();
      if (problems.length && !(await confirmDialog({ title: t("Save with warnings?"), message: problems.join("\n"), confirmLabel: t("Save anyway") }))) return;
      await ctx.api.put("/api/resource", { kind: kind.id, scope: entry.scope, cwd: ctx.cwd, name: entry.name, content: currentText() });
      toast(t("Saved {name}", { name: entry.name }), "ok", 2000);
      await refreshExtensions(ctx, { control: kind.control });
      await load();
    }, { variant: "primary", small: false });

    rawArea.addEventListener("input", validate);
    bodyArea.addEventListener("input", validate);
    drawForm();
    paintSeg();
    host.replaceChildren(
      h("div.ext-title",
        h("button.btn.ghost.small", { type: "button", onclick: () => load() }, icon("chevron-left", 14), t("Back")),
        h("h3", { dir: "ltr" }, `${kind.id === "commands" ? "/" : ""}${entry.name}`),
        h("span.badge", currentScopeLabel(entry.scope)), modeSeg),
      entry.parseError ? h("div.banner.warn", icon("alert", 14), entry.parseError) : null,
      errors, formHost, bodyField, rawArea,
      h("div.ext-actions", save, h("button.btn", { type: "button", onclick: () => load() }, t("Cancel"))),
    );
    validate();
  }

  const off = bus.on(EXT_CHANGED, () => {
    if (alive && !host.isConnected) { alive = false; off(); }
    if (alive && host.querySelector(".ext-fields") === null) load();
  });
  load();
  return () => { alive = false; off(); };
}

for (const id of Object.keys(KINDS)) registerSettingsSection(section(id));
