// Headless Edge driver for UI QA (independent of the desktop app's Browser pane).
//   node scripts/browse.mjs --url http://127.0.0.1:4174 --shot out.png [--width 1280 --height 800]
//        [--theme light|dark] [--lang fa|en] [--eval "js expr"] [--script steps.mjs] [--wait 1500] [--full]
// A --script module default-exports async (page, tools) => any ; `tools` = { sleep, shot(path), log }.
// Console errors / page errors are printed to stderr. Output of --eval / --script is printed as JSON.
import puppeteer from "puppeteer-core";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (arg.startsWith("--")) acc.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
  return acc;
}, []));

const candidates = [
  process.env.EDGE_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", // Edge refuses automation under this machine's policy
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const executablePath = candidates.find((path) => existsSync(path));
if (!executablePath) throw new Error("No Edge/Chrome found; set EDGE_PATH");

const width = Number(args.width || 1280);
const height = Number(args.height || 800);
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const userDataDir = mkdtempSync(join(tmpdir(), "wheelhouse-edge-"));
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  userDataDir,
  pipe: true,
  args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--proxy-bypass-list=*", "--no-proxy-server", "--force-prefers-reduced-motion"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: Number(args.scale || 1) });
  if (args.theme) await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: args.theme }]);
  await page.evaluateOnNewDocument((lang, theme) => {
    try {
      if (lang) localStorage.setItem("wheelhouse-lang", lang);
      if (theme) {
        const prefs = JSON.parse(localStorage.getItem("wheelhouse-prefs") || "{}");
        prefs.theme = theme;
        localStorage.setItem("wheelhouse-prefs", JSON.stringify(prefs));
      }
    } catch { /* ignore */ }
  }, args.lang || "", args.theme || "");
  page.on("console", (msg) => { if (["error", "warning"].includes(msg.type())) console.error(`[console.${msg.type()}] ${msg.text()}`); });
  page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
  page.on("response", (response) => { if (response.status() >= 400) console.error(`[http ${response.status()}] ${response.request().method()} ${response.url()}`); });
  if (args.url) await page.goto(args.url, { waitUntil: "networkidle2", timeout: 60_000 });
  await new Promise((r) => setTimeout(r, Number(args.wait || 1200)));
  const tools = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    shot: (path, options = {}) => page.screenshot({ path, ...options }),
    log: (...items) => console.error("[log]", ...items),
  };
  let result;
  if (args.eval && args.eval !== true) result = await page.evaluate(`(async () => (${args.eval}))()`);
  if (args.script) {
    const module = await import(pathToFileURL(resolve(args.script)).href);
    result = await module.default(page, tools);
  }
  if (args.shot) await page.screenshot({ path: args.shot, fullPage: Boolean(args.full) });
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
