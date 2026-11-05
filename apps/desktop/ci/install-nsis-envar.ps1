# Puts the NSIS EnVar plugin where tauri's bundled makensis will find it.
#
# WHY: the installer hooks must add and remove ONE element of the user PATH
# without ever reading the whole value into an NSIS string. An NSIS string holds
# 1024 characters by default, and a real user PATH is often longer, so the hand
# written read-modify-write silently truncated it and the customer lost every
# tool past the limit. EnVar does the element edit inside the plugin.
#
# PINNED BY HASH, because this is a third party DLL that ends up inside a signed
# installer. The URL is the plugin's own release archive and the SHA256 below is
# the archive this pipeline was built against: a different archive at that URL
# stops the build rather than being packaged.
#
# NOT into tauri's own NSIS directory, deliberately: the bundler DELETES and
# re-extracts that directory whenever one of the files it expects is missing,
# which on a cold runner happens after this step has run. The plugin goes into
# a directory this pipeline owns and installer-hooks.nsi reaches it with
# !addplugindir, reading LIAISON_NSIS_PLUGINS at compile time.
#
# Usage: pwsh apps/desktop/ci/install-nsis-envar.ps1 [-Destination <dir>]

param(
    [string]$Destination = ""
)

$ErrorActionPreference = "Stop"

if (-not $Destination) { $Destination = $env:LIAISON_NSIS_PLUGINS }
if (-not $Destination) {
    $root = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
    $Destination = Join-Path $root "liaison-nsis-plugins"
}

$Url = "https://nsis.sourceforge.io/mediawiki/images/7/7f/EnVar_plugin.zip"
$Sha256 = "E9AA92DE351345ED82795251D838F1AE9041BA35AF9D381A5780C7843B01F56A"

$Archive = Join-Path $env:RUNNER_TEMP "EnVar_plugin.zip"
if (-not $env:RUNNER_TEMP) { $Archive = Join-Path $env:TEMP "EnVar_plugin.zip" }
$Extracted = "$Archive.d"

Write-Host "=== NSIS EnVar plugin ==="
Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing
$Actual = (Get-FileHash -Path $Archive -Algorithm SHA256).Hash
if ($Actual -ne $Sha256) {
    Write-Error "EnVar_plugin.zip does not match the pinned hash. expected $Sha256, got $Actual. Refusing to package an archive nobody reviewed."
    exit 1
}
Write-Host "  sha256 matches the pin: $Actual"

if (Test-Path $Extracted) { Remove-Item $Extracted -Recurse -Force }
Expand-Archive -Path $Archive -DestinationPath $Extracted -Force

# x86-unicode: tauri's bundled makensis is the 32 bit unicode build, and
# installer-hooks.nsi adds this directory with !addplugindir /x86-unicode.
$source = Join-Path $Extracted "Plugins\x86-unicode\EnVar.dll"
if (-not (Test-Path $source)) {
    Write-Error "the archive carried no Plugins\x86-unicode\EnVar.dll: the installer would not build"
    exit 1
}
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
Copy-Item -Path $source -Destination $Destination -Force
Write-Host "  installed: $Destination\EnVar.dll"

Remove-Item $Archive -Force
Remove-Item $Extracted -Recurse -Force
Write-Host "=== EnVar installed into $Destination ==="
Write-Host "    installer-hooks.nsi reads it through LIAISON_NSIS_PLUGINS"
exit 0
