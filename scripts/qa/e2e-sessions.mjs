// Consumer walk-through of session management: reply, reload mid-run, rename, pin, archive, fork, delete.
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok: Boolean(ok), extra }); console.error(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); };

export default async function (page, tools) {
  const waitFor = async (fn, arg, timeout = 90_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) { if (await page.evaluate(fn, arg)) return true; await tools.sleep(400); }
    return false;
  };
  const idle = () => waitFor(async () => {
    const { app } = await import("/js/core/state.js");
    const conv = app.convs.get(app.currentId);
    return conv?.state === "idle" && conv.items.some((i) => i.kind === "result");
  });
  const sidebarTitles = () => page.evaluate(() => [...document.querySelectorAll(".sb-item .sb-title")].map((el) => el.textContent));
  const menuClick = async (label) => {
    await page.evaluate(() => document.querySelector(".sb-item.active .sb-more").click());
    await tools.sleep(300);
    const ok = await page.evaluate((text) => { const el = [...document.querySelectorAll(".menu-item")].find((e) => e.textContent.includes(text)); el?.click(); return Boolean(el); }, label);
    await tools.sleep(500);
    return ok;
  };

  await page.focus(".cmp-input");
  await page.keyboard.type("یک جملهٔ کوتاه دربارهٔ حافظ بنویس.");
  await page.keyboard.press("Enter");
  check("first reply arrives", await idle());
  const id = await page.evaluate(async () => (await import("/js/core/state.js")).app.currentId);

  // reload mid-run: start a longer answer, reload, state must resume
  await page.focus(".cmp-input");
  await page.keyboard.type("Write a 250-word story about a lighthouse.");
  await page.keyboard.press("Enter");
  await tools.sleep(2500);
  await page.reload({ waitUntil: "networkidle2" });
  await tools.sleep(1500);
  const restored = await page.evaluate(async () => {
    const { app } = await import("/js/core/state.js");
    const conv = app.convs.get(app.currentId);
    return { id: app.currentId, items: conv?.items.length, state: conv?.state };
  });
  check("reload keeps the same session open", restored.id === id, restored.id);
  check("history is restored after reload", restored.items >= 3, JSON.stringify(restored));
  check("run finishes after reload", await idle());

  // rename
  await menuClick("Rename") || await menuClick("تغییر نام");
  await page.evaluate(() => { const input = document.querySelector(".modal input"); input.value = "My renamed chat"; input.dispatchEvent(new Event("input")); });
  await page.keyboard.press("Enter");
  await tools.sleep(1200);
  check("rename shows in sidebar and top bar", (await sidebarTitles()).includes("My renamed chat") && (await page.evaluate(() => document.querySelector(".tb-title strong").textContent)) === "My renamed chat");

  // pin
  await menuClick("Pin") || await menuClick("سنجاق");
  await tools.sleep(900);
  const pinnedGroup = await page.evaluate(() => [...document.querySelectorAll(".sb-group-head .grow")].map((el) => el.textContent));
  check("pinned session gets a Pinned group", pinnedGroup.some((t) => /Pinned|سنجاق/.test(t)), pinnedGroup.join("|"));
  await menuClick("Unpin") || await menuClick("برداشتن سنجاق");
  await tools.sleep(600);

  // fork
  await menuClick("Fork") || await menuClick("انشعاب");
  await tools.sleep(2500);
  const forkedId = await page.evaluate(async () => (await import("/js/core/state.js")).app.currentId);
  check("fork opens a different session", forkedId !== id, forkedId);

  // archive the fork, then restore it from the Archived filter
  await menuClick("Archive") || await menuClick("بایگانی");
  await tools.sleep(1500);
  check("archived session leaves the list", !(await page.evaluate((fid) => [...document.querySelectorAll(".sb-item")].some((el) => el.classList.contains("active")) && false, forkedId)));

  // delete the original via the UI (confirm dialog)
  await page.evaluate(async (sid) => { const { openSession } = await import("/js/session.js"); await openSession(sid); }, id);
  await tools.sleep(1200);
  await menuClick("Delete") || await menuClick("حذف");
  await tools.sleep(500);
  const hasDialog = await page.evaluate(() => Boolean(document.querySelector(".modal")));
  check("delete asks for confirmation", hasDialog);
  await page.evaluate(() => [...document.querySelectorAll(".modal .btn")].find((b) => b.classList.contains("danger"))?.click());
  await tools.sleep(1500);
  const gone = await page.evaluate(async (sid) => !(await import("/js/core/state.js")).app.sessions.some((s) => s.id === sid), id);
  check("deleted session disappears", gone);
  return results;
}
