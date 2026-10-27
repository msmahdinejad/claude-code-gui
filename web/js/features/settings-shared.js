// Shared helpers for the settings/config editor sections (permissions, env, hooks, memory, ...).
// Loaded as a normal feature module (it registers nothing); sibling settings-*.js import from here.
import { h, toast, errorMessage, baseName } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { app } from "../core/state.js";

export const SCOPES = [
  { id: "user", label: () => t("User"), hint: () => t("Applies to every project") },
  { id: "project", label: () => t("Project"), hint: () => t("Shared, committed with the project (.claude/settings.json)") },
  { id: "local", label: () => t("Local"), hint: () => t("Only you, ignored by git (.claude/settings.local.json)") },
];

const lastScope = { value: "user" };

export function currentCwd() {
  return app.currentCwd || app.config?.defaultCwd;
}

// ---- object helpers ----------------------------------------------------------------
export function getIn(object, path, fallback) {
  let cursor = object;
  for (const key of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || !(key in cursor)) return fallback;
    cursor = cursor[key];
  }
  return cursor ?? fallback;
}

const isEmpty = (value) =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length) || (value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);

/** Set a dotted path; empty values delete the key and prune empty parents. */
export function setIn(object, path, value) {
  const keys = path.split(".");
  const chain = [object];
  let cursor = object;
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] === null || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) {
      if (isEmpty(value)) return object;
      cursor[key] = {};
    }
    cursor = cursor[key];
    chain.push(cursor);
  }
  const last = keys.at(-1);
  if (isEmpty(value)) delete cursor[last];
  else cursor[last] = value;
  for (let index = chain.length - 1; index > 0; index -= 1) {
    if (!Object.keys(chain[index]).length) delete chain[index - 1][keys[index - 1]];
    else break;
  }
  return object;
}

// ---- file access -------------------------------------------------------------------
export const loadScope = (scope) => api.get("/api/settings", { scope, cwd: currentCwd() });

export async function saveScope(scope, json) {
  const result = await api.put("/api/settings", { scope, cwd: currentCwd(), text: JSON.stringify(json) });
  return result;
}

/**
 * Read-modify-write one scope. Always re-reads the file so edits made elsewhere
 * (CLI, other tabs) are not clobbered; unknown keys survive untouched.
 */
export async function editScope(scope, mutate, { quiet = false } = {}) {
  const file = await loadScope(scope);
  const json = file.json && typeof file.json === "object" ? file.json : {};
  if (file.json === null && file.exists) throw new Error(t("The settings file contains invalid JSON. Fix it in Advanced first."));
  mutate(json);
  await saveScope(scope, json);
  if (!quiet) toast(t("Saved"), "ok", 1400);
  return json;
}

export async function safeEdit(scope, mutate, options) {
  try {
    return await editScope(scope, mutate, options);
  } catch (error) {
    toast(errorMessage(error), "error");
    return null;
  }
}

// ---- UI building blocks --------------------------------------------------------------
export function pageHeader(title, lead) {
  return [h("h2", t(title)), lead ? h("p.lead", t(lead)) : null];
}

/**
 * A page that edits one settings scope at a time. `render(body, state)` is called on
 * load / scope switch / reload() and receives { scope, file, json, path, reload, edit }.
 */
export function scopedPage(el, { title, lead, scopes = SCOPES, render, remember = true }) {
  const state = { scope: remember ? lastScope.value : scopes[0].id };
  if (!scopes.some((scope) => scope.id === state.scope)) state.scope = scopes[0].id;
  const bar = h("div.settings-scope-bar");
  const pathLabel = h("code.settings-path", { dir: "ltr" });
  const hint = h("small.muted");
  const body = h("div.settings-body");
  el.append(...pageHeader(title, lead), bar, h("div.settings-scope-info", pathLabel, hint), body);

  const renderBar = () => {
    bar.replaceChildren(
      h(
        "div.seg",
        scopes.map((scope) =>
          h(`button${scope.id === state.scope ? ".active" : ""}`, { type: "button", onclick: () => { state.scope = scope.id; if (remember) lastScope.value = scope.id; renderBar(); reload(); } }, scope.label()),
        ),
      ),
    );
  };

  async function reload() {
    body.replaceChildren(h("div.muted", t("Loading…")));
    try {
      const file = await loadScope(state.scope);
      const info = scopes.find((scope) => scope.id === state.scope);
      pathLabel.textContent = file.path;
      hint.textContent = `${info.hint()}${file.exists ? "" : ` — ${t("file does not exist yet; it is created on first save")}`}`;
      const context = {
        scope: state.scope,
        file,
        json: file.json,
        path: file.path,
        reload,
        edit: async (mutate, options) => {
          const result = await safeEdit(state.scope, mutate, options);
          if (result) await reload();
          return result;
        },
      };
      body.replaceChildren();
      if (file.json === null && file.exists) {
        body.append(h("div.banner.error", icon("alert", 14), t("This file is not valid JSON, so the form is read-only. Use Advanced → raw editor to repair it.")));
        return;
      }
      await render(body, context);
    } catch (error) {
      body.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
    }
  }

  renderBar();
  reload();
  return { reload, state };
}

export function group(title, ...children) {
  return h("div.group", title ? h("h3", t(title)) : null, ...children);
}

export function settingRow(title, desc, control) {
  return h("div.setting-row", h("div.grow", h("strong", title), desc ? h("small", desc) : null), control);
}

export function toggleControl(checked, onChange) {
  const input = h("input", { type: "checkbox", checked: Boolean(checked) });
  input.addEventListener("change", () => onChange(input.checked));
  return h("label.switch", input);
}

export function selectControl(value, options, onChange, { cls = "" } = {}) {
  const select = h(`select.input${cls ? `.${cls}` : ""}`, options.map(([optionValue, label]) => h("option", { value: optionValue, selected: String(optionValue) === String(value ?? "") }, label)));
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

export function textControl(value, onCommit, { placeholder = "", type = "text", dir = "ltr", width = 220 } = {}) {
  const input = h("input.input", { type, value: value ?? "", placeholder, dir, spellcheck: "false", style: { width: `${width}px`, minWidth: "120px" } });
  const commit = () => {
    if (input.value !== String(value ?? "")) onCommit(input.value);
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (event) => event.key === "Enter" && (event.preventDefault(), commit()));
  return input;
}

/**
 * Editable list of strings with a suggestion datalist. onChange(newArray) is awaited by callers.
 */
export function listEditor({ items, onChange, placeholder, suggestions = [], addLabel = t("Add"), monospace = true, emptyText = t("Nothing here yet.") }) {
  const listId = `dl-${Math.random().toString(36).slice(2, 8)}`;
  const list = h("div.rule-list");
  const input = h("input.input", { type: "text", placeholder, dir: "ltr", spellcheck: "false", list: listId });
  const datalist = h("datalist", { id: listId }, suggestions.map((value) => h("option", { value })));
  const add = () => {
    const value = input.value.trim();
    if (!value) return;
    if (items.includes(value)) {
      toast(t("Already in the list"), "info", 1500);
      return;
    }
    onChange([...items, value]);
  };
  input.addEventListener("keydown", (event) => event.key === "Enter" && (event.preventDefault(), add()));
  if (!items.length) list.append(h("div.muted.rule-empty", emptyText));
  items.forEach((item, index) => {
    const field = h(`input.input.rule-input${monospace ? ".mono" : ""}`, { type: "text", value: item, dir: "ltr", spellcheck: "false" });
    field.addEventListener("change", () => {
      const value = field.value.trim();
      const next = items.slice();
      if (value) next[index] = value;
      else next.splice(index, 1);
      onChange(next);
    });
    list.append(h("div.rule-row", field, h("button.icon-btn", { type: "button", title: t("Remove"), onclick: () => onChange(items.filter((_, i) => i !== index)) }, icon("trash", 14))));
  });
  return h("div.rule-editor", list, h("div.rule-add", input, datalist, h("button.btn.small", { type: "button", onclick: add }, icon("plus", 13), addLabel)));
}

export function pathBadge(path) {
  return h("span.file-badge", { dir: "ltr", title: path }, icon("file", 12), baseName(path));
}

export function dangerBanner(text) {
  return h("div.banner.error", icon("alert", 14), h("span", text));
}

export function infoBanner(text) {
  return h("div.banner.info", icon("info", 14), h("span", text));
}

export function sessionOptions() {
  const live = app.live.get(app.currentId);
  const conv = app.convs.get(app.currentId);
  return { ...(conv?.meta || {}), ...(live?.meta || {}) };
}
