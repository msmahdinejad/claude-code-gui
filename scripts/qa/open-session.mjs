// QA helper: open the session whose title matches --match (env SESSION_MATCH) and wait for render.
export default async function (page, tools) {
  const match = process.env.SESSION_MATCH || "";
  await page.waitForSelector(".sb-item", { timeout: 15000 });
  const clicked = await page.evaluate((needle) => {
    const row = [...document.querySelectorAll(".sb-item")].find((el) => el.textContent.includes(needle));
    row?.click();
    return Boolean(row);
  }, match);
  await tools.sleep(1500);
  return { clicked, items: await page.evaluate(() => document.querySelectorAll(".msg").length) };
}
