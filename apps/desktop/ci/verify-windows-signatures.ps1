# Are the binaries the bundler packaged still signed?
#
# This runs AFTER `tauri build --bundles nsis` and BEFORE the installer is
# signed, and it exists because of what happens in between: the bundler runs
# cargo again, cargo may relink the app .exe, and a relink discards the
# Authenticode signature the earlier stage put on it. The installer is then a
# correctly signed container around an unsigned executable, which no step in
# the build can notice and every customer's first launch can.
#
# Usage:
#   pwsh apps/desktop/ci/verify-windows-signatures.ps1 `
#     -Path 'src-tauri/target/release/Liaison.exe','src-tauri/binaries/liaison-sidecar-*.exe' `
#     -Publisher 'Mathieu Frohlich'
#
# A pattern that matches no file is a FAILURE, not an empty success: the state
# this check guards against is a missing binary's missing signature.

param(
    [Parameter(Mandatory = $true)][string[]]$Path,
    [string]$Publisher = "Mathieu Frohlich"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-signature.ps1")

$ExpectSigned = [bool]$env:AZURE_CLIENT_ID
if ($ExpectSigned) {
    Write-Host "=== Liaison Windows signature check (expecting signed by '$Publisher') ==="
} else {
    Write-Host "=== Liaison Windows signature check (AZURE_CLIENT_ID unset: expecting UNSIGNED) ==="
}

$failures = @()
$files = @()
foreach ($Pattern in $Path) {
    $matched = @(Get-ChildItem -Path $Pattern -File -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName)
    if ($matched.Count -eq 0) {
        $failures += "matched no file: $Pattern"
        continue
    }
    $files += $matched
}

$failures += Get-LiaisonSignatureFailures -Files $files -Publisher $Publisher -ExpectSigned $ExpectSigned

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "=== signature check FAILED ==="
    foreach ($failure in $failures) { Write-Host "  BAD: $failure" }
    Write-Error "the binaries about to be packaged are not in the signature state this build asked for: $($failures.Count) failure(s)"
    exit 1
}

Write-Host "=== signature check passed: $($files.Count) binaries ==="
exit 0
