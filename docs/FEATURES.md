# Feature coverage (Claude Code CLI and desktop app → Wheelhouse)

Legend: ✅ built and exercised live · 🟡 built, only partly exercised · ❌ not built / not applicable

## Conversation
| Feature | Status | Notes |
|---|---|---|
| Streaming replies, Markdown, code highlight, tables, RTL/LTR per block | ✅ | |
| Thinking blocks (collapsible) | ✅ | toggle in Settings |
| Tool cards: Bash/PowerShell, Read, Write, Edit/MultiEdit (diffs), Grep, Glob, WebFetch/Search, TodoWrite, Agent/Task, Skill, MCP, generic | ✅ | |
| Permission prompts (allow / deny + reason / always-allow suggestions) | ✅ | |
| AskUserQuestion forms, plan approval (ExitPlanMode), MCP elicitation, generic dialogs | ✅/🟡 | elicitation & dialogs not exercised |
| Image attach / paste / drag-drop | ✅ | model saw the image |
| `@file` mentions, `/` command & skill popup | ✅ | |
| Message queue while busy, kept by the server (survives restarts, sent when the conversation is not open), edit / send-now (interrupt) / remove, Esc to stop | ✅ | |
| Prompt suggestions, voice dictation (fa-IR) | 🟡 | |
| Sub-agent transcripts, background tasks (stop / background) | ✅ | Tasks tab |
| Fork from message, rewind files to message | ✅ | Checkpoints tab (rewind tracks Write/Edit only — CLI behaviour) |
| `/compact` | ✅ | |
| Images returned by tools (Read on a picture, browser screenshots) with a viewer | ✅ | |
| PDF (≤10 MB) and text/code (≤500 KB) attachments | 🟡 | |
| `/goal` chip, background-subagent status strip, Workflow / ReportFindings / Artifact / PushNotification / SendUserFile cards | 🟡 | |
| API errors as one updating message (status in words, attempt, next retry) | ✅ | |
| Prompt history search (`Ctrl+R`), `!` local shell mode, session tags | ✅ | |
| Usage limit: queue held until the reset, then continue automatically (on by default, max 3 in a row) and the queue follows; runs on the server | 🟡 | tested with injected events, not a real limit |
| Status dot stays "working" while background subagents run; the finished notification waits for them | ✅ | |
| Split view: a second conversation with its own message box and approval cards | ✅ | |
| Resume sessions interrupted by a restart (off by default) | 🟡 | tested with a fake session manager |

## Model & modes
| Feature | Status |
|---|---|
| Model picker from the gateway (Opus/Fable/Sonnet/Haiku/custom), live switch | ✅ |
| Effort levels, extended-thinking toggle | ✅ / 🟡 |
| Permission modes: ask, accept edits, plan, auto, don't ask, bypass (opt-in) | ✅ / 🟡 (auto, dontAsk, bypass not exercised) |
| Fast mode, ultracode, advisor | 🟡 (*Speed and extras* in the model picker, where the model supports them) |

## Sessions & projects
Sessions grouped by project, search, pin, archive, rename, fork, delete, resume, copy ID/resume command, folder picker, draft persistence (on the server, attachments included) — ✅.
Worktrees (`--worktree`) via Advanced → session options — 🟡. Listing and removing git worktrees (including `.claude/worktrees/`) in the Changes panel — ✅.

## Panels (inspector)
Changes/Git (stage, commit, branches, log, diff unified/split, push, pull fast-forward, stash, PR card via `gh`) ✅ · Files (tree, preview incl. SVG/Mermaid, highlighted editor, save with conflict check, @-reference) ✅ · Terminal (real PTY via optional `node-pty`, basic runner as fallback) ✅ · Preview (local web app, HTML/PDF) ✅ ·
File links in the chat with Claude Desktop's right-click menu ✅ · Artifacts (HTML/SVG/Mermaid/Markdown with versions) ✅ ·
Context usage ✅ · Usage & rate limits ✅ · Tasks ✅ · Activity (hooks, denials, raw messages, stderr) ✅ · Checkpoints ✅ · MCP ✅ · Extensions overview ✅ · Plugins ✅.

## Settings
Permissions rules, env, hooks, memory (CLAUDE.md, rules, auto memory), output styles, MCP servers, plugins, skills, slash commands, agents, raw settings.json, session start options — ✅ (hook types other than command/prompt via JSON toggle).
All 168 keys of the settings reference with search, validation and scopes · keyboard shortcuts (`keybindings.json`) · themes · environment suggestions (349 variables) · diagnostics · scheduled tasks (off by default; a task can run inside an existing session through the server-side send queue) · resume after restart (off by default) · Claude Code updates (chip, *Update and relaunch*, optional automatic) — 🟡/✅.

See [GUIDE.md](GUIDE.md) for how to turn each one on.

## Not built / not applicable
Claude Desktop cloud sessions, Remote Control, computer use, MCP resource listing / `@server:uri` completion (the Agent SDK offers no way to list them), PR monitoring beyond the status card, per-hunk staging, listing an account's *limit resets* (only `/limit-reset` in Claude Code can use them), signing in (run `claude auth login` in a terminal, or use a connection profile).
