#!/bin/sh
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Carries a search database written by Meilisearch 1.10 over to the version
# deploy/docker-compose.yml runs, then starts the search server.
#
# Meilisearch upgrades a database in place (MEILI_UPGRADE_DB) only from 1.12
# on, and a newer binary refuses to open a 1.10 one. A 1.10 database is
# carried over through a dump instead, which keeps everything the index holds
# (documents, vectors, settings, keys): nothing is read again from Postgres
# and no embedding is computed again.
#
#   stage  (service `search-upgrade-stage`, the 1.10 image, data read-only)
#          data.ms is 1.10: copy the 1.10 binary to /legacy. Otherwise remove
#          any copy left there.
#   serve  (service `meilisearch`, the new image, the only one writing data)
#          data.ms is 1.10: start the 1.10 binary on loopback, take a dump,
#          stop it, rename data.ms to data.ms.v1.10 (the rollback copy).
#          A dump is waiting: import it into data.ms.importing, stop, rename
#          that to data.ms, delete the dump. Then exec the server.
#
# The upgrade runs inside the search service itself, so it starts only once
# the old container has stopped: no two servers ever open the same database.
# Every step ends in a rename on the same volume, so a run killed at any point
# (an OOM kill, a reboot) starts again from the last finished step on the next
# start, and a partial import is never served. Nothing here deletes data.ms or
# data.ms.v1.10.

set -eu

DATA=/meili_data
DB="$DATA/data.ms"
BACKUP="$DATA/data.ms.v1.10"
WORK="$DATA/upgrade"
DUMP="$WORK/from-1.10.dump"
IMPORTING="$DATA/data.ms.importing"
LEGACY=/legacy/meilisearch-1.10
ADDR=127.0.0.1:7799
PID=""

log() { echo "search-upgrade: $*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

db_version() { cat "$DB/VERSION" 2>/dev/null || true; }

# 0 when data.ms is a 1.10 database; fails on any other version a newer
# binary cannot upgrade in place.
is_v110() {
  v=$(db_version)
  case "$v" in
    1.10.*) return 0 ;;
    0.* | 1.[0-9].* | 1.11.*)
      die "the search database is version $v; only 1.10 is carried over. Dump it with its own version and import the dump, or remove the meili_data volume to rebuild the index from the database (docs/self-hosting/docker.md)"
      ;;
  esac
  return 1
}

stop_server() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    PID=""
  fi
}

api() {
  # $1 method, $2 path. The key reaches curl on stdin, never in its argv.
  printf 'header = "Authorization: Bearer %s"\n' "$MEILI_MASTER_KEY" |
    curl -fsS -K - -X "$1" "http://$ADDR$2"
}

# Waits until the loopback server answers; fails when it exits first.
wait_ready() {
  while ! curl -fsS "http://$ADDR/health" >/dev/null 2>&1; do
    kill -0 "$PID" 2>/dev/null || die "the search server exited before it was ready"
    sleep 2
  done
}

# Waits for task $1; prints its JSON once it succeeded.
wait_task() {
  while :; do
    t=$(api GET "/tasks/$1")
    case "$t" in
      *'"status":"succeeded"'*)
        printf '%s' "$t"
        return 0
        ;;
      *'"status":"failed"'* | *'"status":"canceled"'*) die "task $1 did not succeed: $t" ;;
    esac
    sleep 2
  done
}

wait_queue_empty() {
  while :; do
    case "$(api GET "/tasks?statuses=enqueued,processing&limit=1")" in
      *'"results":[]'*) return 0 ;;
    esac
    sleep 2
  done
}

do_stage() {
  if [ -f "$DB/VERSION" ] && is_v110; then
    mkdir -p /legacy
    if ! cmp -s /bin/meilisearch "$LEGACY" 2>/dev/null; then
      cp /bin/meilisearch "$LEGACY.tmp"
      mv "$LEGACY.tmp" "$LEGACY"
    fi
    log "search database $(db_version): the 1.10 binary is staged for its dump"
  else
    rm -f "$LEGACY" "$LEGACY.tmp"
  fi
}

dump_v110() {
  [ -x "$LEGACY" ] || die "the search database is 1.10 but $LEGACY is missing (the search-upgrade-stage service did not run)"
  [ -e "$BACKUP" ] && die "$BACKUP exists already; move it away before upgrading again"
  log "search database $(db_version): taking a dump for $(meilisearch --version)"
  rm -rf "$WORK/dumps"
  mkdir -p "$WORK/dumps"
  "$LEGACY" --db-path "$DB" --dump-dir "$WORK/dumps" --http-addr "$ADDR" &
  PID=$!
  wait_ready
  task=$(api POST /dumps)
  uid=$(printf '%s' "$task" | sed -n 's/.*"taskUid":\([0-9]*\).*/\1/p')
  [ -n "$uid" ] || die "the dump was not enqueued: $task"
  dump_uid=$(wait_task "$uid" | sed -n 's/.*"dumpUid":"\([^"]*\)".*/\1/p')
  [ -f "$WORK/dumps/$dump_uid.dump" ] || die "the dump file $dump_uid.dump is missing"
  stop_server
  mv "$WORK/dumps/$dump_uid.dump" "$DUMP"
  rm -rf "$WORK/dumps"
  mv "$DB" "$BACKUP"
  log "dump written ($(du -h "$DUMP" | cut -f1)); the 1.10 database is kept as $BACKUP"
}

import_dump() {
  if [ -e "$DB" ]; then
    rm -f "$DUMP" # the import was renamed in place; only the dump was left
    return 0
  fi
  log "importing the 1.10 dump: every document is indexed again, search answers once it is done"
  rm -rf "$IMPORTING"
  start=$(date +%s)
  meilisearch --db-path "$IMPORTING" --import-dump "$DUMP" --http-addr "$ADDR" &
  PID=$!
  wait_ready
  wait_queue_empty
  stop_server
  mv "$IMPORTING" "$DB"
  rm -f "$DUMP"
  rmdir "$WORK" 2>/dev/null || true
  log "import done in $(($(date +%s) - start)) s; search database $(db_version)"
}

do_serve() {
  if [ -f "$DB/VERSION" ] && is_v110; then
    [ -n "${MEILI_MASTER_KEY:-}" ] || die "MEILI_MASTER_KEY is not set"
    trap stop_server EXIT
    dump_v110
  fi
  if [ -f "$DUMP" ]; then
    [ -n "${MEILI_MASTER_KEY:-}" ] || die "MEILI_MASTER_KEY is not set"
    trap stop_server EXIT
    import_dump
  fi
  trap - EXIT
  exec meilisearch
}

case "${1:-}" in
  stage) do_stage ;;
  serve) do_serve ;;
  *) die "usage: upgrade.sh stage|serve" ;;
esac
