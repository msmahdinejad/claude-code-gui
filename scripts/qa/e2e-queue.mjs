// Queue-while-busy behaviour, with the state printed so timing problems are visible.
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok: Boolean(ok), extra }); console.error(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); };

export default async function (page, tools) {
  await page.focus(".cmp-input");
  await page.keyboard.type("Write a 300-word essay about the history of printing.");
  await page.keyboard.press("Enter");
  let state = "";
  for (let i = 0; i < 60 && state !== "running"; i += 1) {
    await tools.sleep(250);
    state = await page.evaluate(async () => (await import("/js/core/state.js")).app.convs.get((await import("/js/core/state.js")).app.currentId).state);
  }
  check("first message is running", state === "running", state);
  await page.focus(".cmp-input");
  await page.keyboard.type("then say DONE2");
  await page.keyboard.press("Enter");
  await tools.sleep(400);
  const queued = (await page.$$(".queue-item")).length;
  const now = await page.evaluate(async () => (await import("/js/core/state.js")).app.convs.get((await import("/js/core/state.js")).app.currentId).state);
  check("second message waits in the queue", queued === 1, `queued=${queued} state=${now}`);
  await page.keyboard.press("Escape");
  await tools.sleep(1500);
  let delivered = false;
  for (let i = 0; i < 60 && !delivered; i += 1) {
    delivered = await page.evaluate(async () => {
      const { app } = await import("/js/core/state.js");
      return app.convs.get(app.currentId).items.some((item) => item.kind === "user" && /DONE2/.test(item.text));
    });
    await tools.sleep(500);
  }
  check("queued message is sent after the interrupt", delivered);
  return results;
}
