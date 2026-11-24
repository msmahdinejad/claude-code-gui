// Copies the browser builds of Mermaid and Chart.js from node_modules into web/vendor/. Run: node scripts/build-mermaid.mjs
//   web/vendor/mermaid/mermaid.esm.min.mjs + chunks/mermaid.esm.min/*.mjs   (loaded lazily, as ES modules, by the Artifacts pane)
//   web/vendor/chart.umd.js                                                 (offered to HTML artifacts as /vendor/chart.umd.js)
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "node_modules", "mermaid", "dist");
const out = join(root, "web", "vendor", "mermaid");
const chunkDir = join("chunks", "mermaid.esm.min");

await rm(out, { recursive: true, force: true });
await mkdir(join(out, chunkDir), { recursive: true });
await copyFile(join(dist, "mermaid.esm.min.mjs"), join(out, "mermaid.esm.min.mjs"));
let count = 0;
for (const name of await readdir(join(dist, chunkDir))) {
  if (!name.endsWith(".mjs")) continue; // no source maps
  await copyFile(join(dist, chunkDir, name), join(out, chunkDir, name));
  count += 1;
}

const chartDir = join(root, "node_modules", "chart.js", "dist");
const chart = existsSync(join(chartDir, "chart.umd.min.js")) ? "chart.umd.min.js" : "chart.umd.js";
await copyFile(join(chartDir, chart), join(root, "web", "vendor", "chart.umd.js"));
console.log(`mermaid: entry + ${count} chunks -> web/vendor/mermaid; chart.js (${chart}) -> web/vendor/chart.umd.js`);
