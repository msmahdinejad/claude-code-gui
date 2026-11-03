# Wheelhouse tray host (Windows). Started by the server with --tray (see server/lib/tray.mjs).
# Shows a notification-area icon: click = open the app window, right-click = menu (open, open in browser, start with
# Windows, quit). Registers global shortcuts. "Quit" stops the server and every window completely.
# Keep this file ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][int]$ServerPid,
  [string]$Browser = "",
  [string]$ProfileDir = "",
  [string]$IconPath = "",
  [string]$IconFile = "",
  [string]$LaunchVbs = "",
  [string]$Hotkey = "",
  [string]$BrowserHotkey = "",
  [string]$AutostartVbs = "",
  [string]$LogPath = "",
  [switch]$SelfTest
)
$ErrorActionPreference = "Stop"
$AppName = "Wheelhouse"

# Written to a file directly: event handlers have no pipeline and the process has no visible console.
function Log([string]$message) {
  if (-not $LogPath) { return }
  try { [IO.File]::AppendAllText($LogPath, ("[{0}] {1}`r`n" -f (Get-Date -Format "s"), $message)) } catch { }
}
if ($LogPath) { try { [IO.File]::WriteAllText($LogPath, "") } catch { } }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ("WhHotkeyWindow" -as [type])) {
  Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class WhHotkeyWindow : NativeWindow, IDisposable {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  public event Action<int> Pressed;
  public WhHotkeyWindow() { CreateHandle(new CreateParams()); }
  public bool Register(int id, uint modifiers, uint vk) { return RegisterHotKey(Handle, id, modifiers | 0x4000u, vk); }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x0312 && Pressed != null) Pressed(m.WParam.ToInt32());
    base.WndProc(ref m);
  }
  public void Dispose() { UnregisterHotKey(Handle, 1); UnregisterHotKey(Handle, 2); DestroyHandle(); }
}
"@
}

. (Join-Path $PSScriptRoot "app-window.ps1")  # Get-AppProcess, Show-AppWindow, Open-AppWindow, WhNative

# ---- shortcuts -------------------------------------------------------------------------------------------------
function ConvertTo-Hotkey([string]$text) {
  if (-not $text) { return $null }
  $mod = 0
  $key = $null
  foreach ($part in $text.Split("+")) {
    $p = $part.Trim()
    if ($p -match "^(ctrl|control)$") { $mod = $mod -bor 2 }
    elseif ($p -match "^alt$") { $mod = $mod -bor 1 }
    elseif ($p -match "^shift$") { $mod = $mod -bor 4 }
    elseif ($p -match "^(win|super|meta)$") { $mod = $mod -bor 8 }
    else { $key = $p }
  }
  if (-not $key -or $mod -eq 0) { return $null }
  if ($key -match "^\d$") { $key = "D$key" }
  try { $vk = [int][System.Windows.Forms.Keys]([Enum]::Parse([System.Windows.Forms.Keys], $key, $true)) } catch { return $null }
  return @{ Mod = [uint32]$mod; Key = [uint32]$vk }
}

# ---- opening the UI --------------------------------------------------------------------------------------------
function Open-App { Open-AppWindow $Url $Browser $ProfileDir $IconFile $LaunchVbs }
function Open-InBrowser { Start-Process $Url }

# Opens the conversation a notification is about: an open window is told to switch to it, a closed one starts on it.
function Open-Session([string]$id) {
  if ($id -notmatch '^[\w-]+$') { Open-App; return }
  if (Show-AppWindow $ProfileDir $IconFile $LaunchVbs) {
    try {
      Invoke-RestMethod -Method Post -Uri "$Url/api/focus" -Headers @{ Origin = $Url } -ContentType "application/json" -Body (@{ sessionId = $id } | ConvertTo-Json -Compress) -TimeoutSec 3 | Out-Null
    } catch { Log "focus request failed: $($_.Exception.Message)" }
    return
  }
  Open-AppWindow $Url $Browser $ProfileDir $IconFile $LaunchVbs "#/s/$id"
}

# ---- icon ------------------------------------------------------------------------------------------------------
$script:iconHandle = [IntPtr]::Zero
function New-TrayIcon([bool]$badge) {
  $size = [System.Windows.Forms.SystemInformation]::SmallIconSize.Width
  $bitmap = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  if ($IconPath -and (Test-Path $IconPath)) {
    $source = [System.Drawing.Image]::FromFile($IconPath)
    $g.DrawImage($source, 0, 0, $size, $size)
    $source.Dispose()
  } else {
    $g.FillEllipse([System.Drawing.Brushes]::OrangeRed, 0, 0, $size - 1, $size - 1)
  }
  if ($badge) {
    $d = [int][Math]::Round($size * 0.5)
    $g.FillEllipse([System.Drawing.Brushes]::White, $size - $d - 1, -1, $d + 2, $d + 2)
    $g.FillEllipse([System.Drawing.Brushes]::Gold, $size - $d, 0, $d, $d)
  }
  $g.Dispose()
  $handle = $bitmap.GetHicon()
  $bitmap.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($handle)
  if ($script:iconHandle -ne [IntPtr]::Zero) { $previous = $script:iconHandle } else { $previous = [IntPtr]::Zero }
  $script:iconHandle = $handle
  return @{ Icon = $icon; Previous = $previous }
}

function Set-TrayIcon([bool]$badge) {
  Log "icon badge: $badge"
  $made = New-TrayIcon $badge
  $notify.Icon = $made.Icon
  if ($made.Previous -ne [IntPtr]::Zero) { [void][WhNative]::DestroyIcon($made.Previous) }
}

# ---- autostart -------------------------------------------------------------------------------------------------
$startupLink = Join-Path ([Environment]::GetFolderPath("Startup")) "$AppName.lnk"
function Set-Autostart([bool]$on) {
  if ($on) {
    if (-not $AutostartVbs) { return }
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($startupLink)
    $link.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
    $link.Arguments = "`"$AutostartVbs`""
    $link.Description = "Start $AppName in the notification area"
    if ($IconFile -and (Test-Path $IconFile)) { $link.IconLocation = "$IconFile,0" }
    $link.Save()
  } elseif (Test-Path $startupLink) {
    Remove-Item $startupLink -Force
  }
}

# ---- shutting down ---------------------------------------------------------------------------------------------
function Exit-Tray {
  try { $timer.Stop() } catch { }
  try { $notify.Visible = $false; $notify.Dispose() } catch { }
  try { $hotkeys.Dispose() } catch { }
  if ($script:iconHandle -ne [IntPtr]::Zero) { [void][WhNative]::DestroyIcon($script:iconHandle) }
  [System.Windows.Forms.Application]::Exit()
}

# Closes the app window(s), stops the server if it is still running, then removes the tray icon. Also used when the
# server disappears on its own (Ctrl+C, quit from the web UI), so nothing is left behind.
function Quit-All {
  Log "quitting"
  $notify.Visible = $false
  foreach ($candidate in (Get-AppProcess $ProfileDir | Where-Object { $_.CommandLine -notmatch "--type=" })) {
    $proc = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
    if ($proc) { [void]$proc.CloseMainWindow() }
  }
  if (Get-Process -Id $ServerPid -ErrorAction SilentlyContinue) {
    try { Invoke-RestMethod -Method Post -Uri "$Url/api/shutdown" -Headers @{ Origin = $Url } -TimeoutSec 4 | Out-Null } catch { Log "shutdown request failed: $($_.Exception.Message)" }
    for ($i = 0; $i -lt 40 -and (Get-Process -Id $ServerPid -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 150 }
    if (Get-Process -Id $ServerPid -ErrorAction SilentlyContinue) { & taskkill.exe /PID $ServerPid /T /F | Out-Null }
  }
  for ($i = 0; $i -lt 8; $i++) {
    $left = @(Get-AppProcess $ProfileDir)
    if (-not $left.Count) { break }
    foreach ($candidate in $left) { Stop-Process -Id $candidate.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 400
  }
  Log "browser processes left: $(@(Get-AppProcess $ProfileDir).Count)"
  Exit-Tray
}

# ---- notification identity -------------------------------------------------------------------------------------
# Without its own AppUserModelID a notification is labelled "Windows PowerShell" (the process that owns the icon).
# A Start menu shortcut that carries the id gives it the name and icon of Wheelhouse.
try {
  $startLink = Join-Path ([Environment]::GetFolderPath("Programs")) "$AppName.lnk"
  if ($LaunchVbs -and -not (Test-Path $startLink)) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($startLink)
    $link.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
    $link.Arguments = "`"$LaunchVbs`""
    $link.Description = $AppName
    if ($IconFile -and (Test-Path $IconFile)) { $link.IconLocation = "$IconFile,0" }
    $link.Save()
    [void][WhNative]::TagShortcut($startLink, "Wheelhouse.Tray")
  }
  [void][WhNative]::SetCurrentProcessExplicitAppUserModelID("Wheelhouse.Tray")
} catch { Log "notification identity not set: $($_.Exception.Message)" }

# ---- UI --------------------------------------------------------------------------------------------------------
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = $AppName
Set-TrayIcon $false

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open $AppName")
$openItem.Font = New-Object System.Drawing.Font($openItem.Font, [System.Drawing.FontStyle]::Bold)
$browserItem = $menu.Items.Add("Open in browser")
[void]$menu.Items.Add("-")
$statusItem = $menu.Items.Add("Starting...")
$statusItem.Enabled = $false
[void]$menu.Items.Add("-")
$autostartItem = $menu.Items.Add("Start with Windows")
$autostartItem.Checked = Test-Path $startupLink
if (-not $AutostartVbs) { $autostartItem.Enabled = $false }
[void]$menu.Items.Add("-")
$quitItem = $menu.Items.Add("Quit $AppName")
$notify.ContextMenuStrip = $menu

$openItem.add_Click({ Open-App })
$browserItem.add_Click({ Open-InBrowser })
$autostartItem.add_Click({
    $autostartItem.Checked = -not $autostartItem.Checked
    Set-Autostart $autostartItem.Checked
  })
$quitItem.add_Click({ Quit-All })
$notify.add_MouseClick({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-App }
  })

$hotkeys = New-Object WhHotkeyWindow
$appKey = ConvertTo-Hotkey $Hotkey
$browserKey = ConvertTo-Hotkey $BrowserHotkey
if ($appKey) {
  if ($hotkeys.Register(1, $appKey.Mod, $appKey.Key)) { $openItem.ShortcutKeyDisplayString = $Hotkey } else { Log "shortcut $Hotkey is taken by another program"; $openItem.ShortcutKeyDisplayString = "unavailable" }
}
if ($browserKey) {
  if ($hotkeys.Register(2, $browserKey.Mod, $browserKey.Key)) { $browserItem.ShortcutKeyDisplayString = $BrowserHotkey } else { Log "shortcut $BrowserHotkey is taken by another program"; $browserItem.ShortcutKeyDisplayString = "unavailable" }
}
$hotkeys.add_Pressed([Action[int]]{
    param($id)
    if ($id -eq 1) { Open-App } elseif ($id -eq 2) { Open-InBrowser }
  })

# ---- notifications ---------------------------------------------------------------------------------------------
# The server collects "finished / needs approval / has a question" items; they are shown as native notifications, so
# they arrive with the window closed too. A click opens the conversation the notification is about.
$script:noteCursor = $null
$script:noteSession = ""
function Clip-Text([string]$text, [int]$max) {
  if ($text.Length -le $max) { return $text }
  return $text.Substring(0, $max - 1) + [string][char]0x2026
}
function Show-Notes {
  try {
    $uri = "$Url/api/notifications"
    if ($null -ne $script:noteCursor) { $uri += "?since=$($script:noteCursor)" }
    $r = Invoke-RestMethod -Uri $uri -TimeoutSec 2
  } catch { return }
  $script:noteCursor = $r.cursor
  $items = @($r.items)
  if (-not $items.Count) { return }
  $last = $items[$items.Count - 1]
  $script:noteSession = [string]$last.sessionId
  $body = [string]$last.body
  if ($items.Count -gt 1) { $body = "$body  (+$($items.Count - 1))" }
  Log "notify: $($last.kind) $($last.sessionId)"
  $notify.ShowBalloonTip(10000, (Clip-Text ([string]$last.title) 60), (Clip-Text $body 230), [System.Windows.Forms.ToolTipIcon]::None)
}
$notify.add_BalloonTipClicked({ Open-Session $script:noteSession })

# ---- status polling --------------------------------------------------------------------------------------------
$script:waiting = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
function Update-Status {
  if (-not (Get-Process -Id $ServerPid -ErrorAction SilentlyContinue)) { Log "server is gone"; Quit-All; return }
  $text = "running"
  $waiting = $false
  try {
    $s = Invoke-RestMethod -Uri "$Url/api/status" -TimeoutSec 2
    $waiting = $s.waiting -gt 0
    if ($s.waiting -gt 0) { $text = "$($s.waiting) waiting for you" }
    elseif ($s.running -gt 0) { $text = "$($s.running) working" }
    else { $text = "idle" }
  } catch { $text = "not responding" }
  $label = "$AppName - $text"
  $statusItem.Text = "Running on " + ([Uri]$Url).Authority + " - $text"
  $notify.Text = $label.Substring(0, [Math]::Min(63, $label.Length))
  if ($waiting -ne $script:waiting) { $script:waiting = $waiting; Set-TrayIcon $waiting }
  Show-Notes
}
$timer.add_Tick({ Update-Status })
$timer.Start()
Update-Status
$notify.Visible = $true
Log "tray ready (pid $PID, server $ServerPid)"

if ($SelfTest) {
  $step = New-Object System.Windows.Forms.Timer
  $step.Interval = 6000
  $script:phase = 0
  $step.add_Tick({
      $script:phase++
      if ($script:phase -eq 1) { Log "selftest: open"; Open-App }
      elseif ($script:phase -eq 2) { Log "selftest: open again (must reuse the window)"; Open-App }
      else { $step.Stop(); Log "selftest: quit"; Quit-All }
    })
  $step.Start()
}

[System.Windows.Forms.Application]::Run()
Log "tray stopped"
