// Settings → Learning: what Claude has learned and what is waiting. Reads <config>/learning (inbox, skill usage,
// upkeep reports), learned skills and the local git history of the config folder (server/lib/routes/learning.mjs).
// The only change made here is marking an inbox item skipped or pending again; /reflect does the real work.
import { h, toast, errorMessage, modal, baseName } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { api } from "../core/api.js";
import { bus } from "../core/state.js";
import { registerSettingsSection } from "../core/registry.js";
import { group, pageHeader, infoBanner } from "./settings-shared.js";

const TYPE_LABELS = { explicit: "Remember", correction: "Correction", "skill-candidate": "Skill candidate" };
const STATUS_LABELS = { pending: "Waiting", applied: "Saved", "applied-by-session": "Saved by the session", skipped: "Skipped" };

const when = (iso) => {
  const at = Date.parse(iso);
  if (!at) return "";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 60) return t("{n} min ago", { n: Math.max(1, minutes) });
  if (minutes < 48 * 60) return t("{n} h ago", { n: Math.round(minutes / 60) });
  return new Date(at).toLocaleDateString();
};

function showText(title, text) {
  modal({ title, width: 860, body: h("pre.code-block", { dir: "ltr", style: { maxHeight: "65vh", overflow: "auto", whiteSpace: "pre-wrap" } }, text), actions: [{ label: t("Close"), onClick: (dialog) => dialog.close() }] });
}

function reflectButton(label = t("Review with /reflect")) {
  return h("button.btn.primary", {
    type: "button",
    title: t("Puts /reflect in the message box of the current conversation"),
    onclick: async () => {
      const { openSettings } = await import("../ui/settings.js");
      openSettings("learning")?.dialog?.close();
      bus.emit("composer:fill", "/reflect");
    },
  }, icon("sparkles", 13), label);
}

registerSettingsSection({
  id: "learning",
  title: "Learning",
  icon: "brain",
  order: 14,
  async render(el) {
    const host = h("div");
    el.append(...pageHeader("Learning", "What Claude learned from your sessions: corrections and \"remember this\" requests waiting for review, skills it wrote for itself, and the history of every change."), host);

    async function draw() {
      let data;
      try {
        data = await api.get("/api/learning");
      } catch (error) {
        host.replaceChildren(h("div.banner.error", icon("alert", 14), h("span", errorMessage(error))));
        return;
      }
      const pending = data.inbox.filter((item) => item.status === "pending");
      const parts = [];

      parts.push(group("Status",
        h("div.learn-stats", { style: { display: "flex", gap: "18px", flexWrap: "wrap" } },
          stat(pending.length, t("waiting for review")),
          stat(data.skills.filter((skill) => skill.learned).length, t("learned skills")),
          stat(data.history.length, t("recorded changes")),
          stat(data.hooks.length, t("learning hooks"))),
        h("p.muted.small", { dir: "ltr" }, data.configDir),
        !data.present ? infoBanner(t("No learning folder in this profile yet. The page fills in once learning hooks write to <config>/learning.")) : null,
        data.present && !data.hooks.length ? infoBanner(t("The learning folder exists but no hook in settings.json writes to it.")) : null,
        data.lastReflectAt ? h("p.muted.small", t("Last review: {when}", { when: when(data.lastReflectAt) })) : null));

      const rows = data.inbox.slice(0, 80).map((item) => h("li.learn-item", { style: { padding: "8px 0", borderBottom: "1px solid var(--line)" } },
        h("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
          h("span.chip", t(TYPE_LABELS[item.type] || item.type || "")),
          h("span.muted.small", t(STATUS_LABELS[item.status] || item.status || "")),
          h("span.muted.small", [item.project, when(item.ts)].filter(Boolean).join(" · ")),
          h("span", { style: { flex: "1" } }),
          item.status === "pending"
            ? h("button.btn.small", { type: "button", onclick: () => setStatus(item.id, "skipped") }, t("Skip"))
            : item.status === "skipped" ? h("button.btn.small", { type: "button", onclick: () => setStatus(item.id, "pending") }, t("Put back")) : null),
        h("div", { dir: "auto", style: { marginTop: "4px", whiteSpace: "pre-wrap" } }, item.text)));
      parts.push(group("Inbox",
        pending.length ? h("div", { style: { marginBottom: "8px" } }, reflectButton()) : null,
        rows.length ? h("ul", { style: { listStyle: "none", padding: 0, margin: 0 } }, rows) : h("p.muted", t("Nothing caught yet."))));

      parts.push(group("Skills",
        data.skills.length
          ? h("div.markdown", h("div.md-table-wrap", h("table",
            h("thead", h("tr", h("th", t("Skill")), h("th", t("Uses ({n} days)", { n: data.usageDays })), h("th", t("Last used")))),
            h("tbody", data.skills.map((skill) => h("tr",
              h("td", h("div", h("code", skill.name), skill.learned ? h("span.chip", { style: { marginInlineStart: "6px" } }, t("learned")) : null), h("div.muted.small", { dir: "auto" }, skill.description)),
              h("td", String(skill.uses) + (skill.failed ? ` (${t("{n} failed", { n: skill.failed })})` : "")),
              h("td.muted.small", skill.lastUsed ? when(skill.lastUsed) : "—")))))))
          : h("p.muted", t("No learned or used skills yet."))));

      parts.push(group("History",
        data.versioned
          ? (data.history.length
            ? h("ul", { style: { listStyle: "none", padding: 0, margin: 0 } }, data.history.map((entry) => h("li", { style: { display: "flex", gap: "10px", padding: "4px 0" } },
              h("button.btn.small", { type: "button", dir: "ltr", onclick: () => openCommit(entry.sha) }, h("code", entry.sha)),
              h("span", { dir: "auto", style: { flex: "1" } }, entry.subject),
              h("span.muted.small", when(entry.date)))))
            : h("p.muted", t("No changes recorded yet.")))
          : infoBanner(t("The config folder is not a git repository, so changes are not recorded."))));

      if (data.reports.length) {
        parts.push(group("Upkeep reports",
          h("ul", data.reports.map((name) => h("li", h("button.btn.small", { type: "button", dir: "ltr", onclick: () => openReport(name) }, baseName(name)))))));
      }
      host.replaceChildren(...parts);
    }

    function stat(value, label) {
      return h("div", h("div", { style: { fontSize: "22px", fontWeight: "600" } }, String(value)), h("div.muted.small", label));
    }

    async function setStatus(id, status) {
      try {
        await api.post(`/api/learning/inbox/${encodeURIComponent(id)}`, { status });
        draw();
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    }

    async function openCommit(sha) {
      try {
        const out = await api.get(`/api/learning/commit/${sha}`);
        showText(t("Change {sha}", { sha }), out.text);
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    }

    async function openReport(name) {
      try {
        const out = await api.get(`/api/learning/report/${encodeURIComponent(name)}`);
        showText(name, out.text);
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    }

    await draw();
  },
});
