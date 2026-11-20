// Hiding credentials in values that are shown in the browser (gateway URLs, MCP server definitions).
export const MASK = "••••••";

/** Names whose values are secrets (env keys, header names, query parameters, CLI flags). */
export const SECRET_NAME = /(key|token|secret|passw|authorization|auth|cookie|credential|signature|session|sig$|bearer)/i;

/** An opaque, token-like string: long, no spaces or path separators, letters and digits mixed. */
const TOKEN = /^(?:sk-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abprs]-|eyJ)[\w.-]{8,}$/;
const looksLikeToken = (value) => TOKEN.test(value) || (/^[\w.~+=-]{32,}$/.test(value) && /\d/.test(value) && /[a-z]/i.test(value));

/**
 * A URL without its secrets: user and password, query values and token-like path segments are replaced by MASK.
 * Not a URL: `fallback` (default "(set)").
 */
export function redactUrl(value, fallback = "(set)") {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return fallback;
  }
  if (!/^[a-z][a-z0-9+.-]*:$/i.test(url.protocol)) return fallback;
  const auth = url.username || url.password ? `${MASK}@` : "";
  const path = url.pathname.split("/").map((part) => (looksLikeToken(decodeURIComponent(part)) ? MASK : part)).join("/");
  const query = url.search ? `?${[...url.searchParams.keys()].map((name) => `${name}=${MASK}`).join("&")}` : "";
  const hash = url.hash ? `#${MASK}` : "";
  return url.host || auth ? `${url.protocol}//${auth}${url.host}${path}${query}${hash}` : `${url.protocol}${path}${query}${hash}`;
}

/** Command-line arguments with secrets masked: values of secret flags, NAME=value and "Header: value" pairs, URLs, tokens. */
export function maskArgs(args) {
  if (!Array.isArray(args)) return args;
  let secretNext = false;
  return args.map((arg) => {
    if (typeof arg !== "string") return arg;
    if (secretNext) {
      secretNext = false;
      if (!arg.startsWith("-")) return /^[\w-]+:\s/.test(arg) ? maskHeader(arg) : MASK;
    }
    const flag = /^(--?[\w.-]+)(=(.*))?$/s.exec(arg);
    if (flag) {
      if (flag[2] !== undefined) return SECRET_NAME.test(flag[1]) ? `${flag[1]}=${MASK}` : `${flag[1]}=${maskValue(flag[3])}`;
      secretNext = SECRET_NAME.test(flag[1]) || /^(-H|--header)$/.test(flag[1]);
      return arg;
    }
    return maskValue(arg);
  });
}

function maskHeader(text) {
  const at = text.indexOf(":");
  return SECRET_NAME.test(text.slice(0, at)) ? `${text.slice(0, at)}: ${MASK}` : text;
}

/** One free-standing value: NAME=value with a secret name, a "Header: value" line, a URL or a token. */
export function maskValue(value) {
  if (typeof value !== "string" || !value) return value;
  const pair = /^([A-Za-z_][\w.-]*)=(.*)$/s.exec(value);
  if (pair) return SECRET_NAME.test(pair[1]) ? `${pair[1]}=${MASK}` : `${pair[1]}=${maskValue(pair[2])}`;
  if (/^[\w-]+:\s/.test(value)) return maskHeader(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return redactUrl(value, MASK);
  return looksLikeToken(value) ? MASK : value;
}

/** Object values whose key names a secret are masked (env, headers). */
export function maskMap(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return map;
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, SECRET_NAME.test(key) ? MASK : typeof value === "string" ? maskValue(value) : value]));
}
