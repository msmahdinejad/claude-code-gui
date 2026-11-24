// The server-side send queue of every session (see ../outbox.mjs): messages typed while Claude works or while a usage
// limit holds the session, and the automatic continue after the limit resets. Survives restarts; needs no open page.
import { Outbox } from "../outbox.mjs";

const SWEEP_MS = 30_000; // a missed event (or a profile switched back) never leaves a queue stuck for long

export default function register({ route, config, manager, store, sendTo, session, join, HttpError }) {
  const outbox = new Outbox({
    dir: join(config.dataDir, "outbox"),
    manager,
    profile: () => config.activeProfile,
    send: (id, entry) => sendTo(id, entry),
    // A scheduled run is unattended and has its own limit and stall rules: its limits are not continued from here.
    skip: (id) => Boolean(manager.get(id)?.meta?.scheduledTaskId || store.sessionMeta(id)?.scheduledTaskId),
  });
  manager.outboxView = (id) => outbox.view(id);
  manager.outbox = outbox;
  const ids = outbox.start();
  // Sessions with something waiting get their session object back (no process yet), so pages see their queue.
  for (const id of ids) {
    const box = outbox.box(id);
    if (!outbox.waiting(id) && !box?.hold && !box?.paused) continue; // only remembers a setting: nothing to show
    if (box?.cwd && (!box.profile || box.profile === config.activeProfile)) {
      try { session(id, { create: true, cwd: box.cwd }); } catch { /* shown once it is opened */ }
    }
  }
  const sweep = setInterval(() => {
    for (const id of outbox.boxes.keys()) if (outbox.waiting(id) && !outbox.timers.has(id) && !outbox.sending.has(id)) outbox.schedule(id, 0);
  }, SWEEP_MS);
  sweep.unref?.();

  // A deleted session takes its queue with it.
  const remove = manager.remove.bind(manager);
  manager.remove = (id) => {
    outbox.forget(id);
    return remove(id);
  };

  const view = (id) => ({ outbox: outbox.view(id) });
  const itemId = (value) => {
    if (!/^[0-9a-f-]{36}$/i.test(String(value))) throw new HttpError(400, "bad item id");
    return value;
  };

  route("GET", "/api/sessions/([^/]+)/outbox", async ({ params }) => view(params[0]));

  // Queue a message. It is sent right away when the session is free and no limit holds it.
  route("POST", "/api/sessions/([^/]+)/outbox", async ({ params, body }) => {
    const [id] = params;
    const images = Array.isArray(body.images) ? body.images : [];
    // The session object carries the queue to every page (its summary), so it exists from the first queued message.
    const target = session(id, { create: true, cwd: body.cwd });
    if (body.meta && typeof body.meta === "object") Object.assign(target.meta, body.meta);
    let item;
    try {
      item = outbox.add(id, { text: String(body.text || ""), images, cwd: body.cwd || manager.get(id)?.cwd });
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    return { item: { id: item.id }, ...view(id) };
  });

  route("DELETE", "/api/sessions/([^/]+)/outbox/([^/]+)", async ({ params }) => {
    const item = outbox.remove(params[0], itemId(params[1]));
    if (!item) throw new HttpError(404, "that message is no longer waiting");
    return { item, ...view(params[0]) }; // with its text and attachments, so the page can put it back in the box to edit
  });

  // Send this one now: the running turn is interrupted and the message goes first.
  route("POST", "/api/sessions/([^/]+)/outbox/([^/]+)/now", async ({ params }) => {
    const [id] = params;
    const item = outbox.take(id, itemId(params[1]));
    if (!item) throw new HttpError(404, "that message is no longer waiting");
    const live = manager.get(id);
    if (live?.alive && ["running", "requires_action"].includes(live.state)) await live.interrupt().catch(() => {});
    try {
      await sendTo(id, { text: item.text, images: item.images, cwd: outbox.box(id)?.cwd || live?.cwd });
    } catch (error) {
      outbox.add(id, { text: item.text, images: item.images, cwd: outbox.box(id)?.cwd || live?.cwd, front: true });
      throw new HttpError(500, error.message);
    }
    return view(id);
  });

  route("PUT", "/api/sessions/([^/]+)/outbox/auto", async ({ params, body }) => {
    outbox.setAuto(params[0], body.auto !== false);
    return view(params[0]);
  });

  route("POST", "/api/sessions/([^/]+)/outbox/continue", async ({ params }) => {
    outbox.continueNow(params[0]);
    return view(params[0]);
  });

  // Try again after failures, or (skipHold) send the queue now without waiting for the limit to reset.
  route("POST", "/api/sessions/([^/]+)/outbox/resume", async ({ params, body }) => {
    outbox.resume(params[0], { skipHold: Boolean(body?.skipHold) });
    return view(params[0]);
  });
}
