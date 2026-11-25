# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting:
<https://github.com/msmahdinejad/claude-code-gui/security/advisories/new>. Include steps to reproduce, the version and your
operating system. Fixes are released as patch versions and credited in the changelog unless you prefer otherwise.

Supported versions: the latest `0.x` release.

## Threat model

Wheelhouse is a **local tool**: it runs on your machine as your user and lets Claude Code (and you) read files, edit
files and run commands there. That is its purpose. The security work is about making sure *only you* can drive it.

What it does:

- **Loopback only.** The server binds to `127.0.0.1`; the port is never exposed on the network by Wheelhouse.
- **Origin checks.** Every `/api` request must come from a loopback `Host`, and state-changing requests (POST, PUT,
  DELETE) must carry a same-origin `Origin` header. A request that a browser marks as coming from another site
  (`Sec-Fetch-Site` other than `same-origin`, or a `Referer` from another origin) is refused for every method, so a
  page you visit cannot trigger even a GET (an image or script tag sends no `Origin`). This blocks other websites from
  driving the local server (CSRF) and DNS-rebinding attacks; tools without browser headers (the tray, curl) still work.
- **Strict CSP.** `default-src 'self'`; no inline scripts, no remote assets, no third-party requests from the UI.
- **No secrets to the browser.** Environment values of the active profile are never sent to the UI (only variable
  names, plus a short allow-list of harmless values); API keys and headers stay in the server process.
- **Path hygiene.** Routes that write (editor, terminal working directory, git actions) resolve paths, follow symlinks
  and refuse paths outside the project folder the request names; git revisions and branch names are validated (nothing
  that starts with `-` reaches git as an option); the terminal only starts in existing directories. Memory, rules,
  keybindings and theme routes only touch Markdown/JSON files inside their own folders.
- **File links and artifacts.** File links only *view* files outside the project folder (editing stays inside it),
  never show, resolve or open credential stores (`~/.ssh`, `~/.aws`, `~/.kube`, `.credentials.json`, `*.pem`, ...),
  and hand to the default app only documents and media, never programs or scripts. Artifact names are validated
  (`.wheelhouse/artifacts/<name>.{html,svg,md,mmd}`, no folders, no symlinks, at most 5 MB). HTML artifacts are served
  with a CSP sandbox (opaque origin, `connect-src 'none'`, no images or frames from the network, scripts only from the
  app's bundled libraries and three public CDNs) and framed without `allow-same-origin`, so a page Claude writes cannot
  read the app, its storage or call its API; SVG is shown as an image (no scripts); Mermaid renders in strict mode.
  `GET /api/artifacts/view` is the one API request a browser may also make as a top-level navigation (*Open in
  browser*); it returns only the sandboxed artifact.
- **Sanitized rendering.** Model output is rendered as Markdown through DOMPurify; links open with `noopener`.
- **Permissions stay Claude Code's.** Tool approvals, permission modes, allow/deny rules and hooks are enforced by the
  Claude Code executable, not re-implemented here. "Bypass permissions" must be enabled explicitly in Settings.

What it does **not** do:

- It does not sandbox Claude Code. Approving a command lets it run with your privileges.
- It has no authentication of its own; anyone who can already run code as you on this machine can use it. Do not put it
  behind a reverse proxy or tunnel on a shared or public host.
- The terminal panel is a real shell (a pseudo-terminal) and the `!` message prefix runs a command locally, both with your
  privileges and only for the page that is open on this machine. Preview frames only `localhost` / `127.0.0.1` (a CSP
  `frame-src` allows nothing else), never Wheelhouse's own port, and runs project HTML without scripts unless you allow
  them. Dev servers from `.claude/launch.json` start only after you confirm the command.
- Scheduled tasks are **off by default**; when on, they run unattended only in `plan`, `acceptEdits`, `dontAsk` or
  `auto` mode (never bypass), one at a time, with turn and time limits. Resuming interrupted sessions is also off by
  default and sends one fixed message per session. Both use your account's usage.
- Updating Claude Code installs the new version next to the old one, checks it and swaps it in; it downloads only the
  official `@anthropic-ai/claude-code` package through your own npm configuration.
- Plugins, MCP servers, skills and hooks you install can run code; install only what you trust.

## Hardening tips

- Keep the server bound to loopback and do not forward its port.
- Prefer the `default` or `acceptEdits` permission modes outside throwaway environments; use `bypassPermissions` only in
  sandboxes.
- Keep secrets in environment variables and reference them from profiles as `${VAR}` instead of writing them into
  `wheelhouse.config.json` (which is git-ignored by default).
