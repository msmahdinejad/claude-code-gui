# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/) (while `0.x`, minor versions may change the config format).

## [0.6.0] - 2026-11-10

### Added
- **Automatic Claude Code updates**: Claude Code lists only the models it knew when it was built, so a new model (such as
  Fable 5.2, added in Claude Code 2.1.322) is missing from the picker until the CLI is updated, and a profile that sets
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` also switches off the CLI's own updater. Wheelhouse now checks the npm
  registry every few hours, downloads a newer version in the background and installs it once no session is working or
  waiting (idle Claude processes are stopped for a few seconds and start again on the next message). The new install is
  verified with `claude --version` and the old version is put back if it does not run. The model list is reloaded
  afterwards and the page says so. *Settings → Updates* has the switch (on by default), the installed/newest versions,
  *Check now* and *Update now*. `updateChannel: "stable"` in the UI preferences follows the `stable` tag instead of `latest`.

## [0.5.1] - 2026-11-06

### Changed
- **Clearer API errors**: a failing request now shows one message that says what happened in words, with the HTTP status
  (for example "The gateway timed out waiting for the model provider — HTTP 504"), the attempt ("Attempt 4 of 10"), when
  the next try happens and whose side the fault is on (gateway/provider, not your login). The attempts of one request update
  that message instead of adding a line each; *Details* has the raw status per attempt. The Activity tab shows the same.

## [0.5.0] - 2026-11-06

### Added
- **Sign in from the app**: when the OAuth login has expired ("OAuth session expired…", "Login expired · Please run
  /login"), the error message has a *Sign in* button; `/login`, the command palette and *Settings → Connection → Sign in*
  open the same dialog. It runs the CLI's own `auth login` for the profile, shows the sign-in link and takes the code the
  page displays, so no terminal is needed.
- **Earlier messages with Up/Down**: in the message box, Up (from the start of the box) steps back through the messages sent
  in the conversation and Down steps forward again, back to what you were typing.
- **Fork** and a *More* menu (copy, fork, ask again, rewind files) on every finished reply.

### Fixed
- The conversation jumped to the last message whenever the window came back to the front (and when switching sessions),
  losing the place you were reading. Every conversation now keeps its scroll position, also across a reload of that
  conversation; the timeline is only rebuilt when another conversation is shown.
- After *Reply* the message box takes the focus reliably, so you can type at once.

## [0.4.1] - 2026-11-03

### Fixed
- Queued messages (sent while Claude was still working) vanished after a few seconds and were never sent: the composer
  cleared the queue, and reset the text box, on every "current conversation" refresh (a title arriving, a reload, the
  window coming back to the front), not only when you switched conversations. The queue is now kept per conversation,
  survives those refreshes, and a conversation's queue is sent when you return to it. A queued message that fails to
  send goes back to the text box instead of being dropped.

## [0.4.0] - 2026-11-03

### Added
- **Native notifications** (Windows tray): a notification when a session finishes, needs your approval, has a question
  or has a plan ready. They are shown by the tray, so they arrive with the window closed; clicking one opens that
  conversation. The server decides what is worth announcing and stays quiet about the conversation you are reading in a
  focused window. *Settings → Notifications* has an on/off switch and a *Send* button for a test notification.
- A *Wheelhouse* Start menu shortcut is created on first tray start; it gives the notifications the app's name and icon.

### Changed
- Without a tray, the page-based notifications now use the same server-side events (finished, approval, question, plan),
  and the unused *Sound* switch was removed.

## [0.3.0] - 2026-11-02

### Added
- **Links open in your own browser**: a link clicked in the standalone window (`--app`) is opened as a new tab in the
  browser you already work in, instead of a new window of the app's private profile (which looked like "a new Chrome").
  `linkBrowser: "chrome"` picks Chrome explicitly. In a normal browser tab links behave as before. Only `http(s)` links
  are opened, never through a shell.
- **Use my open Chrome** (`chrome` option / Settings → Model & behavior): sessions get the Claude in Chrome tools, which
  work in the Chrome you already have open, and Claude is told not to start another browser. Needs the extension attached
  to Claude Code and signed in to the same account, see Troubleshooting.

### Changed
- Opening the UI in the default browser no longer goes through `cmd start` (links containing `&` were cut).

## [0.2.3] - 2026-10-28

### Added
- **Reply**: a Reply button on every message, and a floating Reply button when you select text in the conversation;
  both put the text into the composer as a Markdown quote.
- Reasoning effort is now a button in the composer bar (it was a read-only badge) with a menu of all levels, including
  *Extra high* and *Max*, each with a short description.

### Fixed
- The app icon showed as a blank page on Windows shortcuts and the taskbar: the ICO stored its small sizes as PNG, which
  the Windows shell does not read (browsers do). The ICO now uses bitmap images for the small sizes, and shortcuts,
  *Start with Windows* and the taskbar button reference a copy in the data folder (`~/.wheelhouse/wheelhouse.ico`),
  because the shell also refuses icons stored in some protected folders.
- A session started from a new chat appeared in the sidebar only after a manual refresh. It is now listed as soon as its
  first message is sent, named from that message until the model title arrives.
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
