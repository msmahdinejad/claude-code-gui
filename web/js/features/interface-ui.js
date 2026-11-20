// Small UI helpers shared by the keyboard shortcut, theme and environment pages. Registers nothing.
import { h, toast, errorMessage } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t, getLang } from "../core/i18n.js";

/** Pick the English or Persian half of an [en, fa] pair or an { en, fa } object. */
export function pick(entry) {
  const [en, fa] = Array.isArray(entry) ? entry : [entry.en, entry.fa];
  return getLang() === "fa" && fa ? fa : en;
}

/** A key chord such as "ctrl+x ctrl+k" drawn as one <kbd> per keystroke. */
export function chordView(chord) {
  return h("span.chord", { dir: "ltr" }, String(chord).split(/\s+/).filter(Boolean).map((step) => h("kbd", step)));
}

/** { line, column } of a JSON.parse error, when the message says where. */
export function locateJson(text, error) {
  const message = error.message || "";
  let position = null;
  const direct = /position (\d+)/.exec(message);
  if (direct) position = Number(direct[1]);
  else if (/end of JSON input/i.test(message)) position = text.length;
  if (position === null) return null;
  const before = text.slice(0, position).split("\n");
  return { line: before.length, column: before.at(-1).length + 1 };
}

/**
 * Raw JSON tab: a textarea with live validation. `check(parsed)` throws Error(message) for a document that is
 * valid JSON but not usable; `lint(parsed)` returns [{ level, text }] shown under the editor (never blocking);
 * `onSave(text)` is awaited. Nothing is rewritten: what is in the textarea is what is saved.
 */
export function rawJsonEditor({ text, check, lint, onSave, path }) {
  const area = h("textarea.input.editor.interface-raw", { dir: "ltr", spellcheck: "false", rows: 18 });
  area.value = text;
  const status = h("div.json-status");
  const notes = h("div.lint-list");
  const save = h("button.btn.primary.small", { type: "button" }, t("Save"));
  const revert = h("button.btn.small", { type: "button", onclick: () => { area.value = text; validate(); } }, t("Revert"));
  const validate = () => {
    notes.replaceChildren();
    try {
      const parsed = JSON.parse(area.value);
      check?.(parsed);
      status.className = "json-status ok";
      status.replaceChildren(icon("check-circle", 14), t("Valid JSON"));
      for (const problem of lint?.(parsed) || []) notes.append(h(`div.banner.${problem.level === "error" ? "error" : "warn"}`, icon("alert", 14), h("span", problem.text)));
      save.disabled = false;
      return true;
    } catch (error) {
      const where = error instanceof SyntaxError ? locateJson(area.value, error) : null;
      status.className = "json-status bad";
      status.replaceChildren(icon("alert", 14), `${error.message}${where ? ` — ${t("line {line}, column {column}", where)}` : ""}`);
      save.disabled = true;
      return false;
    }
  };
  area.addEventListener("input", validate);
  save.addEventListener("click", async () => {
    if (!validate()) return;
    save.disabled = true;
    try {
      await onSave(area.value);
    } catch (error) {
      toast(errorMessage(error), "error");
      save.disabled = false;
    }
  });
  validate();
  return h("div.interface-raw-editor", path ? h("code.settings-path", { dir: "ltr" }, path) : null, area, status, notes, h("div.rule-actions", save, revert));
}

export function chipButton(label, onclick, { title = "", cls = "" } = {}) {
  return h(`button.btn.small${cls ? `.${cls}` : ""}`, { type: "button", title, onclick }, label);
}
