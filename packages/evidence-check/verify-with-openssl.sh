#!/bin/sh
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Check an evidence file (the staff file or a signer's copy) with openssl
# alone, using only the files inside the zip plus the timestamp authority's
# own published certificate chain (never taken from the zip: a chain the zip
# carried would vouch for itself).
#
#   verify-with-openssl.sh <evidence.zip> [tsa-chain.pem]
#
# Checks: document.pdf and signed.pdf have the fingerprints manifest.json
# names; the seal is the SHA-256 of manifest.json; the full event list has the
# manifest's fingerprint (a signer's copy leaves other people's devices out,
# so it is not checked); and, when timestamp.tsr is there, that the
# authority's reply is over manifest.json and verifies against the chain.
# Exit 0 when every check passed, 1 when one failed, 2 on a usage error.
set -eu

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 <evidence.zip> [tsa-chain.pem]" >&2
  exit 2
fi
zip=$1
chain=${2:-}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
unzip -q "$zip" -d "$work"

failed=0
manifest="$work/manifest.json"
for f in manifest.json document.pdf signed.pdf trail.json; do
  if [ ! -f "$work/$f" ]; then
    echo "FAIL: $f is missing from the zip"
    exit 1
  fi
done

field() { sed -n "s/.*\"$1\":\"\([0-9a-f]\{64\}\)\".*/\1/p" "$manifest"; }
sha256() { openssl dgst -sha256 -r "$1" | cut -d' ' -f1; }

check() {
  name=$1
  want=$2
  got=$(sha256 "$work/$name")
  if [ -n "$want" ] && [ "$got" = "$want" ]; then
    echo "OK: $name has the fingerprint in the manifest ($got)"
  else
    echo "FAIL: $name has fingerprint $got, the manifest names ${want:-nothing}"
    failed=1
  fi
}

check document.pdf "$(field document_sha256)"
check signed.pdf "$(field signed_pdf_sha256)"

seal=$(sha256 "$manifest")
echo "Seal (SHA-256 of manifest.json): $seal"

trail_want=$(field trail_sha256)
trail_got=$(sha256 "$work/trail.json")
if [ "$trail_got" = "$trail_want" ]; then
  echo "OK: trail.json is the sealed event list"
elif grep -q '"copy":{' "$work/trail.json"; then
  echo "NOTE: trail.json is a signer's copy, without other people's devices: it is not checked against the seal"
else
  echo "FAIL: trail.json has fingerprint $trail_got, the manifest names $trail_want"
  failed=1
fi

if [ -f "$work/timestamp.tsr" ]; then
  if [ -z "$chain" ]; then
    echo "The zip has a timestamp: give the authority's certificate chain to check it." >&2
    exit 2
  fi
  if openssl ts -verify -in "$work/timestamp.tsr" -data "$manifest" -CAfile "$chain" >"$work/ts.out" 2>&1; then
    echo "OK: the timestamp is over manifest.json and verifies against $chain"
  else
    echo "FAIL: the timestamp does not verify:"
    cat "$work/ts.out"
    failed=1
  fi
else
  echo "NOTE: no timestamp yet (timestamp.tsr is not in the zip)"
fi

exit $failed
