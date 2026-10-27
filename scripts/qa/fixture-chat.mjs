// Renders a synthetic conversation (no model call) to review typography, RTL/LTR and cards.
// env: TOUR_DIR, TOUR_NAME
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installFixture } from "./fixture-lib.mjs";

export default async function (page, tools) {
  const dir = process.env.TOUR_DIR || ".";
  const name = process.env.TOUR_NAME || "fixture";
  mkdirSync(dir, { recursive: true });

  await installFixture(page);
  await tools.sleep(900);
  await page.screenshot({ path: join(dir, `${name}-chat-top.png`) });
  await page.evaluate(() => { document.querySelector(".chat-scroll").scrollTop = 0; });
  await tools.sleep(300);
  await page.screenshot({ path: join(dir, `${name}-chat-start.png`) });

  // open all tool cards to inspect their bodies
  await page.evaluate(() => document.querySelectorAll(".tool-head").forEach((b) => b.closest(".tool").classList.contains("open") || b.click()));
  await tools.sleep(400);
  await page.screenshot({ path: join(dir, `${name}-tools-open.png`), fullPage: false });

  // swap the permission card for the question and plan cards
  for (const [label, request] of [
    ["question", { id: "r2", kind: "permission", toolName: "AskUserQuestion", toolUseID: "q1", input: { questions: [{ header: "Framework", question: "Which test framework should I use?", multiSelect: false, options: [{ label: "pytest", description: "Fixtures and plain asserts" }, { label: "unittest", description: "Standard library" }] }] } }],
    ["plan", { id: "r3", kind: "permission", toolName: "ExitPlanMode", toolUseID: "p1", input: { plan: "## برنامه\n\n1. افزودن تست برای نیم‌فاصله\n2. به‌روزرسانی `README.md`\n3. اجرای کامل تست‌ها" } }],
  ]) {
    await page.evaluate(async (req) => {
      const { app, bus } = await import("/js/core/state.js");
      const { applyMessage } = await import("/js/chat/reducer.js");
      const conv = app.convs.get("fixture");
      applyMessage(conv, { type: "wh_request_resolved", id: "r1", cancelled: true });
      for (const id of [...conv.requests.keys()]) applyMessage(conv, { type: "wh_request_resolved", id, cancelled: true });
      applyMessage(conv, { type: "wh_request", request: req });
      bus.emit("conv:update", "fixture");
      bus.emit("current");
    }, request);
    await tools.sleep(700);
    await page.screenshot({ path: join(dir, `${name}-card-${label}.png`) });
  }
  return { ok: true };
}
