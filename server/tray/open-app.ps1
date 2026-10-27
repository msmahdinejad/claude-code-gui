# Focus-or-open the app window once (used by `wheelhouse --app` on Windows). See app-window.ps1.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$Browser = "",
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [string]$IconFile = "",
  [string]$LaunchVbs = ""
)
. (Join-Path $PSScriptRoot "app-window.ps1")
Open-AppWindow $Url $Browser $ProfileDir $IconFile $LaunchVbs
