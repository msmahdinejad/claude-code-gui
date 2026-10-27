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
  DELETE) must carry a same-origin `Origin` header. This blocks other websites you visit from driving the local server
  (CSRF) and DNS-rebinding attacks.
- **Strict CSP.** `default-src 'self'`; no inline scripts, no remote assets, no third-party requests from the UI.
- **No secrets to the browser.** Environment values of the active profile are never sent to the UI (only variable
  names, plus a short allow-list of harmless values); API keys and headers stay in the server process.
- **Path hygiene.** Routes that write (editor, terminal working directory, git actions) resolve paths and refuse to
  leave the session's project folder; git arguments are validated; the terminal only starts in existing directories.
- **Sanitized rendering.** Model output is rendered as Markdown through DOMPurify; links open with `noopener`.
- **Permissions stay Claude Code's.** Tool approvals, permission modes, allow/deny rules and hooks are enforced by the
  Claude Code executable, not re-implemented here. "Bypass permissions" must be enabled explicitly in Settings.

What it does **not** do:

- It does not sandbox Claude Code. Approving a command lets it run with your privileges.
- It has no authentication of its own; anyone who can already run code as you on this machine can use it. Do not put it
  behind a reverse proxy or tunnel on a shared or public host.
- The terminal panel is a command runner for your own commands, with your privileges.
- Plugins, MCP servers, skills and hooks you install can run code; install only what you trust.

## Hardening tips

- Keep the server bound to loopback and do not forward its port.
- Prefer the `default` or `acceptEdits` permission modes outside throwaway environments; use `bypassPermissions` only in
  sandboxes.
- Keep secrets in environment variables and reference them from profiles as `${VAR}` instead of writing them into
  `wheelhouse.config.json` (which is git-ignored by default).
