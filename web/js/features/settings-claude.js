// Settings → Claude Code settings: every settings.json key from the official reference, rendered from
// settings-catalog-data.js. Each row edits one key in the selected scope through a read-modify-write
// (editScope), so other keys, including ones this editor doesn't know, are never touched.
import { h, errorMessage, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { app } from "../core/state.js";
import { registerSettingsSection } from "../core/registry.js";
import { scopedPage, editScope, loadScope, currentCwd, SCOPES } from "./settings-shared.js";
import { CATALOG, SECTIONS, ALL_SECTION, ELSEWHERE, EXCLUDED, GLOBAL_CONFIG_KEYS, EFFORT, MAX_EFFORT, categoryTitle } from "./settings-catalog-data.js";
import * as V from "./settings-catalog-values.js";

const scopeLabel = (id) => SCOPES.find((scope) => scope.id === id)?.label() || id;
const errorText = (problem) => `${problem.at ? `${problem.at}: ` : ""}${t(problem.msg, problem.vars || undefined)}`;
let uidCounter = 0;
const uid = () => `cc-${(uidCounter += 1)}`;
let lastQuery = "";

// ---- registration ------------------------------------------------------------------------------
for (const section of [...SECTIONS, ALL_SECTION]) {
  registerSettingsSection({ id: section.id, title: section.title, icon: section.icon, order: section.order, render: (el, appCtx) => renderPage(el, appCtx, section) });
}

function renderPage(el, appCtx, section) {
  scopedPage(el, {
    title: section.title,
    lead: section.lead,
    async render(body, page) {
      const env = await loadEnvironment(page.scope);
      if (page.isCurrent && !page.isCurrent()) return;
      const state = { scope: page.scope, json: V.isPlainObject(page.json) ? page.json : {}, ...env, appCtx };
      if (section === ALL_SECTION) renderAll(body, state);
      else renderSection(body, state, section);
    },
  });
}

/** The other scopes' files (for "also set in" badges) and the top-level keys a managed policy or --settings sets. */
async function loadEnvironment(scope) {
  const others = {};
  const policy = new Map();
  const tasks = SCOPES.filter((item) => item.id !== scope).map(async (item) => {
    try {
      const file = await loadScope(item.id);
      others[item.id] = V.isPlainObject(file.json) ? file.json : null;
    } catch {
      others[item.id] = null;
    }
  });
  tasks.push(
    api
      .get("/api/settings-effective", { cwd: currentCwd() })
      .then((result) => {
        for (const source of result.sources || []) if (source.source === "managed" || source.source === "flag") for (const key of source.keys || []) policy.set(key, source.source);
      })
      .catch(() => {}),
  );
  await Promise.all(tasks);
  return { others, policy };
}

// ---- pages -----------------------------------------------------------------------------------------
function renderSection(body, state, section) {
  body.append(elsewhereBox(state, ELSEWHERE.filter((item) => item.cats.some((cat) => section.cats.includes(cat)))));
  for (const cat of section.cats) {
    const entries = CATALOG.filter((entry) => entry.cat === cat);
    if (entries.length) body.append(categoryBlock(cat, entries, state));
  }
}

function categoryBlock(cat, entries, state) {
  return h("section.cc-group", h("h3", t(categoryTitle(cat))), h("div.cc-rows", entries.map((entry) => rowFor(entry, state))));
}

function elsewhereBox(state, items) {
  if (!items.length) return null;
  return h(
    "div.cc-elsewhere",
    icon("info", 14),
    h("span", t("Edited on other pages:")),
    items.map((item) =>
      h("button.btn.ghost.small", { type: "button", onclick: () => state.appCtx?.openSettings?.(item.section) }, t(item.title), h("code", { dir: "ltr" }, item.keys.join(", "))),
    ),
  );
}

function renderAll(body, state) {
  const search = h("input.input.cc-search", { type: "search", value: lastQuery, placeholder: t("Search keys and descriptions…"), "aria-label": t("Search settings"), spellcheck: "false" });
  const onlySet = h("input", { type: "checkbox" });
  const count = h("span.muted.small", { "aria-live": "polite" });
  const results = h("div.cc-results");
  const draw = () => {
    lastQuery = search.value;
    const list = CATALOG.filter(
      (entry) =>
        (!onlySet.checked || V.getPath(state.json, entry.path) !== undefined) &&
        V.matchesQuery(search.value, [entry.path, entry.title, t(entry.title), entry.desc, t(entry.desc), categoryTitle(entry.cat), t(categoryTitle(entry.cat))]),
    );
    count.textContent = t("{n} of {total} keys", { n: list.length, total: CATALOG.length });
    const cats = [...new Set(list.map((entry) => entry.cat))];
    results.replaceChildren(list.length ? cats.map((cat) => categoryBlock(cat, list.filter((entry) => entry.cat === cat), state)) : h("div.muted.cc-empty", t("No matching settings.")));
  };
  search.addEventListener("input", debounce(draw, 120));
  onlySet.addEventListener("change", draw);
  body.append(
    elsewhereBox(state, ELSEWHERE),
    h("div.cc-search-bar", search, h("label.cc-check", onlySet, t("Only keys set in this file")), count),
    results,
    notEditedHere(),
  );
  draw();
}

function notEditedHere() {
  const reasons = [...new Set(EXCLUDED.map((item) => item.reason))];
  const keyLink = (key) => h("a.cc-key-link", { href: V.docsUrl({ path: key }), target: "_blank", rel: "noreferrer noopener", dir: "ltr" }, key);
  return h(
    "details.cc-excluded",
    h("summary", t("Keys not edited here")),
    reasons.map((reason) => h("div.cc-excluded-group", h("strong", t(reason)), h("div.cc-key-list", EXCLUDED.filter((item) => item.reason === reason).map((item) => keyLink(item.path))))),
    h("div.cc-excluded-group", h("strong", t("Kept in ~/.claude.json (global config), not in settings.json")), h("div.cc-key-list", GLOBAL_CONFIG_KEYS.map(keyLink))),
  );
}

// ---- one key -------------------------------------------------------------------------------------------
function rowFor(entry, state) {
  let current = null;
  const draw = () => {
    // Keep focus on the same control across a redraw (a save redraws the row).
    const focusIndex = current?.contains(document.activeElement) ? focusables(current).indexOf(document.activeElement) : -1;
    const next = buildRow(entry, state, draw);
    if (current) current.replaceWith(next);
    current = next;
    if (focusIndex >= 0) focusables(next)[focusIndex]?.focus();
    return next;
  };
  return draw();
}

const focusables = (root) => [...root.querySelectorAll("input, select, textarea, button, a[href]")];

function buildRow(entry, state, redraw) {
  const value = V.getPath(state.json, entry.path);
  const allowed = V.scopeAllowed(entry, state.scope);
  const errorBox = h("div.cc-error", { role: "alert", hidden: true });
  const showError = (problem) => {
    errorBox.hidden = !problem;
    errorBox.textContent = problem ? errorText(problem) : "";
  };
  const commit = async (next) => {
    const problem = V.validateValue(entry, next);
    if (problem) {
      showError(problem);
      return false;
    }
    showError(null);
    if (V.sameValue(next, V.getPath(state.json, entry.path))) return true;
    try {
      state.json = await editScope(state.scope, (draft) => {
        if (next === undefined) V.unsetPath(draft, entry.path);
        else V.setPath(draft, entry.path, next);
      });
      redraw();
      return true;
    } catch (error) {
      showError({ msg: errorMessage(error) });
      return false;
    }
  };

  const invalid = value === undefined ? null : V.validateValue(entry, value);
  const ctx = { entry, value, commit, showError, state, label: t(entry.title) };
  const control = fitsControl(entry, value) ? controlFor(ctx) : jsonControl({ value, placeholder: entry.placeholder, onSave: commit, showError, label: ctx.label });

  return h(
    `div.cc-row${value !== undefined ? ".is-set" : ""}`,
    { dataset: { path: entry.path } },
    h(
      "div.cc-row-head",
      h("strong.cc-title", t(entry.title)),
      h("code.cc-key", { dir: "ltr" }, entry.path),
      badges(entry, state),
      h("a.cc-docs", { href: V.docsUrl(entry), target: "_blank", rel: "noreferrer noopener", title: t("Official documentation for this key") }, icon("external", 12), t("Docs")),
    ),
    h("p.cc-desc", t(entry.desc)),
    entry.deprecated ? h("p.cc-note.warn", icon("alert", 13), t(entry.deprecated)) : null,
    entry.note ? h("p.cc-note", t(entry.note)) : null,
    allowed
      ? entry.scopeNote && entry.scopes ? null : entry.scopeNote ? h("p.cc-note", t(entry.scopeNote)) : null
      : h("p.cc-note.warn", icon("lock", 13), t("Claude Code ignores this key in {scope} settings.", { scope: scopeLabel(state.scope) }), " ", entry.scopeNote ? t(entry.scopeNote) : ""),
    invalid ? h("p.cc-note.bad", icon("alert", 13), t("The value in this file is not valid: {error}", { error: errorText(invalid) })) : null,
    h("div.cc-control", allowed ? control : h("fieldset.cc-locked", { disabled: true }, control)),
    errorBox,
    h(
      "div.cc-meta",
      value === undefined ? h("span.muted", t("Not set in this file")) : null,
      h("span.cc-default", t("Default:"), " ", entry.default !== undefined ? h("code", { dir: "ltr" }, V.formatValue(entry.default)) : t("not set"), entry.defaultNote ? ` — ${t(entry.defaultNote)}` : ""),
      value !== undefined ? h("button.btn.ghost.small.cc-reset", { type: "button", title: t("Remove this key from the file"), onclick: () => commit(undefined) }, icon("undo", 13), t("Reset")) : null,
    ),
  );
}

function badges(entry, state) {
  const out = [];
  if (entry.since) out.push(h("span.badge", { dir: "ltr", title: t("Requires Claude Code {version} or later", { version: entry.since }) }, `v${entry.since}+`));
  if (entry.deprecated) out.push(h("span.badge.warn", t("Deprecated")));
  if (entry.scopes) out.push(h("span.badge", { title: entry.scopeNote ? t(entry.scopeNote) : "" }, entry.scopes.length === 1 ? t("User settings only") : t("User and local only")));
  for (const [id, json] of Object.entries(state.others)) {
    const other = json ? V.getPath(json, entry.path) : undefined;
    if (other === undefined) continue;
    const higher = V.SCOPE_RANK[id] > V.SCOPE_RANK[state.scope];
    out.push(h(`span.badge${higher ? ".warn" : ".accent"}`, { title: `${higher ? t("Usually overrides the value in this file") : t("The value in this file usually overrides it")}: ${V.formatValue(other)}` }, t("Also set in {scope}", { scope: scopeLabel(id) })));
  }
  const top = entry.path.split(".")[0];
  const source = state.policy.get(top);
  if (source) out.push(h("span.badge.danger", { title: t("A higher-priority source sets {key}; it may override this file.", { key: top }) }, source === "managed" ? t("Set by managed policy") : t("Set by --settings")));
  return out;
}

/** Whether the stored value has the basic shape the dedicated control can show; otherwise the JSON editor is used. */
function fitsControl(entry, value) {
  if (value === undefined || entry.type === "json") return true;
  switch (entry.type) {
    case "bool":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "enum":
    case "string":
    case "flag":
      return typeof value === "string";
    case "stringList":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "object":
      return entry.editor === "attribution" ? value === false || V.isPlainObject(value) : V.isPlainObject(value);
    case "map":
      return V.isPlainObject(value) && (entry.editor === "modelSettings" || Object.values(value).every((item) => typeof item === "string"));
    default:
      return true;
  }
}

function controlFor(ctx) {
  const { entry, value, commit, label } = ctx;
  if (entry.editor === "attribution") return attributionEditor(ctx);
  if (entry.editor === "modelPicker") return modelPickerEditor(ctx);
  if (entry.editor === "modelSettings") return modelSettingsEditor(ctx);
  switch (entry.type) {
    case "bool":
      return boolSeg(value, commit, label);
    case "flag":
      return seg([[undefined, t("Not set")], [entry.value, entry.value]], value, commit, label);
    case "enum":
      return enumControl({ value, options: entry.options, allowOther: entry.allowOther, suggestions: suggestionsFor(entry), onValue: commit, label });
    case "string":
      return textInput({ value, placeholder: entry.placeholder, suggestions: suggestionsFor(entry), label, onValue: (raw) => commit(V.parseTextInput(raw, { allowEmpty: entry.allowEmpty })) });
    case "number":
      return numberInput({ value, placeholder: entry.placeholder, label, showError: ctx.showError, onValue: commit });
    case "stringList":
      return listControl({ items: value || [], ordered: entry.editor === "orderedList", suggestions: suggestionsFor(entry), placeholder: entry.placeholder, label, onChange: (next) => commit(V.normalizeList(next)) });
    case "object":
      return objectEditor(ctx);
    case "map":
      return mapEditor(ctx);
    case "json":
      return jsonControl({ value, placeholder: entry.placeholder, onSave: commit, showError: ctx.showError, label });
    default:
      return h("span.muted", entry.type);
  }
}

function suggestionsFor(entry) {
  if (entry.suggest === "models") return (app.catalog?.models || []).map((model) => model.value).filter(Boolean);
  if (entry.suggest === "agents") return (app.catalog?.agents || []).map((agent) => agent.name).filter(Boolean);
  return [];
}

// ---- basic controls -----------------------------------------------------------------------------------
function seg(options, value, onValue, label) {
  return h(
    "div.seg.cc-seg",
    { role: "group", "aria-label": label },
    options.map(([optionValue, text]) => {
      const active = V.sameValue(optionValue, value);
      return h(`button${active ? ".active" : ""}`, { type: "button", "aria-pressed": String(active), title: optionValue === undefined ? t("Remove the key") : JSON.stringify(optionValue), onclick: () => onValue(optionValue) }, text);
    }),
  );
}

const boolSeg = (value, onValue, label) => seg([[undefined, t("Not set")], [true, t("On")], [false, t("Off")]], value, onValue, label);

function datalistFor(values) {
  if (!values.length) return [null, null];
  const id = uid();
  return [id, h("datalist", { id }, values.map((item) => h("option", { value: item })))];
}

function textInput({ value, placeholder, suggestions = [], label, onValue, multiline = false }) {
  const [listId, datalist] = datalistFor(suggestions);
  const input = multiline
    ? h("textarea.input.cc-textarea", { rows: 3, dir: "auto", placeholder: placeholder || "", "aria-label": label, spellcheck: "false" })
    : h("input.input.cc-text", { type: "text", value: value ?? "", placeholder: placeholder || "", dir: "ltr", spellcheck: "false", list: listId, "aria-label": label });
  if (multiline) input.value = value ?? "";
  let committed = String(value ?? "");
  const fire = () => {
    if (input.value === committed) return;
    committed = input.value;
    onValue(input.value);
  };
  input.addEventListener("change", fire);
  if (!multiline) input.addEventListener("keydown", (event) => event.key === "Enter" && (event.preventDefault(), fire()));
  return datalist ? h("span.cc-inline", input, datalist) : input;
}

function numberInput({ value, placeholder, label, showError, onValue, extra }) {
  return textInput({
    value: value === undefined ? "" : String(value),
    placeholder,
    label,
    onValue: (raw) => {
      if (extra && raw.trim() === extra) return onValue(extra);
      const parsed = V.parseNumberInput(raw);
      if (parsed.error) return showError(parsed.error);
      return onValue(parsed.value);
    },
  });
}

function enumControl({ value, options, allowOther, suggestions = [], onValue, label, notSetLabel }) {
  const values = options.map(V.optionValue);
  if (allowOther) return textInput({ value, suggestions: [...values, ...suggestions.filter((item) => !values.includes(item))], placeholder: values.join(" / "), label, onValue: (raw) => onValue(V.parseTextInput(raw)) });
  const items = [["", notSetLabel || t("(not set)")], ...values.map((item) => [item, item])];
  if (value !== undefined && !values.includes(value)) items.push([String(value), `${value} (?)`]);
  const select = h("select.input.cc-select", { "aria-label": label }, items.map(([optionValue, text]) => h("option", { value: optionValue, selected: String(value ?? "") === optionValue }, text)));
  select.addEventListener("change", () => onValue(select.value === "" ? undefined : select.value));
  return select;
}

function listControl({ items, onChange, ordered = false, suggestions = [], placeholder = "", label = "" }) {
  const [listId, datalist] = datalistFor(suggestions);
  const rows = items.map((item, index) => {
    const field = h("input.input.mono", { type: "text", value: item, dir: "ltr", spellcheck: "false", list: listId, "aria-label": `${label} ${index + 1}` });
    field.addEventListener("change", () => {
      const next = items.slice();
      next[index] = field.value;
      onChange(next);
    });
    const move = (delta) => {
      const next = items.slice();
      const [moved] = next.splice(index, 1);
      next.splice(index + delta, 0, moved);
      onChange(next);
    };
    return h(
      "div.cc-list-row",
      ordered ? h("span.cc-order", { dir: "ltr" }, String(index + 1)) : null,
      field,
      ordered ? h("button.icon-btn", { type: "button", title: t("Move up"), "aria-label": t("Move up"), disabled: index === 0, onclick: () => move(-1) }, icon("chevron-up", 14)) : null,
      ordered ? h("button.icon-btn", { type: "button", title: t("Move down"), "aria-label": t("Move down"), disabled: index === items.length - 1, onclick: () => move(1) }, icon("chevron-down", 14)) : null,
      h("button.icon-btn", { type: "button", title: t("Remove"), "aria-label": t("Remove"), onclick: () => onChange(items.filter((_, i) => i !== index)) }, icon("trash", 14)),
    );
  });
  const input = h("input.input.mono", { type: "text", placeholder, dir: "ltr", spellcheck: "false", list: listId, "aria-label": t("New item") });
  const add = () => {
    const next = input.value.trim();
    if (next) onChange([...items, next]);
  };
  input.addEventListener("keydown", (event) => event.key === "Enter" && (event.preventDefault(), add()));
  return h("div.cc-list", rows.length ? rows : h("div.muted.small", t("Empty list")), h("div.cc-list-add", input, datalist, h("button.btn.small", { type: "button", onclick: add }, icon("plus", 13), t("Add"))));
}

function jsonControl({ value, placeholder, onSave, showError, label, rows = 6 }) {
  const area = h("textarea.input.mono.cc-json", { rows, dir: "ltr", spellcheck: "false", placeholder: placeholder || "", "aria-label": label });
  area.value = value === undefined ? "" : JSON.stringify(value, null, 2);
  const status = h("span.json-status");
  const check = () => {
    const parsed = V.parseJsonInput(area.value);
    status.className = `json-status ${parsed.error ? "bad" : "ok"}`;
    status.replaceChildren(parsed.error ? errorText(parsed.error) : area.value.trim() ? t("Valid JSON") : t("Empty: saving removes the key"));
    return parsed;
  };
  area.addEventListener("input", check);
  const save = () => {
    const parsed = check();
    if (parsed.error) return showError(parsed.error);
    return onSave(parsed.value);
  };
  const format = () => {
    const parsed = check();
    if (!parsed.error && parsed.value !== undefined) area.value = JSON.stringify(parsed.value, null, 2);
  };
  return h("div.cc-json-editor", area, h("div.cc-json-bar", h("button.btn.small.primary", { type: "button", onclick: save }, icon("check", 13), t("Save")), h("button.btn.small", { type: "button", onclick: format }, icon("wand", 13), t("Format")), status));
}

// ---- objects and maps --------------------------------------------------------------------------------
function fieldControl(field, value, onValue, { showError, scope }) {
  const label = field.title ? t(field.title) : field.key;
  switch (field.type) {
    case "bool":
      return boolSeg(value, onValue, label);
    case "enum":
      return enumControl({ value, options: field.options, onValue, label, notSetLabel: field.default !== undefined ? t("(not set: {value})", { value: field.default }) : undefined });
    case "string":
      return textInput({ value, placeholder: field.placeholder, label, onValue: (raw) => onValue(V.parseTextInput(raw, { allowEmpty: field.allowEmpty })) });
    case "number":
      return numberInput({ value, placeholder: field.placeholder, label, showError, onValue });
    case "stringList":
      return listControl({ items: Array.isArray(value) ? value : [], placeholder: field.placeholder, label, onChange: (next) => onValue(V.normalizeList(next)) });
    case "tips":
      return tipsControl(value, onValue, { showError, scope, label });
    default:
      return h("span.muted", field.type);
  }
}

function fieldRow(field, control, locked) {
  return h("div.cc-field", h("div.cc-field-label", h("span", t(field.title || field.key)), h("code", { dir: "ltr" }, field.key)), locked ? h("fieldset.cc-locked", { disabled: true }, control, h("small.muted", t("Only honored in user settings."))) : control);
}

function objectEditor({ entry, value, commit, showError, state, label }) {
  let draft = value;
  const setField = (key, fieldValue) => {
    draft = V.withField(entry, draft, key, fieldValue);
    const problem = V.validateValue(entry, draft);
    if (problem) return showError(problem); // keep the draft until it is complete
    return commit(draft);
  };
  const parts = [];
  if (entry.presence) parts.push(seg([[false, t("Off")], [true, t("On")]], value !== undefined, (on) => commit(on ? (V.isPlainObject(value) ? value : {}) : undefined), label));
  if (!entry.presence || value !== undefined) {
    for (const field of entry.fields.filter((item) => item.const === undefined)) {
      const control = fieldControl(field, V.isPlainObject(draft) ? draft[field.key] : undefined, (next) => setField(field.key, next), { showError, scope: state.scope });
      parts.push(fieldRow(field, control, !V.fieldAllowed(field, state.scope)));
    }
  }
  return h("div.cc-object", parts);
}

function tipsControl(value, onValue, { showError, scope, label }) {
  const tips = Array.isArray(value) ? value : [];
  const plain = tips.every((tip) => typeof tip === "string");
  const host = h("div.cc-tips");
  const asJson = () =>
    host.replaceChildren(
      jsonControl({ value: tips.length ? tips : undefined, placeholder: "[\n  \"Run /review before opening a PR\",\n  { \"id\": \"gateway\", \"text\": \"Check the status page first\", \"cooldownSessions\": 5 }\n]", label, showError, onSave: (next) => {
        const problem = next === undefined ? null : V.check(V.TIPS_SCHEMA, next, "tips");
        if (problem) return showError(problem);
        return onValue(next === undefined || !next.length ? undefined : next);
      } }),
      scope !== "user" ? h("small.muted", t("Project and local files only use plain text tips.")) : null,
    );
  if (!plain) asJson();
  else host.replaceChildren(listControl({ items: tips, label, placeholder: t("Tip text"), onChange: (next) => onValue(V.normalizeList(next)) }), h("button.btn.ghost.small", { type: "button", onclick: asJson }, icon("edit", 13), t("Edit as JSON (tip objects with id, cooldown, priority)")));
  return host;
}

function mapEditor({ entry, value, commit, label }) {
  const pairs = Object.entries(V.isPlainObject(value) ? value : {});
  const save = (nextPairs) => commit(V.mapFromPairs(nextPairs));
  const valueControl = (current, onValue, aria) =>
    entry.valueField.type === "enum"
      ? (() => {
          const select = h("select.input.cc-select", { "aria-label": aria }, entry.valueField.options.map((option) => h("option", { value: option, selected: option === current }, option)));
          select.addEventListener("change", () => onValue(select.value));
          return select;
        })()
      : textInput({ value: current, placeholder: entry.placeholder, label: aria, onValue });
  const rows = pairs.map(([key, current], index) => {
    const keyInput = textInput({ value: key, label: `${label} ${index + 1}`, onValue: (raw) => save(pairs.map((pair, i) => (i === index ? [raw.trim(), pair[1]] : pair))) });
    return h(
      "div.cc-map-row",
      keyInput,
      valueControl(current, (next) => save(pairs.map((pair, i) => (i === index ? [pair[0], V.parseTextInput(next)] : pair))), `${key}`),
      h("button.icon-btn", { type: "button", title: t("Remove"), "aria-label": t("Remove"), onclick: () => save(pairs.filter((_, i) => i !== index)) }, icon("trash", 14)),
    );
  });
  const newKey = h("input.input.mono", { type: "text", placeholder: entry.keyPlaceholder || t("Key"), dir: "ltr", spellcheck: "false", "aria-label": t("New key") });
  let newValue = entry.valueField.type === "enum" ? entry.valueField.options[0] : "";
  const newValueControl = valueControl(newValue, (next) => { newValue = next; }, t("New value"));
  if (newValueControl.tagName !== "SELECT") newValueControl.addEventListener?.("input", (event) => { newValue = event.target.value; });
  const add = () => {
    const key = newKey.value.trim();
    const item = entry.valueField.type === "enum" ? newValue : V.parseTextInput(newValue);
    if (!key || item === undefined) return;
    save([...pairs.filter(([existing]) => existing !== key), [key, item]]);
  };
  return h("div.cc-map", rows.length ? rows : h("div.muted.small", t("No entries")), h("div.cc-map-row.cc-map-add", newKey, newValueControl, h("button.btn.small", { type: "button", onclick: add }, icon("plus", 13), t("Add"))));
}

// ---- custom editors ------------------------------------------------------------------------------------
function attributionEditor({ entry, value, commit, showError, label }) {
  const host = h("div.cc-object");
  const mode = value === false ? "none" : V.isPlainObject(value) ? "custom" : "default";
  let draft = V.isPlainObject(value) ? value : {};
  const save = (key, next) => {
    draft = V.withField(entry, draft, key, next) || {};
    return commit(Object.keys(draft).length ? draft : undefined);
  };
  const textPart = (key, title, placeholder) => {
    const current = draft[key];
    const kind = current === undefined ? "standard" : current === "" ? "hidden" : "custom";
    const area = textInput({ value: current ?? "", placeholder, multiline: true, label: t(title), onValue: (raw) => save(key, raw) });
    const wrap = h("div.cc-attr-text", { hidden: kind !== "custom" }, area);
    const select = h(
      "select.input.cc-select",
      { "aria-label": t(title) },
      [["standard", t("Standard text")], ["custom", t("Custom text")], ["hidden", t("None (empty text)")]].map(([optionValue, text]) => h("option", { value: optionValue, selected: optionValue === kind }, text)),
    );
    select.addEventListener("change", () => {
      if (select.value === "standard") save(key, undefined);
      else if (select.value === "hidden") save(key, "");
      else wrap.hidden = false;
    });
    return fieldRow({ key, title }, h("div.cc-attr", select, wrap));
  };
  const fields = () => [
    textPart("commit", "Commit text", "Co-Authored-By: …"),
    textPart("pr", "Pull request text", "🤖 Generated with Claude Code"),
    fieldRow({ key: "sessionUrl", title: "Session link" }, boolSeg(draft.sessionUrl, (next) => save("sessionUrl", next), t("Session link"))),
  ];
  const modeSeg = seg([["default", t("Standard")], ["custom", t("Custom")], ["none", t("None (false)")]], mode, (next) => {
    showError(null);
    if (next === "default") return commit(undefined);
    if (next === "none") return commit(false);
    draft = V.isPlainObject(value) ? value : {};
    host.replaceChildren(modeSeg, ...fields());
    return null;
  }, label);
  host.append(modeSeg, ...(mode === "custom" ? fields() : []));
  return host;
}

function modelPickerEditor({ value, commit, showError, label }) {
  const draft = V.isPlainObject(value) ? structuredClone(value) : { options: [] };
  if (!Array.isArray(draft.options)) draft.options = [];
  const models = (app.catalog?.models || []).map((model) => model.value).filter(Boolean);
  const save = () => {
    const empty = !draft.options.length && Object.keys(draft).every((key) => key === "options");
    return commit(empty ? undefined : draft);
  };
  const cols = [["model", "Model"], ["label", "Label"], ["description", "Description"], ["behavesAs", "Behaves as"]];
  const rows = draft.options.map((option, index) =>
    h(
      "div.cc-picker-row",
      cols.map(([key, title]) =>
        textInput({ value: option?.[key], placeholder: t(title), suggestions: key === "model" || key === "behavesAs" ? models : [], label: `${t(title)} ${index + 1}`, onValue: (raw) => {
          const next = { ...option };
          const text = V.parseTextInput(raw);
          if (text === undefined && key !== "model") delete next[key];
          else next[key] = text ?? "";
          draft.options[index] = next;
          save();
        } }),
      ),
      h("button.icon-btn", { type: "button", title: t("Move up"), "aria-label": t("Move up"), disabled: index === 0, onclick: () => { draft.options.splice(index - 1, 0, draft.options.splice(index, 1)[0]); save(); } }, icon("chevron-up", 14)),
      h("button.icon-btn", { type: "button", title: t("Remove"), "aria-label": t("Remove"), onclick: () => { draft.options.splice(index, 1); save(); } }, icon("trash", 14)),
    ),
  );
  const [listId, datalist] = datalistFor(models);
  const newModel = h("input.input.mono", { type: "text", dir: "ltr", spellcheck: "false", list: listId, placeholder: "us.anthropic.claude-opus-4-8", "aria-label": t("New model row") });
  const add = () => {
    const model = newModel.value.trim();
    if (!model) return showError({ msg: V.MESSAGES.required, vars: { field: "model" } });
    draft.options.push({ model });
    return save();
  };
  newModel.addEventListener("keydown", (event) => event.key === "Enter" && (event.preventDefault(), add()));
  return h(
    "div.cc-object",
    h("div.cc-picker-head", cols.map(([, title]) => h("span", t(title)))),
    rows.length ? rows : h("div.muted.small", t("No rows; the picker shows the built-in list.")),
    h("div.cc-list-add", newModel, datalist, h("button.btn.small", { type: "button", onclick: add }, icon("plus", 13), t("Add row"))),
    fieldRow({ key: "replaceBuiltInOptions", title: "Replace the built-in list" }, boolSeg(draft.replaceBuiltInOptions, (next) => { if (next === undefined) delete draft.replaceBuiltInOptions; else draft.replaceBuiltInOptions = next; save(); }, label)),
    h("small.muted", t("behavesAs needs Claude Code 2.1.257 or later.")),
  );
}

function modelSettingsEditor({ value, commit, showError }) {
  const draft = V.isPlainObject(value) ? structuredClone(value) : {};
  const host = h("div.cc-object");
  const models = (app.catalog?.models || []).map((model) => model.value).filter((item) => item && item !== "default");
  const save = () => {
    const kept = Object.fromEntries(Object.entries(draft).filter(([, item]) => !V.isPlainObject(item) || Object.keys(item).length));
    return commit(Object.keys(kept).length ? kept : undefined);
  };
  const setField = (model, key, next) => {
    const item = V.isPlainObject(draft[model]) ? { ...draft[model] } : {};
    if (next === undefined) delete item[key];
    else item[key] = next;
    draft[model] = item;
    save();
  };
  const draw = () => {
    const names = Object.keys(draft);
    const rows = names.map((model) => {
      const item = V.isPlainObject(draft[model]) ? draft[model] : {};
      return h(
        "div.cc-ms-row",
        h("code.cc-ms-model", { dir: "ltr" }, model),
        enumControl({ value: item.effortLevel, options: EFFORT, label: `${model} effortLevel`, notSetLabel: t("Effort: not set"), onValue: (next) => setField(model, "effortLevel", next) }),
        enumControl({ value: item.maxEffortLevel, options: MAX_EFFORT, label: `${model} maxEffortLevel`, notSetLabel: t("Cap: not set"), onValue: (next) => setField(model, "maxEffortLevel", next) }),
        numberInput({ value: item.autoCompactWindow, extra: "auto", placeholder: t("Compact window or auto"), label: `${model} autoCompactWindow`, showError, onValue: (next) => setField(model, "autoCompactWindow", next) }),
        h("button.icon-btn", { type: "button", title: t("Remove"), "aria-label": t("Remove"), onclick: () => { delete draft[model]; save(); } }, icon("trash", 14)),
      );
    });
    const [listId, datalist] = datalistFor(models);
    const input = h("input.input.mono", { type: "text", dir: "ltr", spellcheck: "false", list: listId, placeholder: "claude-opus-5-5", "aria-label": t("Model name") });
    const add = () => {
      const model = input.value.trim();
      if (!model || model in draft) return;
      draft[model] = {};
      draw(); // not saved until a field is set
    };
    input.addEventListener("keydown", (event) => event.key === "Enter" && (event.preventDefault(), add()));
    host.replaceChildren(
      h("div.cc-ms-head", h("span", t("Model")), h("span", "effortLevel"), h("span", "maxEffortLevel"), h("span", "autoCompactWindow")),
      rows.length ? rows : h("div.muted.small", t("No models saved.")),
      h("div.cc-list-add", input, datalist, h("button.btn.small", { type: "button", onclick: add }, icon("plus", 13), t("Add model"))),
      h("small.muted", t("maxEffortLevel needs 2.1.267 and autoCompactWindow needs 2.1.288 or later.")),
    );
  };
  draw();
  return host;
}
