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

/** { family: "fable", version: [5, 2] } for "claude-fable-5-2[1m]"; null for aliases and other names. */
export function parseModel(id) {
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)*)(?:\[\w+\])?$/.exec(String(id || "").toLowerCase());
  if (!match) return null;
  const version = match[2].split("-").map(Number).filter((part) => part < 1000); // a date is not part of the version
  return version.length ? { family: match[1], version } : null;
}

const newerVersion = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
};

/**
 * Claude Code may keep an older model in its list (on Team plans "Fable" stays Fable 5.1 until the organization allows the
 * newer one, although the newer one already answers). When a newer model of the same family has answered (it is
 * remembered), the CLI's row points at it instead: same name, its version in the description, the same `[1m]`-style tag.
 */
export function upgradeModels(models = [], remembered = []) {
  return models.map((model) => {
    if (model.value === "default") return model;
    const base = model.resolvedModel || String(model.value).replace(/\[.*\]$/, "");
    const current = parseModel(base);
    if (!current) return model;
    let best = null;
    for (const entry of remembered) {
      const candidate = parseModel(entry.id);
      if (candidate?.family === current.family && newerVersion(candidate.version, (best || current).version)) best = { ...candidate, id: String(entry.id).replace(/\[.*\]$/, "") };
    }
    if (!best) return model;
    const tag = /\[\w+\]$/.exec(String(model.value))?.[0] || "";
    const from = prettyModelName(`claude-${current.family}-${current.version.join("-")}`);
    const to = prettyModelName(best.id);
    return { ...model, value: `${best.id}${tag}`, resolvedModel: best.id, description: String(model.description || "").split(from).join(to), upgradedFrom: model.value };
  });
}

/**
 * The CLI's models (upgraded, see upgradeModels) plus remembered ones it does not list. `remembered` is [{ id, at }]; a remembered id is left out
 * when the CLI already has the same model (as a value or as what an alias resolves to).
 */
export function mergeModels(cliModels = [], remembered = []) {
  const upgraded = upgradeModels(cliModels, remembered);
  // The version the CLI listed stays available as a row of its own ("Fable 5.1 (1M)").
  const older = upgraded.filter((model) => model.upgradedFrom).map((model) => {
    const original = cliModels.find((entry) => entry.value === model.upgradedFrom);
    return { ...original, displayName: prettyModelName(model.upgradedFrom) };
  });
  const models = [...upgraded, ...older];
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
