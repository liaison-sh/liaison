#!/bin/bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Codesigns and notarizes the Liaison desktop APP BUNDLE.
#
# ORDERING RULE: this runs AFTER apps/desktop/ci/sign-sidecar-macos.sh. The
# sidecar is signed on its own, with its own entitlements, and embedded; this
# script seals the bundle around it. Run in the other order and the outer
# signature covers a binary that changed underneath it.
#
# The nested pass is the monorepo ci/sign-macos.sh sign_app() shape (dylibs,
# then Mach-O executables, then nested .xpc/.app/.framework inside out, then
# the outer bundle), with ONE deliberate difference: a nested binary that
# already carries OUR Developer ID signature, that of team APPLE_TEAM_ID, is
# left alone (an ad hoc one or another team's is not, see sign_nested). The monorepo products have no
# pre-signed payload; this app does, and re-signing the sidecar here would
# replace its JIT entitlements with the app's, which do not grant JIT. That
# failure does not show up until an agent turn runs on a customer's machine.
#
# KEYCHAIN: the same variables ci/sign-macos.sh documents, and the same
# temporary keychain setup when they are present:
#   MACOS_CERTIFICATE_P12   base64 encoded .p12
#   MACOS_CERTIFICATE_PWD   password for the .p12
#   MACOS_KEYCHAIN_PWD      temporary keychain password
# On a developer Mac none of those are set and the Developer ID identity is
# read from the login keychain. SIGNING_IDENTITY pins it explicitly.
#
# TEAM: APPLE_TEAM_ID is REQUIRED, on CI and on a developer Mac alike (set it
# to the Team ID Liaison ships under). A keychain can hold several teams'
# Developer ID certificates, so the identity is the one Developer ID
# Application of THAT team, by its SHA-1 hash, never the first match, and the
# sidecar and the bundle are asserted to carry that team once signed
# (macos-signing-identity.sh).
#
# NOTARIZATION credentials, also the names ci/sign-macos.sh documents:
#   APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID
# or, on a Mac where they are already stored, NOTARY_KEYCHAIN_PROFILE (passed
# to notarytool as --keychain-profile). No value is ever printed.
#
# Usage: apps/desktop/ci/sign-app-macos.sh <path to Liaison.app> [--no-notarize]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTITLEMENTS="$SCRIPT_DIR/entitlements-app.plist"
APP_PATH="${1:-}"
NOTARIZE=1
if [ "${2:-}" = "--no-notarize" ]; then
  # Asked for in writing, and said out loud: an unnotarized bundle is refused
  # by Gatekeeper on any machine that did not build it.
  NOTARIZE=0
fi

if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
  echo "usage: sign-app-macos.sh <path to .app> [--no-notarize]" >&2
  exit 1
fi
if [ ! -f "$ENTITLEMENTS" ]; then
  echo "App entitlements not found: $ENTITLEMENTS" >&2
  exit 1
fi

APP_NAME="$(basename "$APP_PATH")"
echo "=== Liaison app code signing: $APP_NAME ==="

# shellcheck source=macos-signing-identity.sh
source "$SCRIPT_DIR/macos-signing-identity.sh"
# Before anything is signed or kept: no team, no signing.
require_apple_team_id

# --- The embedded sidecar keeps its OWN entitlements -------------------------
#
# Measured, not assumed: `tauri build` RE-SIGNS the externalBin while it
# bundles it. The copy inside Contents/MacOS comes out with a valid Developer
# ID signature and the hardened runtime, and with NO entitlements at all, so
# the JIT grant the sidecar was signed with before the build is gone by the
# time the bundle exists. Nothing about that is visible in a codesign --verify:
# the app notarizes, ships, and the first agent turn dies on a JIT that is no
# longer allowed.
#
# So the sidecar is signed again HERE, inside the bundle, with 6a's script and
# its own entitlements file, and before the outer bundle is sealed around it.
SIDECAR="$APP_PATH/Contents/MacOS/liaison-sidecar"
if [ ! -f "$SIDECAR" ]; then
  # Not a case to skip past. Either the externalBin never made it into the
  # bundle, and the app cannot run an agent turn at all, or it is somewhere
  # else now, and this whole block became a no-op that signs and notarizes a
  # shell whose sidecar lost its JIT grant. Both ship green.
  echo "no embedded sidecar at $SIDECAR" >&2
  echo "The bundle has no liaison-sidecar to keep entitlements on: refusing to sign it." >&2
  exit 1
fi

if codesign --display --entitlements - "$SIDECAR" 2>&1 | grep -q "allow-jit" &&
  signed_by_team "$SIDECAR"; then
  echo "Embedded sidecar already carries its entitlements and our team, leaving it alone"
else
  echo "Embedded sidecar lost its entitlements in the bundler (or is not signed by team $APPLE_TEAM_ID), re-signing it"
  "$SCRIPT_DIR/sign-sidecar-macos.sh" "$SIDECAR"
  codesign --display --entitlements - "$SIDECAR" 2>&1 | grep -q "allow-jit" || {
    echo "The embedded sidecar still has no JIT entitlement after re-signing" >&2
    exit 1
  }
fi

KEYCHAIN_ARG=()
if [ -n "${MACOS_CERTIFICATE_P12:-}" ]; then
  # shellcheck source=macos-temp-keychain.sh
  source "$SCRIPT_DIR/macos-temp-keychain.sh"
  setup_temp_keychain app-signing
fi

resolve_signing_identity

# --- Nested code, inside out -------------------------------------------------

# An existing signature is kept ONLY when it is one of ours. `codesign --verify`
# is happy with an ad hoc signature (Signature=adhoc), which is what a vendored
# binary or somebody's local build carries, and Gatekeeper refuses that on any
# machine that did not build it: the bundle notarizes and the nested binary is
# still refused. Nor is any Developer ID ours: another team's certificate can
# sit in the same keychain, and a binary it signed would ship inside our
# bundle. So the authority AND the team are read (signed_by_team), not just
# the validity.
sign_nested() {
  local target="$1"
  if codesign --verify --strict "$target" >/dev/null 2>&1 && signed_by_team "$target"; then
    echo "  keeping the existing signature (Developer ID, team $APPLE_TEAM_ID): ${target#"$APP_PATH"/}"
    return
  fi
  codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$target"
  echo "  signed: ${target#"$APP_PATH"/}"
}

while IFS= read -r dylib; do
  sign_nested "$dylib"
done < <(find "$APP_PATH" -type f -name "*.dylib")

while IFS= read -r executable; do
  sign_nested "$executable"
done < <(find "$APP_PATH" -type f -perm +111 \
  ! -name "*.plist" ! -name "*.strings" ! -name "*.nib" ! -name "*.car")

while IFS= read -r -d '' nested; do
  [ -d "$nested" ] || continue
  codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$nested"
done < <(find "$APP_PATH/Contents" \( -name "*.xpc" -o -name "*.app" \) -print0 2>/dev/null | sort -zr)

while IFS= read -r -d '' framework; do
  [ -d "$framework" ] || continue
  codesign --force --options runtime --timestamp --no-strict \
    --sign "$SIGNING_IDENTITY" "$framework"
done < <(find "$APP_PATH/Contents" -name "*.framework" -print0 2>/dev/null | sort -zr)

# --- The bundle itself -------------------------------------------------------

codesign --force --options runtime --timestamp \
  --sign "$SIGNING_IDENTITY" \
  --entitlements "$ENTITLEMENTS" \
  "$APP_PATH"

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
assert_signed_by_team "$APP_PATH"

# The embedded sidecar is the payload the whole ordering rule exists for:
# assert its own signature and entitlements survived the outer signature.
codesign --verify --strict "$SIDECAR"
assert_signed_by_team "$SIDECAR"
codesign --display --entitlements - "$SIDECAR" 2>&1 | grep -q "allow-jit" \
  || { echo "Embedded sidecar lost its JIT entitlement" >&2; exit 1; }
echo "OK: embedded sidecar signature and entitlements intact"
echo "OK: $APP_NAME signed"

# --- Notarization ------------------------------------------------------------

if [ "$NOTARIZE" -eq 0 ]; then
  echo "NOT NOTARIZED (--no-notarize). Gatekeeper will refuse this bundle on"
  echo "any machine that did not build it. This is a local build only."
  exit 0
fi

ZIP_PATH="${APP_PATH%.app}.zip"
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

if [ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]; then
  xcrun notarytool submit "$ZIP_PATH" \
    --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" \
    --wait
else
  xcrun notarytool submit "$ZIP_PATH" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
fi

xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"

# Re-zip so the archive carries the stapled ticket, not the pre-staple bundle.
rm -f "$ZIP_PATH"
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

spctl --assess --type execute --verbose=4 "$APP_PATH"
echo "OK: $APP_NAME notarized, stapled and assessed"
