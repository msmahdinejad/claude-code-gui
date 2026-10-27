// Model / effort / permission-mode pickers shared by the composer and the command palette.
import { h, popover, promptDialog, toast } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app } from "../core/state.js";
import * as session from "../session.js";

export const PERMISSION_MODES = [
  { id: "default", icon: "shield", title: () => t("Ask permissions"), desc: () => t("Claude asks before editing files or running commands.") },
  { id: "acceptEdits", icon: "file-diff", title: () => t("Accept edits"), desc: () => t("File edits are auto-approved; commands still ask.") },
  { id: "plan", icon: "list", title: () => t("Plan mode"), desc: () => t("Claude researches and proposes a plan; nothing is changed.") },
  { id: "auto", icon: "zap", title: () => t("Auto mode"), desc: () => t("A classifier approves safe actions and blocks risky ones.") },
  { id: "dontAsk", icon: "lock", title: () => t("Don't ask"), desc: () => t("Anything not already allowed by rules is denied.") },
  { id: "bypassPermissions", icon: "unlock", title: () => t("Bypass permissions"), desc: () => t("No prompts at all. Use only in a sandbox you trust."), danger: true },
];

export const EFFORTS = [
  { id: "", title: () => t("Auto") },
  { id: "low", title: () => t("Low") },
  { id: "medium", title: () => t("Medium") },
  { id: "high", title: () => t("High") },
  { id: "xhigh", title: () => t("Extra high") },
  { id: "max", title: () => t("Max") },
];

/** Model descriptions come from the CLI in English ("Opus 5.5 · Best for ..."); translate known phrases per segment. */
export function describeModel(text) {
  return String(text || "")
    .split(" · ")
    .map((part) => {
      const match = /^Use the default model (currently (.+))$/.exec(part);
      return match ? t("Use the default model (currently {name})", { name: match[1] }) : t(part);
    })
    .join(" · ");
}

export function currentModelInfo(modelId) {
  const models = app.catalog?.models || [];
  return models.find((model) => model.value === modelId) || models.find((model) => model.resolvedModel === modelId) || null;
}

export function modelLabel(modelId) {
  if (!modelId || modelId === "default") {
    const def = (app.catalog?.models || []).find((model) => model.value === "default");
    const resolved = (app.catalog?.models || []).find((model) => model.value !== "default" && model.resolvedModel === def?.resolvedModel)?.displayName;
    return resolved ? `${t("Default")} · ${resolved}` : t("Default");
  }
  const info = currentModelInfo(modelId);
  return info?.displayName || modelId;
}

export function openModelPicker(anchor) {
  const state = session.effective();
  const models = app.catalog?.models || [];
  const info = currentModelInfo(state.model);
  const body = h("div.picker");
  body.append(h("div.picker-section", t("Model")));
  if (!models.length) body.append(h("div.muted", { style: { padding: "8px 10px" } }, app.catalogLoading ? t("Loading models…") : t("No models reported.")));
  for (const model of models) {
    const active = model.value === state.model || (state.model === model.resolvedModel && model.value !== "default");
    body.append(
      h(
        "button.picker-item",
        { type: "button", onclick: () => { session.setModel(model.value); pop.close(); } },
        h("span.pi-main", h("span.pi-title", t(model.displayName)), h("span.pi-desc", describeModel(model.description) || model.resolvedModel)),
        active ? icon("check", 15, "check") : null,
      ),
    );
  }
  body.append(
    h("button.picker-item", { type: "button", onclick: async () => {
      pop.close();
      const id = await promptDialog({ title: t("Custom model"), label: t("Model ID or alias (e.g. claude-sonnet-5-5)"), placeholder: "claude-…" });
      if (id?.trim()) session.setModel(id.trim());
    } }, h("span.pi-main", h("span.pi-title", t("Custom model…")), h("span.pi-desc", t("Use any model ID your gateway supports."))), icon("edit", 15)),
  );
  const levels = info?.supportedEffortLevels;
  if (info?.supportsEffort !== false) {
    body.append(h("div.picker-section", t("Effort")));
    body.append(
      h(
        "div.seg",
        { style: { margin: "2px 10px 6px", flexWrap: "wrap" } },
        EFFORTS.filter((effort) => !effort.id || !levels || levels.includes(effort.id)).map((effort) =>
          h(`button${(state.effort || "") === effort.id ? ".active" : ""}`, { type: "button", onclick: () => { session.setEffort(effort.id); pop.close(); } }, effort.title()),
        ),
      ),
    );
  }
  if (info?.supportsThinkingOff !== false || state.thinkingEnabled === false) {
    const input = h("input", { type: "checkbox", checked: state.thinkingEnabled !== false });
    input.addEventListener("change", () => session.setThinking(input.checked));
    body.append(h("label.switch", { style: { padding: "6px 10px" } }, input, h("span", t("Extended thinking"))));
  }
  const pop = popover(anchor, body, { placement: "top-start", width: 340, className: "model-popover" });
  return pop;
}

export function openModePicker(anchor) {
  const state = session.effective();
  const body = h("div.picker");
  body.append(h("div.picker-section", t("Permission mode")));
  for (const mode of PERMISSION_MODES) {
    body.append(
      h(
        "button.picker-item",
        { type: "button", onclick: async () => {
          pop.close();
          if (mode.id === "bypassPermissions") {
            if (!app.prefs.allowBypass) {
              toast(t("Enable “Allow bypass mode” in Settings → Permissions first."), "error");
              return;
            }
            // Bypass must be declared when the process starts, so restart in place.
            await session.applyStartOptions({ allowBypass: true, permissionMode: mode.id });
            return;
          }
          session.setPermissionMode(mode.id);
        } },
        icon(mode.icon, 16),
        h("span.pi-main", h("span.pi-title", { style: mode.danger ? { color: "var(--danger)" } : null }, mode.title()), h("span.pi-desc", mode.desc())),
        state.permissionMode === mode.id ? icon("check", 15, "check") : null,
      ),
    );
  }
  const pop = popover(anchor, body, { placement: "top-start", width: 360 });
  return pop;
}

export function modeInfo(id) {
  return PERMISSION_MODES.find((mode) => mode.id === id) || PERMISSION_MODES[0];
}
