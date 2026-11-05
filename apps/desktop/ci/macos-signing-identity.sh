#!/bin/bash
# SPDX-License-Identifier: FSL-1.1-ALv2
# Sourced by sign-sidecar-macos.sh, sign-app-macos.sh and make-dmg.sh: which
# Developer ID identity signs Liaison, and the check that what was signed
# carries it.
#
# ONE APPLE TEAM, NAMED: a self-hosted Mac signs other products too, and its
# keychain can hold the Developer ID Application certificates of several Apple
# teams at once. "The first Developer ID in the keychain" is then whichever
# sorts first, and a bundle signed by another team notarizes, staples and
# ships. So the team is never guessed: APPLE_TEAM_ID names it (the same secret
# the notary already takes), exactly one identity of that team must be found,
# and it is passed to codesign by its SHA-1 hash, which no other certificate
# can share. Whatever signed, the result is then read back and its
# TeamIdentifier asserted.
#
# Expects KEYCHAIN_ARG (possibly empty) from the caller: when the temporary CI
# keychain is set up, the identity is looked up in it and nowhere else.
# Sets SIGNING_IDENTITY for the caller (an explicitly set one is kept, and the
# signature it makes is asserted all the same).

require_apple_team_id() {
  if [ -z "${APPLE_TEAM_ID:-}" ]; then
    echo "APPLE_TEAM_ID is not set. Several Apple teams' Developer ID certificates can share one keychain, so the team Liaison is signed as must be named: set APPLE_TEAM_ID to its 10 character Team ID." >&2
    return 1
  fi
  case "$APPLE_TEAM_ID" in
    *[!A-Z0-9]*)
      echo "APPLE_TEAM_ID is not an Apple Team ID (10 upper case letters and digits): $APPLE_TEAM_ID" >&2
      return 1
      ;;
  esac
  if [ "${#APPLE_TEAM_ID}" -ne 10 ]; then
    echo "APPLE_TEAM_ID is not an Apple Team ID (10 upper case letters and digits): $APPLE_TEAM_ID" >&2
    return 1
  fi
  # Exported, so a script this one calls (sign-app runs sign-sidecar) signs as
  # the same team rather than failing on a variable it never saw.
  export APPLE_TEAM_ID
}

resolve_signing_identity() {
  require_apple_team_id || return 1
  if [ -n "${SIGNING_IDENTITY:-}" ]; then
    echo "Signing identity: $SIGNING_IDENTITY (set explicitly, its team is asserted after signing)"
    return 0
  fi
  local listing hashes count
  # bash 3.2 (the macOS system bash) treats an empty array expansion as unset
  # under `set -u`, so the expansion is guarded rather than bare.
  if ! listing="$(security find-identity -v -p codesigning ${KEYCHAIN_ARG[@]+"${KEYCHAIN_ARG[@]}"})"; then
    echo "security find-identity failed, cannot look up the signing identity" >&2
    return 1
  fi
  # `  1) <40 hex SHA-1> "Developer ID Application: <name> (<team>)"`, kept
  # only for the named team. The same certificate listed from two keychains is
  # one identity, so the count is of distinct hashes.
  hashes="$(printf '%s\n' "$listing" \
    | grep -E "^[[:space:]]*[0-9]+\)[[:space:]]+[0-9A-Fa-f]{40}[[:space:]]+\"Developer ID Application: .* \(${APPLE_TEAM_ID}\)\"[[:space:]]*\$" \
    | sed -E 's/^[[:space:]]*[0-9]+\)[[:space:]]+([0-9A-Fa-f]{40}).*/\1/' \
    | tr 'a-f' 'A-F' | sort -u || true)"
  count=0
  if [ -n "$hashes" ]; then
    count="$(printf '%s\n' "$hashes" | wc -l | tr -d ' ')"
  fi
  if [ "$count" -eq 0 ]; then
    echo "No Developer ID Application identity of team $APPLE_TEAM_ID found for code signing" >&2
    echo "(identities of other teams in the keychain are never used)" >&2
    return 1
  fi
  if [ "$count" -gt 1 ]; then
    echo "$count different Developer ID Application identities of team $APPLE_TEAM_ID found, refusing to pick one:" >&2
    printf '%s\n' "$hashes" | sed 's/^/  /' >&2
    echo "Remove the stale one, or pin the right one with SIGNING_IDENTITY=<its SHA-1 hash>" >&2
    return 1
  fi
  SIGNING_IDENTITY="$hashes"
  echo "Signing identity: $SIGNING_IDENTITY (Developer ID Application, team $APPLE_TEAM_ID)"
}

# True when <path> carries a Developer ID Application signature of
# APPLE_TEAM_ID. Says nothing about validity: callers verify that separately.
signed_by_team() {
  local details
  details="$(codesign -dvv "$1" 2>&1)" || return 1
  printf '%s\n' "$details" | grep -q "^Authority=Developer ID Application: " || return 1
  printf '%s\n' "$details" | grep -qx "TeamIdentifier=${APPLE_TEAM_ID:-}" || return 1
}

assert_signed_by_team() {
  require_apple_team_id || return 1
  if ! signed_by_team "$1"; then
    echo "$1 is not signed with a Developer ID Application identity of team $APPLE_TEAM_ID:" >&2
    codesign -dvv "$1" 2>&1 | grep -E "^(Authority|TeamIdentifier|Signature)=" >&2 || true
    return 1
  fi
  echo "OK: signed by team $APPLE_TEAM_ID: $1"
}
