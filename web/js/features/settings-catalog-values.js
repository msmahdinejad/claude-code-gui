// Pure helpers for the Claude Code settings catalog: schemas, validation, path edits, input parsing.
// No DOM and no imports, so test/settings-catalog.test.mjs can load it in Node.
// Error objects are { msg, vars, at }: `msg` is an English source string (translated by the UI with t()).

export const DOCS_BASE = "https://code.claude.com/docs/en/settings-reference";
export const SCOPE_IDS = ["user", "project", "local"];
/** Later scopes take precedence over earlier ones for most keys. */
export const SCOPE_RANK = { user: 0, project: 1, local: 2 };
export const TYPES = ["bool", "enum", "string", "number", "stringList", "object", "map", "json", "flag"];
export const FIELD_TYPES = ["bool", "enum", "string", "number", "stringList", "tips"];

export const MESSAGES = {
  bool: "Expected true or false.",
  string: "Expected text.",
  empty: "Must not be empty.",
  enum: "Must be one of: {values}",
  number: "Expected a number.",
  integer: "Must be a whole number.",
  min: "Must be at least {min}.",
  max: "Must be at most {max}.",
  gt: "Must be greater than {min}.",
  array: "Expected a list.",
  object: "Expected an object.",
  required: "Missing required field {field}.",
  constant: "Must be {value}.",
  pattern: "Does not match the expected format.",
  maxLength: "At most {max} characters.",
  exactlyOne: "Each entry needs exactly one of: {fields}.",
  anyOf: "Does not match any allowed form.",
  json: "Not valid JSON: {error}",
  key: "Key {key} is not valid.",
  absPath: "Use an absolute path or one that starts with ~/.",
  version: "Use a version number such as 2.1.323.",
  url: "Use a full URL including the scheme, such as https://.",
  timeFormat: "Use a preset or a strftime pattern containing %.",
  theme: "Use a built-in theme or custom:<name>.",
  serverName: "Letters, numbers, hyphens and underscores only.",
  twoChars: "Exactly two characters.",
  tipId: "Up to 64 letters, digits, dots, underscores or hyphens.",
};

const err = (msg, vars, at = "") => ({ msg, vars, at });

// ---- schema builders (used by the catalog data) ------------------------------------------
export const S = {
  any: () => ({ t: "any" }),
  bool: () => ({ t: "boolean" }),
  str: (opts = {}) => ({ t: "string", ...opts }),
  num: (opts = {}) => ({ t: "number", ...opts }),
  enumOf: (values, opts = {}) => ({ t: "enum", values, ...opts }),
  constOf: (value) => ({ t: "const", value }),
  arr: (items) => ({ t: "array", items }),
  obj: (props = {}, opts = {}) => ({ t: "object", props, ...opts }),
  anyOf: (...of) => ({ t: "anyOf", of }),
};

/** Patterns with a readable hint, shared by catalog entries. */
export const PATTERNS = {
  absPath: { pattern: "^(~/|/|[A-Za-z]:[\\\\/]|\\\\\\\\)", hint: MESSAGES.absPath },
  version: { pattern: "^\\d+\\.\\d+\\.\\d+$", hint: MESSAGES.version },
  url: { pattern: "^[A-Za-z][A-Za-z0-9+.-]*://\\S+$", hint: MESSAGES.url },
  serverName: { pattern: "^[A-Za-z0-9_-]+$", hint: MESSAGES.serverName },
  twoChars: { pattern: "^[\\s\\S]{2}$", hint: MESSAGES.twoChars },
  tipId: { pattern: "^[A-Za-z0-9._-]{1,64}$", hint: MESSAGES.tipId },
};

export const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const typeOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
const joinAt = (at, key) => (typeof key === "number" ? `${at}[${key}]` : at ? `${at}.${key}` : key);

// ---- validation -------------------------------------------------------------------------------
/** Validate `value` against a schema. Returns null when valid, else the first error. */
export function check(schema, value, at = "") {
  switch (schema.t) {
    case "any":
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : err(MESSAGES.bool, null, at);
    case "string": {
      if (typeof value !== "string") return err(MESSAGES.string, null, at);
      if (value === "" && !schema.allowEmpty) return err(MESSAGES.empty, null, at);
      if (value === "" && schema.allowEmpty) return null;
      if (schema.maxLength && [...value].length > schema.maxLength) return err(MESSAGES.maxLength, { max: schema.maxLength }, at);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) return err(schema.hint || MESSAGES.pattern, null, at);
      return null;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return err(MESSAGES.number, null, at);
      if (schema.integer && !Number.isInteger(value)) return err(MESSAGES.integer, null, at);
      if (schema.exclusiveMin !== undefined && !(value > schema.exclusiveMin)) return err(MESSAGES.gt, { min: schema.exclusiveMin }, at);
      if (schema.min !== undefined && value < schema.min) return err(MESSAGES.min, { min: schema.min }, at);
      if (schema.max !== undefined && value > schema.max) return err(MESSAGES.max, { max: schema.max }, at);
      return null;
    }
    case "enum": {
      if (typeof value !== "string") return err(MESSAGES.string, null, at);
      if (schema.values.includes(value)) return null;
      if (schema.allowOther) {
        if (value === "") return err(MESSAGES.empty, null, at);
        if (!schema.pattern || new RegExp(schema.pattern).test(value)) return null;
        return err(schema.hint || MESSAGES.pattern, null, at);
      }
      return err(MESSAGES.enum, { values: schema.values.join(", ") }, at);
    }
    case "const":
      return value === schema.value ? null : err(MESSAGES.constant, { value: JSON.stringify(schema.value) }, at);
    case "array": {
      if (!Array.isArray(value)) return err(MESSAGES.array, null, at);
      for (let index = 0; index < value.length; index += 1) {
        const problem = check(schema.items, value[index], joinAt(at, index));
        if (problem) return problem;
      }
      return null;
    }
    case "object": {
      if (!isPlainObject(value)) return err(MESSAGES.object, null, at);
      for (const field of schema.required || []) if (!(field in value) || value[field] === undefined) return err(MESSAGES.required, { field }, at);
      if (schema.exactlyOne) {
        const present = schema.exactlyOne.filter((field) => field in value);
        if (present.length !== 1) return err(MESSAGES.exactlyOne, { fields: schema.exactlyOne.join(", ") }, at);
      }
      for (const [key, item] of Object.entries(value)) {
        if (schema.keyPattern && !new RegExp(schema.keyPattern).test(key)) return err(schema.keyHint || MESSAGES.key, { key }, at);
        const sub = schema.props?.[key] || (schema.additional && typeof schema.additional === "object" ? schema.additional : null);
        if (sub) {
          const problem = check(sub, item, joinAt(at, key));
          if (problem) return problem;
        }
      }
      return null;
    }
    case "anyOf": {
      let first = null;
      for (const option of schema.of) {
        const problem = check(option, value, at);
        if (!problem) return null;
        // Prefer the error from the branch whose basic type matches (more useful than "no form matched").
        if (!first && sameKind(option, value)) first = problem;
      }
      return first || err(MESSAGES.anyOf, null, at);
    }
    default:
      throw new Error(`unknown schema type ${schema.t}`);
  }
}

function sameKind(schema, value) {
  const kind = typeOf(value);
  if (schema.t === "string" || schema.t === "enum") return kind === "string";
  if (schema.t === "number") return kind === "number";
  if (schema.t === "boolean") return kind === "boolean";
  if (schema.t === "array") return kind === "array";
  if (schema.t === "object") return kind === "object";
  if (schema.t === "const") return typeOf(schema.value) === kind;
  return false;
}

/** Schema for one field of an `object` entry. */
export function fieldSchema(field) {
  switch (field.type) {
    case "bool":
      return S.bool();
    case "enum":
      return S.enumOf(field.options.map(optionValue), { allowOther: field.allowOther, pattern: field.pattern, hint: field.hint });
    case "string":
      return field.const !== undefined ? S.constOf(field.const) : S.str({ allowEmpty: field.allowEmpty, maxLength: field.maxLength, pattern: field.pattern, hint: field.hint });
    case "number":
      return S.num({ min: field.min, max: field.max, integer: field.integer, exclusiveMin: field.exclusiveMin });
    case "stringList":
      return S.arr(S.str());
    case "tips":
      return TIPS_SCHEMA;
    default:
      throw new Error(`unknown field type ${field.type}`);
  }
}

export const TIPS_SCHEMA = S.arr(
  S.anyOf(
    S.str(),
    S.obj(
      { id: S.str(PATTERNS.tipId), text: S.str({ maxLength: 500 }), cooldownSessions: S.num({ integer: true, min: 0, max: 1000 }), priority: S.num({ integer: true, min: -10, max: 10 }) },
      { required: ["id", "text"] },
    ),
  ),
);

export const optionValue = (option) => (typeof option === "string" ? option : option.value);

/** The schema an entry's whole value must satisfy. */
export function schemaFor(entry) {
  if (entry.schema) return entry.schema;
  switch (entry.type) {
    case "bool":
      return S.bool();
    case "enum":
      return S.enumOf(entry.options.map(optionValue), { allowOther: entry.allowOther, pattern: entry.pattern, hint: entry.hint });
    case "string":
      return S.str({ allowEmpty: entry.allowEmpty, pattern: entry.pattern, hint: entry.hint, maxLength: entry.maxLength });
    case "number":
      return S.num({ min: entry.min, max: entry.max, integer: entry.integer, exclusiveMin: entry.exclusiveMin });
    case "stringList":
      return S.arr(S.str());
    case "flag":
      return S.constOf(entry.value);
    case "object": {
      const props = Object.fromEntries(entry.fields.map((field) => [field.key, fieldSchema(field)]));
      const required = entry.fields.filter((field) => field.required || field.const !== undefined).map((field) => field.key);
      return S.obj(props, { required, additional: true });
    }
    case "map":
      return S.obj({}, { additional: fieldSchema(entry.valueField), keyPattern: entry.keyPattern, keyHint: entry.keyHint });
    case "json":
      return S.any();
    default:
      throw new Error(`unknown entry type ${entry.type}`);
  }
}

/** null when `value` may be saved for `entry`; undefined (unset) is always fine. */
export function validateValue(entry, value) {
  if (value === undefined) return null;
  return check(schemaFor(entry), value);
}

// ---- input parsing ------------------------------------------------------------------------------
/** Text box → number. "" means unset. Returns { value } or { error }. */
export function parseNumberInput(raw) {
  const text = String(raw ?? "").trim().replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))).replace(/[_,\s]/g, "");
  if (text === "") return { value: undefined };
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return { error: err(MESSAGES.number) };
  return { value: Number(text) };
}

/** Textarea → JSON value. "" (only whitespace) means unset. */
export function parseJsonInput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { value: undefined };
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: err(MESSAGES.json, { error: error.message }) };
  }
}

/** List editor items → stored list: trimmed, without blanks or duplicates. Empty → unset. */
export function normalizeList(items) {
  const out = [];
  for (const item of items || []) {
    const value = String(item).trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out.length ? out : undefined;
}

/** Plain text box → string value; "" → unset unless the entry treats "" as meaningful. */
export function parseTextInput(raw, { allowEmpty = false, trim = true } = {}) {
  const value = trim ? String(raw ?? "").trim() : String(raw ?? "");
  if (value === "" && !allowEmpty) return undefined;
  return value;
}

// ---- object / map drafts ------------------------------------------------------------------------
/** Copy `current` with one field set (or removed when value is undefined); constant fields are filled in.
 *  Returns undefined when nothing but constants is left. */
export function withField(entry, current, key, value) {
  const next = isPlainObject(current) ? { ...current } : {};
  if (value === undefined) delete next[key];
  else next[key] = value;
  const constants = (entry.fields || []).filter((field) => field.const !== undefined);
  const meaningful = Object.keys(next).filter((name) => !constants.some((field) => field.key === name));
  if (!meaningful.length) return entry.presence && isPlainObject(current) ? stripConstants(next, constants) : undefined;
  for (const field of constants) next[field.key] = field.const;
  return next;
}

const stripConstants = (object, constants) => {
  for (const field of constants) delete object[field.key];
  return object;
};

/** Map entries → stored object (empty → unset). `pairs` is [[key, value], …]; blank keys and undefined values are dropped. */
export function mapFromPairs(pairs) {
  const out = {};
  for (const [rawKey, value] of pairs) {
    const key = String(rawKey ?? "").trim();
    if (!key || value === undefined) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---- path edits ----------------------------------------------------------------------------------------
/** Read a dotted path; undefined when any part is missing. */
export function getPath(object, path) {
  let cursor = object;
  for (const key of path.split(".")) {
    if (!isPlainObject(cursor) || !(key in cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/** Write a dotted path exactly (no "empty means delete" magic); parents that are not objects are replaced. */
export function setPath(object, path, value) {
  const keys = path.split(".");
  let cursor = object;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = value;
  return object;
}

/** Delete a dotted path and remove parent objects that became empty because of it. Siblings stay. */
export function unsetPath(object, path) {
  const keys = path.split(".");
  const chain = [object];
  let cursor = object;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(cursor[key])) return object;
    cursor = cursor[key];
    chain.push(cursor);
  }
  if (!(keys.at(-1) in cursor)) return object;
  delete cursor[keys.at(-1)];
  for (let index = chain.length - 1; index > 0; index -= 1) {
    if (Object.keys(chain[index]).length) break;
    delete chain[index - 1][keys[index - 1]];
  }
  return object;
}

/** Apply one edit to a parsed settings object: validate, then set or unset. Returns { json } or { error }. */
export function applyEdit(json, entry, value) {
  const problem = validateValue(entry, value);
  if (problem) return { error: problem };
  if (value === undefined) unsetPath(json, entry.path);
  else setPath(json, entry.path, value);
  return { json };
}

export function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- scopes & docs ---------------------------------------------------------------------------------
export const entryScopes = (entry) => entry.scopes || SCOPE_IDS;
export const scopeAllowed = (entry, scope) => entryScopes(entry).includes(scope);
export const fieldAllowed = (field, scope) => !field.scopes || field.scopes.includes(scope);

export const docsAnchor = (key) => key.toLowerCase().replaceAll(".", "-");
export const docsUrl = (entry) => `${DOCS_BASE}#${docsAnchor(entry.doc || entry.path)}`;

/** Short one-line rendering of a stored value for hints and badges. */
export function formatValue(value, max = 60) {
  if (value === undefined) return "";
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Search helper: every whitespace-separated term must appear in one of the haystack strings. */
export function matchesQuery(query, haystacks) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = haystacks.filter(Boolean).join("\n").toLowerCase();
  return terms.every((term) => text.includes(term));
}
