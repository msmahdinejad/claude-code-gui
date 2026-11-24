import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../server/lib/routes/learning.mjs";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wh-learning-"));
  const routes = [];
  register({ route: (method, pattern, fn) => routes.push({ method, pattern: new RegExp(`^${pattern}$`), fn }), HttpError, cfiles: { configDir: () => dir } });
  const call = (method, url, body) => {
    for (const r of routes) {
      const m = r.method === method && r.pattern.exec(url);
      if (m) return r.fn({ params: m.slice(1), body });
    }
    throw new Error(`no route ${method} ${url}`);
  };
  return { dir, call, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("learning: empty profile reports nothing present", async () => {
  const { call, done } = setup();
  try {
    const out = await call("GET", "/api/learning");
    assert.equal(out.present, false);
    assert.deepEqual(out.inbox, []);
    assert.deepEqual(out.hooks, []);
  } finally { done(); }
});

test("learning: inbox, learned skills, usage and status changes", async () => {
  const { dir, call, done } = setup();
  try {
    mkdirSync(join(dir, "learning", "garden"), { recursive: true });
    mkdirSync(join(dir, "skills", "learned-demo"), { recursive: true });
    mkdirSync(join(dir, "skills", "plain"), { recursive: true });
    writeFileSync(join(dir, "skills", "learned-demo", "SKILL.md"), "---\nname: learned-demo\ndescription: Demo\nmetadata:\n  origin: learned\n  updated: 2026-11-01\n---\nbody");
    writeFileSync(join(dir, "skills", "plain", "SKILL.md"), "---\nname: plain\ndescription: Mentions origin: learned in text only\n---\norigin: learned");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node learn-hook.mjs stop" }] }] } }));
    writeFileSync(join(dir, "learning", "inbox.jsonl"), [
      JSON.stringify({ id: "a1", ts: new Date().toISOString(), type: "correction", status: "pending", cwd: "D:/x/proj", text: "fix it" }),
      "not json",
      JSON.stringify({ id: "b2", ts: new Date().toISOString(), type: "explicit", status: "applied-by-session", text: "remember" }),
    ].join("\n"));
    writeFileSync(join(dir, "learning", "skill-usage.jsonl"), [
      JSON.stringify({ ts: new Date().toISOString(), skill: "learned-demo", failed: false }),
      JSON.stringify({ ts: new Date().toISOString(), skill: "learned-demo", failed: true }),
      JSON.stringify({ ts: "2020-01-01T00:00:00Z", skill: "plain" }),
    ].join("\n"));
    writeFileSync(join(dir, "learning", "garden", "2026-11-22.md"), "# report");

    const out = await call("GET", "/api/learning");
    assert.equal(out.present, true);
    assert.deepEqual(out.hooks, ["Stop"]);
    assert.equal(out.inbox.length, 2);
    assert.equal(out.counts.pending, 1);
    assert.equal(out.inbox.find((i) => i.id === "a1").project, "proj");
    assert.deepEqual(out.skills.map((s) => [s.name, s.learned, s.uses, s.failed]), [["learned-demo", true, 2, 1]]);
    assert.deepEqual(out.reports, ["2026-11-22.md"]);

    await call("POST", "/api/learning/inbox/a1", { status: "skipped" });
    assert.match(readFileSync(join(dir, "learning", "inbox.jsonl"), "utf8"), /"id":"a1"[^\n]*"status":"skipped"/);
    assert.match(readFileSync(join(dir, "learning", "inbox.jsonl"), "utf8"), /not json/);
    await assert.rejects(() => call("POST", "/api/learning/inbox/a1", { status: "deleted" }), /Unknown status/);
    await assert.rejects(() => call("POST", "/api/learning/inbox/zz", { status: "pending" }), /No such item/);

    assert.equal((await call("GET", "/api/learning/report/2026-11-22.md")).text, "# report");
    assert.throws(() => call("GET", "/api/learning/report/../settings.json"), /no route/);
  } finally { done(); }
});
