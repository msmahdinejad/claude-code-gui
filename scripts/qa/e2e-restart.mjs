// QA: a page that stays open across a server restart must keep showing a session's live messages.
// Needs a server already running on SERVER_PORT (started with SERVER_ARGS) and uses a real model (haiku, tiny prompts):
//   SERVER_PID=<pid> SERVER_PORT=4197 SERVER_CWD=<work dir> SERVER_ARGS="bin/wheelhouse.mjs --port 4197 --data-dir <dir>" \
//   node scripts/browse.mjs --url http://127.0.0.1:4197 --script scripts/qa/e2e-restart.mjs
import { spawn } from "node:child_process";

export default async function (page, tools) {
  const port = process.env.SERVER_PORT;
  const cwd = process.env.SERVER_CWD;
  const base = `http://127.0.0.1:${port}`;
  const pageEval = (fn, ...args) => page.evaluate(fn, ...args);
  const waitFor = async (check, ms) => {
    for (let waited = 0; waited < ms; waited += 500) {
      if (await check()) return true;
      await tools.sleep(500);
    }
    return false;
  };
  const texts = () => pageEval(async () => {
    const { app } = await import("/js/core/state.js");
    const conv = app.convs.get(app.currentId);
    return { state: conv?.state, text: (conv?.items || []).map((item) => (item.blocks || []).map((block) => block.text || "").join(" ")).join(" | ") };
  });

  // 1. a session with one exchange, followed live by this page
  const id = await pageEval(async (cwd) => {
    const { newSession, sendMessage } = await import("/js/session.js");
    const { app } = await import("/js/core/state.js");
    const conv = await newSession({ cwd, meta: { model: "haiku", permissionMode: "default" } });
    app.currentId = conv.id;
    await sendMessage("Reply with exactly: alpha");
    return conv.id;
  }, cwd);
  const first = await waitFor(async () => /alpha/i.test((await texts()).text), 40_000);

  // 2. restart the server while the page stays open
  process.kill(Number(process.env.SERVER_PID));
  await tools.sleep(2500);
  const [exe, ...args] = [process.execPath, ...process.env.SERVER_ARGS.split(" ")];
  const next = spawn(exe, args, { cwd: process.cwd(), stdio: "ignore", detached: false });
  await waitFor(async () => fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false), 20_000);
  await tools.sleep(6000); // page reconnects, sees a new boot id

  // 3. continue the same (now "old") session from the page that was open all along
  await pageEval(async () => {
    const { sendMessage } = await import("/js/session.js");
    await sendMessage("Reply with exactly: bravo");
  });
  const second = await waitFor(async () => /bravo/i.test((await texts()).text), 45_000);
  const final = await texts();

  await fetch(`${base}/api/sessions/${id}?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE", headers: { origin: base } }).catch(() => {});
  next.kill();
  return { sawFirstReply: first, sawReplyAfterRestart: second, finalState: final.state, text: final.text.slice(0, 200) };
}
