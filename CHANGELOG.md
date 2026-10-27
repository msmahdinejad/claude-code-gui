# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/) (while `0.x`, minor versions may change the config format).

## [Unreleased]

### Added
- **Reply**: a Reply button on every message, and a floating Reply button when you select text in the conversation;
  both put the text into the composer as a Markdown quote.
- Reasoning effort is now a button in the composer bar (it was a read-only badge) with a menu of all levels, including
  *Extra high* and *Max*, each with a short description.

### Fixed
- Settings (and every other page) stuck on "Loading…" in a window that had opened several conversations: each open event
  stream holds one of the browser's 6 connections per site, so the page ran out of connections. Only the current
  conversation and sessions that are working keep a stream (at most 3); the others are closed and re-attached from
  where they stopped when needed.

## [0.2.2] - 2026-10-27

### Fixed
- A page that stays open while the server restarts no longer shows only "Working…" for sessions that were open before
  (new messages were dropped because the page was still following the old server's message numbers, and a session the
  new server did not know yet was never re-attached). The page now detects a restart (boot id in the event stream),
  reloads its open conversations and re-attaches sessions as soon as the server starts them.

## [0.2.1] - 2026-10-27

### Added
- Proper app icon: PNG/ICO icon set (`web/icons`, `web/favicon.ico`) generated from the logo with `npm run build:icons`.
- On Windows the app window gets its own taskbar identity and icon instead of being grouped under Chrome; a pinned
  taskbar button relaunches Wheelhouse. The tray's *Start with Windows* shortcut has the icon too.
- `autoTitle`: new sessions get a short model-written title after the first reply.

### Fixed
- Session names no longer show the whole first prompt (or the last prompt): until the model title arrives a shortened
  first prompt is shown (greetings, links and code blocks dropped).

## [0.2.0] - 2026-10-27

### Added
- Windows tray icon (`--tray` or `tray.enabled`): click to open or focus the app window, menu with *Open*, *Open in browser*,
  live status (idle / working / waiting), *Start with Windows* and *Quit*; a yellow dot while a session waits for approval.
- Global shortcuts: `Ctrl+Alt+W` (app window) and `Ctrl+Alt+Shift+W` (browser), configurable with `tray.hotkey` and
  `tray.browserHotkey`.
- Full quit: the tray's *Quit* and the new *Quit Wheelhouse* command (palette) stop the server, every Claude Code process and
  the window. The tray also cleans up after a server that stops on its own.
- `GET /api/status` and `POST /api/shutdown` (same-origin only).
- Running `wheelhouse --app` or `--open` while an instance is already up brings the existing window forward instead of
  failing with "port in use".

## [0.1.1] - 2026-10-27

### Changed
- The repository and package are now called `claude-code-gui` (the app keeps the Wheelhouse name).
- Development dependencies updated (eslint 10, marked 18, esbuild 0.28, puppeteer-core 25) and GitHub Actions bumped.

### Fixed
- The first-run "not signed in" notice is no longer hidden when `ANTHROPIC_BASE_URL` is the official API URL.
- Link to the Agent SDK documentation.

## [0.1.0] - 2026-10-27

First public release.

### Added
- Browser/standalone-window UI on top of the Claude Agent SDK with streaming conversations, tool cards, approval
  prompts, question forms, plan review, images, `@file` mentions, `/` commands, queue, interrupt, fork and rewind.
- Model, effort, thinking and permission-mode controls fed by the account's real model list.
- Session management by project, "new folder" sessions, native folder dialog (Windows, macOS, Linux).
- Inspector panels: Changes (git), Files, Terminal, Context, Usage, Tasks, Activity, Checkpoints, MCP, Extensions.
- Settings editors for permissions, environment, hooks, memory, output styles, MCP servers, plugins, skills, commands,
  agents and raw settings, per scope.
- Connection profiles (`wheelhouse.config.json`): choose the Claude Code executable and environment; test and switch
  profiles in the UI.
- English and Persian interface with full right-to-left support, light and dark themes.
