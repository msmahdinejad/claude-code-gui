// Catalog integrity for the Claude Code settings editor and the pure value logic behind it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, CATEGORIES, SECTIONS, ALL_SECTION, ELSEWHERE, EXCLUDED, GLOBAL_CONFIG_KEYS } from "../web/js/features/settings-catalog-data.js";
import * as V from "../web/js/features/settings-catalog-values.js";
import { fa } from "../web/js/i18n/fa/settings-claude.js";

const byPath = (path) => CATALOG.find((entry) => entry.path === path);

test("catalog paths are unique and well formed", () => {
  const seen = new Set();
  for (const entry of CATALOG) {
    assert.match(entry.path, /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/, entry.path);
    assert.ok(!seen.has(entry.path), `duplicate ${entry.path}`);
    seen.add(entry.path);
    for (const covered of entry.covers || []) {
      assert.ok(!seen.has(covered), `covered key listed twice: ${covered}`);
      seen.add(covered);
    }
  }
});

test("every entry has a valid type, category, scopes, version and docs anchor", () => {
  const cats = new Set(CATEGORIES.map((category) => category.id));
  for (const entry of CATALOG) {
    assert.ok(V.TYPES.includes(entry.type), `${entry.path}: type ${entry.type}`);
    assert.ok(cats.has(entry.cat), `${entry.path}: category ${entry.cat}`);
    assert.ok(entry.title && entry.desc, `${entry.path}: title/desc`);
    if (entry.scopes) {
      assert.ok(entry.scopes.length > 0 && entry.scopes.every((scope) => V.SCOPE_IDS.includes(scope)), `${entry.path}: scopes`);
      assert.ok(entry.scopeNote, `${entry.path}: restricted scopes need a note`);
    }
    if (entry.since) assert.match(entry.since, /^\d+\.\d+\.\d+$/, entry.path);
    const url = V.docsUrl(entry);
    assert.match(url, /^https:\/\/code\.claude\.com\/docs\/en\/settings-reference#[a-z0-9-]+$/, entry.path);
    assert.equal(url.split("#")[1], entry.path.toLowerCase().replaceAll(".", "-"));
    assert.doesNotThrow(() => V.schemaFor(entry), entry.path);
  }
});

test("enums are non-empty and unique; object fields are valid", () => {
  for (const entry of CATALOG) {
    if (entry.type === "enum") {
      const values = entry.options.map(V.optionValue);
      assert.ok(values.length > 0, entry.path);
      assert.equal(new Set(values).size, values.length, entry.path);
    }
    if (entry.type === "flag") assert.equal(typeof entry.value, "string", entry.path);
    if (entry.type === "object" && !entry.editor) {
      assert.ok(entry.fields.length > 0, entry.path);
      const keys = entry.fields.map((field) => field.key);
      assert.equal(new Set(keys).size, keys.length, entry.path);
      for (const field of entry.fields) {
        assert.ok(V.FIELD_TYPES.includes(field.type), `${entry.path}.${field.key}`);
        if (field.type === "enum") assert.ok(field.options.length > 0);
        if (field.const === undefined) assert.ok(field.title, `${entry.path}.${field.key} title`);
        if (field.default !== undefined) assert.equal(V.check(V.fieldSchema(field), field.default), null);
      }
    }
    if (entry.type === "map" && !entry.editor) assert.ok(entry.valueField, entry.path);
    if (entry.type === "json") assert.ok(entry.schema, `${entry.path}: json entries need a schema`);
  }
});

test("documented defaults match their type", () => {
  for (const entry of CATALOG) {
    if (entry.default === undefined) continue;
    assert.equal(V.validateValue(entry, entry.default), null, `${entry.path} default ${JSON.stringify(entry.default)}`);
  }
  assert.equal(byPath("cleanupPeriodDays").default, 30);
  assert.equal(byPath("skillListingMaxDescChars").default, 1536);
  assert.equal(byPath("theme").default, "dark");
  assert.equal(byPath("sandbox.allowUnsandboxedCommands").default, true);
});

test("catalog and excluded list do not overlap; excluded keys are unique", () => {
  const catalogKeys = new Set(CATALOG.flatMap((entry) => [entry.path, ...(entry.covers || [])]));
  const excluded = EXCLUDED.map((item) => item.path);
  assert.equal(new Set(excluded).size, excluded.length);
  for (const path of excluded) assert.ok(!catalogKeys.has(path), `${path} is both catalogued and excluded`);
  for (const key of GLOBAL_CONFIG_KEYS) assert.ok(!catalogKeys.has(key) && !excluded.includes(key), key);
  for (const item of ELSEWHERE) for (const key of item.keys) assert.ok(!catalogKeys.has(key), key);
});

test("sections cover every category exactly once", () => {
  const used = SECTIONS.flatMap((section) => section.cats);
  assert.equal(new Set(used).size, used.length);
  for (const category of CATEGORIES) assert.ok(used.includes(category.id), category.id);
  const ids = [...SECTIONS, ALL_SECTION].map((section) => section.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every user-visible catalog string has a Persian translation", () => {
  const strings = new Set();
  const add = (value) => value && strings.add(value);
  CATEGORIES.forEach((category) => add(category.title));
  [...SECTIONS, ALL_SECTION].forEach((section) => { add(section.title); add(section.lead); });
  ELSEWHERE.forEach((item) => add(item.title));
  EXCLUDED.forEach((item) => add(item.reason));
  Object.values(V.MESSAGES).forEach(add);
  for (const entry of CATALOG) {
    ["title", "desc", "note", "scopeNote", "defaultNote", "deprecated", "hint"].forEach((key) => add(entry[key]));
    (entry.fields || []).forEach((field) => add(field.title));
  }
  const missing = [...strings].filter((text) => !fa[text]);
  assert.deepEqual(missing, []);
});

test("validation: booleans, numbers, enums, strings", () => {
  assert.equal(V.validateValue(byPath("autoCompactEnabled"), false), null);
  assert.ok(V.validateValue(byPath("autoCompactEnabled"), "false"));
  const days = byPath("cleanupPeriodDays");
  assert.equal(V.validateValue(days, 7), null);
  assert.equal(V.validateValue(days, 0).msg, V.MESSAGES.min);
  assert.equal(V.validateValue(days, 1.5).msg, V.MESSAGES.integer);
  assert.equal(V.validateValue(days, "7").msg, V.MESSAGES.number);
  const fraction = byPath("skillListingBudgetFraction");
  assert.equal(V.validateValue(fraction, 0).msg, V.MESSAGES.gt);
  assert.equal(V.validateValue(fraction, 1), null);
  assert.equal(V.validateValue(fraction, 1.01).msg, V.MESSAGES.max);
  assert.equal(V.validateValue(byPath("effortLevel"), "xhigh"), null);
  assert.equal(V.validateValue(byPath("effortLevel"), "max").msg, V.MESSAGES.enum);
  assert.equal(V.validateValue(byPath("maxEffortLevel"), "max"), null);
  assert.equal(V.validateValue(byPath("theme"), "custom:solar"), null);
  assert.ok(V.validateValue(byPath("theme"), "neon"));
  assert.equal(V.validateValue(byPath("timeFormat"), "%H:%M"), null);
  assert.ok(V.validateValue(byPath("timeFormat"), "HH:mm"));
  assert.equal(V.validateValue(byPath("advisorModel"), "claude-opus-5-5"), null);
  assert.equal(V.validateValue(byPath("minimumVersion"), "2.1.323"), null);
  assert.ok(V.validateValue(byPath("minimumVersion"), "latest"));
  assert.equal(V.validateValue(byPath("autoMemoryDirectory"), "~/mem"), null);
  assert.equal(V.validateValue(byPath("autoMemoryDirectory"), "C:\\mem"), null);
  assert.ok(V.validateValue(byPath("autoMemoryDirectory"), "mem"));
  assert.equal(V.validateValue(byPath("disableAutoMode"), "disable"), null);
  assert.ok(V.validateValue(byPath("disableAutoMode"), true));
  assert.equal(V.validateValue(byPath("model"), undefined), null, "unset is always allowed");
  assert.equal(V.validateValue(byPath("model"), "").msg, V.MESSAGES.empty);
});

test("validation: objects, maps and json shapes", () => {
  const statusLine = byPath("statusLine");
  assert.equal(V.validateValue(statusLine, { type: "command", command: "x", padding: 2 }), null);
  assert.equal(V.validateValue(statusLine, { type: "command", padding: 2 }).msg, V.MESSAGES.required);
  assert.equal(V.validateValue(statusLine, { type: "shell", command: "x" }).msg, V.MESSAGES.constant);
  assert.equal(V.validateValue(statusLine, { type: "command", command: "x", refreshInterval: 0 }).msg, V.MESSAGES.min);
  assert.equal(V.validateValue(statusLine, { type: "command", command: "x", future: true }), null, "unknown fields are kept");

  const attribution = byPath("attribution");
  assert.equal(V.validateValue(attribution, false), null);
  assert.equal(V.validateValue(attribution, { commit: "", pr: "", sessionUrl: false }), null, "empty text hides a part");
  assert.ok(V.validateValue(attribution, true));

  const settings = byPath("modelSettings");
  assert.equal(V.validateValue(settings, { "claude-opus-5-5": { effortLevel: "high", autoCompactWindow: "auto" } }), null);
  assert.equal(V.validateValue(settings, { m: { autoCompactWindow: 400000, maxEffortLevel: "max" } }), null);
  assert.ok(V.validateValue(settings, { m: { autoCompactWindow: 50 } }));
  assert.ok(V.validateValue(settings, { m: { effortLevel: "max" } }));

  const picker = byPath("modelPicker");
  assert.equal(V.validateValue(picker, { options: [{ model: "opus", label: "Opus" }], replaceBuiltInOptions: true }), null);
  assert.equal(V.validateValue(picker, { options: [{ label: "x" }] }).at, "options[0]");
  assert.ok(V.validateValue(picker, { replaceBuiltInOptions: true }));

  const allow = byPath("allowedMcpServers");
  assert.equal(V.validateValue(allow, []), null, "an empty allowlist is meaningful");
  assert.equal(V.validateValue(allow, [{ serverName: "github" }, { serverUrl: "https://*.x.com/*" }]), null);
  assert.equal(V.validateValue(allow, [{ serverName: "a", serverUrl: "b" }]).msg, V.MESSAGES.exactlyOne);
  assert.ok(V.validateValue(allow, [{ serverName: "has space" }]));

  const remaps = byPath("vimInsertModeRemaps");
  assert.equal(V.validateValue(remaps, { jk: "<Esc>" }), null);
  assert.ok(V.validateValue(remaps, { jkl: "<Esc>" }));
  assert.ok(V.validateValue(remaps, { jk: "Esc" }));

  const tips = byPath("spinnerTipsOverride");
  assert.equal(V.validateValue(tips, { tips: ["a", { id: "x-1", text: "b", priority: 2 }], excludeDefault: true }), null);
  assert.ok(V.validateValue(tips, { tips: [{ id: "x", text: "b", priority: 20 }] }));
  assert.ok(V.validateValue(tips, { label: "x".repeat(41) }));

  assert.equal(V.validateValue(byPath("forceLoginOrgUUID"), ["a", "b"]), null);
  assert.ok(V.validateValue(byPath("forceLoginOrgUUID"), 5));
  assert.equal(V.validateValue(byPath("spinnerVerbs"), { mode: "append" }).msg, V.MESSAGES.required);
});

test("input parsing keeps numbers numbers and treats empty as unset", () => {
  assert.deepEqual(V.parseNumberInput(" 30 "), { value: 30 });
  assert.deepEqual(V.parseNumberInput("0.01"), { value: 0.01 });
  assert.deepEqual(V.parseNumberInput("۳۰"), { value: 30 });
  assert.deepEqual(V.parseNumberInput("200,000"), { value: 200000 });
  assert.deepEqual(V.parseNumberInput(""), { value: undefined });
  assert.ok(V.parseNumberInput("12abc").error);
  assert.deepEqual(V.parseJsonInput(""), { value: undefined });
  assert.deepEqual(V.parseJsonInput("[1]"), { value: [1] });
  assert.equal(V.parseJsonInput("{").error.msg, V.MESSAGES.json);
  assert.deepEqual(V.normalizeList([" a ", "", "a", "b"]), ["a", "b"]);
  assert.equal(V.normalizeList(["", " "]), undefined);
  assert.equal(V.parseTextInput("  "), undefined);
  assert.equal(V.parseTextInput("", { allowEmpty: true }), "");
});

test("path edits change only the edited key and prune empty parents", () => {
  const json = { model: "opus", unknownKey: { keep: 1 }, sandbox: { network: { allowedDomains: ["a.com"] }, enabled: true } };
  V.unsetPath(json, "sandbox.network.allowedDomains");
  assert.deepEqual(json, { model: "opus", unknownKey: { keep: 1 }, sandbox: { enabled: true } });
  V.unsetPath(json, "sandbox.enabled");
  assert.deepEqual(json, { model: "opus", unknownKey: { keep: 1 } });
  V.setPath(json, "worktree.baseRef", "head");
  assert.deepEqual(json.worktree, { baseRef: "head" });
  V.unsetPath(json, "not.there");
  assert.deepEqual(Object.keys(json), ["model", "unknownKey", "worktree"]);

  const attr = { attribution: false };
  V.setPath(attr, "attribution", { commit: "" });
  assert.deepEqual(attr, { attribution: { commit: "" } });

  const result = V.applyEdit({ a: 1 }, byPath("cleanupPeriodDays"), 0);
  assert.ok(result.error);
  const ok = V.applyEdit({ a: 1 }, byPath("cleanupPeriodDays"), 14);
  assert.deepEqual(ok.json, { a: 1, cleanupPeriodDays: 14 });
  assert.deepEqual(V.applyEdit({ a: 1, cleanupPeriodDays: 14 }, byPath("cleanupPeriodDays"), undefined).json, { a: 1 });
  // An empty object that is meaningful (tlsTerminate {}) is written as is.
  const tls = V.applyEdit({}, byPath("sandbox.network.tlsTerminate"), {});
  assert.deepEqual(tls.json, { sandbox: { network: { tlsTerminate: {} } } });
});

test("object drafts fill constants, keep unknown fields and empty out to unset", () => {
  const statusLine = byPath("statusLine");
  assert.deepEqual(V.withField(statusLine, undefined, "command", "x"), { command: "x", type: "command" });
  assert.deepEqual(V.withField(statusLine, { type: "command", command: "x", extra: 1 }, "padding", 2), { type: "command", command: "x", extra: 1, padding: 2 });
  assert.equal(V.withField(statusLine, { type: "command", command: "x" }, "command", undefined), undefined);
  const tls = byPath("sandbox.network.tlsTerminate");
  assert.deepEqual(V.withField(tls, { caCertPath: "/a" }, "caCertPath", undefined), {}, "presence objects stay present");
  assert.deepEqual(V.mapFromPairs([["a", "1"], ["", "x"], ["b", undefined]]), { a: "1" });
  assert.equal(V.mapFromPairs([]), undefined);
});

test("scope rules", () => {
  assert.ok(V.scopeAllowed(byPath("model"), "project"));
  assert.ok(!V.scopeAllowed(byPath("modelPicker"), "project"));
  assert.ok(V.scopeAllowed(byPath("modelPicker"), "user"));
  assert.ok(V.scopeAllowed(byPath("useAutoModeDuringPlan"), "local"));
  assert.ok(!V.scopeAllowed(byPath("useAutoModeDuringPlan"), "project"));
  const label = byPath("spinnerTipsOverride").fields.find((field) => field.key === "label");
  assert.ok(!V.fieldAllowed(label, "project"));
  assert.ok(V.matchesQuery("status line", ["statusLine", "Status line"]));
  assert.ok(!V.matchesQuery("vim sandbox", ["statusLine"]));
});
