// Pure helpers for model ids (no DOM, no state), shared by the picker and the tests.

/** "claude-fable-5-2" -> "Fable 5.2"; "claude-sonnet-4-5-20250929" -> "Sonnet 4.5"; "claude-opus-5-5[1m]" -> "Opus 5.5 (1M)". */
export function prettyModelName(id) {
  const raw = String(id || "");
  const tag = /\[(\w+)\]$/.exec(raw)?.[1];
  const parts = raw.replace(/\[.*\]$/, "").replace(/^claude-/, "").split("-").filter((part) => part && !/^\d{8}$/.test(part) && part !== "latest");
  if (!/^claude-/.test(raw) || !parts.length) return raw;
  const words = parts.filter((part) => !/^\d+$/.test(part));
  const digits = parts.filter((part) => /^\d+$/.test(part));
  const name = [words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" "), digits.join(".")].filter(Boolean).join(" ");
  return tag ? `${name} (${tag.toUpperCase()})` : name;
}

/** The id without a date suffix or a `[1m]`-style tag: two ids with the same family are the same model. */
export const modelFamily = (id) => String(id || "").replace(/\[.*\]$/, "").replace(/-\d{8}$/, "").replace(/-latest$/, "").toLowerCase();

/** Ids that look like a real model (not "<synthetic>", not empty, nothing odd). */
export const isModelId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,118}(\[\w+\])?$/.test(id);

/**
 * The CLI's models plus remembered ones it does not list. `remembered` is [{ id, at }]; a remembered id is left out
 * when the CLI already has the same model (as a value or as what an alias resolves to).
 */
export function mergeModels(models = [], remembered = []) {
  const known = new Set();
  for (const model of models) {
    known.add(modelFamily(model.value));
    if (model.resolvedModel) known.add(modelFamily(model.resolvedModel));
  }
  const extra = [];
  for (const entry of [...remembered].sort((a, b) => (b.at || 0) - (a.at || 0))) {
    const family = modelFamily(entry.id);
    if (!isModelId(entry.id) || known.has(family)) continue;
    known.add(family);
    extra.push({ value: entry.id, displayName: prettyModelName(entry.id), description: "", resolvedModel: entry.id, remembered: true });
  }
  return [...models, ...extra];
}
