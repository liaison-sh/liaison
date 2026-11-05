#!/bin/bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Codesigns the Liaison desktop SIDECAR binary with the hardened runtime.
#
# ORDERING RULE: the sidecar signs FIRST. The outer bundle is signed by the
# monorepo's own ci/sign-macos.sh, which must run AFTER this script, never
# before it: re-signing the outer bundle is what seals a nested binary whose
# signature changed underneath it.
#
# KEYCHAIN: this script does not invent a second way to handle signing
# material. On CI it expects the SAME variables the monorepo's ci/sign-macos.sh
# documents, and performs the same temporary-keychain setup when they are
# present:
#   MACOS_CERTIFICATE_P12   base64 encoded .p12
#   MACOS_CERTIFICATE_PWD   password for the .p12
#   MACOS_KEYCHAIN_PWD      temporary keychain password
# On a developer Mac none of those are set and the Developer ID identity is
# already in the login keychain, so the identity is read from there instead.
#
# TEAM: APPLE_TEAM_ID is REQUIRED, on CI and on a developer Mac alike (set it
# to the Team ID Liaison ships under). A keychain can hold several teams'
# Developer ID certificates, so the identity is the one Developer ID
# Application of THAT team, by its SHA-1 hash, never the first match
# (macos-signing-identity.sh). SIGNING_IDENTITY may still pin one explicitly;
# either way the signed binary's TeamIdentifier is asserted afterwards.
#
# Usage: apps/desktop/ci/sign-sidecar-macos.sh <path to the sidecar binary>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENTITLEMENTS="$SCRIPT_DIR/entitlements-sidecar.plist"
BINARY="${1:?usage: sign-sidecar-macos.sh <path to the sidecar binary>}"

if [ ! -f "$BINARY" ]; then
  echo "Sidecar binary not found: $BINARY" >&2
  exit 1
fi
if [ ! -f "$ENTITLEMENTS" ]; then
  echo "Sidecar entitlements not found: $ENTITLEMENTS" >&2
  exit 1
fi

echo "=== Liaison sidecar code signing ==="

# shellcheck source=macos-signing-identity.sh
source "$SCRIPT_DIR/macos-signing-identity.sh"
# Before anything else, the temporary keychain included: no team, no signing.
require_apple_team_id

KEYCHAIN_ARG=()
if [ -n "${MACOS_CERTIFICATE_P12:-}" ]; then
  # shellcheck source=macos-temp-keychain.sh
  source "$SCRIPT_DIR/macos-temp-keychain.sh"
  setup_temp_keychain sidecar-signing
fi

resolve_signing_identity

codesign --force --options runtime --timestamp \
  --sign "$SIGNING_IDENTITY" \
  --entitlements "$ENTITLEMENTS" \
  "$BINARY"

codesign --verify --deep --strict "$BINARY"
assert_signed_by_team "$BINARY"
echo "OK: sidecar signed and verified: $BINARY"
