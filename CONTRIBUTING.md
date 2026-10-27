# Contributing

Thanks for helping! Bug reports, translations, docs, and features are all welcome.

## Quick start

```bash
git clone https://github.com/msmahdinejad/claude-code-gui.git && cd claude-code-gui
npm install
npm run dev          # server with restart on change; the web app only needs a browser reload
npm run check        # eslint + unit tests + translation coverage (what CI runs)
```

You need Node.js 20+ and a working Claude Code (see [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for gateways and
other setups). Live model calls cost money: when you test against a real model, use a cheap one (`haiku`) and tiny prompts.

## Project layout

```
bin/            CLI entry (`wheelhouse`)
server/         HTTP + SSE server, session manager, config/profiles, route modules (server/lib/routes)
web/            front end: plain ES modules, no build step (web/js/core, chat, ui, features, i18n)
scripts/        build-vendor, extract-i18n, headless-browser QA helpers (scripts/qa)
test/           node:test suites
docs/           architecture, configuration, features, troubleshooting
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. The important idea: **features are self-contained modules**.
Adding a settings page, inspector panel, command, tool renderer, server route or translation means adding a file; you
rarely edit shared code.

## Ground rules

- **Never call a model API from this project.** All model traffic goes through the Claude Code executable (via the
  Agent SDK). Wheelhouse must not alter or proxy requests.
- **Security matters**: the server runs commands and edits files on the user's behalf. New routes must validate paths,
  keep the same-origin check, and never expose secrets to the browser. See [SECURITY.md](SECURITY.md).
- **Right-to-left is a first-class citizen.** Use logical CSS (`margin-inline-start`, `inset-inline-end`, …), put
  `dir="auto"` on user/model text and `dir="ltr"` on code, paths and identifiers, and check both languages and both
  themes before opening a PR.
- **Every user-visible string goes through `t("English source")`** and needs a Persian entry (`web/js/i18n/fa/`).
  `npm run i18n:check` fails when one is missing. To add a language, mirror `web/js/i18n/fa/` and register it in
  `web/js/core/i18n.js`.
- Keep code style: ES modules, small functions, early returns, comments that explain *why*. `npm run lint` must pass.
- No new runtime dependencies without discussion; the front end must stay build-free (vendored libraries are rebuilt
  with `npm run build:vendor`).

## Tests

- `npm test` runs the suites in `test/`: conversation reducer, config/profiles, and a real server process.
- `scripts/qa/` has headless-Chrome end-to-end scripts
  (`node scripts/browse.mjs --url http://127.0.0.1:4173 --script scripts/qa/e2e-core.mjs`). They use a real model and
  are not part of CI.

## Pull requests

1. Open an issue first for anything large, so we can agree on the approach.
2. Branch from `main`, keep PRs focused, and add or update tests and docs.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …).
4. Fill in the PR template; include screenshots for UI changes (both directions if layout is affected).

By contributing you agree your work is released under the [MIT license](LICENSE) and that you follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
