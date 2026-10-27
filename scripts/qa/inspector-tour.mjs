// Opens every inspector tab and settings section; screenshots + error report.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export default async function (page, tools) {
  const dir = process.env.TOUR_DIR || ".";
  const name = process.env.TOUR_NAME || "insp";
  mkdirSync(dir, { recursive: true });
  const report = { tabs: [], sections: [] };
  await page.evaluate(async () => {
    const { toggleInspector } = await import("/js/ui/inspector.js");
    toggleInspector(true);
  });
  await tools.sleep(800);
  const tabs = await page.evaluate(() => [...document.querySelectorAll(".insp-tab")].map((el) => el.textContent.trim()));
  for (let i = 0; i < tabs.length; i += 1) {
    await page.evaluate((n) => document.querySelectorAll(".insp-tab")[n]?.click(), i);
    await tools.sleep(1500);
    const info = await page.evaluate(() => ({ error: document.querySelector(".insp-body .banner.error")?.textContent || null, len: document.querySelector(".insp-body")?.innerText.length }));
    report.tabs.push({ tab: tabs[i], ...info });
    await page.screenshot({ path: join(dir, `${name}-tab-${i}.png`) });
  }
  await page.evaluate(() => document.querySelector(".sb-foot .icon-btn")?.click());
  await tools.sleep(600);
  const sections = await page.evaluate(() => [...document.querySelectorAll(".settings-nav button")].map((el) => el.textContent.trim()));
  for (let i = 0; i < sections.length; i += 1) {
    await page.evaluate((n) => document.querySelectorAll(".settings-nav button")[n]?.click(), i);
    await tools.sleep(1200);
    const info = await page.evaluate(() => ({ error: document.querySelector(".settings-main .banner.error")?.textContent || null, len: document.querySelector(".settings-main")?.innerText.length }));
    report.sections.push({ section: sections[i], ...info });
    await page.screenshot({ path: join(dir, `${name}-sec-${i}.png`) });
  }
  return report;
}
