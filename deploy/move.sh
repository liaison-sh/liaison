#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Move this Liaison instance to another host over SSH:
#
#   ./deploy/move.sh <user@host> [--base-url https://new.host] [--remote-dir PATH]
#                    [--force] [--no-stop] [--project NAME]
#
# The target needs a checkout of this repository (same release or newer) with
# its own deploy/.env, prepared once as for any new server
# (docs/runbooks/production-bootstrap.md, or deploy/quickstart.sh there).
#
# Steps:
#   1. stop this instance's app, so nothing changes after the snapshot
#      (Postgres and the object store keep running for the backup);
#   2. deploy/backup.sh here;
#   3. copy the archive to <remote-dir>/deploy/backups/ on the target;
#   4. run deploy/restore.sh there over SSH (with --base-url / --force);
#   5. print what to do with this, the old, instance.
#
# Flags:
#   --base-url URL     The URL people will reach the new instance at.
#   --remote-dir PATH  The repository checkout on the target (default: liaison,
#                      relative to the SSH user's home).
#   --force            Passed to restore.sh: replace a target that already has data.
#   --no-stop          Keep this instance's app running during the backup (writes
#                      made after the snapshot are then lost).
#   --project NAME     Compose project name, here and on the target (default: liaison).
#   -h, --help         Show this help.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
DEPLOY_DIR="${SCRIPT_DIR}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-liaison}"
TARGET=""
REMOTE_DIR="liaison"
RESTORE_ARGS=()
STOP_APP="yes"

# shellcheck source-path=SCRIPTDIR source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

print_help() {
  sed -n '4,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url)
      [ $# -ge 2 ] || die "--base-url requires a URL"
      RESTORE_ARGS+=(--base-url "$2")
      shift 2
      ;;
    --remote-dir)
      [ $# -ge 2 ] || die "--remote-dir requires a path"
      REMOTE_DIR="$2"
      shift 2
      ;;
    --force)
      RESTORE_ARGS+=(--force)
      shift
      ;;
    --no-stop)
      STOP_APP="no"
      shift
      ;;
    --project)
      [ $# -ge 2 ] || die "--project requires a value"
      PROJECT_NAME="$2"
      shift 2
      ;;
    -h | --help)
      print_help
      exit 0
      ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *)
      [ -z "${TARGET}" ] || die "only one target, please"
      TARGET="$1"
      shift
      ;;
  esac
done
[ -n "${TARGET}" ] || die "usage: deploy/move.sh <user@host> [--base-url URL]"
command -v ssh >/dev/null 2>&1 || die "ssh is not installed"
require_tools

# Quote a value for the remote shell.
rq() { printf '%q' "$1"; }

log "Checking the target ${TARGET}..."
ssh -o BatchMode=yes "${TARGET}" "test -x $(rq "${REMOTE_DIR}")/deploy/restore.sh && test -f $(rq "${REMOTE_DIR}")/deploy/.env && docker compose version >/dev/null" ||
  die "the target needs ${REMOTE_DIR}/deploy/restore.sh (a checkout of this release or newer), a deploy/.env, and docker compose; SSH must work without a password prompt"

# Until the target has restored and verified, THIS instance is the live one:
# any failure from here restarts its app (the target's restore stops its own
# app when it fails, so the two never run together).
STOPPED="no"
STEP="starting"
on_exit() {
  local rc=$?
  [ "${rc}" -ne 0 ] || return 0
  err ""
  err "The move FAILED while ${STEP}. This instance's data is untouched."
  if [ "${STOPPED}" = "yes" ]; then
    if compose up -d app >/dev/null 2>&1; then
      err "Its app was stopped for the backup and has been started again: this host is still the live instance."
    else
      err "Its app was stopped for the backup and did NOT start again. Start it with:"
      err "  docker compose -p ${PROJECT_NAME} -f deploy/docker-compose.yml up -d app"
    fi
  fi
}
trap on_exit EXIT

if [ "${STOP_APP}" = "yes" ]; then
  log "Stopping this instance's app (data services stay up for the backup)..."
  STEP="stopping this instance's app"
  compose stop app >/dev/null
  STOPPED="yes"
fi

STEP="backing up this instance (deploy/backup.sh, output above)"
ARCHIVE="$("${SCRIPT_DIR}/backup.sh" --project "${PROJECT_NAME}" | tail -n 1)"
[ -f "${ARCHIVE}" ] || die "the backup did not produce an archive"
NAME="$(basename "${ARCHIVE}")"

STEP="copying the archive to ${TARGET}"
log "Copying ${NAME} to ${TARGET}:${REMOTE_DIR}/deploy/backups/..."
ssh -o BatchMode=yes "${TARGET}" "umask 077 && mkdir -p $(rq "${REMOTE_DIR}")/deploy/backups && chmod 700 $(rq "${REMOTE_DIR}")/deploy/backups"
if command -v rsync >/dev/null 2>&1 && ssh -o BatchMode=yes "${TARGET}" "command -v rsync >/dev/null"; then
  rsync -t --chmod=F600 --partial "${ARCHIVE}" "${TARGET}:${REMOTE_DIR}/deploy/backups/"
else
  scp -q -p "${ARCHIVE}" "${TARGET}:${REMOTE_DIR}/deploy/backups/"
fi
ssh -o BatchMode=yes "${TARGET}" "chmod 600 $(rq "${REMOTE_DIR}")/deploy/backups/$(rq "${NAME}")"

STEP="restoring on ${TARGET} (its report is above)"
log "Restoring on ${TARGET}..."
remote_cmd="cd $(rq "${REMOTE_DIR}") && ./deploy/restore.sh deploy/backups/$(rq "${NAME}") --project $(rq "${PROJECT_NAME}")"
for a in "${RESTORE_ARGS[@]+"${RESTORE_ARGS[@]}"}"; do remote_cmd="${remote_cmd} $(rq "${a}")"; done
ssh -o BatchMode=yes "${TARGET}" "${remote_cmd}"
STEP="done"
trap - EXIT

log ""
log "Moved. The new instance runs on ${TARGET}; the archive stays in deploy/backups/ on both hosts."
log ""
log "This (old) instance:"
if [ "${STOP_APP}" = "yes" ]; then
  log "  - Its app is stopped. Leave it stopped: two running instances would both sync the"
  log "    same mailboxes and answer the same webhooks."
else
  log "  - Its app still runs. Stop it now, so two instances never sync the same mailboxes:"
  log "      docker compose -p ${PROJECT_NAME} -f deploy/docker-compose.yml stop app"
fi
log "  - Once the new instance has served a few days, remove this one and its data:"
log "      docker compose -p ${PROJECT_NAME} -f deploy/docker-compose.yml down -v"
log "    and delete deploy/.env and deploy/backups/ here (they hold the data keys)."
