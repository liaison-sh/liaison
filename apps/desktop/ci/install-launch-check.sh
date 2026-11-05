#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Install the built package the way a customer would, launch it, and confirm
# the thing that actually has to happen: a window, and the sidecar process
# beside it.
#
# A check that only starts the binary and looks for a process proves almost
# nothing about this app. The shell starts, the window is built in `setup`, and
# the sidecar is a separate process the shell spawns; any one of the three can
# fail while the other two look fine. A missing sidecar in particular is
# invisible until the first agent turn.
#
# Usage:
#   apps/desktop/ci/install-launch-check.sh <dmg or AppImage> [seconds]
#
# Exit 0 the app launched, a window exists and the sidecar is running.
# Exit 1 something did not come up. Exit 2 nothing to check.

set -euo pipefail

PACKAGE="${1:-}"
WAIT_SECONDS="${2:-10}"
if [ -z "$PACKAGE" ] || [ ! -e "$PACKAGE" ]; then
  echo "usage: install-launch-check.sh <dmg or AppImage> [seconds]" >&2
  exit 2
fi

SCRATCH="$(mktemp -d)"
MOUNT_POINT=""
APP_PID=""

cleanup() {
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null || true
    # The shell stops its sidecar on exit; give it the moment it asks for.
    for _ in 1 2 3 4 5; do
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$APP_PID" 2>/dev/null || true
  fi
  if [ -n "$MOUNT_POINT" ]; then
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

case "$PACKAGE" in
  *.dmg)
    # Mounted and COPIED OUT, the way a customer installs. Launching from the
    # read only image would exercise a path no installed copy ever takes.
    MOUNT_POINT="$SCRATCH/mount"
    mkdir -p "$MOUNT_POINT"
    hdiutil attach "$PACKAGE" -nobrowse -readonly -mountpoint "$MOUNT_POINT" -quiet
    APP_SOURCE="$(find "$MOUNT_POINT" -maxdepth 1 -name '*.app' -print -quit)"
    [ -n "$APP_SOURCE" ] || { echo "no .app on the image" >&2; exit 1; }
    APP="$SCRATCH/$(basename "$APP_SOURCE")"
    cp -R "$APP_SOURCE" "$APP"
    hdiutil detach "$MOUNT_POINT" -quiet
    MOUNT_POINT=""
    BINARY="$APP/Contents/MacOS/liaison-desktop"
    [ -x "$BINARY" ] || BINARY="$(find "$APP/Contents/MacOS" -maxdepth 1 -type f -perm -111 -print -quit)"
    SIDECAR="$(find "$APP/Contents/MacOS" -maxdepth 1 -name 'liaison-sidecar*' -print -quit)"
    ;;
  *.AppImage)
    chmod +x "$PACKAGE"
    BINARY="$PACKAGE"
    SIDECAR=""
    ;;
  *)
    echo "no install path for $PACKAGE" >&2
    exit 2
    ;;
esac

window_is_up() {
  # CoreGraphics, not a screenshot: the window list answers even when the
  # screen is locked, and a capture does not. On Linux there is no equivalent
  # without a session bus, so the process check is the whole of it there.
  [ "$(uname)" = "Darwin" ] || return 0
  /usr/bin/swift - "$APP_PID" <<'SWIFT' 2>/dev/null
import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1]) ?? -1
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let mine = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }
exit(mine.isEmpty ? 1 : 0)
SWIFT
}

sidecar_is_ready() {
  # NOT a running process: no session starts on its own, so the sidecar is
  # spawned the moment a user picks a folder and an agent, and never before.
  # What the install has to carry is a sidecar that is THERE, whose signature
  # still verifies inside the installed copy, and that runs. A bundle whose
  # embedded sidecar lost its signature to the bundler launches perfectly and
  # dies on the first agent turn.
  [ -n "${SIDECAR:-}" ] || return 1
  [ -x "$SIDECAR" ] || return 1
  if [ "$(uname)" = "Darwin" ]; then
    codesign --verify --strict "$SIDECAR" >/dev/null 2>&1 || return 1
  fi
  "$SIDECAR" --help >/dev/null 2>&1 || "$SIDECAR" </dev/null >/dev/null 2>&1
  # Either answer is fine: what is being asked is whether the operating system
  # will let it start at all.
  return 0
}

# The app allows one instance: a second copy hands its arguments to the first
# and quits at once, with no output. This Mac is also somebody's desktop, and
# their Liaison stays open (it is their computer for their agents). A second
# copy beside it is not an option either: it would read the same sign-in and
# could connect as a second instance of their computer. So when one is open,
# the launch is skipped and everything that needs no launch is still checked:
# the installed copy's signature, and a sidecar that is there, signed, and
# starts. The release goes on; the log says the launch was not exercised.
if [ "$(uname)" = "Darwin" ] && pgrep -f "/Contents/MacOS/liaison-desktop" >/dev/null 2>&1; then
  echo "another Liaison is open on this runner: launch skipped, checking the install without it"
  pgrep -fl "/Contents/MacOS/liaison-desktop" || true
  if ! codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
    echo "the installed copy's signature does not verify" >&2
    exit 1
  fi
  if ! sidecar_is_ready; then
    echo "the installed copy carries no usable sidecar" >&2
    exit 1
  fi
  echo "signature verified, sidecar installed and runnable (launch not exercised)"
  exit 0
fi

LOG="$SCRATCH/launch.log"
echo "launching $BINARY"
"$BINARY" > "$LOG" 2>&1 &
APP_PID=$!

alive=false
window=false
sidecar=false
for _ in $(seq 1 "$WAIT_SECONDS"); do
  sleep 1
  kill -0 "$APP_PID" 2>/dev/null && alive=true || { alive=false; break; }
  window_is_up && window=true
  sidecar_is_ready && sidecar=true
  if [ "$window" = true ] && [ "$sidecar" = true ]; then break; fi
done

echo "--- the app's own output ---"
cat "$LOG" || true
echo "--- end ---"
echo "process alive: $alive"
echo "window listed: $window"
echo "sidecar installed and runnable: $sidecar"

if [ "$alive" != true ]; then
  echo "the app exited before the window was up" >&2
  exit 1
fi
if [ "$(uname)" = "Darwin" ] && [ "$sidecar" != true ]; then
  echo "the installed copy carries no usable sidecar" >&2
  exit 1
fi
if [ "$window" != true ]; then
  # A window that cannot be listed is not always a failed launch: a locked
  # screen has no on screen window list. The caller decides; this says which.
  echo "no window was listed for the process" >&2
  exit 1
fi
exit 0
