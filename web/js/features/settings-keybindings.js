// Settings → Keyboard shortcuts: edits Claude Code's keybindings.json (CLAUDE_CONFIG_DIR/keybindings.json).
// Shows the documented defaults per context, the user's overrides, and lets you add / change / unbind / remove a
// binding, or edit the raw JSON. Every write re-reads the file first and changes only the bindings, so $schema,
// $docs and any field this editor does not know are kept.
import { h, toast, errorMessage, modal, confirmDialog } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { registerSettingsSection } from "../core/registry.js";
import { pageHeader, group, infoBanner } from "./settings-shared.js";
import { KEY_CONTEXTS, KEY_ACTIONS, DEFAULT_BINDINGS, CTRL_X_EXTRA_CHORDS, CONTEXT_IDS, isKnownAction, validateChord, lintKeybindings } from "./interface-data.js";
import { pick, chordView, rawJsonEditor } from "./interface-ui.js";

const SCHEMA = "https://www.schemastore.org/claude-code-keybindings.json";
const DOCS = "https://code.claude.com/docs/en/keybindings";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const contextInfo = new Map(KEY_CONTEXTS.map((entry) => [entry[0], entry]));
const actionInfo = new Map(KEY_ACTIONS.map((entry) => [entry[0], entry]));
const actionText = (id) => {
  const entry = actionInfo.get(id) || (id?.startsWith("command:") ? actionInfo.get("command:<name>") : null);
  return entry ? pick([entry[2], entry[3]]) : "";
};
const canonicalOf = (key) => validateChord(key).canonical || String(key).trim().toLowerCase();

let activeTab = "shortcuts";
let lastQuery = "";
let lastContext = "";
const openGroups = new Set(["Chat"]);

// ---- file access ---------------------------------------------------------------------------------------
const loadFile = () => api.get("/api/keybindings");

/** Read-modify-write: re-reads the file, lets `mutate(doc)` change the bindings, writes it back. */
async function mutateFile(mutate) {
  const fresh = await loadFile();
  if (fresh.error) throw new Error(t("keybindings.json is not valid JSON. Fix it in the Raw JSON tab first."));
  const doc = fresh.exists ? fresh.json : { $schema: SCHEMA, $docs: DOCS, bindings: [] };
  if (!isObject(doc)) throw new Error(t("keybindings.json must be a JSON object. Fix it in the Raw JSON tab first."));
  if (doc.bindings === undefined) doc.bindings = [];
  if (!Array.isArray(doc.bindings)) throw new Error(t("“bindings” in keybindings.json is not an array. Fix it in the Raw JSON tab first."));
  mutate(doc);
  await api.put("/api/keybindings", { text: `${JSON.stringify(doc, null, 2)}\n` });
}

const blocksOf = (doc, context) => doc.bindings.filter((block) => isObject(block) && block.context === context && isObject(block.bindings));

function removeKey(doc, context, key) {
  for (const block of blocksOf(doc, context)) delete block.bindings[key];
  doc.bindings = doc.bindings.filter((block) => !(isObject(block) && isObject(block.bindings) && !Object.keys(block.bindings).length && Object.keys(block).every((name) => name === "context" || name === "bindings")));
}

/** Set a binding; any existing entry for the same chord in that context (however it was spelled) is replaced. */
function setBinding(doc, context, key, action) {
  const canonical = canonicalOf(key);
  for (const block of blocksOf(doc, context)) for (const existing of Object.keys(block.bindings)) if (canonicalOf(existing) === canonical) delete block.bindings[existing];
  let block = blocksOf(doc, context)[0];
  if (!block) {
    block = { context, bindings: {} };
    doc.bindings.push(block);
  }
  block.bindings[key] = action;
}

function overridesOf(doc) {
  const rows = [];
  if (!isObject(doc) || !Array.isArray(doc.bindings)) return rows;
  for (const block of doc.bindings) {
    if (!isObject(block) || !isObject(block.bindings)) continue;
    for (const [key, action] of Object.entries(block.bindings)) rows.push({ context: String(block.context), key, action, canonical: canonicalOf(key) });
  }
  return rows;
}

// ---- add / edit dialog ---------------------------------------------------------------------------------
function openBindingDialog({ prefill = {}, overrides, onSaved }) {
  const original = prefill.original || null; // { context, key } when editing an existing override
  const contextSelect = h("select.input", KEY_CONTEXTS.map(([id]) => h("option", { value: id, selected: id === (prefill.context || lastContext || "Chat") }, id)));
  const contextHint = h("small.muted");
  const keyInput = h("input.input.mono", { type: "text", value: prefill.key || "", placeholder: "ctrl+k   or   ctrl+k ctrl+s", dir: "ltr", spellcheck: "false", autocomplete: "off" });
  const unbind = h("input", { type: "checkbox", checked: prefill.action === null });
  const actionInput = h("input.input.mono", { type: "text", value: typeof prefill.action === "string" ? prefill.action : "", placeholder: "chat:submit", dir: "ltr", spellcheck: "false", autocomplete: "off", list: "kb-actions" });
  const datalist = h("datalist", { id: "kb-actions" });
  const actionHint = h("small.muted");
  const messages = h("div.lint-list");
  const actionRow = h("div.kb-field", h("label.field-label", t("Action")), actionInput, datalist, actionHint);

  const fillActions = () => {
    const context = contextSelect.value;
    const home = KEY_ACTIONS.filter((entry) => entry[1].includes(context));
    const rest = KEY_ACTIONS.filter((entry) => !entry[1].includes(context) && !entry[4]);
    datalist.replaceChildren(...[...home, ...rest].map((entry) => h("option", { value: entry[0], label: pick([entry[2], entry[3]]).slice(0, 70) })));
    const info = contextInfo.get(context);
    contextHint.textContent = info ? pick([info[1], info[2]]) : "";
  };

  const problems = () => {
    const errors = [];
    const warnings = [];
    const context = contextSelect.value;
    const chord = validateChord(keyInput.value, t);
    errors.push(...chord.errors);
    warnings.push(...chord.warnings);
    if (!unbind.checked) {
      const action = actionInput.value.trim();
      if (!action) errors.push(t("Choose an action, or tick “Unbind”."));
      else if (!isKnownAction(action)) errors.push(t("“{action}” is not a documented action. Claude Code would skip this binding.", { action }));
      else {
        const entry = actionInfo.get(action);
        if (entry && entry[1].length && !entry[1].includes(context)) warnings.push(t("The docs list {action} for the {homes} context, not {context}; it may do nothing here.", { action, homes: entry[1].join(", "), context }));
        if (action === "command:<name>") errors.push(t("Replace <name> with a slash command name, for example command:compact."));
      }
    }
    if (chord.canonical) {
      const clash = overrides.find((row) => row.context === context && row.canonical === chord.canonical && !(original && original.context === row.context && canonicalOf(original.key) === row.canonical));
      if (clash) errors.push(t("“{key}” is already overridden in {context}. Edit that row instead.", { key: clash.key, context }));
    }
    return { errors, warnings };
  };
  const showProblems = () => {
    const { errors, warnings } = problems();
    messages.replaceChildren(
      ...errors.map((text) => h("div.banner.error", icon("alert", 14), h("span", text))),
      ...warnings.map((text) => h("div.banner.warn", icon("alert", 14), h("span", text))),
    );
    return !errors.length;
  };
  const sync = () => {
    actionRow.hidden = unbind.checked;
    const entry = actionInfo.get(actionInput.value.trim());
    actionHint.textContent = entry ? pick([entry[2], entry[3]]) : "";
    showProblems();
  };
  contextSelect.addEventListener("change", () => { fillActions(); sync(); });
  keyInput.addEventListener("input", showProblems);
  actionInput.addEventListener("input", sync);
  unbind.addEventListener("change", sync);
  fillActions();

  const body = h(
    "div.kb-dialog",
    h("div.kb-field", h("label.field-label", t("Context")), contextSelect, contextHint),
    h("div.kb-field", h("label.field-label", t("Key or chord")), keyInput, h("small.muted", t("Modifiers: ctrl, shift, alt (opt, option, meta), cmd (command, super, win). Chords are keystrokes separated by a space, pressed within 3 seconds."))),
    h("label.kb-check", unbind, h("span", t("Unbind: turn this key off in this context (null)"))),
    actionRow,
    messages,
  );
  sync();

  modal({
    title: original ? t("Edit shortcut") : t("Add shortcut"),
    body,
    width: 560,
    actions: [
      { label: t("Cancel"), onClick: (m) => m.close() },
      {
        label: t("Save"),
        variant: "primary",
        onClick: async (m) => {
          if (!showProblems()) return;
          const context = contextSelect.value;
          const key = keyInput.value.trim().replace(/\s+/g, " ");
          const action = unbind.checked ? null : actionInput.value.trim();
          try {
            await mutateFile((doc) => {
              if (original) removeKey(doc, original.context, original.key);
              setBinding(doc, context, key, action);
            });
            lastContext = context;
            m.close();
            toast(t("Saved"), "ok", 1400);
            onSaved();
          } catch (error) {
            toast(errorMessage(error), "error");
          }
        },
      },
    ],
  });
  queueMicrotask(() => keyInput.focus());
}

// ---- page ------------------------------------------------------------------------------------------------
registerSettingsSection({
  id: "keybindings",
  title: "Keyboard shortcuts",
  icon: "keyboard",
  order: 36,
  async render(el) {
    const host = h("div.interface-page");
    el.append(...pageHeader("Keyboard shortcuts", "Claude Code's terminal shortcuts. Changes are saved to keybindings.json in the Claude Code config folder and apply to running sessions without a restart."), host);
    let file = null;

    const reload = async () => {
      try {
        file = await loadFile();
        draw();
      } catch (error) {
        host.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
      }
    };

    const run = async (work, doneText) => {
      try {
        await work();
        if (doneText) toast(doneText, "ok", 1400);
      } catch (error) {
        toast(errorMessage(error), "error");
      }
      await reload();
    };

    function draw() {
      const broken = Boolean(file.error);
      if (broken) activeTab = "raw";
      const tabs = [["shortcuts", t("Shortcuts")], ["raw", t("Raw JSON")]];
      const bar = h("div.tabs-inline", tabs.map(([id, label]) => h(`button${id === activeTab ? ".active" : ""}`, { type: "button", disabled: broken && id === "shortcuts", onclick: () => { activeTab = id; draw(); } }, label)));
      const info = h("div.settings-scope-info", h("code.settings-path", { dir: "ltr" }, file.path), h("small.muted", file.exists ? "" : t("file does not exist yet; it is created on first save")));
      const panel = h("div.interface-panel");
      host.replaceChildren(info, broken ? h("div.banner.error", icon("alert", 14), h("span", `${t("keybindings.json is not valid JSON, so the shortcut list is unavailable. Repair it below.")} ${file.error}`)) : "", bar, panel);
      if (activeTab === "raw") drawRaw(panel);
      else drawShortcuts(panel);
    }

    function drawRaw(panel) {
      const text = file.exists ? file.text : `${JSON.stringify({ $schema: SCHEMA, $docs: DOCS, bindings: [] }, null, 2)}\n`;
      panel.append(
        infoBanner(t("Fields other than “bindings”, such as $schema and $docs, are kept exactly as written here.")),
        rawJsonEditor({
          text,
          check: (parsed) => {
            if (!isObject(parsed)) throw new Error(t("keybindings.json must be a JSON object with a “bindings” array."));
            if ("bindings" in parsed && !Array.isArray(parsed.bindings)) throw new Error(t("“bindings” must be an array of { context, bindings } blocks."));
            (parsed.bindings || []).forEach((block, index) => {
              if (!isObject(block) || typeof block.context !== "string" || !isObject(block.bindings)) throw new Error(t("bindings[{index}] needs a “context” string and a “bindings” object.", { index }));
              for (const [key, action] of Object.entries(block.bindings)) if (action !== null && typeof action !== "string") throw new Error(t("Binding “{key}” must be an action name or null.", { key }));
            });
          },
          lint: (parsed) => lintKeybindings(parsed, t),
          onSave: async (text2) => {
            await api.put("/api/keybindings", { text: text2 });
            toast(t("Saved"), "ok", 1400);
            await reload();
          },
        }),
      );
    }

    function drawShortcuts(panel) {
      const overrides = overridesOf(file.json);
      const byContext = new Map();
      for (const row of overrides) {
        if (!byContext.has(row.context)) byContext.set(row.context, new Map());
        byContext.get(row.context).set(row.canonical, row);
      }
      const search = h("input.input", { type: "search", value: lastQuery, placeholder: t("Search keys, actions or descriptions"), dir: "auto", "aria-label": t("Search") });
      const contextFilter = h("select.input", { "aria-label": t("Context") }, [h("option", { value: "" }, t("All contexts")), ...KEY_CONTEXTS.map(([id]) => h("option", { value: id, selected: id === lastContext }, id))]);
      const add = h("button.btn.primary.small", { type: "button", onclick: () => openBindingDialog({ prefill: { context: contextFilter.value || undefined }, overrides, onSaved: reload }) }, icon("plus", 13), t("Add shortcut"));
      const lists = h("div.kb-lists");
      panel.append(h("div.kb-toolbar", search, contextFilter, add), lists);

      const draw2 = () => {
        lists.replaceChildren(overridesGroup(overrides, contextFilter.value, search.value), defaultsGroup(byContext, contextFilter.value, search.value), notesGroup());
      };
      let timer = 0;
      search.addEventListener("input", () => { lastQuery = search.value; clearTimeout(timer); timer = setTimeout(draw2, 120); });
      contextFilter.addEventListener("change", () => { lastContext = contextFilter.value; draw2(); });
      draw2();
    }

    const matches = (query, ...parts) => !query || parts.some((part) => String(part).toLowerCase().includes(query.trim().toLowerCase()));

    function overridesGroup(overrides, context, query) {
      const rows = overrides.filter((row) => (!context || row.context === context) && matches(query, row.key, row.action, row.context, row.action ? actionText(row.action) : "unbind"));
      const body = h("div.kb-table");
      if (!rows.length) body.append(h("div.muted.rule-empty", overrides.length ? t("No override matches the filter.") : t("No overrides yet. Claude Code uses its default shortcuts.")));
      for (const row of rows) {
        const unknownContext = !CONTEXT_IDS.has(row.context);
        const unknownAction = row.action !== null && !isKnownAction(row.action);
        const problem = validateChord(row.key).errors.length > 0;
        body.append(
          h(
            "div.kb-row",
            h("code.kb-context", { dir: "ltr" }, row.context),
            chordView(row.key),
            h("span.kb-action", row.action === null ? h("span.badge.warn", t("unbound")) : h("code", { dir: "ltr" }, row.action), row.action ? h("small.muted", actionText(row.action)) : null),
            h("span.kb-flags", unknownContext ? h("span.badge.danger", t("unknown context")) : null, unknownAction ? h("span.badge.danger", t("unknown action")) : null, problem ? h("span.badge.danger", t("invalid key")) : null),
            h(
              "span.kb-buttons",
              h("button.icon-btn", { type: "button", title: t("Edit"), onclick: () => openBindingDialog({ prefill: { context: row.context, key: row.key, action: row.action, original: { context: row.context, key: row.key } }, overrides, onSaved: reload }) }, icon("edit", 14)),
              h(
                "button.icon-btn",
                {
                  type: "button",
                  title: t("Remove this override"),
                  onclick: async () => {
                    if (await confirmDialog({ title: t("Remove override"), message: t("Remove the binding for {key} in {context}? The default shortcut applies again.", { key: row.key, context: row.context }), confirmLabel: t("Remove"), danger: true })) run(() => mutateFile((doc) => removeKey(doc, row.context, row.key)), t("Removed"));
                  },
                },
                icon("trash", 14),
              ),
            ),
          ),
        );
      }
      return group("Your overrides", body);
    }

    function defaultsGroup(byContext, contextFilter, query) {
      const wrap = h("div.kb-defaults");
      const contexts = [...KEY_CONTEXTS.map(([id]) => id), null];
      for (const context of contexts) {
        if (contextFilter && context !== contextFilter) continue;
        const entries = DEFAULT_BINDINGS.filter((entry) => entry[0] === context).filter(([, action, keys]) => matches(query, action, actionText(action), keys.join(" ")));
        const extra = context === "Chat" ? CTRL_X_EXTRA_CHORDS.filter((chord) => matches(query, chord)) : [];
        if (!entries.length && !extra.length) {
          if (!query && context && !DEFAULT_BINDINGS.some((entry) => entry[0] === context)) wrap.append(contextOnly(context));
          continue;
        }
        const info = context ? contextInfo.get(context) : null;
        const details = h("details.kb-group", { open: Boolean(query) || openGroups.has(String(context)) });
        details.append(h("summary", h("code", { dir: "ltr" }, context || t("Context not stated in the docs")), h("small.muted", info ? pick([info[1], info[2]]) : t("Documented without a context. Add an override to choose one.")), h("span.badge", String(entries.length + extra.length))));
        details.addEventListener("toggle", () => (details.open ? openGroups.add(String(context)) : openGroups.delete(String(context))));
        const table = h("div.kb-table");
        for (const [, action, keys] of entries) {
          const keyCells = keys.length
            ? keys.map((key) => {
                const override = context ? byContext.get(context)?.get(canonicalOf(key)) : null;
                const state = override ? (override.action === null ? "unbound" : "rebound") : "";
                return h(
                  `span.kb-key${state ? `.${state}` : ""}`,
                  chordView(key),
                  state === "unbound" ? h("span.badge.warn", t("unbound")) : null,
                  state === "rebound" ? h("span.badge.accent", override.action) : null,
                  context && !state ? h("button.icon-btn.tiny", { type: "button", title: t("Unbind this key"), onclick: () => run(() => mutateFile((doc) => setBinding(doc, context, key, null)), t("Saved")) }, icon("x", 12)) : null,
                );
              })
            : [h("span.badge", t("unbound by default"))];
          table.append(
            h(
              "div.kb-row.kb-default",
              h("span.kb-action", h("code", { dir: "ltr" }, action), h("small.muted", actionText(action))),
              h("span.kb-keys", keyCells),
              context ? h("button.btn.small.ghost", { type: "button", onclick: () => openBindingDialog({ prefill: { context, action }, overrides: overridesOf(file.json), onSaved: reload }) }, t("Override")) : h("span.icon-gap"),
            ),
          );
        }
        if (extra.length) {
          table.append(
            h(
              "div.kb-row.kb-default",
              h("span.kb-action", h("small.muted", t("More default chords on the ctrl+x prefix; the docs name no action for them, but they can be unbound."))),
              h(
                "span.kb-keys",
                extra.map((key) => {
                  const override = byContext.get("Chat")?.get(canonicalOf(key));
                  return h("span.kb-key", chordView(key), override ? h("span.badge.warn", t("unbound")) : h("button.icon-btn.tiny", { type: "button", title: t("Unbind this key"), onclick: () => run(() => mutateFile((doc) => setBinding(doc, "Chat", key, null)), t("Saved")) }, icon("x", 12)));
                }),
              ),
              h("span.icon-gap"),
            ),
          );
        }
        details.append(table);
        wrap.append(details);
      }
      return group("Documented defaults", wrap);
    }

    const contextOnly = (context) => {
      const info = contextInfo.get(context);
      return h("div.kb-group-empty", h("code", { dir: "ltr" }, context), h("small.muted", `${pick([info[1], info[2]])} — ${t("no default bindings of its own; bind a Select or other action here to change a key for this context only.")}`));
    };

    function notesGroup() {
      return group(
        "Good to know",
        h("ul.kb-notes", [
          h("li", t("Reserved keys cannot be rebound: Ctrl+C, Ctrl+D, Ctrl+M, Ctrl+[, Ctrl+I, Ctrl+H and Caps Lock.")),
          h("li", t("Unbinding every chord that shares a prefix (such as ctrl+x) frees that prefix for a single-key binding; unbinding only some keeps chord-wait mode for the rest.")),
          h("li", t("Vim keys are not remappable here. Map a two-key INSERT-mode sequence such as jj to Escape with the vimInsertModeRemaps setting.")),
          h("li", t("Claude Code writes warnings about invalid JSON, misspelled modifiers, unknown contexts or actions and duplicates to its debug log; start it with --debug to see them.")),
        ]),
      );
    }

    await reload();
  },
});
