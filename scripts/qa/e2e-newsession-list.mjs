// QA: a session started with its first message must show up in the sidebar list by itself (no manual refresh).
// Uses a real model (haiku, one tiny prompt). SERVER_CWD = an existing empty folder to work in.
//   SERVER_CWD=<dir> node scripts/browse.mjs --url http://127.0.0.1:4199 --script scripts/qa/e2e-newsession-list.mjs
export default async function (page, tools) {
  const cwd = process.env.SERVER_CWD;
  const before = await page.evaluate(async (cwd) => {
    const { newSession, sendMessage } = await import("/js/session.js");
    const { app } = await import("/js/core/state.js");
    const conv = await newSession({ cwd, meta: { model: "haiku", permissionMode: "default", scratch: false } });
    app.currentId = conv.id;
    window.__newId = conv.id;
    const listedBefore = app.sessions.some((s) => s.id === conv.id);
    await sendMessage("Reply with exactly: ok");
    return { listedBefore };
  }, cwd);
  await tools.sleep(6000); // no refresh by hand: the list has to update on its own
  const result = await page.evaluate(async () => {
    const { app } = await import("/js/core/state.js");
    const entry = app.sessions.find((s) => s.id === window.__newId);
    return { listed: Boolean(entry), title: entry?.title || null, inSidebar: [...document.querySelectorAll(".sb-list, .sidebar, aside")].some((el) => el.textContent.includes(entry?.title || "\u0000")) };
  });
  await page.evaluate(async () => { const { api } = await import("/js/core/api.js"); await api.deleteSession(window.__newId, undefined).catch(() => {}); });
  return { ...before, ...result };
}
