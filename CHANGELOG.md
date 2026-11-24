# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/) (while `0.x`, minor versions may change the config format).

## [Unreleased]

### Fixed
- A session whose turn ended while a background shell (tests, a build) still runs now also stays "working" (orange),
  not only for subagents. Only tasks Claude Code itself marks as not activity (watchers) are left out.

## [0.9.0] - 2026-11-24

### Added
- **Server-side message queue** (`<dataDir>/outbox`): messages sent while Claude works, while a usage limit holds the
  session or while earlier ones still wait are kept by the server. They survive a restart or a closed window and are
  sent as soon as the session is free, also when the conversation is not on screen (before, a queued message only went
  once you opened the conversation, and a restart lost it). Waiting messages can be edited, sent now or removed; a failed
  send is retried, then paused with *Try again*. The split pane queues as well.
- **Usage limits hold the queue**: after a claude.ai limit stops a turn, nothing more is sent into the limit. At the
  reset the cut-off turn is continued first (automatic continue, now done by the server, so no window has to be open),
  then the queue follows. The banner tells how many messages wait and has *Send now* to skip the wait.
- **Drafts on the server** (`<dataDir>/drafts`): the text and attachments of every message box survive a restart, a
  closed window and another address or port.
- **Settings → Learning**: a view of a learning loop kept in the profile folder (`<config>/learning`): lessons caught by hooks and waiting for review (skip or put back; *Review with /reflect* fills the message box), learned skills with how often each skill was used and failed in the last 60 days, upkeep reports, and the local git history of the config folder with each change viewable. Read-only except the inbox status; every part is optional.

### Fixed
- A session whose turn has ended but whose background subagents still work now shows as working (orange) in the
  sidebar, the split pane, the *Running* filter and the tray, and the *finished* notification waits for them. Shells and
  monitors left running in the background do not count. Resume after restart also counts such sessions as working.
- A new session that never got a message failed its first send after a restart (*No conversation found*): it now starts
  fresh with its id.
- The *finished* notification no longer fires between two queued messages.

## [0.8.1] - 2026-11-22

### Added
- **Resume after restart** (*Settings → Resume after restart*): sessions that were working when Wheelhouse stopped are
  offered for continuing at the next start (a dialog), and, with the switch on (off by default), sessions interrupted in
  the last 30 minutes are continued by themselves: at most 3 at once, each once, with one message that asks them to
  check what already finished. Scheduled runs are never continued this way.
- A feature guide with screenshots ([docs/GUIDE.md](docs/GUIDE.md)); README, README.fa, FEATURES and CONFIGURATION brought up to date. The screenshots come from a throwaway demo project.

### Changed
- *Continue automatically after a usage limit* is now **on by default** (switch it off per conversation in the banner).

## [0.8.0] - 2026-11-20

### Added
- **Update and relaunch**: when a newer Claude Code is available, a chip next to the title (also with automatic updates
  off) opens a dialog with the versions, links to the changes and an *Update and relaunch* button with download
  progress; sessions on the old version restart on your next message.
- **Real terminal**: the Terminal tab runs a real pseudo-terminal (ConPTY on Windows, via the optional `node-pty`
  package) with colors and interactive programs; without it the previous basic terminal is used.
- **Preview** tab: a local web app (from `.claude/launch.json` or any `localhost` port) or a project HTML/PDF next to
  the conversation, with device widths.
- **Scheduled tasks** (*Settings → Scheduled tasks*, off by default): recurring prompts started as sessions while
  Wheelhouse is open; never in bypass mode, one run at a time, missed runs caught up once.
- **Split view**: a second conversation beside the main one (sidebar menu → *Open in split view*, or Alt+click), with
  its own message box and approval cards, a draggable divider and *Swap*.
- **Prompt history across sessions** with Ctrl+R, `!` shell mode (runs locally; you choose whether to send the output
  to Claude) and *Continue automatically after a usage limit* (off by default).

### Fixed
- The Claude Code updater could leave the installed Claude Code broken: when the large platform package could not be
  downloaded, npm still reported success and the old install was already gone. The new version is now installed
  next to the old one, checked (size and `--version`) and only then swapped in; the old version is restored by renaming
  if anything fails, with no network needed, and an interrupted swap is recovered at the next start.

## [0.7.0] - 2026-11-20

### Added
- **Every Claude Code setting in Settings**: 168 `settings.json` keys from the official settings reference, on six
  category pages plus a searchable *All Claude Code settings* page. Each row has a description, a docs link, the
  documented default, a Reset button, badges when another scope or a managed policy sets the key, and a control that
  matches the key's type (structured editors for `attribution`, `modelPicker`, `modelSettings`, `fallbackModel`,
  `statusLine`, `spinnerVerbs`, `voice`, worktree and sandbox keys…). Input is validated before it is saved, only the
  edited key is written, and keys Wheelhouse doesn't know are kept. Keys read only from user settings are locked in
  project and local scope. The old *Advanced → Common settings* tab now points to these pages.
- **Memory**: *Settings → Memory* has three tabs. *Rules* lists, creates, renames and deletes `.claude/rules/**/*.md`
  for the project and the user, with an editor for the `paths` frontmatter. *Auto memory* finds the project's memory
  folder the way Claude Code does (git root, `autoMemoryDirectory`, `CLAUDE_CODE_PROJECT_DIR_NAME`), shows whether
  auto memory is on (with a toggle), the `MEMORY.md` index with a warning near the 200-line / 25KB load limit, and
  lets you view, edit, create and delete memories.
- **Keyboard shortcuts** and **Themes** pages for `keybindings.json` and `themes/*.json` (documented contexts,
  actions and chord syntax; theme tokens with swatches and a preview). The *Environment* page suggests 349 documented
  variables with English and Persian descriptions and masks secret values.
- **Diagnostics** page: Claude Code version, `auth status`, `mcp list`, `doctor`, the executable, profile, config
  folder and update status in one place.
- **Git**: push, pull, stash and a pull request card (via `gh`: status, checks, create, open), and a list of git
  worktrees (including Claude Code's `.claude/worktrees/`) with size, branch, state and Remove.
- **Conversation**: images that tools return (Read on a picture, screenshots from browser or MCP tools) are shown,
  with a viewer; `/goal` shows a chip with the condition, turns, last reason and Clear; a refused reply that fell back
  to another model removes the retracted messages and offers *Edit and retry*; recalled memories and plugin installs
  get notices; Workflow, PushNotification, Artifact, SendUserFile, ReportFindings (with *Fix this*), ProposeGoal and
  worktree tools get their own cards. *Compact now* takes optional focus instructions.

### Fixed
- Live replies stayed "streaming" until a reload: Claude Code sends one message per content block, and the page
  stopped following a reply after its first block. Text after thinking now streams, and Reply/Copy/Fork, the model
  and the token count appear as soon as a reply ends.
- Long conversations did work proportional to their length on every streamed token; rendering is now linear and the
  streaming reply's Markdown is re-rendered at most every 100 ms.
- Security: a GET request could make git write a file (`base=--output=…` on a legacy diff route), and pages on other
  sites could trigger GET routes that start processes. Cross-site requests (`Sec-Fetch-Site`, `Referer`) are refused,
  the unused legacy `/api/git/{diff,log,branches,action}` routes are gone, and git arguments that look like options
  are rejected. Gateway URLs, MCP arguments and `.mcp.json` values no longer reach the page unmasked.
- A session restarted while it was still starting (changing model or mode right after the first message) killed the
  new process. Streams attached to a session that was removed or stopped by a profile switch now end, so replies
  after it are not lost; session streams get keepalive pings.
- Profile names such as `constructor` stopped every session and then failed.
- The Claude Code updater now only uses its own copy for npm installs without a custom command, removes old copies,
  waits for every Claude Code process (sign-ins, `/limit-reset` windows, CLI runs) before replacing files, and runs
  npm without a shell.
- File names with non-Latin characters (Persian) came back garbled from file search and git.
- The Files editor lost unsaved edits when the panel re-rendered; terminal tabs held a browser connection each and
  could starve other requests; the Output styles page kept showing the old style as active; the Hooks page never showed
  *Effective hooks*; settings pages could show and save the wrong scope after a quick tab switch; clearing a value in
  Session options didn't apply; the Environment table lost typing and silently overwrote a duplicate name; approval
  cards accepted double clicks and empty answers; Persian text in the Markdown editors was laid out left to right.

## [0.6.3] - 2026-11-11

### Changed
- The model list's **Fable** row follows the newest Fable that has answered on the account: Claude Code keeps it at
  Fable 5.1 on Team plans (also with `ANTHROPIC_DEFAULT_FABLE_MODEL` set, which a claude.ai sign-in ignores), although
  `claude-fable-5-2` already answers. The row now uses Fable 5.2 with the same 1M tag, and Fable 5.1 stays available as
  "Fable 5.1 (1M)". The same applies to any model family once a newer version has answered.
- The limit-reset dialog says that Wheelhouse cannot see which resets an account has: the reset types are listed under
  "Or use a type directly (only if the account has one)", and *Open /limit-reset* is the way to see them.

## [0.6.2] - 2026-11-11

### Added
- **Limit resets** (`/limit-reset`, the command palette, or *Usage → Limit resets…*): the "Reset for free" resets of an
  account are handled only by Claude Code's own terminal screen (claude.ai does not offer them to other clients), so
  Wheelhouse opens Claude Code 2.1.322+ in a new terminal window, signed in as the chosen profile, with `/limit-reset` or
  `/limit-reset fable|full|5-hour|weekly`. Every button asks first, because Claude Code may use the reset right away.
- *Settings → Updates → Update now* updates the Claude Code your terminal runs at once, without waiting for a quiet
  moment (sessions that run the old version are stopped and continue on the next message).
- **Models you use stay in the model list**: Claude Code lists only the models it knows, and on Team and Enterprise plans
  it keeps showing an older one (Fable 5.1) until the organization allows the newer one, even though the newer one
  (`claude-fable-5-2`) already answers. A model picked with *Custom model…*, or one that answered in a conversation, is now
  remembered and listed with a readable name ("Fable 5.2") in the model picker, the composer and *Settings → Model &
  behavior*. A remembered model can be removed from the list with its ✕.

## [0.6.1] - 2026-11-10

### Added
- **Background subagents are visible**: a subagent started in the background used to show as a closed, finished
  "Agent" card while it was still working. Its card now follows the subagent itself: a spinner while it runs, what it is
  doing right now, how many tools it used and for how long; opened, it shows the subagent's own messages and tool calls.
  A *running in the background* strip under the conversation lists every subagent and background command that is still
  working after the turn ended; a click opens its card.

### Changed
- **Claude Code updates no longer wait for a quiet moment**: the new version is installed into Wheelhouse's own folder
  (`~/.wheelhouse/claude-code/<version>`) and used at once for new sessions and the model list, so a new model appears
  even while sessions keep working (0.6.0 waited until no session was busy, which for a busy user never happened).
  Sessions that are working keep their process. The Claude Code that the terminal runs is still updated in a quiet
  moment, after which Wheelhouse uses it again and removes its own copy.

### Fixed
- *Usage → Plan limits* showed a window that was 1% used as 100% used (the value is a percentage; it was read as a
  fraction when it was at most 1). The Fable limit looked used up after a dollar or two.
- An idle session whose subagents were still working in the background could be stopped (after 25 minutes without
  activity, or for an update), which ended those subagents. Sessions with background work are now left running, and
  background tasks of a process that did end are no longer shown as running.

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
