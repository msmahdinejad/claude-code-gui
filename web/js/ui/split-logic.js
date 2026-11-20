// Pure helpers of the split view (no DOM, no app state): width clamping, whether there is room, the stream budget,
// what is read back from localStorage. Tested in test/split.test.mjs.

export const SPLIT_MIN_PANE = 320; // narrowest a pane may get (the main chat and the split pane alike)
export const SPLIT_DIVIDER = 4;
export const SPLIT_MIN_WINDOW = 1100; // narrower windows have no room for two conversations (sidebar included)
export const MAX_SESSION_STREAMS = 3; // a browser allows 6 connections per host; see session.js

/** Width of the split pane for a main area `containerWidth` wide: between the minimum and what leaves the main chat its minimum. */
export function clampSplitWidth(width, containerWidth, { min = SPLIT_MIN_PANE, divider = SPLIT_DIVIDER } = {}) {
  const room = Number(containerWidth);
  if (!Number.isFinite(room)) return min;
  const max = room - divider - min;
  if (max <= min) return min;
  const wanted = Number.isFinite(Number(width)) && width !== null && width !== "" ? Number(width) : room / 2;
  return Math.round(Math.min(max, Math.max(min, wanted)));
}

/** True when the window and the main area are wide enough for two panes. */
export function canSplit({ windowWidth, mainWidth }, { minWindow = SPLIT_MIN_WINDOW, min = SPLIT_MIN_PANE, divider = SPLIT_DIVIDER } = {}) {
  return Number(windowWidth) >= minWindow && Number(mainWidth) >= min * 2 + divider;
}

/** Split pane width for a pointer at `clientX`: the pane sits at the inline end of the main area (right in LTR, left in RTL). */
export function widthFromPointer(clientX, rect, rtl) {
  return rtl ? clientX - rect.left : rect.right - clientX;
}

/** A stored width: a positive finite number, otherwise null (no stored value or garbage). */
export function parseStoredWidth(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** A stored session id: only the characters ids are made of (the same rule the hash route uses). */
export function parseStoredId(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  return /^[\w-]+$/.test(value) ? value : null;
}

/**
 * Which conversations keep a live stream. Visible panes (main, then split) always do; the rest of the budget goes to
 * working sessions, most recently looked at first, so the least recently used non-visible one is dropped first.
 * @param {object} o
 * @param {Iterable<string>} o.ids      conversations loaded in the page (in their cache order)
 * @param {string|null} o.currentId     the main pane
 * @param {string|null} [o.splitId]     the split pane
 * @param {(id: string) => boolean} o.isLive   whether a session is working (starting / running / waiting for an answer)
 * @param {Map<string, number>} [o.lastSeen]   when each conversation was last visible
 * @param {number} [o.max]
 */
export function chooseStreams({ ids, currentId, splitId = null, isLive, lastSeen = new Map(), max = MAX_SESSION_STREAMS }) {
  const known = [...ids];
  const visible = [currentId, splitId].filter((id, index, all) => id && known.includes(id) && all.indexOf(id) === index);
  const working = known
    .filter((id) => !visible.includes(id) && isLive(id))
    .map((id, index) => ({ id, index }))
    .sort((a, b) => (lastSeen.get(b.id) || 0) - (lastSeen.get(a.id) || 0) || a.index - b.index)
    .map((entry) => entry.id);
  return [...visible, ...working].slice(0, Math.max(max, 0));
}
