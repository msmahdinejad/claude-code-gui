// Rebuilds web/vendor/md.js. Run: node scripts/build-vendor.mjs
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [join(root, "scripts/vendor-entry.mjs")],
  outfile: join(root, "web/vendor/md.js"),
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
  legalComments: "none",
  logLevel: "info",
});
