// Renders web/icon.svg to server/tray/icon.png (transparent, 128x128) for the tray icon.
//   node scripts/build-tray-icon.mjs
import puppeteer from "puppeteer-core";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "web", "icon.svg"), "utf8");
const executablePath = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((path) => path && existsSync(path));
if (!executablePath) throw new Error("No Chrome found; set CHROME_PATH");

const browser = await puppeteer.launch({ executablePath, headless: true, pipe: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 128, height: 128 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:128px;height:128px}</style>${svg}`);
  await page.screenshot({ path: join(root, "server", "tray", "icon.png"), omitBackground: true, clip: { x: 0, y: 0, width: 128, height: 128 } });
  console.log("wrote server/tray/icon.png");
} finally {
  await browser.close();
}
