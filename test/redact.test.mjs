import test from "node:test";
import assert from "node:assert/strict";
import { MASK, maskArgs, maskMap, redactUrl } from "../server/lib/redact.mjs";
import { maskMcpText, restoreMasked } from "../server/lib/routes/ext.mjs";

test("URLs lose credentials, query values and token-like path parts", () => {
  assert.equal(redactUrl("https://user:pw@gw.example.com/v1?key=abc&team=x"), `https://${MASK}@gw.example.com/v1?key=${MASK}&team=${MASK}`);
  assert.equal(redactUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080/");
  assert.equal(redactUrl("https://gw.example.com/k/sk-ant-abcdefghijklmnop/v1"), `https://gw.example.com/k/${MASK}/v1`);
  assert.equal(redactUrl("not a url"), "(set)");
});

test("server args, env and headers are masked", () => {
  assert.deepEqual(
    maskArgs(["-y", "@scope/server", "--api-key", "abc", "--token=xyz", "--port", "3000", "-H", "Authorization: Bearer t", "API_TOKEN=1", "https://h.example/?k=v", "ghp_abcdefghijklmnopqrstuv"]),
    ["-y", "@scope/server", "--api-key", MASK, `--token=${MASK}`, "--port", "3000", "-H", `Authorization: ${MASK}`, `API_TOKEN=${MASK}`, `https://h.example/?k=${MASK}`, MASK],
  );
  assert.deepEqual(maskMap({ API_KEY: "s", DEBUG: "1" }), { API_KEY: MASK, DEBUG: "1" });
});

test("the .mcp.json editor text is masked and the real values come back on save", () => {
  const original = { mcpServers: { a: { command: "npx", args: ["srv", "--token", "secret-1"], env: { API_KEY: "secret-2", MODE: "x" } }, b: { type: "http", url: "https://h.example/mcp?key=secret-3", headers: { Authorization: "Bearer secret-4" } } } };
  const text = JSON.stringify(original, null, 4);
  const masked = maskMcpText(text, original);
  for (const secret of ["secret-1", "secret-2", "secret-3", "secret-4"]) assert.ok(!masked.includes(secret), secret);
  assert.match(masked, /^\{\n {4}"mcpServers"/, "the file's own layout is kept");
  const edited = JSON.parse(masked);
  edited.mcpServers.a.env.MODE = "y";
  edited.mcpServers.c = { command: "node", args: ["x.js"] };
  const saved = restoreMasked(edited, original);
  assert.deepEqual(saved.mcpServers.a.args, ["srv", "--token", "secret-1"]);
  assert.equal(saved.mcpServers.a.env.API_KEY, "secret-2");
  assert.equal(saved.mcpServers.a.env.MODE, "y");
  assert.equal(saved.mcpServers.b.url, "https://h.example/mcp?key=secret-3");
  assert.equal(saved.mcpServers.b.headers.Authorization, "Bearer secret-4");
  edited.mcpServers.c.env = { NEW_KEY: MASK };
  assert.throws(() => restoreMasked(edited, original), /hidden value/);
});
