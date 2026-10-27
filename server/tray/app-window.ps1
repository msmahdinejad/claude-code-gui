# Focus-or-open the standalone app window (Chrome/Edge --app mode) and give it its own taskbar identity and icon.
# Dot-sourced by tray.ps1 and open-app.ps1. Keep this file ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
if (-not ("WhNative" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class WhNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr hinst, string name, uint type, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Sequential)] struct PropVariant { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }

  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid riid, out IPropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant var);

  static void Set(IPropertyStore store, uint pid, string value) {
    PropertyKey key = new PropertyKey();
    key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    key.pid = pid;
    PropVariant variant = new PropVariant();
    variant.vt = 31; // VT_LPWSTR
    variant.p = Marshal.StringToCoTaskMemUni(value);
    store.SetValue(ref key, ref variant);
    PropVariantClear(ref variant); // frees the string
  }

  // Own AppUserModelID (so the window is not grouped under the browser's taskbar button) + relaunch info (what a
  // pinned taskbar button runs and shows), and the window icon itself.
  public static int Identify(IntPtr hwnd, string appId, string relaunchCommand, string iconFile, string displayName) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore store;
    int hr = SHGetPropertyStoreForWindow(hwnd, ref iid, out store);
    if (hr != 0 || store == null) return hr;
    Set(store, 5, appId);                                  // System.AppUserModel.ID
    if (!string.IsNullOrEmpty(relaunchCommand)) {
      Set(store, 2, relaunchCommand);                      // RelaunchCommand
      Set(store, 4, displayName);                          // RelaunchDisplayNameResource
      if (!string.IsNullOrEmpty(iconFile)) Set(store, 3, iconFile + ",0"); // RelaunchIconResource
    }
    store.Commit();
    Marshal.ReleaseComObject(store);
    if (!string.IsNullOrEmpty(iconFile)) {
      IntPtr big = LoadImage(IntPtr.Zero, iconFile, 1, 64, 64, 0x10);
      IntPtr small = LoadImage(IntPtr.Zero, iconFile, 1, 16, 16, 0x10);
      if (big != IntPtr.Zero) SendMessage(hwnd, 0x0080, new IntPtr(1), big);
      if (small != IntPtr.Zero) SendMessage(hwnd, 0x0080, IntPtr.Zero, small);
    }
    return 0;
  }
}
"@
}

$script:WhAppId = "Wheelhouse.App"

# Browser processes that belong to the app profile (the main process has no --type= argument).
function Get-AppProcess([string]$ProfileDir) {
  if (-not $ProfileDir) { return @() }
  $list = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" -ErrorAction SilentlyContinue
  return @($list | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($ProfileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

function Get-AppWindowHandle([string]$ProfileDir) {
  foreach ($candidate in (Get-AppProcess $ProfileDir | Where-Object { $_.CommandLine -notmatch "--type=" })) {
    $proc = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) { return $proc.MainWindowHandle }
  }
  return [IntPtr]::Zero
}

function Set-AppWindowIdentity([IntPtr]$Handle, [string]$IconFile, [string]$LaunchVbs) {
  $relaunch = ""
  if ($LaunchVbs) { $relaunch = "`"" + (Join-Path $env:WINDIR "System32\wscript.exe") + "`" `"$LaunchVbs`"" }
  try { [void][WhNative]::Identify($Handle, $script:WhAppId, $relaunch, $IconFile, "Wheelhouse") } catch { }
}

function Show-AppWindow([string]$ProfileDir, [string]$IconFile = "", [string]$LaunchVbs = "") {
  $handle = Get-AppWindowHandle $ProfileDir
  if ($handle -eq [IntPtr]::Zero) { return $false }
  Set-AppWindowIdentity $handle $IconFile $LaunchVbs
  if ([WhNative]::IsIconic($handle)) { [void][WhNative]::ShowWindow($handle, 9) }
  [void][WhNative]::SetForegroundWindow($handle)
  return $true
}

# An open app window is brought to the front; otherwise a new one is started (or the default browser, if no
# Chromium-based browser was found). New windows get their own taskbar identity and icon as soon as they appear.
function Open-AppWindow([string]$Url, [string]$Browser, [string]$ProfileDir, [string]$IconFile = "", [string]$LaunchVbs = "") {
  if (Show-AppWindow $ProfileDir $IconFile $LaunchVbs) { return }
  if (-not $Browser) { Start-Process $Url; return }
  Start-Process -FilePath $Browser -ArgumentList @("--app=$Url", "--user-data-dir=`"$ProfileDir`"", "--window-size=1320,860")
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    $handle = Get-AppWindowHandle $ProfileDir
    if ($handle -ne [IntPtr]::Zero) { Start-Sleep -Milliseconds 300; Set-AppWindowIdentity $handle $IconFile $LaunchVbs; return }
  }
}
