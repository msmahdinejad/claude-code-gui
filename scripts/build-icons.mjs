// Renders web/icon.svg into every raster icon the app needs: web/icons/*.png (favicon, manifest, apple-touch),
// web/favicon.ico (window / taskbar / shortcut icon, 16-256 px) and server/tray/icon.png.
//   node scripts/build-icons.mjs
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512];
const png = {};
const browser = await puppeteer.launch({ executablePath, headless: true, pipe: true });
try {
  const page = await browser.newPage();
  for (const size of SIZES) {
    await page.setViewport({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    png[size] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
} finally {
  await browser.close();
}

mkdirSync(join(root, "web", "icons"), { recursive: true });
const out = (path, data) => writeFileSync(join(root, path), data);
out("web/icons/icon-32.png", png[32]);
out("web/icons/icon-192.png", png[192]);
out("web/icons/icon-512.png", png[512]);
out("web/icons/apple-touch-icon.png", png[180]);
out("server/tray/icon.png", png[128]);

// ICO with PNG-compressed images (Windows Vista and later, every browser).
const icoSizes = [16, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6 + 16 * icoSizes.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(icoSizes.length, 4);
let offset = header.length;
icoSizes.forEach((size, i) => {
  const entry = 6 + i * 16;
  header.writeUInt8(size === 256 ? 0 : size, entry); // width (0 = 256)
  header.writeUInt8(size === 256 ? 0 : size, entry + 1); // height
  header.writeUInt16LE(1, entry + 4); // color planes
  header.writeUInt16LE(32, entry + 6); // bits per pixel
  header.writeUInt32LE(png[size].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png[size].length;
});
out("web/favicon.ico", Buffer.concat([header, ...icoSizes.map((size) => png[size])]));
console.log("wrote web/icons/*.png, web/favicon.ico, server/tray/icon.png");
