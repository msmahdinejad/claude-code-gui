// Bundled by scripts/build-vendor.mjs into web/vendor/md.js (markdown, sanitizer, highlighter).
import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import powershell from "highlight.js/lib/languages/powershell";
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import xml from "highlight.js/lib/languages/xml";
import markdownLang from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import diff from "highlight.js/lib/languages/diff";
import sql from "highlight.js/lib/languages/sql";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import kotlin from "highlight.js/lib/languages/kotlin";
import swift from "highlight.js/lib/languages/swift";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import ini from "highlight.js/lib/languages/ini";
import lua from "highlight.js/lib/languages/lua";
import graphql from "highlight.js/lib/languages/graphql";
import nginx from "highlight.js/lib/languages/nginx";
import makefile from "highlight.js/lib/languages/makefile";
import plaintext from "highlight.js/lib/languages/plaintext";

const languages = {
  javascript, typescript, json, python, bash, shell, powershell, css, scss, xml, markdown: markdownLang, yaml, diff, sql, go, rust,
  java, c, cpp, csharp, php, ruby, kotlin, swift, dockerfile, ini, lua, graphql, nginx, makefile, plaintext,
};
for (const [name, definition] of Object.entries(languages)) hljs.registerLanguage(name, definition);
const aliases = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", py: "python",
  sh: "bash", zsh: "bash", ps1: "powershell", pwsh: "powershell", html: "xml", svg: "xml", vue: "xml", md: "markdown", yml: "yaml",
  patch: "diff", cs: "csharp", rb: "ruby", kt: "kotlin", toml: "ini", conf: "ini", gql: "graphql", docker: "dockerfile", make: "makefile",
  text: "plaintext", txt: "plaintext", console: "shell", jsonc: "json",
};
for (const [alias, target] of Object.entries(aliases)) hljs.registerAliases(alias, { languageName: target });

export { Marked, DOMPurify, hljs };
