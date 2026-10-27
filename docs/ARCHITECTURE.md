# Architecture

Wheelhouse = a small Node server on the official `@anthropic-ai/claude-agent-sdk` + a build-free ES-module front end.

```
 Browser UI ⇄ HTTP/SSE ⇄ server/index.mjs ⇄ Agent SDK query() ⇄ claude (per active session) ⇄ model provider
```

Design rules:

1. **Never talk to the model API.** Every model request is made by the Claude Code executable of the active
   [profile](CONFIGURATION.md). Wheelhouse only forwards the SDK's messages and control calls.
2. **Forward raw messages.** The server adds only a few synthetic `wh_*` messages (user echo, permission/dialog requests,
   lifecycle). The browser folds the stream (and transcript history) into a conversation model.
3. **Local and loopback-only** (see [SECURITY.md](../SECURITY.md)).
4. **Features are modules.** Shared code stays small; a feature is a file in `web/js/features/` (and optionally a CSS file,
   a server route module and a translation file), discovered automatically.

## Layout

```
bin/wheelhouse.mjs          CLI entry
server/index.mjs            HTTP + SSE server, REST routes, static files, feature discovery
server/lib/config.mjs       config file / flags / env, connection profiles, executable resolution
server/lib/session-manager  ClaudeSession: SDK query(), event buffer, permission/dialog plumbing, control ops
server/lib/catalog.mjs      models / commands / agents / MCP / account for a cwd (idle SDK session, cached)
server/lib/fs-git.mjs       fs list/read/write, git info/diff/log/actions, @file search
server/lib/claude-files.mjs settings.json / CLAUDE.md / agents|skills|commands|output-styles files per scope
server/lib/ui-store.mjs     UI-owned state (pins, per-session meta, prefs, recents) in ~/.wheelhouse
server/lib/routes/*.mjs     EXTENSION POINT: server routes per feature (auto-loaded)
web/index.html              shell
web/css/*.css               tokens, base, layout, chat, panels, polish (final layer)
web/css/features/*.css      EXTENSION POINT: feature styles (auto-loaded)
web/js/core/                dom.js (h(), modal, popover, menu, toast), icons.js, i18n.js, state.js, api.js, registry.js
web/js/chat/                reducer.js (SDK messages → conversation), view.js, tools.js, requests.js, markdown.js
web/js/ui/                  sidebar, topbar, chatpane, composer, inspector, settings shell, palette, pickers, …
web/js/session.js           session controller (open/new/send/respond/setModel/…)
web/js/ctx.js               makeCtx() passed to feature modules
web/js/features/*.js        EXTENSION POINT: feature modules (core.js is loaded first)
web/js/i18n/fa/*.js         EXTENSION POINT: Persian strings per feature (auto-loaded)
web/vendor/md.js            generated: marked + DOMPurify + highlight.js (npm run build:vendor)
```

## Data flow

- `POST /api/sessions` creates a draft session (no process yet). The first message starts a long-lived `claude` process
  with streaming input; `GET /api/sessions/:id/stream` (SSE) delivers its messages with sequence numbers, so a reload or
  reconnect resumes without gaps. Transcript history comes from the SDK's `getSessionMessages`.
- Interactive requests (tool permissions, `AskUserQuestion`, plan approval, MCP elicitation) arrive through the SDK's
  `canUseTool` / `onElicitation` / `onUserDialog` callbacks, are shown in the UI and answered via
  `POST /api/sessions/:id/respond`.
- Live changes (`setModel`, `setPermissionMode`, `applyFlagSettings`, …) are SDK control requests exposed at
  `POST /api/sessions/:id/control`. Options that only exist at process start are applied by restarting the process in place.
- A **profile** (one active at a time) decides the executable and environment; switching stops sessions and re-applies the
  environment to the server process.

## Adding a feature (no shared files are edited)

1. `web/js/features/<name>.js` imports from `../core/*.js` and registers things:
   - `registerSettingsSection({ id, title, icon, order, render(container, ctx) })`: a page in the Settings dialog
   - `registerInspectorTab({ id, title, icon, order, render(container, ctx) → cleanup?, badge?(ctx), when?(ctx) })`
   - `registerCommand({ id, title, icon, keywords, shortcut, slash?, slashAliases?, run(ctx, args) })`: palette entry;
     `slash: "name"` also intercepts `/name` in the composer
   - `registerToolRenderer(match, { icon, title(tool), summary(tool), body(tool, ctx) → Node[], defaultOpen?(tool) })`
2. Styles in `web/css/features/<name>.css`. Use the tokens in `css/tokens.css` and **logical properties** so RTL and LTR
   both work. Code, paths and identifiers get `dir="ltr"`; user/model text gets `dir="auto"`.
3. Server routes in `server/lib/routes/<name>.mjs`:
   `export default ({ route, config, manager, catalog, store, HttpError, fsgit, cfiles, runClaudeCli, session }) => { route(method, "/api/regex", async ({ params, query, body }) => json) }`
4. Persian strings in `web/js/i18n/fa/<name>.js`: `export const fa = { "English source": "ترجمه" }`.
   Every user-visible string goes through `t("English source")` (`{name}` placeholders via `t("x {n}", { n })`).
   `npm run i18n:check` lists what is missing.

`ctx` (see `web/js/ctx.js`): `{ app, bus, api, toast, errorMessage, session, setPrefs, cwd, sessionId, live, conv,
openSettings(id), openInspector(id), runPrompt(text), fillComposer(text) }`.
`app` is the global state (`config`, `catalog`, `sessions`, `currentId`, `currentCwd`, `convs`, `live`, `prefs`).
`bus` events: `current`, `sessions`, `live`(id), `conv:update`(id), `meta`, `catalog`, `prefs`, `layout`, `attention`,
`open-file`({ path }), `composer:fill`.

## Server API (JSON, same-origin)

`GET /api/config`, `GET /api/catalog`, `GET|POST /api/sessions`, `GET|DELETE /api/sessions/:id`,
`POST /api/sessions/:id/{messages,start,interrupt,control,respond,meta,restart,close,rename,tag,pin,archive,fork}`,
`GET /api/sessions/:id/stream` and `GET /api/events` (SSE), `GET /api/fs/{list,read,search,home}`,
`GET /api/git/{info,diff,log,branches}`, `POST /api/git/action`, `GET|PUT /api/settings`, `GET|PUT /api/claude-md`,
`GET /api/resources`, `GET|PUT|DELETE /api/resource`, `POST /api/cli` (allow-listed `claude mcp|plugin|auth …`),
`GET /api/profile`, `POST /api/profile/{test,switch}`, `GET /api/profile/status`, `POST /api/pick-folder`,
`POST /api/workspaces/new`, `GET /api/features`. Feature modules add more under `server/lib/routes/`.

SDK types for everything the SDK exposes live in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

## Testing

- `npm test`: `test/reducer.test.mjs` (message → conversation logic), `test/config.test.mjs` (config, profiles),
  `test/server.test.mjs` (spawns the real server: security headers, origin checks, routes).
- `scripts/browse.mjs` drives headless Chrome (puppeteer-core, no browser download); `scripts/qa/*.mjs` are end-to-end and
  screenshot scripts, e.g. `node scripts/browse.mjs --url http://127.0.0.1:4173 --script scripts/qa/tour.mjs --lang fa`.
  The ones that send messages use a real model.
- Live model calls cost real money: use `haiku` and tiny prompts.
