// QA: Reply (per-message button + select-to-reply) and the composer's effort menu, on the synthetic fixture
// conversation (no model call).  node scripts/browse.mjs --url <server> --script scripts/qa/e2e-reply.mjs
import { installFixture } from "./fixture-lib.mjs";

export default async function (page, tools) {
  await installFixture(page);
  await tools.sleep(800);
  const out = {};
  const composerText = () => page.evaluate(() => document.querySelector(".composer textarea")?.value ?? "");

  // 1. per-message Reply button on the last assistant message
  await page.evaluate(() => { document.querySelector(".composer textarea").value = ""; });
  await page.evaluate(() => [...document.querySelectorAll(".msg-actions button")].filter((b) => /Reply|ریپلای/.test(b.title)).at(-1)?.click());
  await tools.sleep(300);
  out.messageReply = (await composerText()).split("\n").slice(0, 3);

  // 2. select text -> floating Reply -> quote of just that selection
  await page.evaluate(() => { document.querySelector(".composer textarea").value = ""; });
  const picked = await page.evaluate(() => {
    const block = [...document.querySelectorAll(".assistant-body .markdown p")].at(-1) || document.querySelector(".assistant-body p");
    const range = document.createRange();
    range.selectNodeContents(block.firstChild || block);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    block.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return selection.toString().slice(0, 60);
  });
  await tools.sleep(400);
  out.selected = picked;
  out.popupVisible = await page.evaluate(() => Boolean(document.querySelector(".reply-pop")));
  await page.screenshot({ path: process.env.OUT_REPLY });
  await page.evaluate(() => document.querySelector(".reply-pop")?.click());
  await tools.sleep(300);
  out.selectionReply = (await composerText()).split("\n").slice(0, 2);

  // 3. effort button -> menu -> Extra high
  out.effortBefore = await page.evaluate(() => document.querySelector(".effort-btn")?.textContent.trim());
  await page.evaluate(() => document.querySelector(".effort-btn")?.click());
  await tools.sleep(400);
  out.effortMenu = await page.evaluate(() => [...document.querySelectorAll(".model-popover .picker-item .pi-title")].map((el) => el.textContent));
  await page.screenshot({ path: process.env.OUT_EFFORT });
  await page.evaluate(() => [...document.querySelectorAll(".model-popover .picker-item")].find((el) => /Extra high|خیلی زیاد/.test(el.textContent))?.click());
  await tools.sleep(600);
  out.effortAfter = await page.evaluate(() => document.querySelector(".effort-btn")?.textContent.trim());
  return out;
}
