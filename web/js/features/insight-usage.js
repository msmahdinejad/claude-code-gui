// Usage tab: cost/tokens per turn and model, plan rate limits, account, project-wide token totals.
import { h, formatCost, formatDuration, formatTokens, formatTime, spinner, ibtn, shortPath } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app, bus } from "../core/state.js";
import { registerInspectorTab } from "../core/registry.js";
import { api } from "../core/api.js";
import { liveControl, isAlive, bar, pct, num } from "./insight-shared.js";

/** Per-turn rows. `total_cost_usd` on a result is cumulative for the running process, so derive deltas. */
export function turnRows(conv) {
  const rows = [];
  let previous = 0;
  let epoch = 0;
  for (const item of conv.items.filter((entry) => entry.kind === "result")) {
    const cost = item.cost || 0;
    if (cost < previous) epoch += 1; // new process after restart/resume: counter reset
    const delta = cost >= previous ? cost - previous : cost;
    previous = cost;
    const usage = item.usage || {};
    rows.push({
      durationMs: item.durationMs,
      delta,
      cumulative: cost,
      input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
      output: usage.output_tokens || 0,
      turns: item.turns,
      isError: item.isError,
      epoch,
    });
  }
  return rows;
}

function resetLabel(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return t("resets now");
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.round((diff % 3_600_000) / 60_000);
  return hours >= 24 ? t("resets in {n}d", { n: Math.round(hours / 24) }) : t("resets in {h}h {m}m", { h: hours, m: minutes });
}

function limitRow(label, limit) {
  if (!limit || limit.utilization === null || limit.utilization === undefined) return null;
  const value = limit.utilization <= 1 && limit.utilization > 0 ? limit.utilization * 100 : limit.utilization;
  return h("div.usage-limit", h("div.row-inline", h("span.grow", label), h("strong", pct(value)), h("span.muted.small", resetLabel(limit.resets_at))), bar(value, value > 90 ? "danger" : value > 70 ? "warn" : ""));
}

function modelTable(modelUsage) {
  const entries = Object.entries(modelUsage || {});
  if (!entries.length) return null;
  return h(
    "table.mini-table",
    h("thead", h("tr", h("th", t("Model")), h("th", t("In")), h("th", t("Out")), h("th", t("Cache")), h("th", t("Cost")))),
    h(
      "tbody",
      entries.map(([model, usage]) =>
        h("tr", h("td", { dir: "ltr" }, model), h("td", formatTokens(usage.inputTokens ?? usage.input_tokens)), h("td", formatTokens(usage.outputTokens ?? usage.output_tokens)), h("td", formatTokens((usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? 0) + (usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? 0))), h("td", formatCost(usage.costUSD ?? usage.cost_usd))),
      ),
    ),
  );
}

registerInspectorTab({
  id: "usage",
  title: "Usage",
  icon: "coins",
  order: 21,
  render(container, ctx) {
    let alive = true;
    let live = null; // control op usage result
    let project = null;
    let loading = false;
    let error = null;

    async function load() {
      loading = true;
      paint();
      const jobs = [];
      if (isAlive() || app.convs.get(app.currentId)?.items.length) {
        jobs.push(liveControl("usage").then((value) => { live = value; }).catch((e) => { error = e.message; }));
      }
      jobs.push(api.get("/api/insight/project-usage", { cwd: app.currentCwd }).then((value) => { project = value; }).catch(() => {}));
      await Promise.all(jobs);
      loading = false;
      if (alive) paint();
    }

    function paint() {
      if (!alive) return;
      const conv = app.convs.get(app.currentId);
      const rows = conv ? turnRows(conv) : [];
      const total = rows.reduce((sum, row) => sum + row.delta, 0);
      const last = conv?.lastResult;
      const modelUsage = live?.session?.model_usage || last?.modelUsage;
      const body = [h("div.panel-head", h("h3", t("Usage")), loading ? spinner(14) : null, ibtn("refresh", t("Refresh"), load, { size: 14 }))];

      body.push(
        h(
          "div.panel-section",
          h("h4", t("This session")),
          h("div.usage-cards", stat(t("Cost"), formatCost(live?.session?.total_cost_usd ?? total) || "$0"), stat(t("Turns"), num(rows.length)), stat(t("API time"), formatDuration(live?.session?.total_api_duration_ms ?? rows.reduce((s, r) => s + (r.durationMs || 0), 0))), stat(t("Lines"), live ? `+${num(live.session.total_lines_added)} −${num(live.session.total_lines_removed)}` : "—")),
          modelTable(modelUsage),
        ),
      );

      // total_cost_usd on results only covers the turns themselves; the live total also counts side calls
      // (titles, summaries, prompt suggestions).
      const sideCost = live?.session?.total_cost_usd !== undefined ? live.session.total_cost_usd - total : 0;
      if (rows.length) {
        body.push(
          h(
            "div.panel-section",
            h("h4", t("Per turn")),
            h(
              "table.mini-table",
              h("thead", h("tr", h("th", "#"), h("th", t("Time")), h("th", t("In")), h("th", t("Out")), h("th", t("Cost")))),
              h("tbody", rows.map((row, index) => h(`tr${row.isError ? ".err" : ""}`, h("td", String(index + 1)), h("td", formatDuration(row.durationMs)), h("td", formatTokens(row.input)), h("td", formatTokens(row.output)), h("td", formatCost(row.delta)))), sideCost > 0.0001 ? h("tr.muted", h("td", { colspan: 4 }, t("Background calls (titles, summaries, suggestions)")), h("td", formatCost(sideCost))) : null),
            ),
          ),
        );
      }

      // Plan limits
      const limits = live?.rate_limits;
      const events = conv?.rateLimit;
      const limitNodes = [];
      if (live?.rate_limits_available && limits) {
        limitNodes.push(limitRow(t("5-hour window"), limits.five_hour), limitRow(t("7-day window"), limits.seven_day), limitRow(t("7-day Opus"), limits.seven_day_opus), limitRow(t("7-day Sonnet"), limits.seven_day_sonnet));
        for (const scoped of limits.model_scoped || []) limitNodes.push(limitRow(scoped.display_name, scoped));
        if (limits.extra_usage?.is_enabled) limitNodes.push(h("div.usage-limit", h("div.row-inline", h("span.grow", t("Extra usage")), h("strong", `${formatCost(limits.extra_usage.used_credits)} / ${formatCost(limits.extra_usage.monthly_limit)}`)), bar(limits.extra_usage.utilization || 0)));
      }
      const shown = limitNodes.filter(Boolean);
      body.push(
        h(
          "div.panel-section",
          h("h4", t("Plan limits")),
          shown.length ? shown : h("div.muted.small", live ? t("Plan limits are not reported for this account or gateway.") : t("Press refresh to load.")),
          events ? h("div.banner.info", icon("info", 14), h("span", rateLimitText(events))) : null,
        ),
      );

      const account = app.catalog?.account;
      const fast = app.live.get(app.currentId)?.init?.fast_mode_state || app.catalog?.fastMode?.state;
      body.push(
        h(
          "div.panel-section",
          h("h4", t("Account")),
          h("dl.kv", h("dt", t("Email")), h("dd", account?.email || "—"), h("dt", t("Organization")), h("dd", account?.organization || "—"), h("dt", t("Subscription")), h("dd", live?.subscription_type || account?.subscriptionType || "—"), h("dt", t("Provider")), h("dd", account?.apiProvider || "—"), h("dt", t("Fast mode")), h("dd", fast || "—")),
        ),
      );

      if (project?.sessions?.length) {
        const top = [...project.sessions].sort((a, b) => b.output + b.input - (a.output + a.input)).slice(0, 8);
        body.push(
          h(
            "div.panel-section",
            h("h4", t("This project")),
            h("div.muted.small", t("Tokens across the last {n} sessions in {path} (cost is not stored in transcripts).", { n: project.scanned, path: shortPath(app.currentCwd || "", 30) })),
            h("div.usage-cards", stat(t("Input"), formatTokens(project.total.input + project.total.cacheRead + project.total.cacheWrite)), stat(t("Output"), formatTokens(project.total.output)), stat(t("Cache read"), formatTokens(project.total.cacheRead)), stat(t("Turns"), num(project.total.turns))),
            h(
              "table.mini-table",
              h("thead", h("tr", h("th", t("Session")), h("th", t("When")), h("th", t("Out")))),
              h("tbody", top.map((session) => h("tr.clickable", { onclick: () => ctx.session.openSession(session.id, { cwd: app.currentCwd }) }, h("td", { dir: "auto" }, session.title || t("Untitled session")), h("td", formatTime(session.lastModified)), h("td", formatTokens(session.output))))),
            ),
          ),
        );
      }
      if (error) body.push(h("div.banner.warn", error));
      container.replaceChildren(h("div.panel.usage", body));
    }

    const offs = [bus.on("conv:update", (id) => id === app.currentId && paint()), bus.on("live", (id) => id === app.currentId && paint()), bus.on("catalog", paint)];
    paint();
    load();
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  },
});

const stat = (label, value) => h("div.usage-card", h("span.muted.small", label), h("strong", value || "—"));

function rateLimitText(info) {
  const status = info.status || "";
  const type = info.rateLimitType || info.rate_limit_type || "";
  const reset = info.resetsAt ? ` · ${resetLabel(new Date(info.resetsAt * 1000 > 1e12 ? info.resetsAt : info.resetsAt * 1000).toISOString())}` : "";
  return `${t("Last rate-limit event")}: ${status} ${type}${reset}`.trim();
}
