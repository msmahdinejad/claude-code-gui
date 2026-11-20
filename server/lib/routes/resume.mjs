// Continue sessions that were working when Wheelhouse stopped (see ../resume.mjs). Automatic continue is off by default.
import { InterruptedSessions } from "../resume.mjs";

export default function register({ route, config, manager, store, session, join, HttpError }) {
  const tracker = new InterruptedSessions({
    dir: join(config.dataDir, "resume"),
    manager,
    enabled: () => store.data.prefs.resumeInterrupted === true,
    // A scheduled run is unattended and has its own rules (limits, stall guard): never continue it from here.
    skip: (id, meta) => Boolean(meta?.scheduledTaskId || store.sessionMeta(id)?.scheduledTaskId),
    open: (id, cwd) => session(id, { create: true, cwd }),
  });
  tracker.start();

  // The server closes every session on shutdown: record what was working first (a profile switch is a deliberate stop).
  const closeAll = manager.closeAll.bind(manager);
  manager.closeAll = () => {
    tracker.freeze();
    return closeAll();
  };
  const closeSessions = manager.closeSessions.bind(manager);
  manager.closeSessions = () => {
    tracker.clear();
    return closeSessions();
  };

  const ids = (body) => {
    if (body?.ids === undefined) return null;
    if (!Array.isArray(body.ids) || body.ids.length > 20 || body.ids.some((id) => typeof id !== "string")) throw new HttpError(400, "ids must be a list of session ids");
    return body.ids;
  };

  route("GET", "/api/resume", async () => tracker.status());
  // Continue them now. Answers after a moment with what is known; the page polls GET /api/resume for the rest.
  route("POST", "/api/resume/run", async ({ body }) => {
    const started = tracker.resume(ids(body)).catch(() => null);
    await Promise.race([started, new Promise((resolve) => setTimeout(resolve, 1500))]);
    return tracker.status();
  });
  route("POST", "/api/resume/dismiss", async ({ body }) => tracker.dismiss(ids(body) || undefined));
}
