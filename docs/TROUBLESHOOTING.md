# Troubleshooting

## "Claude Code could not be started" on the welcome screen
Wheelhouse could not run the executable of the active profile. Open **Settings → Connection** and press **Test**.
- *Command not found*: set `command` in your profile to an absolute path, or install Claude Code so `claude` is on `PATH`.
- On Windows, an npm-installed `claude.cmd` is mapped to the real `claude.exe` next to it. If your install is elsewhere,
  give the full path to `claude.exe`.

## "Not signed in"
Run `claude auth login` in a terminal (use your wrapper's name if you have one), or configure an API key / gateway /
cloud provider in a profile ([examples](../examples)). Wheelhouse itself never asks for credentials.

## Requests hang or fail with connection errors
- A system-wide `HTTPS_PROXY` can break access to internal gateways. Add the host to the profile's `proxyBypass`.
- Many `claude` processes sharing one config directory may invalidate a shared OAuth login. Close unused sessions and
  avoid running several Wheelhouse instances against the same profile.

## The model list is empty or "Default" only
The list comes from your account/gateway through Claude Code. Check **Test** in Settings → Connection; then
**Command palette → Reload models, commands and skills**. You can still type any model id with *Custom model…*.

## Folder dialog does not open
Windows and macOS use the system dialog. On Linux install `zenity` or `kdialog`; otherwise Wheelhouse falls back to its
built-in folder browser.

## Port already in use
Start with `--port <n>` (or set `port` in the config file).

## Right-to-left or font problems
The UI language is chosen in Settings → General. Persian uses the bundled Vazirmatn font. If text looks wrong, attach a
screenshot and say which language/theme you used when you open an issue.

## Still stuck?
Open an [issue](https://github.com/msmahdinejad/wheelhouse/issues/new/choose) with the Wheelhouse and Claude Code versions,
your OS, and the server terminal output (remove tokens and private paths first).
