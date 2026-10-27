// Lists t("...") source strings that have no Persian translation yet.
// Usage: node scripts/extract-i18n.mjs [--all] [dir ...]   (default: every file under web/js); --fail exits 1 when something is missing
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../web/js/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const args = process.argv.slice(2);
const showAll = args.includes("--all");
const failOnMissing = args.includes("--fail");
const dirs = args.filter((arg) => !arg.startsWith("--"));

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".js")) yield full;
  }
}

// Load every dictionary (core + per-feature) the same way the app does.
const dictionary = {};
for await (const file of walk(join(root, "i18n"))) {
  const module = await import(pathToFileURL(file).href);
  Object.assign(dictionary, module.fa || module.default || {});
}

const found = new Map(); // string -> files
const pattern = /\bt\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\$]|\\.)*`)/g;
for await (const file of walk(dirs.length ? join(root, dirs[0]) : root)) {
  if (file.includes(`${join(root, "i18n")}`)) continue;
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(pattern)) {
    let text;
    try {
      text = Function(`"use strict"; return (${match[1]});`)();
    } catch {
      continue;
    }
    if (!found.has(text)) found.set(text, new Set());
    found.get(text).add(relative(root, file).replaceAll("\\", "/"));
  }
}

const missing = [...found].filter(([text]) => showAll || !(text in dictionary));
console.log(`// ${found.size} strings found, ${missing.length} ${showAll ? "listed" : "missing a Persian translation"}`);
for (const [text, files] of missing) console.log(`${JSON.stringify(text)}: "",   // ${[...files].join(", ")}`);
if (failOnMissing && missing.length) process.exit(1);
