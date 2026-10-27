// UI language. Source strings are English; `fa` maps them to Persian.
// Call t() with an English source string and optional {placeholders}; missing keys fall back to English.
import { fa } from "../i18n/fa.js";

const KEY = "wheelhouse-lang";
let lang = "en";
try {
  lang = localStorage.getItem(KEY) || "en";
} catch { /* storage unavailable */ }

/** Merge extra Persian strings (feature modules ship their own js/i18n/fa/<name>.js). */
export function addTranslations(map) {
  Object.assign(fa, map);
}

export function getLang() {
  return lang;
}

export function setLang(next) {
  lang = next === "en" ? "en" : "fa";
  try { localStorage.setItem(KEY, lang); } catch { /* ignore */ }
  applyLang();
}

export function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
}

export function t(text, vars) {
  let out = lang === "fa" ? fa[text] ?? text : text;
  if (vars) {
    out = out.replace(/\{(\w+)\}/g, (_, name) => {
      if (!(name in vars)) return `{${name}}`;
      const value = vars[name];
      // Persian UI shows Persian digits for counts and times.
      return lang === "fa" && typeof value === "number" ? String(value).replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[digit]) : value;
    });
  }
  return out;
}

applyLang();
