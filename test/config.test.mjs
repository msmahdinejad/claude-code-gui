import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProfile, interpolate, loadConfig, parseJsonc, profileEnv, resolveCommand } from "../server/lib/config.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "wheelhouse-test-"));

test("parseJsonc accepts comments and trailing commas but keeps strings intact", () => {
  const value = parseJsonc(`{
    // line comment
    "url": "https://example.com/a//b", /* block */
    "list": [1, 2,],
  }`);
  assert.deepEqual(value, { url: "https://example.com/a//b", list: [1, 2] });
});

test("interpolate expands ${VAR}, ${VAR:-fallback} and a leading ~", () => {
  const env = { KEY: "secret" };
  assert.equal(interpolate("X: ${KEY}", env), "X: secret");
  assert.equal(interpolate("${MISSING:-fallback}", env), "fallback");
  assert.equal(interpolate("${MISSING}", env), "");
  assert.match(interpolate("~/work", env), /work$/);
  assert.equal(interpolate("a~b", env), "a~b");
});

test("loadConfig without a file yields one default profile", () => {
  const config = loadConfig({ argv: [], env: {}, home: tmp(), cwd: tmp() });
  assert.deepEqual(Object.keys(config.profiles), ["default"]);
  assert.equal(config.port, 4173);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.defaults.model, "default");
});

test("tray is off by default, switched on by --tray or the file, and shortcuts are configurable", () => {
  const dir = tmp();
  const off = loadConfig({ argv: [], env: {}, home: dir, cwd: dir });
  assert.equal(off.tray.enabled, false);
  assert.equal(off.tray.hotkey, "Ctrl+Alt+W");
  assert.equal(off.tray.browserHotkey, "Ctrl+Alt+Shift+W");
  assert.equal(loadConfig({ argv: ["--tray"], env: {}, home: dir, cwd: dir }).tray.enabled, true);
  const file = join(dir, "c.json");
  writeFileSync(file, JSON.stringify({ tray: { enabled: true, hotkey: "Ctrl+Shift+Space" } }));
  const on = loadConfig({ argv: ["--config", file], env: {}, home: dir, cwd: dir });
  assert.deepEqual(on.tray, { enabled: true, hotkey: "Ctrl+Shift+Space", browserHotkey: "Ctrl+Alt+Shift+W" });
});

test("loadConfig reads a file, applies flags and normalizes profiles", () => {
  const dir = tmp();
  const file = join(dir, "wheelhouse.config.json");
  writeFileSync(file, JSON.stringify({
    port: 5000,
    defaultProfile: "gateway",
    defaults: { model: "sonnet", effort: "high", permissionMode: "auto" },
    profiles: {
      plain: { label: "Plain" },
      gateway: {
        label: "Gateway",
        command: "claude",
        configDir: join(dir, "cfg"),
        env: { ANTHROPIC_BASE_URL: "https://gw.example", ANTHROPIC_CUSTOM_HEADERS: "X-Key: ${GW_KEY}" },
        unset: ["ANTHROPIC_API_KEY"],
        proxyBypass: ["gw.example"],
      },
    },
  }));
  const config = loadConfig({ argv: ["--config", file, "--port", "6001"], env: { GW_KEY: "abc", ANTHROPIC_API_KEY: "x", NO_PROXY: "localhost" }, home: dir, cwd: dir });
  assert.equal(config.port, 6001); // flag beats file
  assert.equal(config.defaultProfile, "gateway");
  assert.equal(config.defaults.permissionMode, "auto");
  const env = profileEnv(config, "gateway");
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "X-Key: abc");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://gw.example");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, join(dir, "cfg"));
  assert.equal(env.NO_PROXY, "localhost,gw.example");
  assert.equal(profileEnv(config, "plain").ANTHROPIC_BASE_URL, undefined);
});

test("applyProfile swaps process.env and restores the baseline when switching", () => {
  const dir = tmp();
  const file = join(dir, "c.json");
  writeFileSync(file, JSON.stringify({ profiles: { a: { env: { WH_TEST_VAR: "from-a" } }, b: { env: { WH_OTHER: "from-b" } } } }));
  const config = loadConfig({ argv: ["--config", file], env: { ...process.env }, home: dir, cwd: dir });
  const before = { ...process.env };
  try {
    applyProfile(config, "a");
    assert.equal(process.env.WH_TEST_VAR, "from-a");
    applyProfile(config, "b");
    assert.equal(process.env.WH_TEST_VAR, undefined);
    assert.equal(process.env.WH_OTHER, "from-b");
    assert.equal(config.activeProfile, "b");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});

test("resolveCommand reports a missing executable and falls back to the bundled one when none is configured", () => {
  const missing = resolveCommand(join(tmp(), "nope"), {});
  assert.equal(missing.path, null);
  assert.match(missing.problem, /not found/i);
  assert.equal(resolveCommand("", { PATH: tmp() }).source, "bundled");
});
