# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Removes the per-user install that the release job's "Install the app
# silently" step made, so a self-hosted runner, which outlives the job and runs
# in a real user's session, is left without a test build of Liaison in that
# user's profile. On a hosted runner it is the same few seconds of tidying.
#
# Only processes running from the install directory are stopped: a Liaison the
# user has open from anywhere else is not this job's to close.
#
# Exit 0 nothing was installed, or the install is gone. Exit 1 it is still there.

$ErrorActionPreference = "Stop"

$root = Join-Path $env:LOCALAPPDATA "Liaison"
$uninstaller = Join-Path $root "uninstall.exe"
if (-not (Test-Path $uninstaller)) {
  Write-Host "nothing installed under $root"
  exit 0
}

Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# _?= runs the uninstaller in place and waits for it, instead of the copy in
# TEMP that NSIS otherwise hands the work to and returns at once. It also means
# the uninstaller cannot delete itself, so the directory goes afterwards.
$process = Start-Process -FilePath $uninstaller -ArgumentList "/S", "_?=$root" -Wait -PassThru
if ($process.ExitCode -ne 0) {
  Write-Error "the uninstaller exited with $($process.ExitCode)"
  exit 1
}
Remove-Item -Path $root -Recurse -Force -ErrorAction SilentlyContinue

if (Test-Path (Join-Path $root "*.exe")) {
  Write-Error "the install is still under $root"
  exit 1
}
Write-Host "uninstalled from $root"
exit 0
