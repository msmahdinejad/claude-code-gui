// Rebuilds web/vendor/xterm.js (+ xterm.css): the terminal emulator for the Terminal tab's PTY mode.
// Run: npm run build:xterm   (bundles @xterm/xterm and @xterm/addon-fit; the CSS is copied as a plain file because
// the CSP of the page has no place for it other than a same-origin stylesheet.)
import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  stdin: {
    contents: 'export { Terminal } from "@xterm/xterm";\nexport { FitAddon } from "@xterm/addon-fit";\n',
    resolveDir: root,
    sourcefile: "xterm-entry.mjs",
  },
  outfile: join(root, "web/vendor/xterm.js"),
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
  legalComments: "none",
  logLevel: "info",
});
await copyFile(join(root, "node_modules/@xterm/xterm/css/xterm.css"), join(root, "web/vendor/xterm.css"));
