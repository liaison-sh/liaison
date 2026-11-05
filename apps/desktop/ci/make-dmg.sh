#!/bin/bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Assembles the distributable disk image from a signed, stapled Liaison.app.
#
# WHY THIS EXISTS: `tauri build`'s own disk image step (bundle_dmg.sh) failed
# on this machine after the .app had already been written, so the app is built
# with `--bundles app` and the image is made here, with hdiutil directly. That
# also puts the image AFTER signing and notarization, which is the order that
# matters: an image is a container, and a container of an unsigned app is an
# unsigned app with a nicer icon.
#
# The refusals below are the point of the script:
#   - the .app must carry a valid signature;
#   - that signature must be a Developer ID Application of team APPLE_TEAM_ID
#     (required, on a developer Mac too): a keychain can hold several teams'
#     certificates, and another team's signature is not ours to ship;
#   - the .app must carry a notarization ticket, unless --no-notarize says out
#     loud that this is a local build.
#
# Notarization credentials, the names ci/sign-macos.sh documents:
#   APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID
# or NOTARY_KEYCHAIN_PROFILE on a Mac where they are already stored. No value
# is ever printed.
#
# Usage: apps/desktop/ci/make-dmg.sh <path to Liaison.app> [output dir] [--no-notarize]

set -euo pipefail

APP_PATH="${1:-}"
OUT_DIR="${2:-}"
NOTARIZE=1
for argument in "$@"; do
  if [ "$argument" = "--no-notarize" ]; then NOTARIZE=0; fi
done
if [ "${OUT_DIR}" = "--no-notarize" ]; then OUT_DIR=""; fi

if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
  echo "usage: make-dmg.sh <path to .app> [output dir] [--no-notarize]" >&2
  exit 1
fi
if [ -z "$OUT_DIR" ]; then OUT_DIR="$(dirname "$APP_PATH")"; fi
mkdir -p "$OUT_DIR"

APP_NAME="$(basename "$APP_PATH" .app)"

# --- Refusals ---------------------------------------------------------------

if ! codesign --verify --strict "$APP_PATH" >/dev/null 2>&1; then
  echo "$(basename "$APP_PATH") is not signed, refusing to package it" >&2
  exit 1
fi

# shellcheck source=macos-signing-identity.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/macos-signing-identity.sh"
if ! assert_signed_by_team "$APP_PATH"; then
  echo "$(basename "$APP_PATH") is not signed by team ${APPLE_TEAM_ID:-<unset>}, refusing to package it" >&2
  exit 1
fi

if [ "$NOTARIZE" -eq 1 ]; then
  if ! xcrun stapler validate "$APP_PATH" >/dev/null 2>&1; then
    echo "$(basename "$APP_PATH") carries no notarization ticket." >&2
    echo "Notarize and staple it first (apps/desktop/ci/sign-app-macos.sh)," >&2
    echo "or pass --no-notarize for a local image that Gatekeeper will refuse." >&2
    exit 1
  fi
fi

# --- Name ------------------------------------------------------------------

# The version comes out of the bundle that was actually built, so the file name
# cannot disagree with what is inside it. The NAME is derived by
# apps/desktop/ci/artifact-names.ts, the one module that knows the shape: a
# second spelling here is how the upload glob and the image stop agreeing.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
  "$APP_PATH/Contents/Info.plist")"
# The arch is read from the executable inside the bundle, not from the machine
# running this: a universal build made on an arm64 runner is still universal,
# and naming it after the runner would tell Intel users it is not for them.
EXECUTABLE="$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" \
  "$APP_PATH/Contents/Info.plist")"
SLICES="$(lipo -archs "$APP_PATH/Contents/MacOS/$EXECUTABLE")"
HAS_ARM64=0
HAS_X86_64=0
for slice in $SLICES; do
  case "$slice" in
    arm64) HAS_ARM64=1 ;;
    x86_64) HAS_X86_64=1 ;;
    *)
      echo "unexpected architecture in $EXECUTABLE: $slice" >&2
      exit 1
      ;;
  esac
done
if [ "$HAS_ARM64$HAS_X86_64" = "11" ]; then
  ARCH="universal"
elif [ "$HAS_ARM64" = "1" ]; then
  ARCH="aarch64"
else
  ARCH="x86_64"
fi
DMG_NAME="$(bun "$SCRIPT_DIR/artifact-names.ts" name macos dmg "$VERSION" "$ARCH")"
DMG_PATH="$OUT_DIR/$DMG_NAME"

# --- The image --------------------------------------------------------------

# The image holds the app AND a link to /Applications, the drag target every
# Mac user expects. Without it people open the app inside the mounted image,
# which is read only, and the in-app updater can never replace it (2026-10-30:
# "Read-only file system (os error 30)" after the download). ditto keeps the
# signature, the stapled ticket and the extended attributes intact.

echo "=== Liaison disk image: $(basename "$DMG_PATH") ==="
rm -f "$DMG_PATH"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/liaison-dmg.XXXXXX")"
MOUNT=""
cleanup() {
  if [ -n "$MOUNT" ]; then
    hdiutil detach "$MOUNT" -quiet || true
    rmdir "$MOUNT" 2>/dev/null || true
  fi
  rm -rf "$STAGE"
}
trap cleanup EXIT
ditto "$APP_PATH" "$STAGE/$APP_NAME.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG_PATH"

hdiutil verify "$DMG_PATH"

# What a user sees when they open the image: the app and the Applications link.
# Mounted under /tmp, on the system volume: hdiutil refuses a mount point on an
# external volume (this Mac's TMPDIR) with "attach failed - Permission denied".
MOUNT="$(mktemp -d /tmp/liaison-dmg-mount.XXXXXX)"
hdiutil attach "$DMG_PATH" -readonly -nobrowse -noautoopen -mountpoint "$MOUNT" -quiet
if [ "$(readlink "$MOUNT/Applications" || true)" != "/Applications" ]; then
  echo "$(basename "$DMG_PATH") has no Applications link, refusing to ship it" >&2
  exit 1
fi
if [ ! -d "$MOUNT/$APP_NAME.app" ]; then
  echo "$(basename "$DMG_PATH") does not contain $APP_NAME.app, refusing to ship it" >&2
  exit 1
fi
hdiutil detach "$MOUNT" -quiet
rmdir "$MOUNT" 2>/dev/null || true
MOUNT=""

# --- Notarization of the image itself ---------------------------------------
#
# A disk image is a Gatekeeper checked artifact in its own right: the ticket
# stapled to the app inside it is not the image's ticket.

if [ "$NOTARIZE" -eq 0 ]; then
  echo "NOT NOTARIZED (--no-notarize): $(basename "$DMG_PATH") is a local image."
  ls -la "$DMG_PATH"
  exit 0
fi

if [ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]; then
  xcrun notarytool submit "$DMG_PATH" \
    --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" \
    --wait
else
  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
fi

xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
ls -la "$DMG_PATH"
echo "OK: $(basename "$DMG_PATH") created, verified, notarized and stapled"
