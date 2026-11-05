# Authenticode state of a set of files, as a list of failures.
#
# Dot sourced by ci/verify-windows-signatures.ps1 (the bundler's output, before
# the installer is signed) and by ci/verify-windows-registration.ps1 (the files
# the installer actually put on the machine). One implementation, because the
# two questions are the same question asked in two places, and two copies of it
# drift the moment one of them is edited.
#
# WHAT IT IS FOR: `tauri build --bundles nsis` runs cargo again, and cargo
# decides for itself whether to relink. A relink rewrites the app .exe and
# throws away the signature the previous step put on it. Nothing says so: the
# installer around it is signed, every step is green, and the binary a customer
# double clicks is unsigned, which is the SmartScreen warning on first launch
# and the antivirus quarantine a week later.
#
# UNSIGNED IS A STATE, NOT AN EXCUSE: before the service principal exists,
# AZURE_CLIENT_ID is unset and nothing is signed on purpose. The check then
# asserts the UNSIGNED state rather than skipping, so "this build is unsigned"
# and "this build lost its signature" can never look alike.

function Get-LiaisonSignatureFailures {
    param(
        [string[]]$Files,
        [string]$Publisher = "Mathieu Frohlich",
        [bool]$ExpectSigned = $true
    )

    $failures = @()
    foreach ($File in $Files) {
        $Name = Split-Path $File -Leaf
        if (-not (Test-Path $File)) {
            $failures += "$Name does not exist at $File"
            continue
        }
        $Signature = Get-AuthenticodeSignature -FilePath $File

        if (-not $ExpectSigned) {
            # No credential was provisioned, so the only correct state is no
            # signature. A signature here came from somewhere nobody named.
            if ($Signature.Status -eq "NotSigned") {
                Write-Host "  UNSIGNED (as expected, no signing credential): $Name"
            } else {
                $failures += "$Name carries a signature ($($Signature.Status)) in a build that asked for none"
            }
            continue
        }

        if ($Signature.Status -ne "Valid") {
            $failures += "$Name is not validly signed: status $($Signature.Status). A relink after the signing step discards the signature."
            continue
        }
        $Subject = $Signature.SignerCertificate.Subject
        if ($Subject -notmatch [regex]::Escape($Publisher)) {
            $failures += "$Name is signed by an unexpected publisher: $Subject (expected a subject containing '$Publisher')"
            continue
        }
        Write-Host "  signed and valid: $Name  [$Subject]"
    }
    return $failures
}
