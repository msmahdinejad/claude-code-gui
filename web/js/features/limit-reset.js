// Limit resets ("Reset for free" on claude.ai): a dialog that opens Claude Code's own /limit-reset in a terminal window,
// signed in as a connection profile. Claude Code lists the resets the account has, lets you pick one and uses it.
import { h, modal, toast, errorMessage, confirmDialog } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app } from "../core/state.js";
import { registerCommand } from "../core/registry.js";
import { api } from "../core/api.js";

const KINDS = [
  { id: "", title: "Open /limit-reset", desc: "Claude Code shows the resets this account has, or uses the one that fits." },
  { id: "fable", title: "Fable reset", desc: "Gives back to your weekly limit what Fable used." },
  { id: "full", title: "Full reset", desc: "Clears the 5-hour and the weekly limit." },
  { id: "5-hour", title: "5-hour reset", desc: "Clears the 5-hour limit." },
  { id: "weekly", title: "Weekly reset", desc: "Clears the weekly limit." },
];

async function open(kind, profile) {
  try {
    const result = await api.post("/api/limit-reset/open", { kind, profile });
    toast(t("Claude Code opened in a new window with {command}.", { command: result.command }), "ok");
    return true;
  } catch (error) {
    toast(errorMessage(error), "error");
    return false;
  }
}

export async function openLimitResetDialog() {
  let profiles = [];
  try { profiles = (await api.get("/api/profile")).profiles || []; } catch { /* the active profile is used */ }
  let profile = app.config?.profile;
  const select = profiles.length > 1
    ? h("select.input", { onchange: (event) => { profile = event.target.value; } }, profiles.map((entry) => h("option", { value: entry.name, selected: entry.name === profile }, entry.label || entry.name)))
    : null;
  const body = h(
    "div.limit-reset",
    h("p", t("Limit resets (“Reset for free” on claude.ai) clear a usage limit of an account early. They belong to the account the profile is signed in to: the resets of a personal account do not apply to a work account.")),
    h("p.muted", t("Claude Code handles them only in its own terminal screen, so these buttons open Claude Code in a new window with /limit-reset (or /limit-reset and a type). What happens next is Claude Code's own screen; a reset may be used right away.")),
    select ? h("div.setting-row", h("div.grow", h("strong", t("Account (profile)"))), select) : null,
    h(
      "div.limit-reset-kinds",
      KINDS.map((kind) =>
        h(
          `button.picker-item${kind.id ? "" : ".primary-item"}`,
          { type: "button", onclick: async () => {
            const message = kind.id ? t("Use a {kind} of this account now?", { kind: t(kind.title) }) : t("Open /limit-reset in Claude Code? It may use a reset of this account right away.");
            if (!(await confirmDialog({ title: t(kind.title), message, confirmLabel: kind.id ? t("Use it") : t("Open") }))) return;
            if (await open(kind.id, profile)) dialog.close();
          } },
          icon(kind.id ? "rotate-ccw" : "list", 16),
          h("span.pi-main", h("span.pi-title", t(kind.title)), h("span.pi-desc", t(kind.desc))),
          h("code.muted.small", { dir: "ltr" }, kind.id ? `/limit-reset ${kind.id}` : "/limit-reset"),
        ),
      ),
    ),
  );
  const dialog = modal({ title: t("Limit resets"), body, width: 560 });
  return dialog;
}

registerCommand({
  id: "limit-reset",
  title: "Limit resets",
  icon: "rotate-ccw",
  keywords: ["reset", "limit", "usage", "fable", "quota"],
  slash: "limit-reset",
  run: (ctx, args) => {
    const kind = String(args || "").trim();
    if (["fable", "full", "5-hour", "weekly"].includes(kind)) return open(kind); // typed on purpose: no second question
    return openLimitResetDialog();
  },
});
