# Configuration

Wheelhouse works without any configuration: it runs the `claude` executable it finds on your `PATH` (or, if there is
none, the Claude Code binary bundled with the Agent SDK) using whatever you are already signed in with.

A config file is for pointing Wheelhouse at something else: a gateway, an API key, a cloud provider, a wrapper script, a
second Claude Code installation. Everything goes through **profiles**.

## Where the config lives

Wheelhouse reads the first file it finds:

1. `--config <file>`
2. `$WHEELHOUSE_CONFIG`
3. `./wheelhouse.config.json` (in the directory you start Wheelhouse from)
4. `~/.wheelhouse/config.json`

The file is JSON; `//` comments, `/* */` comments and trailing commas are allowed. Start from
[`examples/wheelhouse.config.example.json`](../examples/wheelhouse.config.example.json). Editors that understand JSON
Schema get completion from [`docs/config.schema.json`](config.schema.json) (`"$schema": "…/config.schema.json"`).

Precedence, highest first: command-line flags → environment variables → config file → built-in defaults.

## Top-level options

| Key | Default | Meaning |
|---|---|---|
| `port` | `4173` | Port (also `--port`, `WHEELHOUSE_PORT`). The server only ever listens on `127.0.0.1`. |
| `defaultCwd` | home directory | Working directory when none is chosen (`--cwd`, `WHEELHOUSE_CWD`). |
| `dataDir` | `~/.wheelhouse` | Wheelhouse's own state: pins, recent projects, per-session UI settings (`--data-dir`, `WHEELHOUSE_DATA_DIR`). Sessions themselves are stored by Claude Code in the profile's config directory. |
| `workspaceRoot` | `<Documents>/Claude` | Parent of the per-session folders created by **New folder** (also in Settings → General; `WHEELHOUSE_WORKSPACE_ROOT`). |
| `systemPromptAppend` | a short "reply in the user's language, keep code LTR" note | Appended to Claude Code's system prompt. `""` disables (`WHEELHOUSE_SYSTEM_PROMPT`). |
| `defaults.model` / `defaults.effort` / `defaults.permissionMode` | `default` / `""` / `default` | Starting values for new sessions. Anything the user picks in Settings → Model & behavior wins. |
| `defaultProfile` | first profile | Profile used at startup. The one chosen in Settings → Connection is remembered. |
| `profiles` | one profile running `claude` | See below. |

## Profiles

```jsonc
"profiles": {
  "gateway": {
    "label": "Company gateway",          // shown in Settings → Connection
    "description": "LiteLLM in front of Claude Code",
    "command": "claude",                 // absolute path, or a name on PATH; "" = auto
    "cli": "claude",                     // name used by "Copy resume command"
    "configDir": "~/.claude-gateway",    // CLAUDE_CONFIG_DIR for this profile
    "env": {                             // added to the process environment
      "ANTHROPIC_BASE_URL": "https://llm-gateway.example.com",
      "ANTHROPIC_CUSTOM_HEADERS": "X-Api-Key: ${GATEWAY_KEY}"
    },
    "unset": ["ANTHROPIC_API_KEY"],      // removed from the environment
    "proxyBypass": ["llm-gateway.example.com"]   // appended to NO_PROXY / no_proxy
  }
}
```

- **Secrets stay out of the file.** `"${VAR}"` and `"${VAR:-fallback}"` are expanded from the environment Wheelhouse was
  started with. A leading `~` expands to your home directory.
- **One profile is active at a time.** The active profile's environment is applied to the Wheelhouse process, so sessions,
  the model list, settings editors and the `claude mcp` / `claude plugin` commands all see the same thing. Switching
  (Settings → Connection → *Use this*) stops running sessions and reloads the list from that profile's config directory.
- **`command` resolution.** An absolute path is used as is. A bare name is looked up on `PATH`; on Windows a `claude.cmd`
  npm shim is mapped to the real `claude.exe` next to it. An empty `command` uses `claude` from `PATH`, and if that is
  missing, the binary bundled with the Agent SDK. A `.js` file is run with `node`.
- **Anything Claude Code reads from the environment works here**: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_MODEL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, … See the Claude Code documentation.
- **Use any compatible CLI.** The executable must speak Claude Code's stream-JSON protocol (that is what the Agent SDK
  drives). A wrapper script that sets variables and then `exec`s `claude` works; so does a fork of Claude Code.

Test a profile without starting a session: Settings → Connection → *Test* runs `<command> --version` and `auth status`.

## Examples

| File | For |
|---|---|
| [`wheelhouse.config.example.json`](../examples/wheelhouse.config.example.json) | Minimal starting point |
| [`gateway.config.example.json`](../examples/gateway.config.example.json) | LLM gateway / corporate proxy |
| [`api-key.config.example.json`](../examples/api-key.config.example.json) | Anthropic API key |
| [`cloud.config.example.json`](../examples/cloud.config.example.json) | Amazon Bedrock, Google Vertex AI |
| [`multi-profile.config.example.json`](../examples/multi-profile.config.example.json) | Several installations, wrapper scripts |

## Environment variables

| Variable | Purpose |
|---|---|
| `WHEELHOUSE_CONFIG` | Path of the config file |
| `WHEELHOUSE_PORT`, `WHEELHOUSE_CWD`, `WHEELHOUSE_DATA_DIR`, `WHEELHOUSE_WORKSPACE_ROOT` | Same as the options above |
| `WHEELHOUSE_SYSTEM_PROMPT` | Overrides `systemPromptAppend` |
| `CLAUDE_BIN` | Executable for the implicit default profile (when no config file defines profiles) |

## Command line

```
wheelhouse [--port <n>] [--config <file>] [--cwd <dir>] [--data-dir <dir>] [--open] [--app]
```

`--open` opens your default browser; `--app` opens a standalone window using Chrome or Edge (no tabs or address bar).
