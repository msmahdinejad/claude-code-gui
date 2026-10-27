# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/) (while `0.x`, minor versions may change the config format).

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
