#!/bin/bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Sourced by sign-sidecar-macos.sh and sign-app-macos.sh: the temporary signing
# keychain both scripts build from MACOS_CERTIFICATE_P12, MACOS_CERTIFICATE_PWD
# and MACOS_KEYCHAIN_PWD.
#
# A self-hosted Mac outlives the job, and other work signs on it too. So the
# keychain is ADDED to the user's search list rather than replacing it, the
# decoded .p12 (it holds the private key) is removed as soon as it is imported,
# and an EXIT trap deletes the keychain, which also drops it from the list.
#
# Sets KEYCHAIN_PATH and KEYCHAIN_ARG for the caller.

setup_temp_keychain() {
  TEMP_KEYCHAIN_DIR="$(mktemp -d "${CI_BUILDS_DIR:-${TMPDIR:-/tmp}}/${1:-signing}-XXXXXX")"
  KEYCHAIN_PATH="$TEMP_KEYCHAIN_DIR/build.keychain"
  local keychain_pwd="${MACOS_KEYCHAIN_PWD}"
  trap cleanup_temp_keychain EXIT

  security create-keychain -p "$keychain_pwd" "$KEYCHAIN_PATH"
  security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
  security unlock-keychain -p "$keychain_pwd" "$KEYCHAIN_PATH"

  echo "$MACOS_CERTIFICATE_P12" | base64 --decode > "$TEMP_KEYCHAIN_DIR/cert.p12"
  security import "$TEMP_KEYCHAIN_DIR/cert.p12" \
    -k "$KEYCHAIN_PATH" \
    -P "$MACOS_CERTIFICATE_PWD" \
    -T /usr/bin/codesign
  rm -f "$TEMP_KEYCHAIN_DIR/cert.p12"
  security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_pwd" "$KEYCHAIN_PATH"

  local existing=()
  local entry
  while IFS= read -r entry; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry#\"}"
    entry="${entry%\"}"
    [ -n "$entry" ] && existing+=("$entry")
  done < <(security list-keychains -d user)
  security list-keychains -d user -s "$KEYCHAIN_PATH" ${existing[@]+"${existing[@]}"}
  KEYCHAIN_ARG=("$KEYCHAIN_PATH")
}

cleanup_temp_keychain() {
  if [ -n "${KEYCHAIN_PATH:-}" ]; then
    security delete-keychain "$KEYCHAIN_PATH" 2>/dev/null || true
  fi
  if [ -n "${TEMP_KEYCHAIN_DIR:-}" ]; then
    rm -rf "$TEMP_KEYCHAIN_DIR"
  fi
}
