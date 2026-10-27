# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/) (while `0.x`, minor versions may change the config format).

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
