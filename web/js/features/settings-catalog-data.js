// Catalog of the settings.json keys a person or a project can set, taken from the official reference:
// https://code.claude.com/docs/en/settings-reference (types, enum values, defaults, scopes and versions come from there).
// Pure data: no DOM, no i18n import (titles/descriptions are English source strings, translated in i18n/fa/settings-claude.js).
//
// Entry fields:
//   path        dotted key in settings.json             cat       docs category id (CATEGORIES)
//   type        bool | enum | string | number | stringList | object | map | json | flag
//   title, desc short English title and description     default   documented default (omitted when the docs say "unset")
//   defaultNote extra words about the default           options   enum values (strings or { value, label })
//   allowOther  enum also accepts other strings (pattern/hint validate them)
//   min/max/integer/exclusiveMin                         numbers
//   scopes      settings files the key is read from (default: all three)   scopeNote  why
//   since       minimum Claude Code version for the key   deprecated  replacement note
//   fields      object fields: { key, type, title, options, required, const, scopes, … }
//   valueField  map value field                           keyPattern/keyHint  map key check
//   schema      explicit schema for json entries          editor    custom editor name (settings-claude.js)
//   covers      other documented keys this entry edits    doc       docs key when it differs from path
//   suggest     "models" | "agents" (live suggestions)    placeholder, multiline, allowEmpty
import { S, PATTERNS } from "./settings-catalog-values.js";

export const CATEGORIES = [
  { id: "model", title: "Model and responses" },
  { id: "permission", title: "Auto mode and permission prompts" },
  { id: "sandbox", title: "Sandbox" },
  { id: "memory", title: "Memory and context" },
  { id: "interface", title: "Interface and terminal" },
  { id: "git", title: "Git and attribution" },
  { id: "hooks", title: "Hooks and automation" },
  { id: "plugins", title: "Plugins and skills" },
  { id: "mcp", title: "MCP" },
  { id: "agents", title: "Agents, sessions and worktrees" },
  { id: "remote", title: "Remote, desktop and notifications" },
  { id: "auth", title: "Authentication and providers" },
  { id: "updates", title: "Updates" },
  { id: "privacy", title: "Privacy and data retention" },
];

/** Settings dialog pages. Small docs categories are merged so the navigation stays short. */
export const SECTIONS = [
  { id: "cc-model", title: "Models & responses", icon: "sparkles", order: 15, cats: ["model"], lead: "Claude Code's own settings for models, effort, thinking and prompt caching." },
  { id: "cc-interface", title: "Terminal & interface", icon: "monitor", order: 16, cats: ["interface"], lead: "How Claude Code looks and behaves in the terminal: theme, status line, spinner, dictation and more." },
  { id: "cc-context", title: "Context, git & privacy", icon: "book", order: 17, cats: ["memory", "git", "privacy"], lead: "Compaction, memory, git attribution and how long data is kept." },
  { id: "cc-safety", title: "Auto mode & sandbox", icon: "shield-check", order: 18, cats: ["permission", "sandbox"], lead: "The auto mode classifier and the sandbox that isolates Bash commands." },
  { id: "cc-automation", title: "Workflows, skills & MCP", icon: "zap", order: 19, cats: ["hooks", "plugins", "mcp"], lead: "Hooks switches, dynamic workflows, skills, plugin marketplaces and MCP server approval." },
  { id: "cc-sessions", title: "Sessions & accounts", icon: "users", order: 20, cats: ["agents", "remote", "auth", "updates"], lead: "Agents, worktrees, Remote Control, notifications, sign-in helpers and update channel." },
];
export const ALL_SECTION = { id: "cc-all", title: "All Claude Code settings", icon: "search", order: 21, lead: "Search every settings.json key this editor knows about." };

/** Keys edited by other Settings pages: shown as links instead of rows. */
export const ELSEWHERE = [
  { section: "permissions", title: "Permissions", keys: ["permissions"], cats: ["permission"] },
  { section: "environment", title: "Environment", keys: ["env"], cats: ["memory"] },
  { section: "hooks", title: "Hooks", keys: ["hooks"], cats: ["hooks"] },
  { section: "output-styles", title: "Output styles", keys: ["outputStyle"], cats: ["model"] },
  { section: "plugins", title: "Plugins", keys: ["enabledPlugins"], cats: ["plugins"] },
];

const SHORT_TIMEOUTS = ["60s", "5m", "10m", "never"];
export const EFFORT = ["low", "medium", "high", "xhigh"];
export const MAX_EFFORT = ["low", "medium", "high", "xhigh", "max"];
const CACHE_TTL = ["5m", "1h"];
const absPath = PATTERNS.absPath;

const USER = ["user"];
const USER_LOCAL = ["user", "local"];
const USER_ONLY_NOTE = "Read only from user (and managed) settings; ignored in project and local files.";
const USER_LOCAL_NOTE = "Read from user and local settings (and managed); ignored in the shared project file.";

const MCP_MATCHER = (nameSchema) => S.arr(S.obj({ serverName: nameSchema, serverCommand: S.arr(S.str()), serverUrl: S.str() }, { exactlyOne: ["serverName", "serverCommand", "serverUrl"] }));
const CREDENTIAL_MODE = S.enumOf(["deny", "mask"]);

export const CATALOG = [
  // ---- Model and responses -----------------------------------------------------------------
  { path: "advisorModel", cat: "model", type: "enum", options: ["fable", "opus", "sonnet"], allowOther: true, suggest: "models", title: "Advisor model", desc: "Model that answers when Claude consults the advisor tool: an alias or a full model ID. Leave unset to turn the advisor off." },
  { path: "alwaysThinkingEnabled", cat: "model", type: "bool", title: "Extended thinking", desc: "Set to false to turn extended thinking off in every session. true changes nothing, because thinking is on by default." },
  { path: "availableModels", cat: "model", type: "stringList", suggest: "models", placeholder: "sonnet", title: "Available models", desc: "Limit which models can be picked for sessions, subagents, skills and the advisor. Mostly used in managed settings." },
  { path: "effortLevel", cat: "model", type: "enum", options: EFFORT, title: "Default effort level", desc: "Effort for models that have no level saved for them in modelSettings. Higher levels reason more and cost more." },
  { path: "enforceAvailableModels", cat: "model", type: "bool", default: false, since: "2.1.175", title: "Enforce available models for Default", desc: "When the Default model would fall outside availableModels, use the first allowed model instead." },
  { path: "fallbackModel", cat: "model", type: "stringList", editor: "orderedList", suggest: "models", placeholder: "claude-sonnet-5", title: "Fallback models", desc: "Backup models tried in order when the main model is overloaded or unavailable. At most three are used, and the list does not merge across files." },
  { path: "fastMode", cat: "model", type: "bool", title: "Fast mode", desc: "Turn fast mode on in sessions where it is available: faster output at a higher price. /fast writes this key." },
  { path: "fastModePerSessionOptIn", cat: "model", type: "bool", default: false, title: "Fast mode per session only", desc: "Make people run /fast in each session instead of a saved fastMode turning it on at start." },
  { path: "language", cat: "model", type: "string", placeholder: "persian", title: "Response language", desc: "Language Claude replies in by default, such as \"persian\" or \"japanese\". Also used for dictation and session titles. Not validated." },
  { path: "maxEffortLevel", cat: "model", type: "enum", options: MAX_EFFORT, since: "2.1.267", title: "Effort cap", desc: "Highest effort level a session may use; \"max\" sets no cap. When several files set a cap, the lowest one applies." },
  { path: "model", cat: "model", type: "string", suggest: "models", placeholder: "claude-sonnet-5", title: "Default model", desc: "Model every new session starts with: an alias such as sonnet or a full model ID." },
  { path: "modelOverrides", cat: "model", type: "map", valueField: { type: "string" }, keyPlaceholder: "claude-opus-4-6", placeholder: "arn:aws:bedrock:…", title: "Model ID overrides", desc: "Map Anthropic model IDs to provider-specific IDs, such as Amazon Bedrock inference profile ARNs." },
  {
    path: "modelPicker", cat: "model", type: "object", editor: "modelPicker", scopes: USER, scopeNote: "Read only from user (and managed) settings, so a cloned repository can't relabel the picker.", since: "2.1.242",
    title: "Model picker rows", desc: "Models the /model picker lists, in your order and with your labels, after the built-in list or instead of it.",
    schema: S.obj(
      {
        options: S.arr(S.obj({ model: S.str(), label: S.str(), description: S.str(), behavesAs: S.str() }, { required: ["model"] })),
        replaceBuiltInOptions: S.bool(),
      },
      { required: ["options"], additional: true },
    ),
    fields: [],
  },
  {
    path: "modelSettings", cat: "model", type: "map", editor: "modelSettings", since: "2.1.251", suggest: "models",
    title: "Per-model settings", desc: "Effort level, effort cap and auto-compact window saved for each model. /effort and /autocompact write here.",
    valueField: { type: "json" },
    schema: S.obj({}, {
      additional: S.obj(
        { effortLevel: S.enumOf(EFFORT), maxEffortLevel: S.enumOf(MAX_EFFORT), autoCompactWindow: S.anyOf(S.num({ integer: true, min: 100000, max: 1000000 }), S.constOf("auto")) },
        { additional: true },
      ),
    }),
  },
  { path: "promptCacheTtl", cat: "model", type: "enum", options: CACHE_TTL, since: "2.1.242", title: "Prompt cache lifetime", desc: "How long the prompt cache keeps the main conversation warm." },
  { path: "showThinkingSummaries", cat: "model", type: "bool", default: false, title: "Show thinking summaries", desc: "Show full thinking summaries when you expand thinking with Ctrl+O, instead of a collapsed stub." },
  { path: "subagentPromptCacheTtl", cat: "model", type: "enum", options: CACHE_TTL, since: "2.1.242", title: "Background prompt cache lifetime", desc: "Prompt cache lifetime for subagents, workflows and Claude Code's background helper requests." },
  { path: "switchModelsOnFlag", cat: "model", type: "bool", title: "Switch models when a message is flagged", desc: "When a safety classifier flags a request: true switches to the fallback model and continues, false pauses so you can choose." },
  { path: "ultracode", cat: "model", type: "bool", since: "2.1.284", title: "Start with ultracode", desc: "Start sessions with ultracode on, so Claude plans a workflow for each substantial task." },

  // ---- Auto mode and permission prompts (permissions.* is edited on the Permissions page) ----------------
  {
    path: "autoMode", cat: "permission", type: "object", scopes: USER, scopeNote: USER_ONLY_NOTE,
    title: "Auto mode rules", desc: "Your own prose rules for the auto mode classifier. Put \"$defaults\" in each list you set to keep the built-in rules; without it your rules can replace them.",
    fields: [
      { key: "environment", type: "stringList", title: "Environment" },
      { key: "allow", type: "stringList", title: "Allow" },
      { key: "soft_deny", type: "stringList", title: "Soft deny" },
      { key: "hard_deny", type: "stringList", title: "Hard deny" },
    ],
  },
  { path: "autoMode.classifyAllShell", cat: "permission", type: "bool", default: false, scopes: USER, scopeNote: USER_ONLY_NOTE, since: "2.1.193", title: "Classify every shell command", desc: "While auto mode is on, send every Bash and PowerShell command through the classifier and suspend your shell allow rules." },
  { path: "disableAutoMode", cat: "permission", type: "flag", value: "disable", title: "Disable auto mode", desc: "Remove auto mode from the Shift+Tab cycle; sessions that would start in auto mode start in default mode." },
  { path: "useAutoModeDuringPlan", cat: "permission", type: "bool", default: true, scopes: USER_LOCAL, scopeNote: USER_LOCAL_NOTE, title: "Auto mode during planning", desc: "Let the auto mode classifier review shell commands in plan mode. false asks about every command outside the read-only set." },
  { path: "skipAutoPermissionPrompt", cat: "permission", type: "bool", scopes: USER, scopeNote: USER_ONLY_NOTE, title: "Skip the auto mode notice", desc: "Skip the one-time notice shown the first time you enter auto mode yourself." },
  { path: "skipDangerousModePermissionPrompt", cat: "permission", type: "bool", scopes: USER_LOCAL, scopeNote: USER_LOCAL_NOTE, title: "Skip the bypass confirmation", desc: "Skip the confirmation dialog shown before a session enters bypassPermissions mode." },

  // ---- Sandbox -------------------------------------------------------------------------------------------
  { path: "sandbox.enabled", cat: "sandbox", type: "bool", default: false, title: "Sandbox Bash commands", desc: "Run Bash commands in a sandbox that limits what they can read, write and reach on the network." },
  { path: "sandbox.failIfUnavailable", cat: "sandbox", type: "bool", default: false, title: "Fail if the sandbox can't start", desc: "Exit at startup when sandboxing is on but the sandbox can't start, instead of running commands unsandboxed." },
  { path: "sandbox.autoAllowBashIfSandboxed", cat: "sandbox", type: "bool", default: false, defaultNote: "Before v2.1.324 the default was true.", title: "Auto-allow sandboxed commands", desc: "Run sandboxed Bash commands without a permission prompt. Deny rules and command-specific ask rules still apply." },
  { path: "sandbox.excludedCommands", cat: "sandbox", type: "stringList", placeholder: "docker *", title: "Commands outside the sandbox", desc: "Commands that always run outside the sandbox, written like the inside of a Bash(...) rule." },
  { path: "sandbox.allowUnsandboxedCommands", cat: "sandbox", type: "bool", default: true, title: "Allow retry outside the sandbox", desc: "Let Claude retry a blocked command outside the sandbox. false keeps every command sandboxed unless it is excluded." },
  { path: "sandbox.filesystem.allowWrite", cat: "sandbox", type: "stringList", placeholder: "~/.kube", title: "Extra writable paths", desc: "Paths sandboxed commands may write to, besides the working directory, temp and added directories." },
  { path: "sandbox.filesystem.denyWrite", cat: "sandbox", type: "stringList", title: "Write-protected paths", desc: "Paths sandboxed commands may not write to, even inside writable folders." },
  { path: "sandbox.filesystem.denyRead", cat: "sandbox", type: "stringList", placeholder: "~/.aws/credentials", title: "Read-protected paths", desc: "Paths sandboxed commands may not read, such as credential files." },
  { path: "sandbox.filesystem.allowRead", cat: "sandbox", type: "stringList", title: "Re-allowed read paths", desc: "Paths that stay readable inside a region blocked by the read-protected list." },
  { path: "sandbox.filesystem.disabled", cat: "sandbox", type: "bool", default: false, scopes: USER, scopeNote: USER_ONLY_NOTE, title: "Skip filesystem isolation", desc: "Give sandboxed commands full filesystem access while keeping network isolation." },
  {
    path: "sandbox.ignoreViolations", cat: "sandbox", type: "json", placeholder: "{\n  \"some-tool\": [\"/etc/hosts\"]\n}",
    title: "Ignored sandbox violations", desc: "Silence violation reports you expect: map a command substring to the paths it may be refused. Access is still blocked.",
    schema: S.obj({}, { additional: S.arr(S.str()) }),
  },
  { path: "sandbox.enableWeakerNestedSandbox", cat: "sandbox", type: "bool", default: false, title: "Weaker nested sandbox", desc: "Let the Linux sandbox run inside an unprivileged Docker container by reusing its /proc. Reduces isolation." },
  { path: "sandbox.enableWeakerNetworkIsolation", cat: "sandbox", type: "bool", default: false, title: "Weaker network isolation (macOS)", desc: "On macOS, let sandboxed commands reach the system TLS trust service, which some Go tools need behind a TLS-inspecting proxy." },
  { path: "sandbox.allowAppleEvents", cat: "sandbox", type: "bool", default: false, scopes: USER, scopeNote: USER_ONLY_NOTE, title: "Allow Apple Events (macOS)", desc: "Let sandboxed commands send Apple Events (open, osascript). This removes code-execution isolation." },
  { path: "sandbox.allowNestedUserNamespaces", cat: "sandbox", type: "bool", default: false, scopes: USER, scopeNote: "A true counts only from user (and managed) settings.", since: "2.1.305", title: "Allow nested user namespaces", desc: "On Linux and WSL2, let sandboxed commands create user namespaces (Chromium, Electron, nested bubblewrap). Turns off a security boundary." },
  {
    path: "sandbox.ripgrep", cat: "sandbox", type: "object", scopes: USER, scopeNote: USER_ONLY_NOTE,
    title: "Sandbox ripgrep binary", desc: "Use your own ripgrep binary in the sandbox instead of the one Claude Code uses.",
    fields: [
      { key: "command", type: "string", required: true, title: "Command", placeholder: "/usr/local/bin/rg" },
      { key: "args", type: "stringList", title: "Arguments to prepend" },
    ],
  },
  {
    path: "sandbox.credentials.files", cat: "sandbox", type: "json", placeholder: "[\n  { \"path\": \"~/.aws/credentials\", \"mode\": \"deny\" }\n]",
    title: "Protected credential files", desc: "Credential files or folders to hide (deny) or replace with a placeholder (mask) inside the sandbox.",
    note: "mask entries are honored only from user (and managed) settings.",
    schema: S.arr(S.obj({ path: S.str(), mode: CREDENTIAL_MODE }, { required: ["path", "mode"], additional: true })),
  },
  {
    path: "sandbox.credentials.envVars", cat: "sandbox", type: "json", placeholder: "[\n  { \"name\": \"GITHUB_TOKEN\", \"mode\": \"deny\" }\n]",
    title: "Protected environment variables", desc: "Environment variables to remove (deny) or replace with a placeholder (mask) for sandboxed commands.",
    note: "mask entries are honored only from user (and managed) settings.",
    schema: S.arr(S.obj({ name: S.str(), mode: CREDENTIAL_MODE }, { required: ["name", "mode"], additional: true })),
  },
  { path: "sandbox.credentials.allowPlaintextInject", cat: "sandbox", type: "bool", default: false, scopes: USER, scopeNote: USER_ONLY_NOTE, title: "Mask over plain HTTP", desc: "Allow mask substitution on plain HTTP requests too. The credential then travels in cleartext." },
  {
    path: "sandbox.credentials.awsPairs", cat: "sandbox", type: "json", scopes: USER, scopeNote: USER_ONLY_NOTE, since: "2.1.224",
    placeholder: "[\n  { \"accessKeyIdVar\": \"MY_AWS_KEY\", \"secretAccessKeyVar\": \"MY_AWS_SECRET\" }\n]",
    title: "AWS credential pairs", desc: "Group masked variables with non-standard names that form one AWS credential, for request re-signing.",
    schema: S.arr(S.obj({ accessKeyIdVar: S.str(), secretAccessKeyVar: S.str(), sessionTokenVar: S.str() }, { required: ["accessKeyIdVar", "secretAccessKeyVar"], additional: true })),
  },
  {
    path: "sandbox.credentials.sigv4", cat: "sandbox", type: "object", scopes: USER, scopeNote: USER_ONLY_NOTE, since: "2.1.224",
    title: "Unsigned AWS request forms", desc: "What the sandbox proxy does with AWS requests it can't re-sign. Unset forms are denied.",
    fields: [
      { key: "streaming", type: "enum", options: ["deny", "passthrough"], title: "Streaming uploads" },
      { key: "presigned", type: "enum", options: ["deny", "passthrough"], title: "Presigned URLs" },
      { key: "sigv4a", type: "enum", options: ["deny", "passthrough"], title: "SigV4A signatures" },
    ],
  },
  { path: "sandbox.network.allowUnixSockets", cat: "sandbox", type: "stringList", title: "Allowed Unix sockets (macOS)", desc: "Unix socket paths sandboxed commands may connect to on macOS. Ignored on Linux and WSL2." },
  { path: "sandbox.network.allowAllUnixSockets", cat: "sandbox", type: "bool", default: false, title: "Allow all Unix sockets", desc: "Let sandboxed commands connect to any Unix socket. This is the only way to allow sockets on Linux and WSL2." },
  { path: "sandbox.network.allowLocalBinding", cat: "sandbox", type: "bool", default: false, title: "Allow local ports (macOS)", desc: "On macOS, let sandboxed commands listen on ports (such as a dev server) and connect to localhost." },
  { path: "sandbox.network.allowMachLookup", cat: "sandbox", type: "stringList", title: "Allowed Mach services (macOS)", desc: "Extra XPC/Mach service names sandboxed commands may look up on macOS. A trailing * matches a prefix." },
  { path: "sandbox.network.allowedDomains", cat: "sandbox", type: "stringList", placeholder: "*.example.com", title: "Allowed domains", desc: "Domains sandboxed commands may reach without a prompt. Wildcards such as *.example.com and a :port suffix work." },
  { path: "sandbox.network.deniedDomains", cat: "sandbox", type: "stringList", title: "Denied domains", desc: "Domains that stay blocked even when an allowed entry matches them." },
  { path: "sandbox.network.strictAllowlist", cat: "sandbox", type: "bool", default: false, scopes: USER, scopeNote: USER_ONLY_NOTE, since: "2.1.219", title: "Strict domain allowlist", desc: "Deny hosts outside the allowlist instead of asking about them." },
  { path: "sandbox.network.httpProxyPort", cat: "sandbox", type: "number", integer: true, min: 1, max: 65535, placeholder: "8080", title: "Your HTTP proxy port", desc: "Send sandbox traffic to your own HTTP proxy on this local port. Your proxy then does the filtering." },
  { path: "sandbox.network.socksProxyPort", cat: "sandbox", type: "number", integer: true, min: 1, max: 65535, placeholder: "1080", title: "Your SOCKS5 proxy port", desc: "Send sandbox traffic to your own SOCKS5 proxy on this local port. Your proxy then does the filtering." },
  {
    path: "sandbox.network.tlsTerminate", cat: "sandbox", type: "object", presence: true, scopes: USER, scopeNote: USER_ONLY_NOTE,
    title: "Terminate TLS in the proxy", desc: "Experimental: let the sandbox proxy read HTTPS requests (needed for mask). Without a certificate it creates one per session.",
    fields: [
      { key: "caCertPath", type: "string", title: "CA certificate file" },
      { key: "caKeyPath", type: "string", title: "CA key file" },
    ],
  },

  // ---- Memory and context ------------------------------------------------------------------------------------
  { path: "autoCompactEnabled", cat: "memory", type: "bool", default: true, title: "Auto-compact", desc: "Compact the conversation automatically when the context window is nearly full." },
  { path: "autoCompactWindow", cat: "memory", type: "number", integer: true, min: 100000, max: 1000000, placeholder: "200000", title: "Auto-compact window (tokens)", desc: "How many tokens the context may hold before auto-compaction. Capped at the model's context window; unset picks a value tuned for the model." },
  { path: "autoMemoryDirectory", cat: "memory", type: "string", ...absPath, placeholder: "~/claude-memory", title: "Auto memory folder", desc: "Folder for auto memory instead of the per-project default under ~/.claude/projects." },
  { path: "autoMemoryEnabled", cat: "memory", type: "bool", default: true, title: "Auto memory", desc: "Let Claude read and write its auto memory folder." },
  { path: "bashOutputMaxChars", cat: "memory", type: "number", integer: true, min: 1, since: "2.1.261", placeholder: "30000", defaultNote: "Up to 30,000 characters inline.", title: "Shell output kept inline", desc: "Characters of a command's output Claude gets inline; the rest is saved to a file. Clamped to 4,000–128,000." },
  { path: "claudeMdExcludes", cat: "memory", type: "stringList", placeholder: "**/other-team/CLAUDE.md", title: "Skipped CLAUDE.md files", desc: "CLAUDE.md files not to load, as glob patterns or absolute paths." },
  { path: "fileCheckpointingEnabled", cat: "memory", type: "bool", default: true, title: "File checkpoints", desc: "Snapshot files before each edit so /rewind can restore them." },
  { path: "idleCompaction", cat: "memory", type: "bool", default: true, since: "2.1.290", title: "Compact while idle", desc: "Compact a long conversation you stepped away from, so your next message sends a summary." },
  { path: "plansDirectory", cat: "memory", type: "string", placeholder: "docs/plans", defaultNote: "~/.claude/plans", title: "Plans folder", desc: "Where plan mode saves its plan files, relative to the project root." },
  { path: "skillListingBudgetFraction", cat: "memory", type: "number", exclusiveMin: 0, max: 1, default: 0.01, title: "Skill listing budget", desc: "Share of the context window the skill listing may use (0.01 = 1%)." },
  { path: "skillListingMaxDescChars", cat: "memory", type: "number", integer: true, min: 1, default: 1536, title: "Skill description length", desc: "Characters of each skill's description shown in the skill listing." },

  // ---- Interface and terminal ----------------------------------------------------------------------------------
  { path: "askUserQuestionTimeout", cat: "interface", type: "enum", options: SHORT_TIMEOUTS, default: "never", scopes: USER, scopeNote: USER_ONLY_NOTE, title: "Question auto-continue", desc: "Continue an unanswered question dialog after this much idle time, with the options already picked." },
  { path: "autoContinueAtUsageLimit", cat: "interface", type: "bool", default: true, scopes: USER, scopeNote: "Read from user (and managed) settings; in project and local files it can only turn the feature off.", since: "2.1.234", title: "Continue after usage limit", desc: "After a claude.ai usage limit stops a session, wait and continue the task once the limit resets." },
  { path: "autoScrollEnabled", cat: "interface", type: "bool", default: true, title: "Auto-scroll", desc: "Follow new output to the bottom in fullscreen mode." },
  { path: "axScreenReader", cat: "interface", type: "bool", scopes: USER, scopeNote: USER_ONLY_NOTE, title: "Screen reader mode", desc: "Flat text output without decorative borders or animations." },
  { path: "bashEditDiffEnabled", cat: "interface", type: "bool", scopes: USER, scopeNote: "A true counts only from user (and managed) settings.", since: "2.1.269", title: "Track files changed by Bash", desc: "Record which files a Bash command changed, show their diff and pass the list to PostToolUse hooks." },
  { path: "companyAnnouncements", cat: "interface", type: "stringList", multiline: true, title: "Startup announcements", desc: "Messages shown at startup; one is picked at random for each session." },
  { path: "defaultShell", cat: "interface", type: "enum", options: ["bash", "powershell"], default: "bash", defaultNote: "powershell on Windows when Bash isn't available.", title: "Shell for ! commands", desc: "Shell that runs the commands you type with the ! prefix." },
  { path: "dialogExpiry", cat: "interface", type: "enum", options: SHORT_TIMEOUTS, default: "5m", scopes: USER, scopeNote: USER_ONLY_NOTE, since: "2.1.224", title: "Remote dialog deadline", desc: "How long dialogs forwarded to a remote client (Remote Control, SDK hosts) wait for an answer; never disables the deadline." },
  { path: "editorMode", cat: "interface", type: "enum", options: ["normal", "vim"], default: "normal", title: "Prompt key bindings", desc: "Normal key bindings or vim-style editing in the prompt input." },
  { path: "emojiCompletionEnabled", cat: "interface", type: "bool", default: true, title: "Emoji completion", desc: "Suggest emoji after : and replace finished shortcodes such as :heart:." },
  {
    path: "fileSuggestion", cat: "interface", type: "object",
    title: "Custom @ file suggestions", desc: "Your own command that supplies @ file path suggestions instead of the built-in search.",
    fields: [
      { key: "type", type: "string", const: "command" },
      { key: "command", type: "string", required: true, title: "Command", placeholder: "~/.claude/file-suggestion.sh" },
    ],
  },
  {
    path: "footerLinksRegexes", cat: "interface", type: "json", scopes: USER, scopeNote: USER_ONLY_NOTE,
    placeholder: "[\n  {\n    \"type\": \"regex\",\n    \"pattern\": \"\\\\b(?<key>PROJ-\\\\d+)\\\\b\",\n    \"url\": \"https://issues.example.com/browse/{key}\"\n  }\n]",
    title: "Footer link badges", desc: "Turn IDs in Claude's output into clickable footer badges: a regex with named groups and a URL template.",
    schema: S.arr(S.obj({ type: S.constOf("regex"), pattern: S.str(), url: S.str(), label: S.str() }, { required: ["type", "pattern", "url"], additional: true })),
  },
  { path: "maxProseWidth", cat: "interface", type: "number", integer: true, min: 40, since: "2.1.282", placeholder: "100", title: "Prose width (columns)", desc: "Wrap Claude's prose at this many columns in wide terminals. Tables and code keep the full width." },
  { path: "prefersReducedMotion", cat: "interface", type: "bool", default: false, title: "Reduce motion", desc: "Reduce or turn off the spinner, shimmer and flash animations." },
  { path: "promptSuggestionEnabled", cat: "interface", type: "bool", default: true, title: "Prompt suggestions", desc: "Show greyed-out predictions in the prompt input." },
  { path: "respectGitignore", cat: "interface", type: "bool", default: true, title: "Respect .gitignore in @ picker", desc: "Leave files that match .gitignore out of the @ file picker." },
  { path: "respondToBashCommands", cat: "interface", type: "bool", default: true, title: "Reply to ! commands", desc: "Have Claude reply after you run a ! command. false only adds the output to the context." },
  { path: "showClearContextOnPlanAccept", cat: "interface", type: "bool", default: false, title: "Offer \"clear context\" on plan approval", desc: "Add an option to the plan approval menu that clears the context and then starts implementing." },
  { path: "showTurnDuration", cat: "interface", type: "bool", default: true, title: "Show turn duration", desc: "Show how long each turn took after the response." },
  {
    path: "spellcheck", cat: "interface", type: "object", scopes: USER, scopeNote: USER_ONLY_NOTE, since: "2.1.235",
    title: "Spell check", desc: "Underline misspelled words in the prompt using aspell, hunspell or ispell, which you install yourself.",
    fields: [
      { key: "enabled", type: "bool", title: "Enabled" },
      { key: "checker", type: "enum", options: ["auto", "aspell", "hunspell", "ispell"], default: "auto", title: "Checker" },
      { key: "language", type: "string", title: "Dictionary", placeholder: "en_GB" },
      { key: "color", type: "string", title: "Color", placeholder: "#ff5555" },
    ],
  },
  { path: "spinnerTipsEnabled", cat: "interface", type: "bool", default: true, title: "Spinner tips", desc: "Show feature tips in the spinner while Claude works." },
  {
    path: "spinnerTipsOverride", cat: "interface", type: "object",
    title: "Custom spinner tips", desc: "Add your own spinner tips, or show only yours.",
    scopeNote: "Project and local files may only add plain text tips.",
    fields: [
      { key: "tips", type: "tips", title: "Tips" },
      { key: "tipsFile", type: "string", ...absPath, scopes: USER, title: "Tips file", placeholder: "~/.claude/tips.json" },
      { key: "label", type: "string", maxLength: 40, scopes: USER, title: "Prefix", placeholder: "Tip" },
      { key: "excludeDefault", type: "bool", scopes: USER, title: "Hide built-in tips" },
    ],
  },
  {
    path: "spinnerVerbs", cat: "interface", type: "object",
    title: "Spinner verbs", desc: "Add your own verbs to the spinner, or replace the built-in ones.",
    fields: [
      { key: "mode", type: "enum", options: ["append", "replace"], required: true, title: "Mode" },
      { key: "verbs", type: "stringList", required: true, title: "Verbs", placeholder: "Pondering" },
    ],
  },
  {
    path: "statusLine", cat: "interface", type: "object",
    title: "Status line", desc: "A command whose output is shown as a status line below the prompt. It receives session data as JSON on stdin.",
    fields: [
      { key: "type", type: "string", const: "command" },
      { key: "command", type: "string", required: true, title: "Command", placeholder: "node ~/.claude/statusline.js" },
      { key: "padding", type: "number", integer: true, title: "Padding (characters)" },
      { key: "refreshInterval", type: "number", min: 1, title: "Refresh every (seconds)" },
      { key: "hideVimModeIndicator", type: "bool", title: "Hide vim mode indicator" },
    ],
  },
  { path: "syntaxHighlightingDisabled", cat: "interface", type: "bool", default: false, title: "Disable syntax highlighting", desc: "Show code, diffs and file previews without syntax colors." },
  { path: "terminalProgressBarEnabled", cat: "interface", type: "bool", default: true, title: "Terminal progress indicator", desc: "Report progress to terminals that show it on the tab or taskbar." },
  { path: "terminalTitleFromRename", cat: "interface", type: "bool", default: true, title: "Tab title from session name", desc: "Use the name you give a session (/rename) as the terminal tab title." },
  {
    path: "theme", cat: "interface", type: "enum", default: "dark", allowOther: true, pattern: "^custom:.+", hint: "Use a built-in theme or custom:<name>.",
    options: ["auto", "dark", "light", "dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi"],
    title: "Theme", desc: "Color theme. custom:<name> picks a custom theme from ~/.claude/themes or a plugin.",
  },
  { path: "timeFormat", cat: "interface", type: "enum", options: ["auto", "12-hour", "24-hour", "24-hour-utc"], default: "auto", allowOther: true, pattern: "%", hint: "Use a preset or a strftime pattern containing %.", since: "2.1.257", title: "Time format", desc: "How times are shown: a preset, or a strftime pattern such as %H:%M." },
  { path: "timeZone", cat: "interface", type: "string", placeholder: "Asia/Tehran", since: "2.1.257", title: "Time zone", desc: "IANA time zone for times in the interface; unset uses the system zone." },
  { path: "tui", cat: "interface", type: "enum", options: ["default", "fullscreen"], title: "Terminal renderer", desc: "Classic renderer or the flicker-free fullscreen one. Unset lets Claude Code choose." },
  { path: "verbose", cat: "interface", type: "bool", default: false, title: "Verbose transcript", desc: "Show full tool output instead of short summaries." },
  { path: "viewMode", cat: "interface", type: "enum", options: ["default", "verbose", "focus"], title: "Starting view", desc: "Transcript view to start in. Overrides verbose and your last /focus choice." },
  {
    path: "vimInsertModeRemaps", cat: "interface", type: "map", scopes: USER, scopeNote: USER_ONLY_NOTE,
    keyPattern: PATTERNS.twoChars.pattern, keyHint: PATTERNS.twoChars.hint, keyPlaceholder: "jk",
    valueField: { type: "enum", options: ["<Esc>"] },
    title: "Vim insert-mode escapes", desc: "Two-key sequences that act as Escape in vim insert mode, such as jk.",
  },
  {
    path: "voice", cat: "interface", type: "object",
    title: "Voice dictation", desc: "Turn dictation on and choose how the dictation key works. /voice writes this.",
    fields: [
      { key: "enabled", type: "bool", title: "Enabled" },
      { key: "mode", type: "enum", options: ["hold", "tap"], title: "Key mode" },
      { key: "autoSubmit", type: "bool", title: "Send on release (hold mode)" },
    ],
  },
  { path: "voiceEnabled", cat: "interface", type: "bool", deprecated: "Replaced by voice.enabled.", title: "Voice dictation (old switch)", desc: "Older on/off switch for dictation. voice.enabled wins when both are set." },
  { path: "wheelScrollAccelerationEnabled", cat: "interface", type: "bool", default: true, title: "Wheel scroll acceleration", desc: "Speed up mouse-wheel scrolling during fast scrolls in fullscreen mode." },

  // ---- Git and attribution -----------------------------------------------------------------------------
  {
    path: "attribution", cat: "git", type: "object", editor: "attribution", covers: ["attribution.commit", "attribution.pr", "attribution.sessionUrl"],
    title: "Attribution", desc: "Text Claude Code adds to commits and pull requests, or false for none. An empty text hides that part.",
    note: "false needs Claude Code 2.1.281 or later; older versions skip the whole file.",
    schema: S.anyOf(S.constOf(false), S.obj({ commit: S.str({ allowEmpty: true }), pr: S.str({ allowEmpty: true }), sessionUrl: S.bool() }, { additional: true })),
    fields: [],
  },
  { path: "includeCoAuthoredBy", cat: "git", type: "bool", default: true, deprecated: "Replaced by attribution.", title: "Co-authored-by (old switch)", desc: "false drops commit and pull request attribution, unless attribution sets commit or pr." },
  { path: "includeGitInstructions", cat: "git", type: "bool", default: true, title: "Git instructions", desc: "Give Claude its built-in commit and pull request instructions and a git status snapshot." },
  { path: "prUrlTemplate", cat: "git", type: "string", placeholder: "https://review.example.com/{owner}/{repo}/{number}", title: "Pull request link template", desc: "Point PR links at your own review tool. Placeholders: {host}, {owner}, {repo}, {number}, {url}." },

  // ---- Hooks and automation (hooks itself is on the Hooks page) -------------------------------------------
  { path: "allowedHttpHookUrls", cat: "hooks", type: "stringList", placeholder: "https://hooks.example.com/*", title: "Allowed HTTP hook URLs", desc: "URL patterns HTTP hooks may call (* is a wildcard). Lists from all files are merged." },
  { path: "disableAllHooks", cat: "hooks", type: "bool", title: "Disable all hooks", desc: "Turn off hooks, the custom status line and the file suggestion command without deleting them." },
  { path: "disableWorkflows", cat: "hooks", type: "bool", default: false, title: "Disable workflows for everyone", desc: "Turn off dynamic workflows and the bundled workflow commands for everyone these settings reach." },
  { path: "enableWorkflows", cat: "hooks", type: "bool", defaultNote: "On, except on the Pro plan.", title: "Dynamic workflows", desc: "Turn dynamic workflows on or off just for you." },
  { path: "httpHookAllowedEnvVars", cat: "hooks", type: "stringList", placeholder: "MY_TOKEN", title: "Env vars for HTTP hook headers", desc: "Environment variables HTTP hooks may put into request headers; a hook must also list them itself." },
  { path: "workflowKeywordTriggerEnabled", cat: "hooks", type: "bool", default: true, title: "Ultracode keyword trigger", desc: "Typing the word ultracode in a prompt starts a dynamic workflow." },
  { path: "workflowSizeGuideline", cat: "hooks", type: "enum", options: ["unrestricted", "small", "medium", "large"], default: "medium", defaultNote: "small on the Pro plan.", title: "Workflow size", desc: "How many agents Claude aims for in the workflows it writes: small < 5, medium < 10, large < 50. Advice, not a cap." },

  // ---- Plugins and skills (enabledPlugins is on the Plugins page) ---------------------------------------
  { path: "disableBundledSkills", cat: "plugins", type: "bool", title: "Disable bundled skills", desc: "Remove the skills and workflows that ship with Claude Code." },
  { path: "disableSkillShellExecution", cat: "plugins", type: "bool", title: "Disable shell in skills", desc: "Don't run inline shell blocks in skills and custom commands; they are replaced with a notice." },
  {
    path: "skillOverrides", cat: "plugins", type: "map", keyPlaceholder: "skill-name",
    valueField: { type: "enum", options: ["on", "name-only", "user-invocable-only", "off"] },
    title: "Skill visibility", desc: "Per skill: on, name only (no description), only you can call it, or off.",
  },
  { path: "syncClaudeAiSkills", cat: "plugins", type: "bool", scopes: USER_LOCAL, scopeNote: USER_LOCAL_NOTE, title: "Sync claude.ai skills", desc: "false stops downloading the skills enabled for your claude.ai account." },
  { path: "syncClaudeAiPlugins", cat: "plugins", type: "bool", scopes: USER_LOCAL, scopeNote: USER_LOCAL_NOTE, since: "2.1.273", title: "Sync claude.ai plugins", desc: "false stops downloading the plugins enabled for your claude.ai account." },
  {
    path: "extraKnownMarketplaces", cat: "plugins", type: "json",
    placeholder: "{\n  \"team-tools\": {\n    \"source\": { \"source\": \"github\", \"repo\": \"org/claude-plugins\" }\n  }\n}",
    title: "Extra plugin marketplaces", desc: "Marketplaces registered for everyone who opens this project (or for you, in user settings).",
    note: "Project entries apply only after you trust the folder.",
    schema: S.obj({}, { additional: S.obj({ source: S.obj({}, { additional: true }), autoUpdate: S.bool() }, { required: ["source"], additional: true }) }),
  },
  {
    path: "pluginConfigs", cat: "plugins", type: "json", scopes: USER, scopeNote: USER_ONLY_NOTE,
    title: "Plugin configuration answers", desc: "Non-secret answers to plugin configuration dialogs. Claude Code writes this for you.",
    schema: S.obj({}, { additional: S.obj({ options: S.obj({}, { additional: true }), mcpServers: S.obj({}, { additional: true }) }, { additional: true }) }),
  },
  { path: "prependPlugins", cat: "plugins", type: "stringList", scopes: USER, scopeNote: "Read from user settings only on a machine without managed settings.", placeholder: "plugin@marketplace", title: "Mods that run first", desc: "Plugins whose mods run before the mods you install, in this order." },
  { path: "appendPlugins", cat: "plugins", type: "stringList", scopes: USER, scopeNote: "Read from user settings only on a machine without managed settings.", placeholder: "plugin@marketplace", title: "Mods that run last", desc: "Plugins whose mods run after the mods you install, in this order." },

  // ---- MCP -------------------------------------------------------------------------------------------------
  {
    path: "allowedMcpServers", cat: "mcp", type: "json", allowEmpty: true, placeholder: "[\n  { \"serverName\": \"github\" }\n]",
    title: "MCP server allowlist", desc: "Only matching MCP servers may be added: entries with one of serverName, serverCommand or serverUrl. An empty list blocks every server users add.",
    schema: MCP_MATCHER(S.str(PATTERNS.serverName)),
  },
  {
    path: "deniedMcpServers", cat: "mcp", type: "json", placeholder: "[\n  { \"serverUrl\": \"https://*.untrusted.example/*\" }\n]",
    title: "MCP server denylist", desc: "MCP servers that are never loaded: entries with one of serverName, serverCommand or serverUrl.",
    schema: MCP_MATCHER(S.str()),
  },
  { path: "disableClaudeAiConnectors", cat: "mcp", type: "bool", default: false, title: "Disable claude.ai connectors", desc: "Don't fetch or connect the MCP connectors from your claude.ai account." },
  { path: "disabledMcpjsonServers", cat: "mcp", type: "stringList", title: "Rejected .mcp.json servers", desc: "Servers from the project's .mcp.json that are never connected." },
  { path: "enableAllProjectMcpServers", cat: "mcp", type: "bool", title: "Approve all .mcp.json servers", desc: "Approve every server in project .mcp.json files without asking." },
  { path: "enabledMcpjsonServers", cat: "mcp", type: "stringList", title: "Approved .mcp.json servers", desc: "Servers from the project's .mcp.json that connect without asking." },

  // ---- Agents, sessions and worktrees ------------------------------------------------------------------------
  { path: "agent", cat: "agents", type: "string", suggest: "agents", title: "Main session agent", desc: "Run the main session as this subagent, with its prompt, tools and model." },
  { path: "crossSessionInbound", cat: "agents", type: "enum", options: ["accept", "hold", "refuse"], scopeNote: "Project and local values apply only when they are stricter.", title: "Messages from your other sessions", desc: "Deliver, hold or drop messages that arrive from your other Claude Code sessions. Unset decides per message." },
  { path: "disableAgentView", cat: "agents", type: "bool", title: "Disable agent view", desc: "Turn off background agents and agent view (claude agents, --bg, /background)." },
  { path: "isolatePeerMachines", cat: "agents", type: "bool", since: "2.1.224", title: "Approve cross-machine messages", desc: "Ask before Claude's SendMessage reaches your sessions on other machines." },
  { path: "processWrapper", cat: "agents", type: "string", scopes: USER, scopeNote: USER_ONLY_NOTE, since: "2.1.210", placeholder: "/usr/local/bin/corp-launcher", title: "Process wrapper", desc: "macOS and Linux: a launcher command placed in front of the background processes Claude Code starts." },
  { path: "teammateMode", cat: "agents", type: "enum", options: ["in-process", "auto", "tmux", "iterm2"], default: "in-process", title: "Teammate display", desc: "Show agent-team teammates in the main pane or in split panes (tmux or iTerm2)." },
  { path: "worktree.baseRef", cat: "agents", type: "enum", options: ["fresh", "head"], default: "fresh", title: "Worktree base", desc: "Branch new worktrees from the remote default branch (fresh) or from your local HEAD (head)." },
  { path: "worktree.symlinkDirectories", cat: "agents", type: "stringList", placeholder: "node_modules", title: "Symlinked directories", desc: "Directories symlinked from the main checkout into each worktree, relative to the repository root." },
  { path: "worktree.sparsePaths", cat: "agents", type: "stringList", placeholder: "packages/app", title: "Sparse checkout paths", desc: "Check out only these directories (plus root files) in each worktree." },
  { path: "worktree.bgIsolation", cat: "agents", type: "enum", options: ["worktree", "none"], default: "worktree", title: "Background session isolation", desc: "Make background sessions edit in a worktree, or let them edit the working copy directly." },
  { path: "worktree.location", cat: "agents", type: "string", ...absPath, scopes: USER, scopeNote: "Desktop app only, read from user settings on the remote machine.", placeholder: "~/worktrees", title: "Remote worktree folder", desc: "Where Desktop SSH sessions create worktrees on the remote machine." },

  // ---- Remote, desktop and notifications ---------------------------------------------------------------------
  { path: "agentPushNotifEnabled", cat: "remote", type: "bool", default: false, title: "Push when Claude decides", desc: "Let Claude send a push notification to your phone when it thinks one is worth sending." },
  { path: "awaySummaryEnabled", cat: "remote", type: "bool", title: "Session recap", desc: "Show a one-line recap when you come back after a few minutes away. On when unset." },
  { path: "disableArtifact", cat: "remote", type: "bool", deprecated: "Replaced by enableArtifact.", title: "Disable artifacts (old switch)", desc: "true turns the Artifact tool off; false is ignored." },
  { path: "disableDeepLinkRegistration", cat: "remote", type: "flag", value: "disable", title: "Don't register claude-cli:// links", desc: "Stop Claude Code from registering its deep-link handler with the operating system." },
  { path: "disableRemoteControl", cat: "remote", type: "bool", default: false, title: "Disable Remote Control", desc: "Turn Remote Control off completely." },
  { path: "enableArtifact", cat: "remote", type: "bool", title: "Artifacts", desc: "false turns off the Artifact tool, which publishes output as a private claude.ai page. true is the same as unset." },
  { path: "inputNeededNotifEnabled", cat: "remote", type: "bool", default: false, title: "Push when input is needed", desc: "Send a push notification to your phone when a prompt or question is waiting." },
  { path: "preferredNotifChannel", cat: "remote", type: "enum", options: ["auto", "terminal_bell", "iterm2", "iterm2_with_bell", "kitty", "ghostty", "notifications_disabled"], default: "auto", title: "Local notifications", desc: "How Claude Code tells you a task finished or a prompt is waiting." },
  { path: "remote.defaultEnvironmentId", cat: "remote", type: "string", placeholder: "env_…", title: "Default cloud environment", desc: "Environment used for cloud sessions you start from the CLI. /remote-env writes this." },
  { path: "remoteControlAtStartup", cat: "remote", type: "bool", title: "Remote Control at startup", desc: "Connect Remote Control automatically when each interactive session starts." },
  {
    path: "sshConfigs", cat: "remote", type: "json", scopes: USER, scopeNote: USER_ONLY_NOTE,
    placeholder: "[\n  { \"id\": \"dev-vm\", \"name\": \"Dev VM\", \"sshHost\": \"user@dev.example.com\" }\n]",
    title: "Desktop SSH connections", desc: "SSH connections offered in the desktop app's environment picker.",
    schema: S.arr(S.obj({ id: S.str(), name: S.str(), sshHost: S.str(), sshIdentityFile: S.str() }, { required: ["id", "name", "sshHost"], additional: true })),
  },
  {
    path: "sshHostCommands", cat: "remote", type: "json", scopes: USER, scopeNote: USER_ONLY_NOTE,
    placeholder: "[\n  { \"id\": \"build\", \"name\": \"Build box\", \"command\": \"/usr/local/bin/pick-host\" }\n]",
    title: "Desktop SSH host commands", desc: "Desktop SSH connections whose host is printed by a command you provide.",
    schema: S.arr(S.obj({ id: S.str(), name: S.str(), command: S.str(), sshIdentityFile: S.str(), startDirectory: S.str() }, { required: ["id", "name", "command"], additional: true })),
  },

  // ---- Authentication and providers -------------------------------------------------------------------------
  { path: "apiKeyHelper", cat: "auth", type: "string", placeholder: "~/bin/get-api-key.sh", title: "API key helper", desc: "Command whose output is sent as the credential with model requests." },
  { path: "awsAuthRefresh", cat: "auth", type: "string", placeholder: "aws sso login --profile myprofile", title: "AWS credential refresh", desc: "Command that refreshes your AWS credentials for Amazon Bedrock when they stop working." },
  { path: "awsCredentialExport", cat: "auth", type: "string", title: "AWS credential export", desc: "Command that prints AWS credentials as JSON for Amazon Bedrock." },
  { path: "forceLoginMethod", cat: "auth", type: "enum", options: ["claudeai", "console", "gateway"], title: "Login method", desc: "Restrict sign-in to claude.ai accounts, Console accounts or a cloud gateway." },
  { path: "forceLoginGatewayUrl", cat: "auth", type: "string", ...PATTERNS.url, scopes: USER, scopeNote: "Read from user settings only on a machine without managed settings.", placeholder: "https://gateway.example.com", title: "Cloud gateway URL", desc: "Gateway the /login cloud gateway screen connects to." },
  {
    path: "forceLoginOrgUUID", cat: "auth", type: "json", placeholder: "\"00000000-0000-0000-0000-000000000000\"",
    title: "Login organization", desc: "Organization UUID (or a list of them) for claude.ai logins. Outside managed settings a single UUID only pre-selects it.",
    schema: S.anyOf(S.str(), S.arr(S.str())),
  },
  { path: "gcpAuthRefresh", cat: "auth", type: "string", placeholder: "gcloud auth application-default login", title: "Google Cloud credential refresh", desc: "Command that refreshes Google Cloud credentials when they expire." },
  { path: "otelHeadersHelper", cat: "auth", type: "string", title: "OpenTelemetry headers helper", desc: "Command that prints a JSON object of headers for OpenTelemetry exports." },

  // ---- Updates ------------------------------------------------------------------------------------------------------
  { path: "autoUpdatesChannel", cat: "updates", type: "enum", options: ["latest", "stable"], defaultNote: "Follows latest.", title: "Update channel", desc: "Release channel for auto-updates: latest, or stable (about a week old, skips releases with major regressions)." },
  { path: "minimumVersion", cat: "updates", type: "string", ...PATTERNS.version, placeholder: "2.1.323", title: "Minimum version", desc: "Auto-updates never install a version below this one." },

  // ---- Privacy and data retention ----------------------------------------------------------------------------------
  { path: "cleanupPeriodDays", cat: "privacy", type: "number", integer: true, min: 1, default: 30, title: "Keep transcripts for (days)", desc: "Days to keep session transcripts and other data before they are deleted." },
  { path: "desktopSessionCleanupPeriodDays", cat: "privacy", type: "number", integer: true, min: 0, default: 0, scopes: USER, scopeNote: USER_ONLY_NOTE, since: "2.1.248", title: "Desktop transcript age limit (days)", desc: "Age limit for transcripts of Claude Desktop and Cowork sessions; 0 means no limit." },
  { path: "feedbackDrafts", cat: "privacy", type: "enum", options: ["notify", "quiet", "off"], default: "notify", scopes: USER, scopeNote: USER_ONLY_NOTE, title: "Feedback drafts", desc: "Whether Claude may queue feedback drafts for you to review, and whether a card is shown." },
  { path: "feedbackSurveyRate", cat: "privacy", type: "number", min: 0, max: 1, placeholder: "0", title: "Feedback survey rate", desc: "Chance from 0 to 1 that the session quality survey appears; 0 turns it off." },
  { path: "skipWebFetchPreflight", cat: "privacy", type: "bool", title: "Skip WebFetch domain check", desc: "Don't send hostnames to api.anthropic.com for the safety check before fetching." },
];

/** Documented keys deliberately left out of the catalog, with the reason. */
const MANAGED = "Managed settings only";
const managed = (...paths) => paths.map((path) => ({ path, reason: MANAGED }));
export const EXCLUDED = [
  { path: "permissions", reason: "Edited on the Permissions page", section: "permissions" },
  ...["allow", "ask", "deny", "additionalDirectories", "blockReadsOutsideWorkingDirectories", "blockWritesOutsideWorkingDirectories", "defaultMode", "denyInsteadOfPrompting", "disableBypassPermissionsMode"].map((key) => ({ path: `permissions.${key}`, reason: "Edited on the Permissions page", section: "permissions" })),
  { path: "env", reason: "Edited on the Environment page", section: "environment" },
  { path: "hooks", reason: "Edited on the Hooks page", section: "hooks" },
  { path: "outputStyle", reason: "Edited on the Output styles page", section: "output-styles" },
  { path: "enabledPlugins", reason: "Edited on the Plugins page", section: "plugins" },
  { path: "taskOutputMaxChars", reason: "Removed in Claude Code 2.1.277; has no effect" },
  { path: "keybindingFlavor", reason: "Deprecated; has no effect since 2.1.261" },
  ...["sandbox", "sandbox.filesystem", "sandbox.network", "sandbox.credentials", "worktree"].map((path) => ({ path, reason: "Edited through its sub-keys" })),
  ...managed(
    "availableModelsMatch", "deniedModels", "modelPricing", "allowManagedPermissionRulesOnly",
    "sandbox.filesystem.allowManagedReadPathsOnly", "sandbox.bwrapPath", "sandbox.socatPath", "sandbox.network.allowManagedDomainsOnly",
    "claudeMd", "allowManagedHooksOnly",
    "allowedChannelPlugins", "blockedMarketplaces", "channelsEnabled", "disableCommandPluginSources", "pluginSuggestionMarketplaces", "pluginTrustMessage", "strictKnownMarketplaces",
    "strictPluginOnlyCustomization", "strictPluginOnlyCustomization.skills", "strictPluginOnlyCustomization.agents", "strictPluginOnlyCustomization.hooks", "strictPluginOnlyCustomization.mcp",
    "allowAllClaudeAiMcps", "allowClaudeInChromeWithManagedMcp", "allowManagedMcpServersOnly", "managedMcpServers",
    "disableDesktopLocalSessions", "disableRemotePreviewScripts", "sshHostAllowlist",
    "allowedProviders", "gatewayInternalNetworks", "requiredMaximumVersion", "requiredMinimumVersion",
    "browserExternalPageTools", "disableBrowserExternalNavigation", "disableMobileSimulatorTools",
    "disableSideloadFlags", "forceRemoteSettingsRefresh", "managedSourcesBehavior", "parentSettingsBehavior",
    "policyHelper", "policyHelper.path", "policyHelper.timeoutMs", "policyHelper.refreshIntervalMs", "wslInheritsWindowsSettings",
  ),
];

/** Keys Claude Code keeps in ~/.claude.json, not settings.json (listed for reference only; never written here). */
export const GLOBAL_CONFIG_KEYS = [
  "autoConnectIde", "autoInstallIdeExtension", "claudeInChromeDefaultEnabled", "copyFullResponse", "copyOnSelect", "defaultToAgentsView",
  "diffTool", "externalEditorContext", "leftArrowOpensAgents", "prStatusFooterEnabled",
];

export const EXCLUDED_REASONS = [...new Set(EXCLUDED.map((item) => item.reason))];

export const byPath = new Map(CATALOG.map((entry) => [entry.path, entry]));
export const categoryTitle = (id) => CATEGORIES.find((category) => category.id === id)?.title || id;
