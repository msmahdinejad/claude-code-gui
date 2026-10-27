// UI tour: screenshots of core surfaces. Output dir from env TOUR_DIR, prefix from TOUR_NAME.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export default async function (page, tools) {
  const dir = process.env.TOUR_DIR || ".";
  const name = process.env.TOUR_NAME || "tour";
  mkdirSync(dir, { recursive: true });
  const out = (label) => join(dir, `${name}-${label}.png`);
  const report = {};

  await page.evaluate(() => document.querySelector(".sb-new")?.click());
  await tools.sleep(900);
  await page.screenshot({ path: out("1-welcome") });

  await page.evaluate(() => document.querySelectorAll(".cmp-chip-btn")[1]?.click());
  await tools.sleep(500);
  await page.screenshot({ path: out("2-model-picker") });
  await page.keyboard.press("Escape");

  await page.evaluate(() => document.querySelectorAll(".cmp-chip-btn")[0]?.click());
  await tools.sleep(400);
  await page.screenshot({ path: out("3-mode-picker") });
  await page.keyboard.press("Escape");

  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  await tools.sleep(500);
  await page.screenshot({ path: out("4-palette") });
  await page.keyboard.press("Escape");

  await page.focus(".cmp-input");
  await page.keyboard.type("/");
  await tools.sleep(600);
  await page.screenshot({ path: out("5-slash") });
  report.slashItems = await page.evaluate(() => document.querySelectorAll(".ac-item").length);
  await page.keyboard.press("Escape");
  await page.evaluate(() => { document.querySelector(".cmp-input").value = ""; });

  await page.evaluate(() => document.querySelector(".sb-foot .icon-btn")?.click());
  await tools.sleep(700);
  await page.screenshot({ path: out("6-settings") });
  report.sections = await page.evaluate(() => [...document.querySelectorAll(".settings-nav button")].map((b) => b.textContent.trim()));
  for (let i = 1; i < Math.min(report.sections.length, 4); i += 1) {
    await page.evaluate((n) => document.querySelectorAll(".settings-nav button")[n]?.click(), i);
    await tools.sleep(600);
    await page.screenshot({ path: out(`7-settings-${i}`) });
  }
  await page.keyboard.press("Escape");

  await page.setViewport({ width: 420, height: 800 });
  await tools.sleep(500);
  await page.screenshot({ path: out("8-mobile") });
  return report;
}
