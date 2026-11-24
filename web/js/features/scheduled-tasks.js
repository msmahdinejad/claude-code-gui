// Scheduled tasks: a Settings page for recurring prompts that Wheelhouse starts as Claude Code sessions while it is open
// (server side: server/lib/scheduler.mjs and server/lib/routes/schedule.mjs). Modelled on Claude Code Desktop's
// scheduled tasks: name, prompt, folder, frequency, model, permission mode, run now, pause, history. A task can also run
// inside an existing session: its prompt then joins that session's send queue instead of starting a new session.
import { h, modal, toast, errorMessage, confirmDialog, faDigits } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { app } from "../core/state.js";
import { api } from "../core/api.js";
import { registerSettingsSection } from "../core/registry.js";
import { pickFolder } from "../ui/folder-picker.js";

const isFa = () => document.documentElement.lang === "fa";
const locale = () => (isFa() ? "fa-IR" : undefined);
const digits = (text) => (isFa() ? faDigits(text) : String(text));
const say = (error) => t(errorMessage(error)); // server messages are English source strings
// A run's stored error: translated whole, or (for "The folder does not exist: <path>") by the part before the colon.
const runError = (text) => {
  const whole = t(text);
  const cut = text.indexOf(": ");
  return whole !== text || cut < 1 ? whole : `${t(text.slice(0, cut))}: ${text.slice(cut + 2)}`;
};

// Literal t() calls so `npm run i18n:check` sees them.
const modes = () => [
  { id: "plan", label: t("Plan (read only)"), desc: t("Claude reads and writes a plan; it changes nothing. The safe default.") },
  { id: "acceptEdits", label: t("Accept edits"), desc: t("Claude edits files on its own; other actions that need approval are refused.") },
  { id: "dontAsk", label: t("Only pre-approved tools"), desc: t("Claude may only use what your allow rules already permit; everything else is refused.") },
  { id: "auto", label: t("Auto"), desc: t("A classifier model reviews each action. Needs a supported model and account; without it Claude Code asks, and the request is refused.") },
];
const frequencies = () => [
  { id: "manual", label: t("Manual (only Run now)") },
  { id: "hourly", label: t("Hourly") },
  { id: "daily", label: t("Daily") },
  { id: "weekdays", label: t("Weekdays") },
  { id: "weekly", label: t("Weekly") },
];
const statusLabel = (status) => ({
  success: t("Succeeded"), failed: t("Failed"), timeout: t("Timed out"), stopped: t("Stopped"), skipped: t("Skipped"), running: t("Running"), queued: t("Waiting"),
}[status] || status);
const triggerLabel = (trigger) => ({ schedule: t("Scheduled"), catchup: t("Catch-up"), manual: t("Run now") }[trigger] || trigger);
const statusClass = (status) => ({ success: "ok", failed: "danger", timeout: "warn", running: "accent" }[status] || "");

function weekdayName(day) {
  return new Date(2026, 5, 7 + Number(day)).toLocaleDateString(locale(), { weekday: "long" }); // 7 June 2026 is a Sunday
}

function when(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(locale(), { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function schedule(task) {
  const time = digits(task.time);
  if (task.frequency === "manual") return t("Manual");
  if (task.frequency === "hourly") return t("Every hour at minute {minute}", { minute: Number(task.time.slice(3)) });
  if (task.frequency === "weekdays") return t("Weekdays at {time}", { time });
  if (task.frequency === "weekly") return t("Every {day} at {time}", { day: weekdayName(task.weekday), time });
  return t("Every day at {time}", { time });
}

function duration(run) {
  if (!run.startedAt || !run.endedAt) return "";
  const seconds = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));
  return seconds < 60 ? t("{n}s", { n: seconds }) : t("{m}m {s}s", { m: Math.floor(seconds / 60), s: seconds % 60 });
}

const PASTE = "__paste";
const shortId = (id) => String(id).slice(0, 8);
const sessionTitle = (task) => task.session?.title || app.sessions?.find((session) => session.id === task.sessionId)?.title || shortId(task.sessionId);
const baseName = (path) => String(path || "").split(/[\\/]/).filter(Boolean).pop() || String(path || "");

function closeSettingsAndOpen(ctx, run, task) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); // the Settings dialog closes itself
  return ctx.session.refreshSessions().catch(() => {}).then(() => ctx.session.openSession(run.sessionId, { cwd: task.cwd }));
}

// ---- the create / edit dialog -----------------------------------------------------------
async function editTask(ctx, task, done) {
  if (!app.catalog) await ctx.session.ensureCatalog().catch(() => {});
  const models = (app.catalog?.models || []).filter((model) => model.value !== "default");
  const known = new Set(models.map((model) => model.value));
  const state = { cwd: task?.cwd || app.currentCwd || app.config?.defaultCwd || "" };
  if (!app.sessions?.length) await ctx.session.refreshSessions().catch(() => {});
  const recent = [...(app.sessions || [])].sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0)).slice(0, 40);

  const name = h("input.input", { type: "text", value: task?.name || "", maxlength: "80", dir: "auto", autofocus: true, placeholder: t("Morning review") });
  const prompt = h("textarea.input.st-prompt", { rows: 7, dir: "auto", placeholder: t("What should Claude do each time this runs?") }, task?.prompt || "");
  const folder = h("code.st-folder", { dir: "ltr", title: state.cwd }, state.cwd || t("No folder chosen"));
  const frequency = h("select.input", frequencies().map((item) => h("option", { value: item.id, selected: (task?.frequency || "daily") === item.id }, item.label)));
  const time = h("input.input", { type: "time", value: task?.time || "09:00", dir: "ltr" });
  const minute = h("input.input", { type: "number", min: "0", max: "59", value: String(Number((task?.time || "00:00").slice(3))), dir: "ltr" });
  const weekday = h("select.input", [0, 1, 2, 3, 4, 5, 6].map((day) => h("option", { value: String(day), selected: Number(task?.weekday ?? 1) === day }, weekdayName(day))));
  const model = h("select.input", [
    h("option", { value: "" }, t("Default")),
    ...models.map((item) => h("option", { value: item.value, selected: task?.model === item.value }, item.displayName || item.value)),
    task?.model && !known.has(task.model) ? h("option", { value: task.model, selected: true }, task.model) : null,
  ]);
  const mode = h("select.input", modes().map((item) => h("option", { value: item.id, selected: (task?.permissionMode || "plan") === item.id }, item.label)));
  const modeHint = h("small.muted");
  const turns = h("input.input", { type: "number", min: "1", max: "200", value: String(task?.maxTurns || 40), dir: "ltr" });
  const worktree = h("input", { type: "checkbox", checked: Boolean(task?.worktree) });
  const error = h("div.banner.error", { hidden: true });

  // Where it runs: a new session each time, or inside one that exists (picked from the recent ones or pasted by its id).
  const where = h("select.input", [
    h("option", { value: "new", selected: !task?.sessionId }, t("A new session each run")),
    h("option", { value: "existing", selected: Boolean(task?.sessionId) }, t("Inside an existing session")),
  ]);
  const listed = (id) => recent.some((item) => item.id === id);
  const picker = h("select.input", [
    h("option", { value: "" }, t("Choose a session…")),
    ...recent.map((item) => h("option", { value: item.id, selected: task?.sessionId === item.id }, `${item.title || t("Untitled session")} · ${baseName(item.cwd)}`)),
    h("option", { value: PASTE, selected: Boolean(task?.sessionId) && !listed(task.sessionId) }, t("Another session (paste its id)")),
  ]);
  const pasted = h("input.input", { type: "text", dir: "ltr", maxlength: "80", placeholder: t("Session id"), value: task?.sessionId && !listed(task.sessionId) ? task.sessionId : "" });
  const sessionRow = h(
    "div.field",
    h("span", t("Which session")),
    picker,
    pasted,
    h("small", t("The prompt is sent to that session like a message you typed. If the session is busy or a usage limit holds it, the prompt waits in its queue (up to 12 hours); a closed session is opened again. Its own model and permission mode apply.")),
  );
  // What only a run in a new session needs: a session that already exists keeps its own settings.
  const newSessionOnly = [
    h("div.st-grid", h("label.field", h("span", t("Model")), model), h("label.field", h("span", t("Permission mode")), mode, modeHint)),
    h("label.field", h("span", t("Turn limit")), turns, h("small", t("A run stops after this many turns, so a task cannot go on for ever."))),
    h("label.st-check", worktree, h("span", t("Run in its own Git worktree"), h("small", t("Each run works in an isolated copy of the repository, so your working files stay untouched. The folder must be a Git repository.")))),
    h("div.banner.info", icon("info", 14), h("span", t("Each run is a new session and uses your account's usage, like any other session. Runs are unattended: a request for approval that nobody answers within 10 minutes is refused, and a run is stopped after an hour."))),
  ];
  const existingOnly = h("div.banner.info", icon("info", 14), h("span", t("Runs add to that session's history and use your account's usage. The session is never interrupted. If Claude asks for approval, the request stays in the session until you answer it. A run counts as finished when Claude's turn ends, or is marked timed out after an hour.")));

  const rows = {
    time: h("label.field", h("span", t("Time of day")), time),
    minute: h("label.field", h("span", t("Minute past the hour")), minute),
    weekday: h("label.field", h("span", t("Day of the week")), weekday),
  };
  const chosenSession = () => (where.value !== "existing" ? "" : picker.value === PASTE ? pasted.value.trim() : picker.value);
  const sync = () => {
    const value = frequency.value;
    const existing = where.value === "existing";
    folderRow.hidden = existing; // a session runs in its own folder, which the server reads from it
    rows.time.hidden = !["daily", "weekdays", "weekly"].includes(value);
    rows.minute.hidden = value !== "hourly";
    rows.weekday.hidden = value !== "weekly";
    modeHint.textContent = modes().find((item) => item.id === mode.value)?.desc || "";
    sessionRow.hidden = !existing;
    pasted.hidden = picker.value !== PASTE;
    for (const row of newSessionOnly) row.hidden = existing;
    existingOnly.hidden = !existing;
  };
  frequency.addEventListener("change", sync);
  mode.addEventListener("change", sync);
  where.addEventListener("change", sync);
  picker.addEventListener("change", sync);

  const choose = h("button.btn.small", { type: "button", onclick: async () => {
    const picked = await pickFolder(state.cwd);
    if (!picked) return;
    state.cwd = picked;
    folder.textContent = picked;
    folder.title = picked;
  } }, icon("folder-open", 14), t("Choose…"));
  const folderRow = h("div.field", h("span", t("Folder")), h("div.st-folder-row", folder, choose));
  sync();

  const save = async (dialog) => {
    if (where.value === "existing" && !chosenSession()) {
      error.hidden = false;
      error.replaceChildren(icon("alert", 14), h("span", t("Choose a session or paste its id")));
      return;
    }
    const minuteValue = String(Math.min(59, Math.max(0, Number(minute.value) || 0))).padStart(2, "0");
    const body = {
      name: name.value, prompt: prompt.value, cwd: state.cwd, sessionId: chosenSession(), frequency: frequency.value,
      time: frequency.value === "hourly" ? `00:${minuteValue}` : time.value || "09:00",
      weekday: Number(weekday.value), model: model.value, permissionMode: mode.value, maxTurns: Number(turns.value) || 40, worktree: worktree.checked,
    };
    try {
      if (task) await api.put(`/api/schedule/tasks/${task.id}`, body);
      else await api.post("/api/schedule/tasks", body);
      dialog.close();
      toast(t("Saved"), "ok", 1400);
      done();
    } catch (failure) {
      error.hidden = false;
      error.replaceChildren(icon("alert", 14), h("span", say(failure)));
    }
  };

  modal({
    title: task ? t("Edit scheduled task") : t("New scheduled task"),
    width: 600,
    className: "st-dialog",
    body: h(
      "div.st-form",
      h("label.field", h("span", t("Name")), name),
      h("label.field", h("span", t("Instructions")), prompt),
      h("label.field", h("span", t("Where to run")), where),
      sessionRow,
      folderRow,
      h("div.st-grid", h("label.field", h("span", t("Frequency")), frequency), rows.time, rows.minute, rows.weekday),
      ...newSessionOnly,
      existingOnly,
      error,
    ),
    actions: [
      { label: t("Cancel"), onClick: (dialog) => dialog.close() },
      { label: t("Save"), variant: "primary", onClick: save },
    ],
  });
}

// ---- the page --------------------------------------------------------------------------------
registerSettingsSection({
  id: "scheduled-tasks", title: "Scheduled tasks", icon: "clock", order: 4,
  async render(el, ctx) {
    const host = h("div");
    const expanded = new Set();
    let data = null;
    el.append(
      h("h2", t("Scheduled tasks")),
      h("p.lead", t("Recurring prompts that Wheelhouse starts as Claude Code sessions: a daily code review, a morning briefing, a dependency check.")),
      host,
    );

    const act = async (call) => {
      try {
        await call();
      } catch (failure) {
        toast(say(failure), "error");
      }
      await load();
    };

    const runRow = (task, run) => h(
      "div.st-run",
      h("span", { class: `badge ${statusClass(run.status)}` }, statusLabel(run.status)),
      h("span.st-run-when", when(run.startedAt || run.queuedAt)),
      h("span.muted.small", [triggerLabel(run.trigger), duration(run)].filter(Boolean).join(" · ")),
      run.error ? h("span.st-run-error", { dir: "auto", title: run.error }, runError(run.error)) : null,
      run.sessionId && run.status !== "skipped"
        ? h("button.btn.small.ghost", { type: "button", onclick: () => closeSettingsAndOpen(ctx, run, task) }, icon("external", 13), t("Open session"))
        : null,
    );

    const card = (task) => {
      const running = task.active === "running";
      const queued = task.active === "queued";
      const open = expanded.has(task.id);
      const state = running ? "running" : queued ? "queued" : !task.enabled ? "paused" : task.frequency === "manual" ? "manual" : "active";
      const badge = { running: ["accent", t("Running")], queued: ["", task.held ? t("Waiting for the usage limit") : t("Waiting")], paused: ["warn", t("Paused")], manual: ["", t("Manual")], active: ["ok", t("Active")] }[state];
      return h(
        "div.st-task",
        h(
          "div.st-head",
          h("div.grow", h("strong", { dir: "auto" }, task.name), h("small.muted", { dir: "auto" }, [schedule(task), task.sessionId ? t("in session {session}", { session: sessionTitle(task) }) : t("in {folder}", { folder: task.cwd })].join(" · "))),
          h("span", { class: `badge ${badge[0]}` }, badge[1]),
          task.folderMissing && !task.sessionId ? h("span.badge.danger", t("Folder missing")) : null,
          task.session?.state === "missing" ? h("span.badge.danger", t("Session missing")) : null,
          task.session?.state === "archived" ? h("span.badge.warn", t("Session archived")) : null,
        ),
        h(
          "div.st-meta",
          h("span", h("span.muted", `${t("Next run")}: `), task.nextRun ? when(task.nextRun) : task.frequency === "manual" ? t("none") : !data.enabled ? t("switched off") : !task.enabled ? t("Paused") : "—"),
          h("span", h("span.muted", `${t("Last run")}: `), task.lastRun ? [h("span", { class: `badge ${statusClass(task.lastRun.status)}` }, statusLabel(task.lastRun.status)), " ", when(task.lastRun.startedAt || task.lastRun.endedAt)] : t("never")),
          h("span.muted", `${t("Mode")}: ${modes().find((item) => item.id === task.permissionMode)?.label || task.permissionMode}`),
        ),
        task.lastRun?.error && !running && !queued && ["failed", "timeout"].includes(task.lastRun.status)
          ? h("div.st-last-error", { dir: "auto" }, icon("alert", 13), runError(task.lastRun.error))
          : null,
        h(
          "div.st-actions",
          running || queued
            ? h("button.btn.small", { type: "button", onclick: () => act(() => api.post(`/api/schedule/tasks/${task.id}/stop`)) }, icon("stop", 13), running ? t("Stop") : t("Cancel run"))
            : h("button.btn.small", { type: "button", disabled: !data.enabled, title: data.enabled ? t("Start a run now") : t("Switch scheduled tasks on first"), onclick: () => act(async () => {
              const { run } = await api.post(`/api/schedule/tasks/${task.id}/run`);
              toast(t("Started: {name}", { name: task.name }), "ok", 1800);
              return run;
            }) }, icon("play", 13), t("Run now")),
          h("button.btn.small", { type: "button", onclick: () => act(() => api.post(`/api/schedule/tasks/${task.id}/${task.enabled ? "pause" : "resume"}`)) }, task.enabled ? t("Pause") : t("Resume")),
          h("button.btn.small", { type: "button", onclick: async () => editTask(ctx, (await api.get(`/api/schedule/tasks/${task.id}`)), load) }, icon("edit", 13), t("Edit")),
          h("button.btn.small.ghost", { type: "button", "aria-expanded": String(open), onclick: async () => {
            if (open) expanded.delete(task.id); else expanded.add(task.id);
            await load();
          } }, icon("history", 13), t("History")),
          h("button.btn.small.danger-outline.st-delete", { type: "button", onclick: async () => {
            const sure = await confirmDialog({ title: t("Delete this task?"), message: t("“{name}” will no longer run. Sessions it already started stay in your list.", { name: task.name }), confirmLabel: t("Delete"), danger: true });
            if (sure) await act(() => api.del(`/api/schedule/tasks/${task.id}`));
          } }, icon("trash", 13), t("Delete")),
        ),
        open ? h("div.st-history", task.runHistory === undefined ? h("div.muted.small", t("Loading…")) : task.runHistory.length ? task.runHistory.map((run) => runRow(task, run)) : h("div.muted.small", t("No runs yet"))) : null,
      );
    };

    const draw = () => {
      const switchInput = h("input", { type: "checkbox", checked: data.enabled });
      switchInput.addEventListener("change", async () => {
        const wanted = switchInput.checked;
        if (wanted && !(await confirmDialog({
          title: t("Turn on scheduled tasks?"),
          message: t("From now on tasks start by themselves while Wheelhouse is open. Every run uses your account's usage, so check each task's folder, instructions and permission mode first."),
          confirmLabel: t("Turn on"),
        }))) {
          switchInput.checked = false;
          return;
        }
        await act(() => api.put("/api/schedule/enabled", { enabled: wanted }));
      });
      host.replaceChildren(
        h("div.banner.info", icon("info", 14), h("span", t("Tasks run only while Wheelhouse is open and this computer is awake. After a restart, a task that missed a run is run once for its latest missed time (within the last 7 days). Each run is a new session and uses your account's usage."))),
        data.timeZone ? h("p.muted.small", { dir: "auto" }, t("Times are read in this computer's time zone: {zone}.", { zone: data.timeZone })) : null,
        h(
          "div.group",
          h("h3", t("Switch")),
          h("div.setting-row", h("div.grow", h("strong", t("Scheduled tasks enabled")), h("small", t("Off by default. While it is off nothing runs, not even with Run now. Only one task runs at a time; the others wait."))), h("label.switch", switchInput)),
        ),
        h(
          "div.group",
          h("h3", t("Tasks")),
          h("div.st-toolbar", h("button.btn.primary", { type: "button", onclick: () => editTask(ctx, null, load) }, icon("plus", 14), t("New task"))),
          data.tasks.length ? h("div.st-list", data.tasks.map(card)) : h("div.muted.st-empty", t("No scheduled tasks yet.")),
        ),
      );
    };

    async function load() {
      try {
        data = await api.get("/api/schedule");
        // Tasks whose history is open need the run log (the list only carries the last run).
        await Promise.all(data.tasks.filter((task) => expanded.has(task.id)).map(async (task) => {
          task.runHistory = (await api.get(`/api/schedule/tasks/${task.id}`)).runs;
        }));
        if (el.isConnected) draw();
      } catch (failure) {
        host.replaceChildren(h("div.banner.error", icon("alert", 14), h("span", say(failure))));
      }
    }

    await load();
    const timer = setInterval(() => {
      if (!el.isConnected) clearInterval(timer);
      else if (!document.hidden && !document.querySelector(".st-dialog")) load();
    }, 5000);
  },
});
