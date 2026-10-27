// Shared helpers for the Extensions feature (MCP, plugins, skills, commands, agents).
// Registers nothing by itself.
import { h, toast, errorMessage, spinner, confirmDialog } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { bus } from "../core/state.js";

export const EXT_CHANGED = "ext:changed";

/** Run an allow-listed `claude ...` command on the server. Throws with stderr on failure. */
export async function runCli(ctx, args, { cwd = ctx.cwd, timeout = 90_000, allowFail = false } = {}) {
  const result = await ctx.api.cli(args, cwd, timeout);
  if (!result.ok && !allowFail) throw new Error((result.stderr || result.stdout || `claude ${args.join(" ")} failed`).trim());
  return result;
}

/** Re-read models/commands/agents/MCP for this cwd and tell panels to redraw. */
export async function refreshExtensions(ctx, { control } = {}) {
  const live = ctx.live;
  if (live?.alive && control) {
    try {
      await ctx.api.control(ctx.sessionId, control);
    } catch { /* optional */ }
  }
  await ctx.session.ensureCatalog(ctx.cwd, true);
  bus.emit(EXT_CHANGED);
}

/** Wrap an async action: disables the button, shows a spinner, toasts failures. */
export function busyButton(label, iconName, action, { variant = "", small = true, title = "" } = {}) {
  const btn = h(`button.btn${variant ? `.${variant}` : ""}${small ? ".small" : ""}`, { type: "button", title: title || undefined });
  const idle = () => btn.replaceChildren(iconName ? icon(iconName, 14) : null, h("span", label));
  idle();
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.replaceChildren(spinner(13), h("span", label));
    try {
      await action();
    } catch (error) {
      toast(errorMessage(error), "error", 7000);
    } finally {
      btn.disabled = false;
      idle();
    }
  });
  return btn;
}

export function statusBadge(status) {
  const map = {
    connected: ["ok", t("Connected")],
    failed: ["danger", t("Failed")],
    "needs-auth": ["warn", t("Needs sign-in")],
    pending: ["", t("Connecting…")],
    disabled: ["", t("Disabled")],
  };
  const [kind, label] = map[status] || ["", status || "—"];
  return h(`span.badge${kind ? `.${kind}` : ""}`, label);
}

export function sectionTitle(text, right) {
  return h("div.ext-title", h("h3", text), right || null);
}

export function emptyNote(text) {
  return h("div.ext-empty", text);
}

export function loading(text = t("Loading…")) {
  return h("div.ext-loading", spinner(14), h("span", text));
}

// ---- frontmatter -------------------------------------------------------------------
/** Minimal YAML-subset frontmatter parser (key: value, quoted strings, inline/block lists kept as text). */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { hasFm: false, data: {}, order: [], body: text, error: text.trimStart().startsWith("---") ? t("Frontmatter is not closed with ---") : null };
  const data = {};
  const order = [];
  let error = null;
  const lines = match[1].split(/\r?\n/);
  let last = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (kv && !line.startsWith(" ")) {
      last = kv[1];
      let value = kv[2].trim();
      if (/^".*"$/.test(value)) {
        try { value = JSON.parse(value); } catch { error = t("Invalid quoted value for {key}", { key: last }); }
      } else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replaceAll("''", "'");
      else if (/^\[.*\]$/.test(value)) value = value.slice(1, -1).split(",").map((part) => part.trim().replace(/^["']|["']$/g, "")).filter(Boolean).join(", ");
      data[last] = value;
      order.push(last);
    } else if (/^\s*-\s+/.test(line) && last) {
      const item = line.replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, "");
      data[last] = data[last] ? `${data[last]}, ${item}` : item;
    } else if (/^\s+\S/.test(line) && last) {
      data[last] = `${data[last]} ${line.trim()}`.trim(); // folded continuation
    } else {
      error = t("Cannot parse frontmatter line: {line}", { line: line.slice(0, 60) });
    }
  }
  return { hasFm: true, data, order, body: text.slice(match[0].length), error };
}

function yamlValue(value) {
  const text = String(value ?? "");
  if (text === "") return '""';
  if (/^[\w./@()*, -]+$/.test(text) && !/^(true|false|null|yes|no|\d+)$/i.test(text) && !text.includes(": ")) return text;
  return JSON.stringify(text);
}

export function buildFile(data, order, body) {
  const keys = [...new Set([...order, ...Object.keys(data)])].filter((key) => data[key] !== undefined && data[key] !== "");
  const fm = keys.map((key) => `${key}: ${yamlValue(data[key])}`).join("\n");
  return `---\n${fm}\n---\n\n${body.replace(/^\n+/, "")}`.replace(/\n*$/, "\n");
}

export function currentScopeLabel(scope) {
  return scope === "user" ? t("User (all projects)") : scope === "project" ? t("Project (shared)") : t("Local (private)");
}

export { confirmDialog };
