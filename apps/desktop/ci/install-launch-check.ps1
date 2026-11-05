# SPDX-License-Identifier: FSL-1.1-ALv2
#
# The Windows half of the install and launch check. The installer has already
# run silently by the time this is called (the workflow's "Install the app
# silently" step), so this launches what it installed and asks Windows whether
# the process and its window are actually there.
#
# The sidecar is not expected to be running: no session starts on its own, so
# it is spawned when a user picks a folder and an agent. What is checked is
# that the installed copy carries one and that it starts.
#
# A runner that is a Windows service runs in session 0, which has no
# interactive desktop: no window can come up there, whatever the app does.
# There the check asks for the next best proof instead: the app stays up for
# the whole wait and its WebView2 (msedgewebview2.exe, started by the app as
# its child) comes up, i.e. the UI engine started, not just the executable.
#
# Exit 0 the app launched and a window came up (or, in session 0, it stayed
# up and its WebView2 started). Exit 1 it did not.

# The executable the NSIS template installs is $INSTDIR\${MAINBINARYNAME}.exe,
# and MAINBINARYNAME is the CARGO binary's name, not the product name: the
# installed file is liaison-desktop.exe and `Liaison.exe` is produced by
# nothing. It is passed in rather than spelled here, from
# `artifact-names.ts main-binary`, so there is one place that decides it.
param(
    [int]$WaitSeconds = 10,
    [string]$MainBinaryName = $env:LIAISON_MAIN_BINARY
)

$ErrorActionPreference = "Stop"

if (-not $MainBinaryName) {
    throw "no main binary name: pass -MainBinaryName or set LIAISON_MAIN_BINARY from 'bun apps/desktop/ci/artifact-names.ts main-binary'"
}
$MainBinaryExe = "$MainBinaryName.exe"

$root = Join-Path $env:LOCALAPPDATA "Liaison"
if (-not (Test-Path $root)) { $root = Join-Path $env:ProgramFiles "Liaison" }
if (-not (Test-Path $root)) { throw "no installed Liaison to launch under $root" }

$exe = Get-ChildItem -Path $root -Filter $MainBinaryExe -Recurse -File |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $exe) { throw "the install carries no $MainBinaryExe" }

$sidecar = Get-ChildItem -Path $root -Filter "liaison-sidecar*.exe" -Recurse -File |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $sidecar) { throw "the install carries no sidecar, the first agent turn would fail" }

$session0 = (Get-Process -Id $PID).SessionId -eq 0
Write-Host "session 0 (no desktop): $session0"

# The WebView2 processes the app started, by parent process id.
function Get-WebViewChildren([int]$parentId) {
  @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' AND ParentProcessId=$parentId" -ErrorAction SilentlyContinue)
}

Write-Host "launching $exe"
$process = Start-Process -FilePath $exe -PassThru

$window = $false
$webview = $false
for ($i = 0; $i -lt $WaitSeconds; $i++) {
  Start-Sleep -Seconds 1
  if ($process.HasExited) { break }
  # MainWindowHandle stays zero until the window is actually up, which is the
  # difference between "the process started" and "the app came up".
  $process.Refresh()
  if ($process.MainWindowHandle -ne 0) { $window = $true; break }
  # In session 0 there is no window to wait for: keep watching the whole wait,
  # so "alive" below means it stayed up, not that it had not crashed yet.
  if ($session0 -and -not $webview) { $webview = (Get-WebViewChildren $process.Id).Count -gt 0 }
}

$alive = -not $process.HasExited
Write-Host "process alive: $alive"
Write-Host "window handle: $($process.MainWindowHandle)"
if ($session0) { Write-Host "webview2 started: $webview" }
Write-Host "sidecar installed: $sidecar"

if ($alive) {
  Get-WebViewChildren $process.Id | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}

if (-not $alive) { Write-Error "the app exited before a window came up"; exit 1 }
if ($window) { exit 0 }
if ($session0) {
  if (-not $webview) { Write-Error "session 0: the app stayed up but its WebView2 never started within $WaitSeconds seconds"; exit 1 }
  Write-Host "session 0: no desktop to show a window on; the app stayed up and its WebView2 started"
  exit 0
}
Write-Error "no window came up within $WaitSeconds seconds"
exit 1
