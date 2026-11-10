# Troubleshooting

## "Claude Code could not be started" on the welcome screen
Wheelhouse could not run the executable of the active profile. Open **Settings → Connection** and press **Test**.
- *Command not found*: set `command` in your profile to an absolute path, or install Claude Code so `claude` is on `PATH`.
- On Windows, an npm-installed `claude.cmd` is mapped to the real `claude.exe` next to it. If your install is elsewhere,
  give the full path to `claude.exe`.

## "Not signed in"
Run `claude auth login` in a terminal (use your wrapper's name if you have one), or configure an API key / gateway /
cloud provider in a profile ([examples](../examples)). Wheelhouse itself never asks for credentials.

## "OAuth session expired" / "Login expired · Please run /login"
The login of the profile ran out and could not be refreshed. Press **Sign in** on the error message, type `/login`, or use
*Settings → Connection → Sign in*. Wheelhouse runs the CLI's own `auth login` for that profile: finish signing in on the page
that opens in your browser and, if the page shows a code, paste it into the dialog. Nothing is stored by Wheelhouse. Messages
that failed stay as they are; send them again once you are signed in (a session that still fails needs to be started again).

## A new model is missing from the model list
The list is the one Claude Code reports, and Claude Code only knows the models that existed when it was built (a gateway
does not change that). Update Claude Code: *Settings → Updates → Update now*, or `npm install -g @anthropic-ai/claude-code@latest`.
Wheelhouse also does this by itself (*Settings → Updates*): the new version is used for new sessions as soon as it is
downloaded; a session that was already running keeps its version until it restarts. If it does not, the page shows why
(for example that the registry could not be reached, which behind a proxy needs `HTTPS_PROXY` in the environment
Wheelhouse starts with). A file that is in use can block the swap; the old version is then kept and it is tried again an
hour later.

## Requests hang or fail with connection errors
- A system-wide `HTTPS_PROXY` can break access to internal gateways. Add the host to the profile's `proxyBypass`.
- Many `claude` processes sharing one config directory may invalidate a shared OAuth login. Close unused sessions and
  avoid running several Wheelhouse instances against the same profile.

## The model list is empty or "Default" only
The list comes from your account/gateway through Claude Code. Check **Test** in Settings → Connection; then
**Command palette → Reload models, commands and skills**. You can still type any model id with *Custom model…*.

## Claude in Chrome lists no browsers
With *Use my open Chrome* on, a session has the `mcp__claude-in-chrome__*` tools and the `claude-in-chrome` MCP server shows
as connected, but `list_connected_browsers` returns nothing. The server only connects to the CLI; the browser side is the
**Claude in Chrome extension**, which talks to one Claude app at a time:
- If **Claude Desktop** is installed it registers its own native host for the same extension and usually wins. Claude Code
  registers `com.anthropic.claude_code_browser_extension` (check `HKCU\Software\Google\Chrome\NativeMessagingHosts`); the
  extension has to be attached to that one, not to Claude Desktop's.
- The extension must be signed in to the **same Claude account** as the CLI (the one `claude auth status` shows).
- Reload the extension (or restart Chrome) after changing either.

Wheelhouse does not change native-host registrations or extension settings for you.

## Links open in a new Chrome window
Links clicked in the standalone window (`--app`) are opened by the server in your default browser (or Chrome with
`"linkBrowser": "chrome"`), as a new tab in a window you already use. If you still get a separate window, the window was
opened before this version: quit Wheelhouse (tray → Quit) and start it again.

## No notifications
Use *Settings → Notifications → Send* to test. Native notifications need the tray (`--tray`); without it the browser's own
notifications are used and the browser must have allowed them for the page. If the test shows nothing, check Windows'
*Focus assist / Do not disturb* and *Settings → System → Notifications → Wheelhouse*. Notifications are not sent for the
conversation you are reading in a focused window.

## Folder dialog does not open
Windows and macOS use the system dialog. On Linux install `zenity` or `kdialog`; otherwise Wheelhouse falls back to its
built-in folder browser.

## Port already in use
Start with `--port <n>` (or set `port` in the config file).

## Right-to-left or font problems
The UI language is chosen in Settings → General. Persian uses the bundled Vazirmatn font. If text looks wrong, attach a
screenshot and say which language/theme you used when you open an issue.

## Still stuck?
Open an [issue](https://github.com/msmahdinejad/claude-code-gui/issues/new/choose) with the Wheelhouse and Claude Code versions,
your OS, and the server terminal output (remove tokens and private paths first).
