import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register, { readHistory } from "../server/lib/routes/history.mjs";

const dir = mkdtempSync(join(tmpdir(), "wh-history-"));
const file = join(dir, "history.jsonl");
const row = (display, project, timestamp, extra = {}) => JSON.stringify({ display, pastedContents: {}, timestamp, project, sessionId: "s1", ...extra });
const APP = "C:\\Work\\App"; // as Claude Code writes a Windows folder

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("newest first, one folder, text filter, no repeats, malformed lines skipped", async () => {
  writeFileSync(file, [
    row("first", APP, 1),
    "{ not json",
    row("fix the login bug", APP, 2),
    row("other project prompt", "D:\\Other", 3),
    "",
    row("first", APP, 4),
    JSON.stringify({ display: 42 }),
    JSON.stringify(null),
    row("   ", APP, 5),
    row("سلام دنیا", "c:/work/app/", 6),
  ].join("\n") + "\n");
  const all = await readHistory(file, {});
  assert.deepEqual(all.entries.map((entry) => entry.text), ["سلام دنیا", "first", "other project prompt", "fix the login bug"]);
  const mine = await readHistory(file, { project: APP });
  assert.deepEqual(mine.entries.map((entry) => entry.text), ["سلام دنیا", "first", "fix the login bug"]);
  const found = await readHistory(file, { q: "LOGIN" });
  assert.deepEqual(found.entries.map((entry) => entry.text), ["fix the login bug"]);
  assert.equal((await readHistory(file, { limit: 2 })).entries.length, 2);
});

test("a missing file is an empty history", async () => {
  assert.deepEqual(await readHistory(join(dir, "nope.jsonl"), {}), { entries: [], partial: false });
});

test("only the tail of a big file is read and a long prompt is cut", async () => {
  const lines = [];
  for (let i = 0; i < 2000; i += 1) lines.push(row(`prompt ${i}`, "/p", i));
  lines.push(row("x".repeat(9000), "/p", 5000));
  writeFileSync(file, lines.join("\n") + "\n");
  const result = await readHistory(file, { limit: 3, tailBytes: 20_000 });
  assert.equal(result.partial, true);
  assert.equal(result.entries.length, 3);
  assert.equal(result.entries[0].text.length, 4000);
  assert.equal(result.entries[0].truncated, true);
  assert.equal(result.entries[1].text, "prompt 1999");
  // a window that starts mid-line never yields a broken first entry
  const all = await readHistory(file, { limit: 200, tailBytes: 20_000 });
  assert.ok(all.entries.every((entry) => /^(prompt \d+|x+)$/.test(entry.text)));
  assert.ok(all.entries.length < 200 && all.entries.length > 3);
});

test("the route reads <config dir>/history.jsonl through cfiles.configDir()", async () => {
  writeFileSync(file, `${row("hello", "/p", 1)}\n`);
  const routes = [];
  register({ route: (method, pattern, handler) => routes.push({ method, pattern, handler }), cfiles: { configDir: () => dir } });
  assert.equal(routes[0].method, "GET");
  assert.equal(routes[0].pattern, "/api/history");
  const result = await routes[0].handler({ query: new URLSearchParams("project=/p&limit=5") });
  assert.deepEqual(result.entries.map((entry) => entry.text), ["hello"]);
});
