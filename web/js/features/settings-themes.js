// Settings → Themes: list / create / edit / duplicate / delete Claude Code custom themes
// (CLAUDE_CONFIG_DIR/themes/<name>.json: optional name, base and overrides). Only the three documented fields are
// edited; any other field in a file is kept as written. How to *select* a theme is described, not edited here.
import { h, toast, errorMessage, modal, confirmDialog, copyText } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { registerSettingsSection } from "../core/registry.js";
import { pageHeader, group, infoBanner } from "./settings-shared.js";
import { THEME_BASES, THEME_GROUPS, THEME_TOKEN_IDS, parseThemeColor, hexForPicker, validThemeSlug } from "./interface-data.js";
import { pick, rawJsonEditor } from "./interface-ui.js";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

// Colors for the preview when a token is not overridden. The docs do not list the presets' real values, so these are
// only a stand-in (the terminal's own colors and Claude Code's base preset decide what you really see).
const STAND_IN = {
  dark: { bg: "#1c1c1c", text: "#e8e6e1", claude: "#d97757", inactive: "#8b8b8b", success: "#4eba65", error: "#ff6b80", warning: "#ffc107", permission: "#b1b9f9", promptBorder: "#8b8b8b", planMode: "#48968c", diffAdded: "#1f4d2b", diffRemoved: "#6b2434", userMessageBackground: "#343434", suggestion: "#b1b9f9" },
  light: { bg: "#fbfaf7", text: "#1f1e1d", claude: "#c15f3c", inactive: "#7a7a7a", success: "#2c7a39", error: "#ab2b3f", warning: "#966c1e", permission: "#5769f7", promptBorder: "#999999", planMode: "#006666", diffAdded: "#b8e6c1", diffRemoved: "#f5c2cb", userMessageBackground: "#eeeae0", suggestion: "#5769f7" },
};

let activeTab = "colors";

registerSettingsSection({
  id: "themes",
  title: "Themes",
  icon: "wand",
  order: 37,
  async render(el) {
    const host = h("div.interface-page");
    el.append(...pageHeader("Themes", "Custom color themes for the Claude Code terminal UI. Each theme is a JSON file in the themes folder of the Claude Code config folder; Claude Code reloads it when it changes."), host);
    const state = { themes: [], dir: "", exists: false, selected: null, work: null, dirty: false, saved: null };

    const confirmDiscard = async () => !state.dirty || confirmDialog({ title: t("Discard changes?"), message: t("This theme has unsaved changes."), confirmLabel: t("Discard"), danger: true });

    async function reload(select) {
      try {
        const result = await api.get("/api/themes");
        state.themes = result.themes;
        state.dir = result.dir;
        state.exists = result.exists;
      } catch (error) {
        host.replaceChildren(h("div.banner.error", icon("alert", 14), errorMessage(error)));
        return;
      }
      const name = select === undefined ? state.selected : select;
      choose(name && state.themes.some((entry) => entry.name === name) ? name : null);
    }

    function choose(name) {
      state.selected = name;
      state.dirty = false;
      const entry = state.themes.find((item) => item.name === name);
      state.work = entry && entry.json ? clone(entry.json) : null;
      state.saved = entry || null;
      draw();
    }

    const slugHint = (slug) =>
      h(
        "div.theme-select-hint",
        icon("info", 14),
        h("span", t("To use it, run /theme in Claude Code and pick it, or set the theme setting to"), " ", h("code", { dir: "ltr" }, `custom:${slug}`), ". "),
        h("button.btn.small.ghost", { type: "button", onclick: () => copyText(`custom:${slug}`) }, icon("copy", 12), t("Copy")),
      );

    // ---- create / duplicate -------------------------------------------------------------------------
    function nameDialog({ title, slug = "", display = "", base = "dark", withBase = true, confirmLabel = t("Create"), onDone }) {
      const slugInput = h("input.input.mono", { type: "text", value: slug, placeholder: "my-theme", dir: "ltr", spellcheck: "false", maxlength: 64 });
      const nameInput = h("input.input", { type: "text", value: display, placeholder: t("Display name (shown in /theme)"), dir: "auto" });
      const baseSelect = h("select.input", THEME_BASES.map((id) => h("option", { value: id, selected: id === base }, id)));
      const message = h("div.json-status");
      const check = () => {
        const value = slugInput.value.trim();
        let problem = "";
        if (!value) problem = t("Enter a file name for the theme.");
        else if (!validThemeSlug(value)) problem = t("Use letters, digits, “-” and “_” only (up to 64 characters, not a reserved Windows name).");
        else if (state.themes.some((entry) => entry.name.toLowerCase() === value.toLowerCase())) problem = t("A theme with that file name already exists.");
        message.className = `json-status ${problem ? "bad" : "ok"}`;
        message.replaceChildren(problem ? icon("alert", 14) : "", problem);
        return !problem;
      };
      slugInput.addEventListener("input", check);
      const body = h(
        "div.kb-dialog",
        h("div.kb-field", h("label.field-label", t("File name")), h("div.theme-slug-row", slugInput, h("code", ".json")), message),
        h("div.kb-field", h("label.field-label", t("Display name")), nameInput),
        withBase ? h("div.kb-field", h("label.field-label", t("Base preset")), baseSelect) : null,
      );
      modal({
        title,
        body,
        width: 480,
        actions: [
          { label: t("Cancel"), onClick: (m) => m.close() },
          { label: confirmLabel, variant: "primary", onClick: (m) => { if (!check()) return; m.close(); onDone({ slug: slugInput.value.trim(), display: nameInput.value.trim(), base: baseSelect.value }); } },
        ],
      });
      if (slug) check();
    }

    const createTheme = async () => {
      if (!(await confirmDiscard())) return;
      nameDialog({
        title: t("New theme"),
        onDone: async ({ slug, display, base }) => {
          const json = { name: display || slug, base, overrides: {} };
          await write(slug, json, true);
        },
      });
    };

    const duplicateTheme = async () => {
      const entry = state.saved;
      if (!entry || !entry.json) return;
      if (!(await confirmDiscard())) return;
      nameDialog({
        title: t("Duplicate theme"),
        slug: `${entry.name}-copy`,
        display: `${entry.json.name || entry.name} ${t("(copy)")}`,
        withBase: false,
        confirmLabel: t("Duplicate"),
        onDone: async ({ slug, display }) => {
          const json = clone(entry.json);
          json.name = display || slug;
          await write(slug, json, true);
        },
      });
    };

    const deleteTheme = async () => {
      const entry = state.saved;
      if (!entry) return;
      if (!(await confirmDialog({ title: t("Delete theme"), message: t("Delete {name}.json from the themes folder? This cannot be undone.", { name: entry.name }), confirmLabel: t("Delete"), danger: true }))) return;
      try {
        await api.del(`/api/themes/${encodeURIComponent(entry.name)}`);
        toast(t("Deleted"), "ok", 1400);
        await reload(null);
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    };

    async function write(slug, json, create = false) {
      try {
        await api.put(`/api/themes/${encodeURIComponent(slug)}`, { text: `${JSON.stringify(json, null, 2)}\n`, create });
        toast(t("Saved"), "ok", 1400);
        await reload(slug);
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    }

    // ---- editor -------------------------------------------------------------------------------------
    function draw() {
      const list = h("div.theme-list");
      if (!state.themes.length) list.append(h("div.muted.rule-empty", t("No custom themes yet.")));
      for (const entry of state.themes) {
        const overrides = isObject(entry.json?.overrides) ? entry.json.overrides : {};
        const dots = Object.values(overrides).map((value) => parseThemeColor(value)).filter((color) => color.ok).slice(0, 6);
        list.append(
          h(
            `button.theme-item${entry.name === state.selected ? ".active" : ""}`,
            {
              type: "button",
              onclick: async () => {
                if (entry.name !== state.selected && (await confirmDiscard())) choose(entry.name);
              },
            },
            h("span.grow", h("strong", entry.json?.name || entry.name), h("small.muted", { dir: "ltr" }, `${entry.name}.json`)),
            entry.error ? h("span.badge.danger", t("invalid")) : h("span.theme-dots", dots.map((color) => h("i", { style: { background: color.css } }))),
          ),
        );
      }
      const toolbar = h(
        "div.kb-toolbar",
        h("button.btn.primary.small", { type: "button", onclick: createTheme }, icon("plus", 13), t("New theme")),
        h("button.btn.small", { type: "button", disabled: !state.saved?.json, onclick: duplicateTheme }, icon("copy", 13), t("Duplicate")),
        h("button.btn.small.danger-outline", { type: "button", disabled: !state.saved, onclick: deleteTheme }, icon("trash", 13), t("Delete")),
      );
      const editor = h("div.theme-editor");
      host.replaceChildren(
        h("div.settings-scope-info", h("code.settings-path", { dir: "ltr" }, state.dir), h("small.muted", state.exists ? "" : t("the folder does not exist yet; it is created with your first theme"))),
        toolbar,
        h("div.theme-layout", list, editor),
      );
      drawEditor(editor);
    }

    function drawEditor(editor) {
      const entry = state.saved;
      if (!entry) {
        editor.append(h("div.muted.rule-empty", state.themes.length ? t("Select a theme to edit it.") : t("Create a theme to start.")), infoBanner(t("In Claude Code, /theme lists your custom themes after the built-in presets. The theme you choose is stored as custom:<file name> in the theme setting.")));
        return;
      }
      const broken = Boolean(entry.error);
      if (broken) activeTab = "raw";
      editor.append(
        h("div.theme-title", h("h3", entry.json?.name || entry.name), h("code", { dir: "ltr" }, `${entry.name}.json`)),
        slugHint(entry.name),
        broken ? h("div.banner.error", icon("alert", 14), h("span", `${t("This file is not valid JSON, so the color editor is unavailable. Repair it in the Raw JSON tab.")} ${entry.error}`)) : "",
      );
      const bar = h("div.tabs-inline", [["colors", t("Colors")], ["raw", t("Raw JSON")]].map(([id, label]) => h(`button${id === activeTab ? ".active" : ""}`, { type: "button", disabled: broken && id === "colors", onclick: () => { activeTab = id; draw(); } }, label)));
      const panel = h("div.interface-panel");
      editor.append(bar, panel);
      if (activeTab === "raw") {
        panel.append(
          rawJsonEditor({
            text: entry.text,
            path: entry.path,
            check: (parsed) => {
              if (!isObject(parsed)) throw new Error(t("A theme must be a JSON object."));
              if ("name" in parsed && typeof parsed.name !== "string") throw new Error(t("“name” must be a string."));
              if ("base" in parsed && typeof parsed.base !== "string") throw new Error(t("“base” must be a string."));
              if ("overrides" in parsed && (!isObject(parsed.overrides) || Object.values(parsed.overrides).some((value) => typeof value !== "string"))) throw new Error(t("“overrides” must be an object of token: color strings."));
            },
            lint: (parsed) => {
              const notes = [];
              if (typeof parsed.base === "string" && !THEME_BASES.includes(parsed.base)) notes.push({ level: "warn", text: t("“{base}” is not one of the documented base presets ({list}).", { base: parsed.base, list: THEME_BASES.join(", ") }) });
              for (const [token, value] of Object.entries(isObject(parsed.overrides) ? parsed.overrides : {})) {
                if (!THEME_TOKEN_IDS.has(token)) notes.push({ level: "warn", text: t("Unknown token “{token}”: Claude Code ignores it.", { token }) });
                else if (typeof value === "string" && !parseThemeColor(value).ok) notes.push({ level: "warn", text: t("“{value}” is not a valid color for {token}: Claude Code ignores it.", { value, token }) });
              }
              return notes;
            },
            onSave: async (text) => {
              await api.put(`/api/themes/${encodeURIComponent(entry.name)}`, { text });
              toast(t("Saved"), "ok", 1400);
              await reload(entry.name);
            },
          }),
        );
        return;
      }
      drawColors(panel, entry);
    }

    function drawColors(panel, entry) {
      const work = state.work;
      if (!isObject(work.overrides)) work.overrides = {};
      const save = h("button.btn.primary.small", { type: "button", disabled: true }, t("Save"));
      const revert = h("button.btn.small", { type: "button", disabled: true, onclick: () => choose(entry.name) }, t("Revert"));
      const preview = h("div.theme-preview", { dir: "ltr" });
      const swatches = new Map(); // token -> () => void (refresh)
      const touched = () => {
        state.dirty = JSON.stringify(work) !== JSON.stringify(entry.json);
        save.disabled = !state.dirty;
        revert.disabled = !state.dirty;
        drawPreview();
      };
      const colorOf = (token) => {
        const value = work.overrides[token];
        const parsed = typeof value === "string" ? parseThemeColor(value) : null;
        return parsed?.ok ? parsed.css : null;
      };
      const drawPreview = () => {
        const base = String(work.base || "dark").startsWith("light") ? "light" : "dark";
        const fallback = STAND_IN[base];
        const c = (token) => colorOf(token) || fallback[token];
        const set = (token) => Boolean(colorOf(token));
        preview.style.background = fallback.bg;
        preview.style.color = c("text");
        const mark = (token) => (set(token) ? "" : " theme-unset");
        const line = (...children) => h("div.pv-line", ...children);
        preview.replaceChildren(
          line(h(`span.${mark("claude").trim()}`, { style: { color: c("claude"), fontWeight: "600" } }, "● Claude"), h("span", { style: { color: c("inactive") } }, "  2.1s · 340 tokens")),
          line(h("span", { style: { background: c("userMessageBackground"), padding: "0 6px" } }, "> add a retry to the upload function")),
          line(h("span", { style: { color: c("success") } }, "✔ 12 tests passed"), h("span", { style: { color: c("error") } }, "   ✘ 1 failed")),
          line(h("span", { style: { color: c("warning") } }, "⚠ the file changed on disk")),
          line(h("span", { style: { background: c("diffRemoved"), display: "block", padding: "0 6px" } }, "- const wait = 100;")),
          line(h("span", { style: { background: c("diffAdded"), display: "block", padding: "0 6px" } }, "+ const wait = backoff(attempt);")),
          line(h("span", { style: { color: c("permission") } }, "┌ Allow this edit? ┐"), h("span", { style: { color: c("suggestion") } }, "  /theme")),
          line(h("span", { style: { color: c("promptBorder"), border: `1px solid ${c("promptBorder")}`, display: "block", padding: "0 6px" } }, "> ")),
        );
      };

      const nameInput = h("input.input", { type: "text", value: work.name ?? "", placeholder: entry.name, dir: "auto" });
      nameInput.addEventListener("input", () => { if (nameInput.value) work.name = nameInput.value; else delete work.name; touched(); });
      const baseSelect = h("select.input", [h("option", { value: "" }, t("dark (default)")), ...THEME_BASES.filter((id) => id !== "dark").map((id) => h("option", { value: id }, id))]);
      baseSelect.value = typeof work.base === "string" && THEME_BASES.includes(work.base) && work.base !== "dark" ? work.base : "";
      const baseKept = typeof work.base === "string" && !THEME_BASES.includes(work.base);
      if (baseKept) baseSelect.append(h("option", { value: work.base, selected: true }, `${work.base} (${t("not documented")})`));
      baseSelect.addEventListener("change", () => { if (baseSelect.value) work.base = baseSelect.value; else delete work.base; touched(); });

      const rows = h("div.theme-groups");
      const query = h("input.input", { type: "search", placeholder: t("Filter tokens"), dir: "auto", "aria-label": t("Filter tokens") });
      const drawRows = () => {
        rows.replaceChildren();
        swatches.clear();
        const needle = query.value.trim().toLowerCase();
        for (const grp of THEME_GROUPS) {
          const tokens = grp.tokens.filter(([name, en, fa]) => !needle || name.toLowerCase().includes(needle) || en.toLowerCase().includes(needle) || fa.includes(needle));
          if (!tokens.length) continue;
          const used = grp.tokens.filter(([name]) => name in work.overrides).length;
          const details = h("details.theme-group", { open: Boolean(needle) || used > 0 }, h("summary", h("strong", pick(grp.title)), used ? h("span.badge.accent", String(used)) : null));
          for (const [token, en, fa] of tokens) details.append(tokenRow(token, pick([en, fa])));
          rows.append(details);
        }
        const unknown = Object.keys(work.overrides).filter((token) => !THEME_TOKEN_IDS.has(token) && (!needle || token.toLowerCase().includes(needle)));
        if (unknown.length) {
          const details = h("details.theme-group", { open: true }, h("summary", h("strong", t("Other entries in this file")), h("span.badge.warn", String(unknown.length))));
          details.append(h("p.muted.small", t("These names are not documented color tokens, so Claude Code ignores them. They are kept unless you remove them.")));
          for (const token of unknown) {
            details.append(h("div.theme-token", h("code", { dir: "ltr" }, token), h("code.muted", { dir: "ltr" }, String(work.overrides[token])), h("button.icon-btn", { type: "button", title: t("Remove"), onclick: () => { delete work.overrides[token]; touched(); drawRows(); } }, icon("trash", 14))));
          }
          rows.append(details);
        }
      };

      function tokenRow(token, description) {
        const value = work.overrides[token];
        const swatch = h("span.theme-swatch");
        const input = h("input.input.mono", { type: "text", value: typeof value === "string" ? value : "", placeholder: "#rrggbb", dir: "ltr", spellcheck: "false", autocomplete: "off", "aria-label": token });
        const picker = h("input.theme-picker", { type: "color", title: t("Pick a color"), "aria-label": t("Pick a color") });
        const note = h("small.theme-note");
        const refresh = () => {
          const raw = work.overrides[token];
          const parsed = typeof raw === "string" ? parseThemeColor(raw) : null;
          swatch.style.background = parsed?.ok ? parsed.css : "";
          swatch.classList.toggle("empty", !parsed?.ok);
          input.classList.toggle("invalid", Boolean(raw) && !parsed?.ok);
          note.textContent = raw && !parsed?.ok ? t("Not a valid color: Claude Code ignores it.") : parsed?.kind?.startsWith("ansi") ? t("ANSI colors are drawn from the terminal's own palette; the swatch is approximate.") : "";
          const hex = hexForPicker(raw);
          if (hex) picker.value = hex;
        };
        input.addEventListener("input", () => {
          const text = input.value.trim();
          if (text) work.overrides[token] = text;
          else delete work.overrides[token];
          refresh();
          touched();
        });
        picker.addEventListener("input", () => { input.value = picker.value; work.overrides[token] = picker.value; refresh(); touched(); });
        const clear = h("button.icon-btn", { type: "button", title: t("Use the base preset's color"), onclick: () => { input.value = ""; delete work.overrides[token]; refresh(); touched(); } }, icon("x", 14));
        swatches.set(token, refresh);
        refresh();
        return h("div.theme-token", h("span.theme-token-name", h("code", { dir: "ltr" }, token), h("small.muted", description)), swatch, input, picker, clear, note);
      }
      query.addEventListener("input", drawRows);

      save.addEventListener("click", async () => {
        save.disabled = true;
        const invalid = Object.entries(work.overrides).filter(([, value]) => typeof value === "string" && !parseThemeColor(value).ok).length;
        await write(entry.name, work);
        if (invalid) toast(t("{n} color values are not valid and are ignored by Claude Code.", { n: invalid }), "info", 5000);
      });

      panel.append(
        group(
          "Theme",
          h("div.theme-meta", h("div.kb-field", h("label.field-label", t("Display name")), nameInput), h("div.kb-field", h("label.field-label", t("Base preset")), baseSelect, h("small.muted", t("Tokens you do not set fall through to this preset.")))),
        ),
        group("Preview", preview, h("small.muted", t("Approximate. Colors you have not set are stand-ins; Claude Code takes them from the base preset and your terminal."))),
        group("Colors", h("div.kb-toolbar", query, h("small.muted", t("Values: #rrggbb, #rgb, rgb(r,g,b), ansi256(n) or ansi:<name> (for example ansi:cyanBright)."))), rows),
        h("div.rule-actions", save, revert, h("small.muted", Object.keys(work).filter((key) => !["name", "base", "overrides"].includes(key)).length ? t("Other fields in this file are kept as they are.") : "")),
      );
      drawRows();
      drawPreview();
    }

    await reload(null);
  },
});
