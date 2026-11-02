import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../server/lib/session-manager.mjs";
import { openExternal } from "../server/lib/ui-launch.mjs";

const baseConfig = (extra = {}) => ({ claudeBin: undefined, systemPromptAppend: "Be brief.", chrome: false, ...extra });

function optionsFor(config, prefs = {}) {
  const manager = new SessionManager(config, { prefs: () => prefs });
  try {
    return manager.create({ cwd: process.cwd(), meta: {} }).buildOptions();
  } finally {
    clearInterval(manager.reaper);
  }
}

test("Claude in Chrome is off by default", () => {
  const options = optionsFor(baseConfig());
  assert.equal(options.extraArgs?.chrome, undefined);
  assert.equal(options.systemPrompt.append, "Be brief.");
});

test("the config option turns the Chrome tools on and tells Claude to reuse the open browser", () => {
  const options = optionsFor(baseConfig({ chrome: true }));
  assert.equal(options.extraArgs.chrome, null); // becomes --chrome
  assert.match(options.systemPrompt.append, /^Be brief\./);
  assert.match(options.systemPrompt.append, /already have open/);
  assert.match(options.systemPrompt.append, /no browser is connected/);
});

test("the Settings toggle wins over the config file, both ways", () => {
  assert.equal(optionsFor(baseConfig({ chrome: true }), { useChrome: false }).extraArgs?.chrome, undefined);
  assert.equal(optionsFor(baseConfig({ chrome: false }), { useChrome: true }).extraArgs.chrome, null);
});

test("only http and https links can be opened externally", () => {
  process.env.WHEELHOUSE_NO_OPEN = "1";
  try {
    assert.doesNotThrow(() => openExternal("https://example.com/a?b=1&c=2"));
    for (const bad of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-msdt:/x", "not a url", ""]) {
      assert.throws(() => openExternal(bad), undefined, bad);
    }
  } finally {
    delete process.env.WHEELHOUSE_NO_OPEN;
  }
});
