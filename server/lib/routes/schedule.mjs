// Scheduled tasks (see ../scheduler.mjs): recurring prompts that Wheelhouse starts as Claude Code sessions while it runs.
// Tasks live in <dataDir>/scheduled-tasks/<id>.json. Nothing runs unless the server pref `scheduledTasksEnabled` is true
// (off by default); every run uses the account's usage like any other session.
import { TaskScheduler } from "../scheduler.mjs";

export default function register({ route, config, manager, store, join }) {
  const scheduler = new TaskScheduler({
    dir: join(config.dataDir, "scheduled-tasks"),
    manager,
    config,
    enabled: () => store.data.prefs.scheduledTasksEnabled === true,
    // The run's session is named after the task in the session list (and keeps that name: no model-written title).
    annotate: (sessionId, meta) => store.patchSessionMeta(sessionId, meta),
  });
  // A moment after the server is up: load the tasks, then look at what is due (one catch-up run per task that missed one).
  scheduler.load().then(() => scheduler.start()).catch((error) => console.warn(`[wheelhouse] scheduled tasks were not loaded: ${error.message}`));

  // Everything: the switch, what is running, and the tasks with their next and last run.
  route("GET", "/api/schedule", async () => ({ ...scheduler.status(), tasks: await scheduler.list() }));

  // The global switch. Turning it on starts the schedule fresh: what came due while it was off is not caught up.
  route("PUT", "/api/schedule/enabled", async ({ body }) => {
    await store.setPrefs({ scheduledTasksEnabled: body?.enabled === true });
    await scheduler.tick();
    return { ...scheduler.status(), tasks: await scheduler.list() };
  });

  route("POST", "/api/schedule/tasks", async ({ body }) => scheduler.create(body));
  route("GET", "/api/schedule/tasks/([^/]+)", async ({ params }) => scheduler.view(scheduler.task(params[0]), { runs: true }));
  route("PUT", "/api/schedule/tasks/([^/]+)", async ({ params, body }) => scheduler.update(params[0], body));
  route("DELETE", "/api/schedule/tasks/([^/]+)", async ({ params }) => scheduler.remove(params[0]));

  route("POST", "/api/schedule/tasks/([^/]+)/run", async ({ params }) => scheduler.runNow(params[0]));
  route("POST", "/api/schedule/tasks/([^/]+)/stop", async ({ params }) => {
    scheduler.stopRun(params[0]);
    return scheduler.view(scheduler.task(params[0]), { runs: true });
  });
  route("POST", "/api/schedule/tasks/([^/]+)/pause", async ({ params }) => scheduler.setPaused(params[0], true));
  route("POST", "/api/schedule/tasks/([^/]+)/resume", async ({ params }) => scheduler.setPaused(params[0], false));
}
