import test from "node:test";
import assert from "node:assert/strict";
import { deriveTitle } from "../server/lib/title.mjs";
import { cleanTitle } from "../server/lib/titler.mjs";

test("model replies are cleaned into plain titles", () => {
  assert.equal(cleanTitle('"Refactor auth middleware."'), "Refactor auth middleware");
  assert.equal(cleanTitle("Title: Fix login bug\nExtra explanation"), "Fix login bug");
  assert.equal(cleanTitle("عنوان گفتگو: پایتخت ایران و تاریخچه‌اش"), "پایتخت ایران و تاریخچه‌اش");
  assert.equal(cleanTitle("**Add dark mode**"), "Add dark mode");
  assert.equal(cleanTitle(""), "");
  assert.equal(cleanTitle("x".repeat(200)), "");
});

test("short prompts are kept as they are", () => {
  assert.equal(deriveTitle("Fix the login bug"), "Fix the login bug");
  assert.equal(deriveTitle("پایتخت ایران؟"), "پایتخت ایران؟");
});

test("long prompts are cut at a word boundary with an ellipsis", () => {
  const title = deriveTitle("Please refactor the authentication middleware so that it validates the token signature before touching the database and add tests");
  assert.ok(title.length <= 49, title);
  assert.ok(title.endsWith("…"));
  assert.ok(title.startsWith("refactor the authentication"));
});

test("greetings, politeness, code blocks and links are dropped", () => {
  assert.equal(deriveTitle("سلام، لطفا README رو فارسی کن"), "README رو فارسی کن");
  assert.equal(deriveTitle("```js\nconsole.log(1)\n```\nWhy does this print twice?"), "Why does this print twice?");
  assert.equal(deriveTitle("see https://example.com/a/very/long/path and summarise it"), "see and summarise it");
});

test("uses the first line or sentence of a multi-line prompt", () => {
  assert.equal(deriveTitle("Add dark mode toggle. Then update the docs and the changelog and release it."), "Add dark mode toggle");
  assert.equal(deriveTitle("## Task\nImplement retry with backoff\n\nDetails below"), "Task");
});

test("empty or markup-only input gives an empty title", () => {
  assert.equal(deriveTitle(""), "");
  assert.equal(deriveTitle(undefined), "");
  assert.equal(deriveTitle("```\ncode only\n```"), "");
});
