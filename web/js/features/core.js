// Core settings sections and commands: General, Model & behavior, About + built-in slash commands.
import { h, toast, errorMessage, copyText } from "../core/dom.js";

import { t, getLang, setLang } from "../core/i18n.js";
import { app, bus, setPrefs } from "../core/state.js";
import { registerSettingsSection, registerCommand } from "../core/registry.js";
import { api } from "../core/api.js";
import * as session from "../session.js";
import { toggleSidebar } from "../ui/sidebar.js";
import { toggleInspector, openInspector } from "../ui/inspector.js";
import { openModelPicker, openModePicker, PERMISSION_MODES, EFFORTS } from "../ui/pickers.js";
import { pickFolder } from "../ui/folder-picker.js";

// ---- helpers ---------------------------------------------------------------------
const row = (title, desc, control) => h("div.setting-row", h("div.grow", h("strong", title), desc ? h("small", desc) : null), control);
const toggle = (key, onChange) => {
  const input = h("input", { type: "checkbox", checked: Boolean(app.prefs[key]) });
  input.addEventListener("change", () => { setPrefs({ [key]: input.checked }); onChange?.(input.checked); });
  return h("label.switch", input);
};
const select = (key, options, onChange) => {
  const el = h("select.input", options.map(([value, label]) => h("option", { value, selected: String(app.prefs[key]) === String(value) }, label)));
  el.addEventListener("change", () => { setPrefs({ [key]: el.value }); onChange?.(el.value); });
  return el;
};

export function applyPrefs() {
  const p = app.prefs;
  if (p.theme === "light" || p.theme === "dark") document.documentElement.dataset.theme = p.theme;
  else delete document.documentElement.dataset.theme;
  document.documentElement.style.setProperty("--font-size", `${p.fontSize}px`);
  document.body.dataset.chatWidth = p.chatWidth;
  document.body.classList.toggle("sidebar-closed", !p.sidebarOpen || window.innerWidth < 1000);
}

// ---- sections --------------------------------------------------------------------
registerSettingsSection({
  id: "general", title: "General", icon: "sliders", order: 0,
  render(el) {
    el.append(
      h("h2", t("General")), h("p.lead", t("Appearance and everyday behavior of this app.")),
      h("div.group", h("h3", t("Appearance")),
        row(t("Theme"), t("Follow the system or force light/dark."), select("theme", [["auto", t("System")], ["light", t("Light")], ["dark", t("Dark")]], applyPrefs)),
        row(t("Language"), t("Interface language. Messages are always shown as written."), (() => {
          const el2 = h("select.input", [["fa", "فارسی"], ["en", "English"]].map(([value, label]) => h("option", { value, selected: getLang() === value }, label)));
          el2.addEventListener("change", () => { setLang(el2.value); location.reload(); });
          return el2;
        })()),
        row(t("Font size"), null, (() => {
          const input = h("input.input", { type: "number", min: 12, max: 22, value: app.prefs.fontSize });
          input.addEventListener("change", () => { setPrefs({ fontSize: Math.min(22, Math.max(12, Number(input.value) || 15)) }); applyPrefs(); });
          return input;
        })()),
        row(t("Chat width"), null, select("chatWidth", [["narrow", t("Narrow")], ["normal", t("Normal")], ["wide", t("Wide")]], applyPrefs)),
      ),
      h("div.group", h("h3", t("Conversation")),
        row(t("Send with"), t("Choose how a message is sent."), select("sendKey", [["enter", t("Enter (Shift+Enter for new line)")], ["ctrl-enter", "Ctrl+Enter"]])),
        row(t("Show thinking"), t("Display Claude's reasoning when the model provides it."), toggle("showThinking")),
        row(t("Expand tool details"), t("Open tool cards by default."), toggle("expandTools", () => bus.emit("prefs"))),
        row(t("Group sessions by project"), null, toggle("groupByProject")),
      ),
      h("div.group", h("h3", t("Sessions")),
        row(t("New sessions start in"), t("A new folder keeps each session's files separate, like Claude Desktop."), select("newSessionIn", [["scratch", t("A new folder")], ["project", t("The current project")]])),
        row(t("Default location for new folders"), t("Sessions started in a new folder are created inside this folder."), (() => {
          const input = h("input.input", { type: "text", dir: "ltr", value: app.config?.workspaceRoot || "", spellcheck: "false" });
          const save = async (value) => {
            try {
              await api.put("/api/prefs", { workspaceRoot: value.trim() });
              app.config = await api.config();
              input.value = app.config.workspaceRoot;
            } catch (error) { toast(errorMessage(error), "error"); }
          };
          input.addEventListener("change", () => save(input.value));
          const browse = h("button.btn", { type: "button", onclick: async () => {
            const { chooseFolder } = await import("../ui/project-menu.js");
            const dir = await chooseFolder(input.value);
            if (dir) save(dir);
          } }, t("Browse…"));
          return h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, input, browse);
        })()),
      ),
      h("div.group", h("h3", t("Notifications")),
        row(t("Desktop notifications"), t("Notify when Claude needs approval or finishes while this tab is in the background."), (() => {
          const input = h("input", { type: "checkbox", checked: Boolean(app.prefs.notifications) });
          input.addEventListener("change", async () => {
            setPrefs({ notifications: input.checked });
            if (input.checked && "Notification" in window && Notification.permission === "default") await Notification.requestPermission();
          });
          return h("label.switch", input);
        })()),
        row(t("Sound"), null, toggle("sound")),
      ),
    );
  },
});

registerSettingsSection({
  id: "model", title: "Model & behavior", icon: "sparkles", order: 1,
  render(el) {
    const models = app.catalog?.models || [];
    el.append(
      h("h2", t("Model & behavior")), h("p.lead", t("Defaults for new sessions. You can change them per session from the composer.")),
      h("div.group", h("h3", t("Defaults")),
        row(t("Model"), t("Models reported by your gateway."), (() => {
          const sel = h("select.input", [["default", t("Default")], ...models.filter((m) => m.value !== "default").map((m) => [m.value, `${m.displayName}`])].map(([value, label]) => h("option", { value, selected: app.prefs.defaultModel === value }, label)));
          sel.addEventListener("change", () => setPrefs({ defaultModel: sel.value }));
          return sel;
        })()),
        row(t("Effort"), t("How much reasoning to spend."), select("defaultEffort", EFFORTS.map((e) => [e.id, e.title()]))),
        row(t("Permission mode"), null, select("defaultPermissionMode", PERMISSION_MODES.filter((m) => m.id !== "bypassPermissions").map((m) => [m.id, m.title()]))),
      ),
    );
  },
});

registerSettingsSection({
  id: "about", title: "About", icon: "info", order: 99,
  async render(el) {
    const cfg = app.config || (await api.config());
    const catalog = app.catalog || (await session.ensureCatalog());
    el.append(
      h("h2", "Wheelhouse"), h("p.lead", t("A graphical front end for Claude Code. It runs the real claude binary; nothing about requests is altered.")),
      h("div.group", h("h3", t("Connection")),
        h("dl.kv",
          h("dt", t("Gateway")), h("dd", cfg.gateway || "—"),
          h("dt", t("Claude binary")), h("dd", cfg.claudeBin),
          h("dt", t("Claude Code")), h("dd", catalog?.claudeCodeVersion || "—"),
          h("dt", t("Config directory")), h("dd", cfg.configDir),
          h("dt", t("Proxy")), h("dd", cfg.proxy?.http ? `${t("system proxy set")} · NO_PROXY=${cfg.proxy.noProxy}` : t("none")),
          h("dt", t("Account")), h("dd", catalog?.account ? `${catalog.account.email || ""} · ${catalog.account.organization || ""} · ${catalog.account.subscriptionType || ""}` : "—"),
        ),
      ),
    );
  },
});

// ---- commands --------------------------------------------------------------------
const reg = (command) => registerCommand(command);
reg({ id: "new", title: "New session", icon: "plus", slash: "clear", slashAliases: ["new", "reset"], shortcut: "Ctrl+Shift+O", run: () => session.newSession({}) });
reg({ id: "palette", title: "Command palette", icon: "command", shortcut: "Ctrl+K", run: () => import("../ui/palette.js").then((m) => m.openPalette()) });
reg({ id: "settings", title: "Open settings", icon: "settings", shortcut: "Ctrl+,", slash: "config", slashAliases: ["settings"], run: (ctx) => ctx.openSettings() });
reg({ id: "sidebar", title: "Toggle sidebar", icon: "panel-left", shortcut: "Ctrl+B", run: () => toggleSidebar() });
reg({ id: "inspector", title: "Toggle inspector", icon: "panel-right", shortcut: "Ctrl+.", run: () => toggleInspector() });
reg({ id: "model", title: "Change model", icon: "sparkles", slash: "model", run: () => bus.emit("command", "model-picker") });
reg({ id: "mode", title: "Change permission mode", icon: "shield", slash: "permissions", slashAliases: ["permission", "mode"], run: () => bus.emit("command", "mode-picker") });
reg({ id: "theme", title: "Toggle light/dark theme", icon: "moon", run: () => { const cur = document.documentElement.dataset.theme; setPrefs({ theme: cur === "dark" ? "light" : "dark" }); applyPrefs(); } });
reg({ id: "folder", title: "Open another project folder…", icon: "folder", run: async () => { const dir = await pickFolder(app.currentCwd); if (dir) await session.newSession({ cwd: dir }); } });
reg({ id: "rename", title: "Rename current session", icon: "edit", slash: "rename", run: () => app.currentId && session.promptRename(app.currentId) });
reg({ id: "interrupt", title: "Stop current response", icon: "stop", shortcut: "Esc", run: () => session.interrupt() });
reg({ id: "copy-id", title: "Copy session ID", icon: "copy", run: () => app.currentId && copyText(app.currentId) });
reg({ id: "context", title: "Show context usage", icon: "gauge", slash: "context", slashAliases: ["cost", "usage"], run: () => openInspector("context") });
reg({ id: "refresh-catalog", title: "Reload models, commands and skills", icon: "refresh", run: () => session.ensureCatalog(app.currentCwd, true) });

bus.on("command", (name) => {
  const anchor = document.querySelector(".cmp-chip-btn") || document.body;
  if (name === "model-picker") openModelPicker(document.querySelectorAll(".cmp-chip-btn")[1] || anchor);
  else if (name === "mode-picker") openModePicker(document.querySelectorAll(".cmp-chip-btn")[0] || anchor);
  else if (name === "palette") import("../ui/palette.js").then((m) => m.openPalette());
});
