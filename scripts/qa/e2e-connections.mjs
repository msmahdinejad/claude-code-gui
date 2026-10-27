// QA: a page that has opened many conversations must still be able to make ordinary requests (a browser allows
// only 6 simultaneous connections per site; open event streams must not use them all).
//   node scripts/browse.mjs --url http://127.0.0.1:4198 --script scripts/qa/e2e-connections.mjs
export default async function (page) {
  return page.evaluate(async () => {
    const { newSession, openSession } = await import("/js/session.js");
    const { app } = await import("/js/core/state.js");
    const cwd = app.config.defaultCwd;
    const ids = [];
    for (let i = 0; i < 8; i += 1) ids.push((await newSession({ cwd, meta: { scratch: false } })).id);
    for (const id of ids.slice(0, 4)) await openSession(id, { cwd }); // go back and forth between conversations
    const probe = async (path) => {
      const started = performance.now();
      const result = await Promise.race([
        fetch(path).then((r) => r.status),
        new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 6000)),
      ]);
      return `${result} in ${Math.round(performance.now() - started)}ms`;
    };
    return {
      conversationsOpened: app.convs.size,
      health: await probe("/api/health"),
      settings: await probe(`/api/settings?scope=user&cwd=${encodeURIComponent(cwd)}`),
      envInfo: await probe("/api/env-info"),
    };
  });
}
