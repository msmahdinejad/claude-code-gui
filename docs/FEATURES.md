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
| Message queue while busy, send-now (interrupt), Esc to stop | ✅ | |
| Prompt suggestions, voice dictation (fa-IR) | 🟡 | |
| Sub-agent transcripts, background tasks (stop / background) | ✅ | Tasks tab |
| Fork from message, rewind files to message | ✅ | Checkpoints tab (rewind tracks Write/Edit only — CLI behaviour) |
| `/compact` | ✅ | |

## Model & modes
| Feature | Status |
|---|---|
| Model picker from the gateway (Opus/Fable/Sonnet/Haiku/custom), live switch | ✅ |
| Effort levels, extended-thinking toggle | ✅ / 🟡 |
| Permission modes: ask, accept edits, plan, auto, don't ask, bypass (opt-in) | ✅ / 🟡 (auto, dontAsk, bypass not exercised) |
| Fast mode | ❌ (use `/fast` in the composer) |

## Sessions & projects
Sessions grouped by project, search, pin, archive, rename, fork, delete, resume, copy ID/resume command, folder picker, draft persistence — ✅.
Worktrees (`--worktree`) via Advanced → session options — 🟡.

## Panels (inspector)
Changes/Git (stage, commit, branches, log, diff unified/split) ✅ · Files (tree, preview, edit/save, @-reference) ✅ · Terminal (non-PTY runner) ✅ ·
Context usage ✅ · Usage & rate limits ✅ · Tasks ✅ · Activity (hooks, denials, raw messages, stderr) ✅ · Checkpoints ✅ · MCP ✅ · Extensions overview ✅ · Plugins ✅.

## Settings
Permissions rules, env, hooks, memory (CLAUDE.md + rules), output styles, MCP servers, plugins, skills, slash commands, agents, raw settings.json, session start options — ✅ (hook types other than command/prompt via JSON toggle).

## Not built / not applicable
Claude Desktop cloud sessions, Remote Control, Chrome extension integration, computer use, scheduled tasks UI, PR monitoring, a real PTY terminal (interactive TUI programs), per-hunk staging, signing in (run `claude auth login` in a terminal, or use a connection profile).
