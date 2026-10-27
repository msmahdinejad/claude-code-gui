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

const SIZES = [16, 24, 32, 48, 64, 128, 180, 192, 256, 512];
const png = {};
const rgba = {}; // raw pixels, for the bitmap images inside the ICO
const browser = await puppeteer.launch({ executablePath, headless: true, pipe: true });
try {
  const page = await browser.newPage();
  for (const size of SIZES) {
    await page.setViewport({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    png[size] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
  // Pixels of the small sizes via a canvas (the shell reads those as plain bitmaps, see below).
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  for (const [size, pixels] of Object.entries(await page.evaluate(async (url, sizes) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const out = {};
    for (const size of sizes) {
      const canvas = new OffscreenCanvas(size, size);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, size, size);
      out[size] = btoa(String.fromCharCode(...context.getImageData(0, 0, size, size).data));
    }
    return out;
  }, dataUrl, [16, 24, 32, 48, 64]))) rgba[size] = Buffer.from(pixels, "base64");
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

// ICO as Windows wants it: classic 32-bit bitmap (DIB) images for the small sizes and a PNG only for 256x256.
// PNG-compressed small images look fine in browsers but the shell (shortcuts, taskbar) then shows a blank page.
function dib(size) {
  const pixels = rgba[size];
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // height counts the AND mask too
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const colors = Buffer.alloc(size * size * 4); // BGRA, bottom-up
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = ((size - 1 - y) * size + x) * 4;
      const to = (y * size + x) * 4;
      colors[to] = pixels[from + 2];
      colors[to + 1] = pixels[from + 1];
      colors[to + 2] = pixels[from];
      colors[to + 3] = pixels[from + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, colors, Buffer.alloc(maskRow * size)]); // all-zero mask: alpha channel decides
}
const icoSizes = [16, 24, 32, 48, 64, 256];
const icoImages = icoSizes.map((size) => (size === 256 ? png[256] : dib(size)));
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
  header.writeUInt32LE(icoImages[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += icoImages[i].length;
});
const ico = Buffer.concat([header, ...icoImages]);
out("web/favicon.ico", ico); // browsers
out("web/wheelhouse.ico", ico); // Windows shortcuts / taskbar (its own name: the shell caches icons per file path)
console.log("wrote web/icons/*.png, web/favicon.ico, web/wheelhouse.ico, server/tray/icon.png");
