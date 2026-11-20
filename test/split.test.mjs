import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SESSION_STREAMS, SPLIT_MIN_PANE, canSplit, chooseStreams, clampSplitWidth, parseStoredId, parseStoredWidth, widthFromPointer } from "../web/js/ui/split-logic.js";

test("clampSplitWidth keeps both panes at least 320px wide", () => {
  assert.equal(clampSplitWidth(500, 1200), 500);
  assert.equal(clampSplitWidth(100, 1200), 320);
  assert.equal(clampSplitWidth(5000, 1200), 1200 - 4 - 320);
  assert.equal(clampSplitWidth(400.4, 1200), 400);
});

test("clampSplitWidth defaults to half the area and survives garbage", () => {
  assert.equal(clampSplitWidth(null, 1000), 500);
  assert.equal(clampSplitWidth(undefined, 1000), 500);
  assert.equal(clampSplitWidth("", 1000), 500);
  assert.equal(clampSplitWidth(NaN, 1000), 500);
  assert.equal(clampSplitWidth("450", 1000), 450);
  assert.equal(clampSplitWidth(600, 500), SPLIT_MIN_PANE); // no room for two panes: the minimum, the caller hides the pane
  assert.equal(clampSplitWidth(600, NaN), SPLIT_MIN_PANE);
});

test("canSplit needs a wide window and two panes of room", () => {
  assert.equal(canSplit({ windowWidth: 1400, mainWidth: 1100 }), true);
  assert.equal(canSplit({ windowWidth: 1099, mainWidth: 1000 }), false);
  assert.equal(canSplit({ windowWidth: 1400, mainWidth: 643 }), false);
  assert.equal(canSplit({ windowWidth: 1400, mainWidth: 644 }), true);
  assert.equal(canSplit({ windowWidth: undefined, mainWidth: 900 }), false);
});

test("widthFromPointer measures from the inline end of the main area", () => {
  const rect = { left: 300, right: 1500 };
  assert.equal(widthFromPointer(1000, rect, false), 500);
  assert.equal(widthFromPointer(800, rect, true), 500);
});

test("stored values are validated", () => {
  assert.equal(parseStoredWidth("480"), 480);
  assert.equal(parseStoredWidth("480.6"), 481);
  for (const bad of [null, undefined, "", "abc", "-5", "0", "Infinity"]) assert.equal(parseStoredWidth(bad), null);
  assert.equal(parseStoredId("0b6f3c1e-1234-4abc-9def-0123456789ab"), "0b6f3c1e-1234-4abc-9def-0123456789ab");
  assert.equal(parseStoredId("  abc_1 "), "abc_1");
  for (const bad of [null, undefined, "", "../etc", "a b", "a/b", 42, "x\n<y>"]) assert.equal(parseStoredId(bad), null);
});

const live = (...ids) => (id) => ids.includes(id);

test("chooseStreams: without a split it keeps the current conversation, then working ones", () => {
  const out = chooseStreams({ ids: ["a", "b", "c", "d", "e"], currentId: "c", isLive: live("a", "e") });
  assert.deepEqual(out, ["c", "a", "e"]);
});

test("chooseStreams: the split pane counts as visible and goes right after the current one", () => {
  const out = chooseStreams({ ids: ["a", "b", "c", "d"], currentId: "a", splitId: "d", isLive: live("b", "c") });
  assert.deepEqual(out, ["a", "d", "b"]);
  assert.ok(out.length <= MAX_SESSION_STREAMS);
});

test("chooseStreams: the least recently seen working stream is dropped first", () => {
  const lastSeen = new Map([["b", 10], ["c", 50], ["d", 30]]);
  const out = chooseStreams({ ids: ["a", "b", "c", "d", "e"], currentId: "a", splitId: "e", isLive: live("b", "c", "d"), lastSeen });
  assert.deepEqual(out, ["a", "e", "c"]);
  const noSplit = chooseStreams({ ids: ["a", "b", "c", "d"], currentId: "a", isLive: live("b", "c", "d"), lastSeen });
  assert.deepEqual(noSplit, ["a", "c", "d"]);
});

test("chooseStreams: a visible pane is never dropped, never listed twice, unknown ids are ignored", () => {
  assert.deepEqual(chooseStreams({ ids: ["a", "b"], currentId: "a", splitId: "a", isLive: live() }), ["a"]);
  assert.deepEqual(chooseStreams({ ids: ["a", "b"], currentId: "a", splitId: "zzz", isLive: live("b") }), ["a", "b"]);
  assert.deepEqual(chooseStreams({ ids: ["a", "b"], currentId: null, splitId: "b", isLive: live() }), ["b"]);
  assert.deepEqual(chooseStreams({ ids: [], currentId: "a", isLive: live() }), []);
  // a visible conversation that is also working is not counted twice
  assert.deepEqual(chooseStreams({ ids: ["a", "b", "c"], currentId: "a", splitId: "b", isLive: live("a", "b", "c") }), ["a", "b", "c"]);
});
