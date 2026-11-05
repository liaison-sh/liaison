# Windows code signing for the Liaison desktop build, Azure Artifact Signing.
#
# The shape of this script mirrors the monorepo's own ci/sign-windows.ps1 on
# purpose: the same six variable names, the same skip-when-unprovisioned
# behaviour, the same dlib brokered signtool call. An operator provisions one
# service principal and both pipelines use it. The two scripts are separate
# files because the two repos never reference each other's tree.
#
# Required variables (AZURE_CLIENT_ID unset means SKIP, see below):
#   AZURE_TENANT_ID         - service principal tenant id
#   AZURE_CLIENT_ID         - service principal app (client) id
#   AZURE_CLIENT_SECRET     - service principal secret
#   AZURE_CODESIGN_ACCOUNT  - Artifact Signing account name
#   AZURE_CODESIGN_PROFILE  - certificate profile name
#   AZURE_CODESIGN_ENDPOINT - region endpoint
# Optional:
#   WINDOWS_SIGN_TOOL       - path to signtool.exe (default: auto-detect)
#   AZURE_CODESIGN_DLIB     - path to Azure.CodeSigning.Dlib.dll (default: auto-detect)
#
# Two stages, because ORDER is the whole point. The sidecar .exe and the app
# .exe are signed BEFORE the bundler builds the installer around them: signing
# them afterwards leaves the copies inside the installer unsigned, and the
# installer's own signature is then a signature over unsigned code. That is the
# SmartScreen warning on first launch, and the antivirus quarantine a week
# later, and neither of them is visible on the machine that built it.
#
#   -Stage binaries   the sidecar .exe, then the app .exe        (before bundling)
#   -Stage installer  the NSIS setup .exe                        (after bundling)
#   -Stage file       exactly -Path, nothing else: the bundler's signCommand
#                     (tauri-build.ts), which signs the app .exe after any
#                     recompile, the uninstaller and the installer as it builds
#   -Stage all        both, in that order                        (a local run)
#
# Whichever way it goes, the installer stage WRITES DOWN what it did, in
# windows-signing.json beside the installer, and that file is uploaded with the
# artifacts. The publish job holds no Azure secret and so cannot work the
# answer out for itself: anything it reads out of its own environment says
# "unsigned" on every release, signed ones included, which is exactly how the
# Authenticode half of the two signature gate came to be waived on every real
# release while the log said it ran. The job that signed is the only one that
# knows, so it says so.
#
# Usage: pwsh apps/desktop/ci/sign-windows.ps1 -Stage binaries

param(
    [ValidateSet("binaries", "installer", "all", "file")]
    [string]$Stage = "all",

    # -Stage file only: the one file to sign.
    [string]$Path = "",

    # The certificate subject the artifacts are signed with, recorded in the
    # marker. It names what was signed WITH, not whether signing happened.
    [string]$Publisher = "Mathieu Frohlich"
)

$ErrorActionPreference = "Stop"

Write-Host "=== Liaison desktop Windows signing (stage: $Stage) ==="

$Desktop   = Split-Path (Split-Path $PSCommandPath -Parent) -Parent
$Release   = Join-Path $Desktop "src-tauri\target\release"
$Binaries  = Join-Path $Desktop "src-tauri\binaries"

# The three categories, in signing order. Each is resolved, never guessed: a
# category that resolves to nothing is a failure below, not a quiet skip.
$SidecarExes = @()
if (Test-Path $Binaries) {
    $SidecarExes = @(Get-ChildItem -Path $Binaries -Filter "liaison-sidecar-*.exe" -File |
        Select-Object -ExpandProperty FullName)
}
# Cargo writes the binary under its crate name; the bundler renames it to the
# product name when it stages the installer. Both spellings are accepted so a
# rename on either side cannot silently leave the app .exe unsigned.
$AppExe = @("liaison-desktop.exe", "Liaison.exe") |
    ForEach-Object { Join-Path $Release $_ } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
$Installers = Join-Path $Release "bundle\nsis"
$InstallerExes = @()
if (Test-Path $Installers) {
    $InstallerExes = @(Get-ChildItem -Path $Installers -Filter "*.exe" -File |
        Select-Object -ExpandProperty FullName)
}

# --- The signing marker the publish gate reads ------------------------------
#
# Beside the installer, because that is the directory the artifact upload
# takes: written anywhere else it is a file the publish job never downloads,
# which is the same as never writing it. Only the installer stage owns it: the
# binaries stage runs before the bundler, when that directory does not exist
# and when the installer it describes has not been built.
function Write-SigningMarker {
    param([bool]$Signed, [string]$Reason)

    if ($Stage -eq "binaries") { return }
    if (-not (Test-Path $Installers)) {
        New-Item -ItemType Directory -Force -Path $Installers | Out-Null
    }
    $Marker = Join-Path $Installers "windows-signing.json"
    $MarkerJson = @{
        signed    = $Signed
        reason    = $Reason
        publisher = $(if ($Signed) { $Publisher } else { "" })
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText($Marker, $MarkerJson)
    Write-Host "  signing marker: $Marker (signed=$Signed)"
}

# --- Gate: no Azure credentials means skip, LOUDLY, artifacts left as they are -
#
# The pre-provisioning weeks are real and the pipeline has to stay green
# through them. What must never happen is a quiet skip. Nothing is copied and
# nothing is moved: every file stays exactly where the build wrote it,
# unmodified, and the log says UNSIGNED in the plain.
if (-not $env:AZURE_CLIENT_ID) {
    Write-Host "  AZURE_CLIENT_ID is not set: SKIPPING code signing."
    Write-Host "  *** UNSIGNED BUILD *** every artifact below ships without a signature:"
    $Listed = if ($Stage -eq "file") { @($Path) } else { $SidecarExes + @($AppExe) + $InstallerExes }
    foreach ($Unsigned in $Listed) {
        if ($Unsigned) { Write-Host "    UNSIGNED: $Unsigned" }
    }
    Write-SigningMarker -Signed $false -Reason "AZURE_CLIENT_ID is not set: the build took the documented unsigned skip path"
    Write-Host "=== Windows signing skipped, artifacts are UNSIGNED ==="
    exit 0
}

# --- Validate the rest of the Azure config up front -------------------------
#
# Past this line signing was ASKED for. A half configured service principal
# must stop the release, not fall back to the skip path above: an operator who
# provisioned five of six variables wants to know, not to ship unsigned.
$Endpoint    = $env:AZURE_CODESIGN_ENDPOINT
$Account     = $env:AZURE_CODESIGN_ACCOUNT
$CertProfile = $env:AZURE_CODESIGN_PROFILE   # NB: $Profile is a PowerShell automatic variable
$missing = @()
if (-not $env:AZURE_TENANT_ID)     { $missing += "AZURE_TENANT_ID" }
if (-not $env:AZURE_CLIENT_SECRET) { $missing += "AZURE_CLIENT_SECRET" }
if (-not $Endpoint)                { $missing += "AZURE_CODESIGN_ENDPOINT" }
if (-not $Account)                 { $missing += "AZURE_CODESIGN_ACCOUNT" }
if (-not $CertProfile)             { $missing += "AZURE_CODESIGN_PROFILE" }
if ($missing.Count -gt 0) {
    Write-Error "AZURE_CLIENT_ID is set but these required variables are missing: $($missing -join ', ')"
    exit 1
}

# --- Locate signtool --------------------------------------------------------
$SignTool = $env:WINDOWS_SIGN_TOOL
if (-not $SignTool) {
    $SignTool = Get-ChildItem -Path "C:\Program Files (x86)\Windows Kits\10\bin" `
        -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\' } |
        Sort-Object { $_.Directory.Parent.Name } -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $SignTool) {
        Write-Error "signtool.exe not found (need Windows SDK >= 10.0.2261.755)"
        exit 1
    }
}
Write-Host "  signtool: $SignTool"

# --- Locate the Artifact Signing dlib (self-bootstrap via winget if absent) --
function Find-Dlib {
    $roots = @(
        "C:\Program Files\Microsoft Artifact Signing Client Tools",
        "C:\Program Files\Microsoft Trusted Signing Client Tools",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Packages",
        "C:\Program Files"
    )
    foreach ($root in $roots) {
        if (Test-Path $root) {
            $hit = Get-ChildItem -Path $root -Recurse -Filter "Azure.CodeSigning.Dlib.dll" -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match '\\x64\\' } |
                Select-Object -First 1 -ExpandProperty FullName
            if ($hit) { return $hit }
        }
    }
    return $null
}
$Dlib = $env:AZURE_CODESIGN_DLIB
if (-not $Dlib) { $Dlib = Find-Dlib }
if (-not $Dlib -and (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "  dlib not found, installing Artifact Signing Client Tools via winget..."
    winget install -e --id Microsoft.Azure.ArtifactSigningClientTools `
        --accept-source-agreements --accept-package-agreements 2>&1 | Out-Host
    $Dlib = Find-Dlib
}
if (-not $Dlib) {
    Write-Error "Azure.CodeSigning.Dlib.dll not found. Install with: winget install -e --id Microsoft.Azure.ArtifactSigningClientTools  (or set AZURE_CODESIGN_DLIB)"
    exit 1
}
Write-Host "  dlib: $Dlib"

# --- The Artifact Signing metadata file (UTF-8, no BOM) ---------------------
#
# In the runner's temp directory, never in the checkout: the file names the
# signing account, the certificate profile and the endpoint, and left in the
# working tree it is a file a later step can glob into an artifact, upload or
# commit, and one that simply stays there between jobs on a self hosted runner.
# It is removed at the end of this script, whichever way the script leaves.
$MetadataRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$Metadata = Join-Path $MetadataRoot "azure-codesign-metadata.json"
$metaJson = @{
    Endpoint               = $Endpoint
    CodeSigningAccountName = $Account
    CertificateProfileName = $CertProfile
    CorrelationId          = $env:GITHUB_RUN_ID
} | ConvertTo-Json
[System.IO.File]::WriteAllText($Metadata, $metaJson)
Write-Host "  account: $Account / profile: $CertProfile / endpoint: $Endpoint"

function Sign-Binary {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        Write-Error "refusing to continue: $Path does not exist"
        exit 1
    }
    $Name = Split-Path $Path -Leaf
    Write-Host "  Signing: $Name"

    # Artifact Signing certificates are valid about three days, so RFC3161
    # timestamping is mandatory: without it the signature dies with the cert.
    & $SignTool sign /v `
        /fd SHA256 /td SHA256 `
        /tr "http://timestamp.acs.microsoft.com" `
        /dlib "$Dlib" /dmdf "$Metadata" `
        /d "Liaison" `
        "$Path"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to sign $Name"
        exit 1
    }

    & $SignTool verify /pa /tw "$Path"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Signature did not verify: $Name"
        exit 1
    }
    Write-Host "  OK: $Name signed"
}

# The metadata file goes away whatever happens below, a failed signature
# included: it is removed in a finally block, not on the happy path only.
$signed = 0
try {

if ($Stage -eq "binaries" -or $Stage -eq "all") {
    # The sidecar first. It is a separate binary that the bundler copies whole
    # into the installer, so it is the one that has to be signed earliest.
    if ($SidecarExes.Count -eq 0) {
        Write-Error "no liaison-sidecar-*.exe under ${Binaries}: the installer would embed an unsigned sidecar"
        exit 1
    }
    foreach ($Exe in $SidecarExes) { Sign-Binary $Exe; $signed++ }

    if (-not $AppExe) {
        Write-Error "no app .exe under $Release (compile it with --no-bundle before this stage)"
        exit 1
    }
    Sign-Binary $AppExe
    $signed++
}

if ($Stage -eq "file") {
    if (-not $Path) {
        Write-Error "-Stage file needs -Path: the file the bundler asked to sign"
        exit 1
    }
    Sign-Binary $Path
    $signed++
}

if ($Stage -eq "installer" -or $Stage -eq "all") {
    if ($InstallerExes.Count -eq 0) {
        Write-Error "no installer under ${Installers}: nothing was bundled to sign"
        exit 1
    }
    foreach ($Exe in $InstallerExes) { Sign-Binary $Exe; $signed++ }
    # Written only after every installer signed AND verified: Sign-Binary exits
    # on the first failure, so a marker saying signed can only be reached by a
    # run where signtool signed and then verified every file.
    Write-SigningMarker -Signed $true -Reason "signtool signed and verified $signed file(s) through Azure Artifact Signing"
}

Write-Host "=== Windows signing complete: $signed binaries signed ==="

} finally {
    if (Test-Path $Metadata) { Remove-Item $Metadata -Force }
}
