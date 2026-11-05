# Post-install smoke check: did the installer actually REGISTER the app?
#
# An install that copies the binaries and registers nothing looks like a
# success from every angle a CI job normally has: the installer exits 0, the
# app launches, the window opens. What is missing is everything the operating
# system holds ON BEHALF of the app, and each piece of it fails somewhere else:
#
#   - the liaison:// scheme: deep links open nothing, or open the executable
#     the PREVIOUS version installed, which after a directory change is a path
#     that no longer exists;
#   - the uninstall key: the app is not in Installed Apps and cannot be removed
#     through Windows at all;
#   - the PATH entry (one ELEMENT of it, which is what the installer adds):
#     the command line does not find the app;
#   - the signatures of the binaries it actually installed: the installer's own
#     signature says nothing about its payload, and a relink between the two
#     signing stages leaves an unsigned main binary on the machine with every
#     step in the build green.
#
# So this runs after a real (silent) install on the Windows runner and refuses
# a build where any of the three is missing. It reports ALL failures before
# exiting: this runs on a machine nobody logs into, and three runs to learn
# three things is three releases.
#
# Usage: pwsh apps/desktop/ci/verify-windows-registration.ps1 [-ProductName <name>]
#          [-MainBinaryName <name>] [-InstallDir <path>] [-Publisher <name>]
#
# AZURE_CLIENT_ID unset means this build asked for no signature, and the
# signature check then asserts the UNSIGNED state instead of demanding one.
#
# TWO NAMES, AND NEITHER IS THE ONE IT LOOKS LIKE. Read from tauri's own NSIS
# template (crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi):
#
#   - the uninstall key is Uninstall\${PRODUCTNAME}, the PRODUCT name, not the
#     bundle identifier. This script asked for the identifier and would have
#     reported "no uninstall entry" on a perfectly registered install.
#   - the installed executable is ${MAINBINARYNAME}.exe, which is the CARGO
#     binary's name (liaison-desktop), not the product name. `Liaison.exe` is
#     produced by nothing, anywhere in this pipeline.

param(
    [string]$ProductName = "Liaison",
    [string]$MainBinaryName = $env:LIAISON_MAIN_BINARY,
    [string]$InstallDir = "",
    [string]$Publisher = "Mathieu Frohlich"
)

$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "windows-signature.ps1")

Write-Host "=== Liaison Windows registration check ==="

if (-not $MainBinaryName) {
    throw "no main binary name: pass -MainBinaryName or set LIAISON_MAIN_BINARY from 'bun apps/desktop/ci/artifact-names.ts main-binary'"
}

$failures = @()
$UninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$ProductName"

# --- 1. The liaison:// URL scheme -------------------------------------------
$Scheme = Get-ItemProperty -Path "HKCU:\Software\Classes\liaison" -ErrorAction SilentlyContinue
if (-not $Scheme) {
    $failures += "the liaison:// scheme is not registered (HKCU:\Software\Classes\liaison is absent)"
} else {
    if ($null -eq $Scheme."URL Protocol") {
        $failures += "HKCU:\Software\Classes\liaison exists but carries no 'URL Protocol' value, so Windows will not treat it as a scheme"
    }
    $Command = (Get-ItemProperty -Path "HKCU:\Software\Classes\liaison\shell\open\command" -ErrorAction SilentlyContinue)."(default)"
    if (-not $Command) {
        $failures += "the liaison:// scheme has no shell\open\command, so a deep link opens nothing"
    } else {
        Write-Host "  scheme command: $Command"
        # The value is '"C:\path\liaison-desktop.exe" "%1"'. The executable it
        # names has to EXIST: a key left behind by a previous version is
        # present and
        # useless, and that is the update failure this check is for.
        $Executable = ($Command -split '"')[1]
        if (-not $Executable -or -not (Test-Path $Executable)) {
            $failures += "the liaison:// scheme points at an executable that does not exist: $Executable"
        } elseif ($Executable -notmatch '\.exe$') {
            $failures += "the liaison:// scheme does not point at an .exe: $Executable"
        }
    }
}

# --- 2. The uninstall entry --------------------------------------------------
$Uninstall = Get-ItemProperty -Path $UninstallKey -ErrorAction SilentlyContinue
if (-not $Uninstall) {
    $failures += "no uninstall entry at $UninstallKey, the app cannot be removed through Windows"
} else {
    Write-Host "  uninstall entry: $($Uninstall.DisplayName) $($Uninstall.DisplayVersion)"
    if (-not $Uninstall.UninstallString) {
        $failures += "the uninstall entry carries no UninstallString"
    }
    # Installed Apps shows this name; it must be the one the binaries are
    # signed by (installer-hooks.nsi, LIAISON_PUBLISHER).
    if ($Uninstall.Publisher -ne $Publisher) {
        $failures += "the uninstall entry names publisher '$($Uninstall.Publisher)', expected '$Publisher'"
    }
    # The template writes this value WITH its quotes ("$\"$INSTDIR$\""), so the
    # raw string is '"C:\Users\...\Liaison"'. Joining a path onto that reads
    # every installed binary as absent, which would have failed the signature
    # half below on a correct install.
    if (-not $InstallDir -and $Uninstall.InstallLocation) {
        $InstallDir = $Uninstall.InstallLocation.Trim().Trim('"').TrimEnd('\')
    }
}

# --- 3. The user PATH entry --------------------------------------------------
if (-not $InstallDir) {
    $failures += "no install directory to check PATH against (the uninstall entry has no InstallLocation and -InstallDir was not given)"
} else {
    # PATH membership is an ELEMENT question, because that is what the installer
    # writes: EnVar::AddValue appends one element. A substring test would say
    # yes to a directory that merely shares a prefix, and a raw comparison would
    # say no to the same directory written with a trailing separator or in
    # quotes, both of which Windows treats as the same place. Comparison is case
    # insensitive, which is PowerShell's default for -eq and -contains on
    # strings and is also how the file system behaves.
    function ConvertTo-PathEntry {
        param([string]$Value)
        return $Value.Trim().Trim('"').TrimEnd('\')
    }
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    Write-Host "  install directory: $InstallDir"
    $Entries = @($UserPath -split ';' |
        Where-Object { $_ } |
        ForEach-Object { ConvertTo-PathEntry $_ })
    $Wanted = ConvertTo-PathEntry $InstallDir
    if ($Entries -notcontains $Wanted) {
        $failures += "the user PATH has no entry for the install directory: $InstallDir"
    }
    # The same check EnVar::AddValue's idempotency exists for: a duplicated
    # entry means twenty updates would leave twenty copies.
    $occurrences = @($Entries | Where-Object { $_ -eq $Wanted }).Count
    if ($occurrences -gt 1) {
        $failures += "the install directory appears $occurrences times in the user PATH, the installer hook is adding it again on every run"
    }
}

# --- 4. The signatures of the binaries that were actually installed ----------
#
# The installer's signature covers the installer. What ends up on the machine
# is what this asks about, and it is the only place the question can be
# answered: a relink between the two signing stages, or a stale staged copy,
# both produce an unsigned main binary under a perfectly signed setup .exe.
if (-not $InstallDir) {
    $failures += "no install directory to check the binary signatures against"
} else {
    $Binaries = @("$MainBinaryName.exe", "liaison-sidecar.exe") |
        ForEach-Object { Join-Path $InstallDir $_ }
    $failures += Get-LiaisonSignatureFailures `
        -Files $Binaries `
        -Publisher $Publisher `
        -ExpectSigned ([bool]$env:AZURE_CLIENT_ID)
}

# --- Verdict -----------------------------------------------------------------
if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "=== registration check FAILED ==="
    foreach ($failure in $failures) { Write-Host "  MISSING: $failure" }
    Write-Error "Liaison is installed but not registered: $($failures.Count) check(s) failed"
    exit 1
}

Write-Host "=== registration check passed: scheme, uninstall entry, PATH and binary signatures ==="
exit 0
