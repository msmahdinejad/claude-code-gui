import test, { after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginFlows } from "../server/lib/login.mjs";

// A stand-in for `claude auth login`: prints a link, waits for a code on stdin, accepts exactly one.
const dir = mkdtempSync(join(tmpdir(), "wheelhouse-login-"));
const fake = join(dir, "fake-cli.mjs");
writeFileSync(fake, `
if (process.argv.slice(2).join(" ") !== "auth login") { console.error("unexpected arguments"); process.exit(2); }
console.log("Opening browser to sign in…");
console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=abc&x=1");
process.stdout.write("Paste code here if prompted > ");
process.stdin.on("data", (data) => {
  const code = String(data).trim();
  if (code === "good-code") { console.log("Login successful."); process.exit(0); }
  if (code === "retry-code") { process.stdout.write("Invalid code. Please make sure the full code was copied.\\n"); return; }
  console.error("Invalid code"); process.exit(1);
});
setTimeout(() => {}, 60000);
`);

const make = (extra = {}) => new LoginFlows({
  resolve: (name) => (name === "broken" ? { problem: "Command not found on PATH: nope" } : name === "bundled" ? { path: null } : { path: process.execPath, args: [fake], env: process.env }),
  ...extra,
});
const flowsToClean = [];
after(() => flowsToClean.forEach((flows) => flows.closeAll()));

/** Wait until the flow shows a sign-in link. */
async function waitForUrl(flows, id) {
  for (let i = 0; i < 100; i += 1) {
    const view = flows.get(id);
    if (view.url) return view;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no sign-in link appeared");
}

test("a sign-in shows the link, takes the pasted code and finishes", async () => {
  const flows = make();
  flowsToClean.push(flows);
  const started = flows.start("work");
  assert.equal(started.state, "starting");
  const waiting = await waitForUrl(flows, started.id);
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.url, "https://claude.com/cai/oauth/authorize?state=abc&x=1");
  const done = once(flows, "done");
  flows.submitCode(started.id, " good-code \n");
  await done;
  assert.equal(flows.get(started.id).state, "done");
  assert.equal(flows.get(started.id).error, null);
});

test("a code the CLI rejects but asks again for is reported as a note while it keeps waiting", async () => {
  const flows = make();
  flowsToClean.push(flows);
  const { id } = flows.start("work");
  await waitForUrl(flows, id);
  assert.equal(flows.get(id).note, "");
  flows.submitCode(id, "retry-code");
  for (let i = 0; i < 100 && !flows.get(id).note; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(flows.get(id).state, "waiting");
  assert.match(flows.get(id).note, /Invalid code/);
  flows.cancel(id);
});

test("a wrong code fails with the CLI's message; the view never carries the code", async () => {
  const flows = make();
  flowsToClean.push(flows);
  const { id } = flows.start("work");
  await waitForUrl(flows, id);
  const failed = once(flows, "failed");
  flows.submitCode(id, "bad-code");
  await failed;
  const view = flows.get(id);
  assert.equal(view.state, "failed");
  assert.match(view.error, /Invalid code/);
  assert.doesNotMatch(JSON.stringify(view), /bad-code/);
});

test("cancelling stops the process; starting again replaces a running sign-in", async () => {
  const flows = make();
  flowsToClean.push(flows);
  const first = flows.start("work");
  await waitForUrl(flows, first.id);
  const second = flows.start("work");
  assert.equal(flows.get(first.id).state, "cancelled");
  await waitForUrl(flows, second.id);
  assert.equal(flows.cancel(second.id).state, "cancelled");
  assert.throws(() => flows.submitCode(second.id, "good-code"), /no longer running/);
});

test("codes are validated; unusable profiles are refused up front", () => {
  const flows = make();
  flowsToClean.push(flows);
  const { id } = flows.start("work");
  assert.throws(() => flows.submitCode(id, "   "), /does not look like/);
  assert.throws(() => flows.submitCode(id, "a\nb"), /does not look like/);
  assert.throws(() => flows.submitCode(id, "x".repeat(5000)), /does not look like/);
  assert.throws(() => flows.start("broken"), /Command not found/);
  assert.throws(() => flows.start("bundled"), /bundled with the SDK/);
  assert.equal(flows.get("nope"), null);
});

test("a sign-in that takes too long is stopped", async () => {
  const flows = make({ timeoutMs: 300 });
  flowsToClean.push(flows);
  const { id } = flows.start("work");
  await once(flows, "failed");
  assert.match(flows.get(id).error, /Timed out/);
});
