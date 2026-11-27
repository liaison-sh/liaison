#!/bin/sh
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Moves a search database written by Meilisearch 1.10 to the version
# deploy/docker-compose.yml runs, before the search service starts.
#
# Meilisearch upgrades a database in place (MEILI_UPGRADE_DB) only from 1.12
# on. A 1.10 database is carried over through a dump, which keeps everything
# the index holds (documents, vectors, settings, keys), so nothing is re-read
# from Postgres and no embedding is computed again. Two one-shot services run
# this script, in order, on the search volume:
#
#   dump    (in the 1.10 image)  data.ms is 1.10: start 1.10 on loopback, take a
#           dump, stop it, then rename data.ms to data.ms.v1.10 (the rollback
#           copy). Anything else: nothing to do.
#   import  (in the new image)   a dump is waiting and data.ms is absent: import
#           it into data.ms.importing, stop, rename it to data.ms, delete the
#           dump.
#
# Every step is a rename on the same volume, so a run killed at any point
# (an OOM kill, a reboot) is redone from the start by the next one: a partial
# import is never served. Nothing here ever deletes data.ms or data.ms.v1.10.
#
# Usage: upgrade.sh dump|import   (env: MEILI_MASTER_KEY, and the image's own
# MEILI_* settings such as MEILI_MAX_INDEXING_MEMORY)

set -eu

DATA=/meili_data
DB="$DATA/data.ms"
BACKUP="$DATA/data.ms.v1.10"
WORK="$DATA/upgrade"
DUMP="$WORK/from-1.10.dump"
IMPORTING="$DATA/data.ms.importing"
ADDR=127.0.0.1:7700
PID=""

log() { echo "search-upgrade: $*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

stop_meili() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    PID=""
  fi
}
trap stop_meili EXIT

api() {
  # $1 method, $2 path. The key goes in a header read from stdin, never argv.
  printf 'header = "Authorization: Bearer %s"\n' "$MEILI_MASTER_KEY" |
    curl -fsS -K - -X "$1" "http://$ADDR$2"
}

# Waits until the loopback server answers, or fails when it exits first.
wait_healthy() {
  while :; do
    if curl -fsS "http://$ADDR/health" >/dev/null 2>&1; then return 0; fi
    kill -0 "$PID" 2>/dev/null || die "the search server exited before it was ready"
    sleep 2
  done
}

# Waits for task $1 and prints its JSON once it succeeded.
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

# Waits until no task is enqueued or processing.
wait_queue_empty() {
  while :; do
    t=$(api GET "/tasks?statuses=enqueued,processing&limit=1")
    case "$t" in *'"results":[]'*) return 0 ;; esac
    sleep 2
  done
}

db_version() { cat "$DB/VERSION" 2>/dev/null || true; }

do_dump() {
  v=$(db_version)
  case "$v" in
    "") return 0 ;; # a fresh volume, or already dumped
    1.10.*) ;;
    0.* | 1.[0-9].* | 1.11.*)
      die "the search database is version $v; this upgrade carries over 1.10 only. Dump it with its own version and import that (docs/self-hosting/docker.md#search-upgrades), or remove the meili_data volume to rebuild the index from the database"
      ;;
    *) return 0 ;; # 1.12 or newer: the search service upgrades it in place
  esac
  [ -e "$BACKUP" ] && die "$BACKUP exists already; move it away before upgrading again"
  [ -n "${MEILI_MASTER_KEY:-}" ] || die "MEILI_MASTER_KEY is not set"
  log "search database $v: taking a dump for the new version"
  rm -rf "$WORK/dumps"
  mkdir -p "$WORK/dumps"
  meilisearch --db-path "$DB" --dump-dir "$WORK/dumps" --http-addr "$ADDR" &
  PID=$!
  wait_healthy
  task=$(api POST /dumps)
  uid=$(printf '%s' "$task" | sed -n 's/.*"taskUid":\([0-9]*\).*/\1/p')
  [ -n "$uid" ] || die "the dump was not enqueued: $task"
  done_task=$(wait_task "$uid")
  dump_uid=$(printf '%s' "$done_task" | sed -n 's/.*"dumpUid":"\([^"]*\)".*/\1/p')
  [ -f "$WORK/dumps/$dump_uid.dump" ] || die "the dump file $dump_uid.dump is missing"
  stop_meili
  mv "$WORK/dumps/$dump_uid.dump" "$DUMP"
  rm -rf "$WORK/dumps"
  mv "$DB" "$BACKUP"
  log "dump written ($(du -h "$DUMP" | cut -f1)); the 1.10 database is kept as $BACKUP"
}

do_import() {
  [ -f "$DUMP" ] || return 0
  if [ -e "$DB" ]; then
    # The import finished and was renamed in place; only the dump was left.
    rm -f "$DUMP"
    return 0
  fi
  [ -n "${MEILI_MASTER_KEY:-}" ] || die "MEILI_MASTER_KEY is not set"
  log "importing the 1.10 dump (every document is indexed again: minutes per GB)"
  rm -rf "$IMPORTING"
  start=$(date +%s)
  meilisearch --db-path "$IMPORTING" --import-dump "$DUMP" --http-addr "$ADDR" &
  PID=$!
  wait_healthy
  wait_queue_empty
  stop_meili
  mv "$IMPORTING" "$DB"
  rm -f "$DUMP"
  rmdir "$WORK" 2>/dev/null || true
  log "import done in $(($(date +%s) - start)) s; search database $(db_version)"
}

case "${1:-}" in
  dump) do_dump ;;
  import) do_import ;;
  *) die "usage: upgrade.sh dump|import" ;;
esac
