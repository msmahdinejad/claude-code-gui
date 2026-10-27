# Focus-or-open the standalone app window (Chrome/Edge --app mode). Dot-sourced by tray.ps1 and open-app.ps1.
# Keep this file ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
if (-not ("WhNative" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class WhNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
}
"@
}

# Browser processes that belong to the app profile (the main process has no --type= argument).
function Get-AppProcess([string]$ProfileDir) {
  if (-not $ProfileDir) { return @() }
  $list = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" -ErrorAction SilentlyContinue
  return @($list | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($ProfileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

function Show-AppWindow([string]$ProfileDir) {
  foreach ($candidate in (Get-AppProcess $ProfileDir | Where-Object { $_.CommandLine -notmatch "--type=" })) {
    $proc = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
      if ([WhNative]::IsIconic($proc.MainWindowHandle)) { [void][WhNative]::ShowWindow($proc.MainWindowHandle, 9) }
      [void][WhNative]::SetForegroundWindow($proc.MainWindowHandle)
      return $true
    }
  }
  return $false
}

# An open app window is brought to the front; otherwise a new one is started (or the default browser, if no
# Chromium-based browser was found).
function Open-AppWindow([string]$Url, [string]$Browser, [string]$ProfileDir) {
  if (Show-AppWindow $ProfileDir) { return }
  if ($Browser) { Start-Process -FilePath $Browser -ArgumentList @("--app=$Url", "--user-data-dir=`"$ProfileDir`"", "--window-size=1320,860") }
  else { Start-Process $Url }
}
