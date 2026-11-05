# Parse every .ps1 under the given roots with the real PowerShell parser.
#
# WHY IT EXISTS: every PowerShell script here was checked as TEXT, because no
# pwsh was installed on the machines that wrote them. Text checks cannot see a
# syntax error, and a syntax error means the script never runs at all: a
# Windows release job spent a full build reaching the signing step and died
# there on "$Binaries:" inside a double quoted string, which PowerShell reads
# as a scope qualified variable reference. The fix is to run the parser the
# shell itself uses, on every script, before the release does.
#
# Prints one "file:line: message" line per parse error and exits 1 if there was
# any; prints "ok <file>" per clean file and exits 0 otherwise.
#
# Usage: pwsh apps/desktop/ci/parse-powershell.ps1 -Path apps/desktop,apps/mobile

param(
    # Every root to sweep, comma separated (pwsh -File binds a bare space
    # separated list positionally and refuses it):
    #   -Path apps/desktop,apps/mobile
    [Parameter(Mandatory = $true)]
    [string[]]$Path
)

$ErrorActionPreference = "Stop"

# `pwsh -File` hands every argument over as one string, so a comma separated
# list arrives as a single element and has to be split here rather than by the
# parameter binder.
$Roots = @($Path | ForEach-Object { $_ -split ',' } | Where-Object { $_ })

$found = 0
foreach ($Root in $Roots) {
    if (-not (Test-Path $Root)) {
        Write-Host "no such path: $Root"
        $found++
        continue
    }
    $Scripts = @(Get-ChildItem -Path $Root -Recurse -Filter *.ps1 -File |
        Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' } |
        Sort-Object FullName)
    foreach ($Script in $Scripts) {
        $tokens = $null
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile(
            $Script.FullName, [ref]$tokens, [ref]$errors)
        if ($errors -and $errors.Count -gt 0) {
            foreach ($e in $errors) {
                Write-Host ("{0}:{1}: {2}" -f $Script.FullName, $e.Extent.StartLineNumber, $e.Message)
                $found++
            }
        } else {
            Write-Host ("ok {0}" -f $Script.FullName)
        }
    }
}

if ($found -gt 0) {
    Write-Host "=== $found PowerShell parse error(s) ==="
    exit 1
}
exit 0
