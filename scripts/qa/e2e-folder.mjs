// New-folder sessions + defaults (Sonnet / auto / high). Real model call (tiny).
import { existsSync } from "node:fs";
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok: Boolean(ok), extra }); console.error(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); };

export default async function (page, tools) {
  const waitFor = async (fn, timeout = 90_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) { if (await page.evaluate(fn)) return true; await tools.sleep(400); }
    return false;
  };
  const chips = await page.evaluate(() => [...document.querySelectorAll(".cmp-chip-btn")].map((b) => b.innerText.trim()).concat([document.querySelector(".cmp-bar .badge")?.textContent || ""]));
  check("default model chip is Sonnet", /Sonnet/.test(chips[1]), chips.join(" | "));
  check("default permission mode is Auto", /mode-auto/.test(await page.evaluate(() => document.querySelectorAll(".cmp-chip-btn")[0].className)));
  check("default effort badge is High", /High|زیاد/.test(chips[2]) && !/خیلی/.test(chips[2]), chips[2]);
  const chip = await page.evaluate(() => document.querySelector(".welcome-project span")?.textContent);
  check("project chip says new folder", /New folder|پوشهٔ جدید/.test(chip), chip);

  await page.evaluate(() => document.querySelector(".welcome-project").click());
  await tools.sleep(400);
  const items = await page.evaluate(() => [...document.querySelectorAll(".menu-item")].map((el) => el.textContent.trim()));
  check("project menu offers choose folder + new folder", items.length >= 2, items.join(" | "));
  await page.keyboard.press("Escape");

  await page.focus(".cmp-input");
  await page.keyboard.type("Reply with exactly: ok");
  await page.keyboard.press("Enter");
  const done = await waitFor(async () => {
    const { app } = await import("/js/core/state.js");
    const conv = app.convs.get(app.currentId);
    return conv?.state === "idle" && conv.items.some((i) => i.kind === "result");
  });
  check("turn completes in auto mode", done);
  const info = await page.evaluate(async () => {
    const { app } = await import("/js/core/state.js");
    const conv = app.convs.get(app.currentId);
    const live = app.live.get(app.currentId);
    return { cwd: conv.cwd, root: app.config.workspaceRoot, model: live?.init?.model, mode: live?.init?.permissionMode, effort: live?.init?.effort };
  });
  check("session folder was created under the workspace root", info.cwd?.toLowerCase().startsWith(info.root.toLowerCase()) && info.cwd.toLowerCase() !== info.root.toLowerCase() && existsSync(info.cwd), info.cwd);
  check("session ran on Sonnet", /sonnet/i.test(info.model || ""), info.model);
  check("session ran in auto mode", info.mode === "auto", info.mode);
  check("session ran with high effort", info.effort === "high", String(info.effort));
  await tools.sleep(2000);
  const groups = await page.evaluate(() => [...document.querySelectorAll(".sb-group-head .grow")].map((el) => el.textContent));
  check("sidebar groups it under Quick sessions", groups.some((g) => /Quick sessions|بدون پروژه/.test(g)), groups.join(" | "));
  return results;
}
