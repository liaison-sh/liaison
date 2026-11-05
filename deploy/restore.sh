#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Restore a deploy/backup.sh archive into this stack (deploy/docker-compose.yml):
#
#   ./deploy/restore.sh <archive> [--base-url https://new.host] [--force] [--project NAME]
#
# The target is a fresh stack: this checkout's deploy/.env exists (run
# deploy/quickstart.sh once, or follow docs/runbooks/production-bootstrap.md),
# and its services are up or can be started. Steps:
#   1. check the archive (checksums) and that this stack's image is not older
#      than the backup (an older backup is fine: the app migrates it up on boot);
#   2. refuse when this stack already holds organizations, unless --force;
#   3. write the archive's data keys into deploy/.env (the previous .env is kept
#      as deploy/.env.before-restore-<timestamp>), keeping this host's own
#      settings, and set BASE_URL / ALLOWED_ORIGINS when --base-url is given;
#   4. restore the database roles and the database, the objects and the app
#      data directory;
#   5. start the app, rebuild the search index, and verify: health, organization
#      and file counts, and one object read back against its checksum;
#   6. print what to change outside this host.
#
# Flags:
#   --base-url URL    The URL people reach this instance at (sets BASE_URL and
#                     ALLOWED_ORIGINS). Without it, this host's values are kept.
#   --force           Replace a database that already holds organizations.
#   --project NAME    Docker Compose project name (default: liaison).
#   -h, --help        Show this help.
#
# Non-interactive; exits non-zero on any failure. Never prints a secret value.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
DEPLOY_DIR="${SCRIPT_DIR}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-liaison}"
ARCHIVE=""
BASE_URL_NEW=""
FORCE="no"

# shellcheck source-path=SCRIPTDIR source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

print_help() {
  sed -n '4,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url)
      [ $# -ge 2 ] || die "--base-url requires a URL"
      BASE_URL_NEW="${2%/}"
      shift 2
      ;;
    --force)
      FORCE="yes"
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
      [ -z "${ARCHIVE}" ] || die "only one archive, please"
      ARCHIVE="$1"
      shift
      ;;
  esac
done

[ -n "${ARCHIVE}" ] || die "usage: deploy/restore.sh <archive> [--base-url URL] [--force]"
[ -f "${ARCHIVE}" ] || die "archive not found: ${ARCHIVE}"
if [ -n "${BASE_URL_NEW}" ]; then
  case "${BASE_URL_NEW}" in
    http://* | https://*) ;;
    *) die "--base-url must start with https:// (or http:// for a local test)" ;;
  esac
fi

require_tools curl
resolve_app_image
ME="$(id -u):$(id -g)"

# Everything up to "point of no return" below only reads, checks and starts
# services; nothing on this host is changed yet. Every check that can fail runs
# there, so a failure leaves the stack exactly as it was.
PHASE="checks"
CHANGED=()
BEFORE=""
APP_STARTED="no"
on_exit() {
  local rc=$?
  rm -rf "${STAGE:-}"
  [ "${rc}" -ne 0 ] || return 0
  if [ "${PHASE}" = "checks" ]; then
    err "Nothing on this host was changed (the restore stopped during its checks)."
    return 0
  fi
  if [ "${APP_STARTED}" = "yes" ]; then
    compose stop app >/dev/null 2>&1 || true
    CHANGED+=("the app was started on the restored data, and stopped again because the restore failed")
  fi
  err ""
  err "The restore FAILED during: ${PHASE}."
  err "What it had changed on this host:"
  local c
  for c in "${CHANGED[@]+"${CHANGED[@]}"}"; do err "  - ${c}"; done
  err "To retry after fixing the cause (the restore is safe to rerun):"
  err "  ./deploy/restore.sh ${ARCHIVE} --force${BASE_URL_NEW:+ --base-url ${BASE_URL_NEW}} --project ${PROJECT_NAME}"
  if [ -n "${BEFORE}" ]; then
    err "To put deploy/.env back as it was:"
    err "  cp ${BEFORE} ${DEPLOY_DIR}/.env"
  fi
  if [ "${HAD_DATA:-0}" != "0" ]; then
    err "This stack held ${HAD_DATA} organization(s) before; they are only recoverable from a"
    err "backup taken before this restore (deploy/backups/), with ./deploy/restore.sh <that archive> --force."
  fi
}
trap on_exit EXIT

# --- 1. Unpack and check the archive ----------------------------------------------
mkdir -p "${DEPLOY_DIR}/backups"
chmod 700 "${DEPLOY_DIR}/backups"
STAGE="$(mktemp -d "${DEPLOY_DIR}/backups/.restore.XXXXXX")"

log "Checking the archive..."
[ -r "${ARCHIVE}" ] || die "cannot read ${ARCHIVE} (permissions?)"
gzip -t "${ARCHIVE}" || die "the archive is not a valid gzip file (truncated copy?)"
tar -xzf "${ARCHIVE}" -C "${STAGE}" || die "could not unpack the archive (disk full? df -h ${DEPLOY_DIR})"
for f in manifest.json db.dump roles.sql secrets.env data.tar.gz objects/index.jsonl; do
  [ -f "${STAGE}/${f}" ] || die "the archive has no ${f}; was it written by deploy/backup.sh?"
done
grep -q '"format": "liaison-backup/1"' "${STAGE}/manifest.json" ||
  die "unknown archive format (manifest.json)"

# manifest.json is written by backup.sh in a fixed layout, one value per line.
manifest_num() { sed -n "s/.*\"$1\": \([0-9][0-9]*\).*/\1/p" "${STAGE}/manifest.json" | head -n 1; }
manifest_str() { sed -n "s/.*\"$1\": \"\([^\"]*\)\".*/\1/p" "${STAGE}/manifest.json" | head -n 1; }
for f in db.dump roles.sql secrets.env data.tar.gz objects/index.jsonl; do
  want="$(grep -F "\"${f}\": {" "${STAGE}/manifest.json" | sed -n 's/.*"sha256": "\([0-9a-f]*\)".*/\1/p')"
  [ -n "${want}" ] || die "manifest.json has no checksum for ${f}"
  [ "$(sha256_of "${STAGE}/${f}")" = "${want}" ] || die "${f} does not match its checksum: the archive is damaged"
done
while IFS= read -r line; do
  case "${line}" in '' | \#*) continue ;; esac
  k="${line%%=*}"
  case "${k}" in *[!A-Z0-9_]* | '') die "secrets.env in the archive has a malformed line" ;; esac
done <"${STAGE}/secrets.env"
unset line

B_VERSION="$(manifest_str version)"
B_CREATED="$(manifest_str createdAt)"
B_MIG_WHEN="$(manifest_num highwaterWhen)"
B_MIG_COUNT="$(manifest_num applied)"
B_ORGS="$(manifest_num organizations)"
B_FILES="$(manifest_num files)"
B_OBJECTS="$(manifest_num objects)"
log "Backup of ${B_CREATED}: Liaison ${B_VERSION}, ${B_ORGS} organization(s), ${B_FILES} file row(s), ${B_OBJECTS} object(s)."

# --- 2. The image ---------------------------------------------------------------------
if ! docker image inspect "${LIAISON_IMAGE}" >/dev/null 2>&1; then
  log "Pulling ${LIAISON_IMAGE}..."
  compose pull app >/dev/null 2>&1 ||
    die "image ${LIAISON_IMAGE} is not on this host and cannot be pulled. Set LIAISON_IMAGE in deploy/.env to an image this host has or can pull (docker images), then rerun."
fi
# The target image's migrations decide whether it can run this database: it
# can migrate an older one up, never run one a newer release already changed.
JOURNAL="$(app_run -- cat /app/apps/api/src/db/migrations/meta/_journal.json)" ||
  die "could not read the migrations of image ${LIAISON_IMAGE}"
T_MIG_WHEN="$(printf '%s\n' "${JOURNAL}" | awk '/"when":/ { gsub(/[^0-9]/, ""); if ($0 + 0 > m) m = $0 + 0 } END { printf "%.0f", m }')"
T_MIG_COUNT="$(printf '%s\n' "${JOURNAL}" | grep -c '"tag":' || true)"
T_VERSION="$(app_run -- cat /app/.liaison-release.json 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
if [ "${B_MIG_WHEN}" -gt "${T_MIG_WHEN}" ] || [ "${B_MIG_COUNT}" -gt "${T_MIG_COUNT}" ]; then
  die "the backup (Liaison ${B_VERSION}, ${B_MIG_COUNT} migrations) is NEWER than this stack's image ${LIAISON_IMAGE} (Liaison ${T_VERSION:-unknown}, ${T_MIG_COUNT} migrations). Upgrade this stack to the backup's version or later (LIAISON_IMAGE in deploy/.env), then run restore again."
fi
if [ "${B_MIG_COUNT}" -lt "${T_MIG_COUNT}" ]; then
  log "The backup is older than this stack's image (Liaison ${T_VERSION:-unknown}): the app applies the $((T_MIG_COUNT - B_MIG_COUNT)) newer migration(s) when it starts."
fi

# --- 3. Services and target state -------------------------------------------------------
log "Starting the database and object store..."
compose up -d postgres redis meilisearch objectstore >/dev/null || die "could not start the data services (docker compose -p ${PROJECT_NAME} -f deploy/docker-compose.yml logs)"
wait_service_healthy postgres
wait_service_healthy objectstore
compose up -d objectstore-init data-init >/dev/null || die "could not start objectstore-init / data-init"
# Both are one-shot; wait for them to finish.
for svc in objectstore-init data-init; do
  for _ in $(seq 1 60); do
    cid="$(compose ps -a -q "${svc}" | head -n 1)"
    st="$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "${cid}" 2>/dev/null || true)"
    [ "${st}" = "exited 0" ] && break
    case "${st}" in exited*) die "${svc} failed (docker compose -p ${PROJECT_NAME} -f deploy/docker-compose.yml logs ${svc})" ;; esac
    sleep 2
  done
done

HAD_DATA="0"
if [ -n "$(psql_value "SELECT to_regclass('kernel.organizations')")" ]; then
  HAD_DATA="$(psql_value "SELECT count(*) FROM kernel.organizations")"
fi
if [ "${HAD_DATA}" != "0" ] && [ "${FORCE}" != "yes" ]; then
  die "this stack already holds ${HAD_DATA} organization(s). Restoring replaces its whole database; rerun with --force if that is what you want (back it up first: deploy/backup.sh)."
fi

# The containers must be able to read what they restore: the objects as this
# user (the stage is private to it), the data directory streamed on stdin to
# the app user that owns deploy/data. Both are read in full here, so a damaged
# object or an unreadable file stops the restore before anything changes.
log "Checking the archive's objects and the object store from the app image..."
app_run --user "${ME}" -v "${STAGE}/objects:/backup:ro" -- bun /liaison-backup/objects.ts verify /backup >/dev/null ||
  die "the app image cannot read the archive's objects, or cannot reach the object store with this host's credentials (see the error above)"
app_run -- tar -tzf - <"${STAGE}/data.tar.gz" >/dev/null ||
  die "the app image cannot read the archive's data directory"
[ -w "${DEPLOY_DIR}/.env" ] || die "deploy/.env is not writable by $(id -un)"

# --- Point of no return: from here on, this host changes. -------------------------------
PHASE="stopping the app"
log "Stopping the app..."
compose stop app >/dev/null 2>&1 || true
compose rm -f app >/dev/null 2>&1 || true
CHANGED+=("the app container was stopped and removed")

PHASE="writing deploy/.env"
BEFORE="${DEPLOY_DIR}/.env.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "${DEPLOY_DIR}/.env" "${BEFORE}"
chmod 600 "${BEFORE}"
CHANGED+=("deploy/.env: the archive's keys and OAuth clients written in, image pinned (previous file: ${BEFORE})")
carried=""
while IFS= read -r line; do
  case "${line}" in '' | \#*) continue ;; esac
  k="${line%%=*}"
  env_set "${k}" "${line#*=}"
  carried="${carried} ${k}"
done <"${STAGE}/secrets.env"
unset line
log "Wrote into deploy/.env:${carried} (previous file: $(basename "${BEFORE}"))"
# The URL OAuth clients and webhooks know: the backed-up instance's own.
OLD_BASE_URL="$(manifest_str baseUrl)"
[ -n "${OLD_BASE_URL}" ] || OLD_BASE_URL="$(env_get BASE_URL)"
if [ -n "${BASE_URL_NEW}" ]; then
  origin="$(printf '%s' "${BASE_URL_NEW}" | sed -E 's#^(https?://[^/]+).*#\1#')"
  env_set BASE_URL "${BASE_URL_NEW}"
  # Merge, never replace: other origins this host allows stay allowed.
  origins="$(env_get ALLOWED_ORIGINS)"
  case ",${origins}," in
    *",${origin},"*) ;;
    *) origins="${origins:+${origins},}${origin}" ;;
  esac
  env_set ALLOWED_ORIGINS "${origins}"
  log "BASE_URL=${BASE_URL_NEW}, ALLOWED_ORIGINS=${origins}"
fi
# Pin the image this restore checked and starts, so a later plain
# `docker compose up -d` runs the same one (a shell LIAISON_IMAGE included).
env_set LIAISON_IMAGE "${LIAISON_IMAGE}"

# Roles are cluster-wide and not in pg_dump. Bring this cluster's roles to the
# source's attributes and memberships: create the ones it lacks, and re-apply
# every role's attributes and settings, because migrations change roles that
# postgres-init created (liaison_admin gains BYPASSRLS, for one) and a role left
# at its init attributes breaks RLS at the app's first boot. The bootstrap
# superuser is left alone. Passwords are never in the archive: logins keep this
# host's passwords (postgres-init and the migration step set them).
PHASE="restoring database roles"
log "Restoring database roles..."
CHANGED+=("database roles: created or re-attributed to match the backup (passwords untouched)")
existing_roles="$(psql_value "SELECT string_agg(rolname, ' ') FROM pg_roles" postgres)"
roles_out="$(awk -v have=" ${existing_roles} " -v boot="liaison" '
  function role_of(line,   r) { r = line; sub(/^(CREATE|ALTER) ROLE /, "", r); sub(/[ ;].*/, "", r); gsub(/"/, "", r); return r }
  /^CREATE ROLE / { r = role_of($0); if (r == boot || index(have, " " r " ") > 0) next }
  /^ALTER ROLE / { if (role_of($0) == boot) next }
  /^(CREATE|ALTER|GRANT|SET) / { print }
' "${STAGE}/roles.sql" | compose exec -T postgres psql -X -q -U liaison -d postgres 2>&1 || true)"
# A membership this cluster already has is reported, not an error worth showing.
roles_err="$(printf '%s\n' "${roles_out}" | grep -E 'ERROR' | grep -v 'already a member' || true)"
[ -z "${roles_err}" ] || die "restoring roles failed: ${roles_err}"

PHASE="restoring the database"
log "Restoring the database (this replaces the current one)..."
CHANGED+=("the database 'liaison' was dropped and is being recreated from the backup (it may be partial)")
psql_super -d postgres -c "DROP DATABASE IF EXISTS liaison WITH (FORCE)"
compose exec -T postgres pg_restore -U liaison -d postgres --create --exit-on-error \
  <"${STAGE}/db.dump"
CHANGED[${#CHANGED[@]}-1]="the database 'liaison' was replaced by the backup's"

PHASE="restoring the objects"
log "Restoring the objects..."
CHANGED+=("objects: the backup's objects written into the bucket (same keys overwritten, others kept)")
app_run --user "${ME}" -v "${STAGE}/objects:/backup:ro" -- bun /liaison-backup/objects.ts load /backup >/dev/null

PHASE="restoring the app data directory"
log "Restoring the app data directory..."
CHANGED+=("deploy/data: the backup's app data directory unpacked over it")
app_run -- tar -xzf - -C /var/lib/liaison <"${STAGE}/data.tar.gz"

# --- 4. Start, reindex, verify ----------------------------------------------------------
PHASE="starting the app"
log "Starting the app (it applies any newer migrations first)..."
APP_STARTED="yes"
compose up -d >/dev/null
APP_PORT_HOST="$(env_get APP_PORT)"
HEALTH_URL="http://127.0.0.1:${APP_PORT_HOST:-3000}/healthz"
# Healthy means status ok and EVERY dependency exactly "ok": error, degraded,
# timeout, slow or anything new all count as not ready.
health_ok() {
  local deps
  printf '%s' "$1" | grep -q '"status":"ok"' || return 1
  deps="$(printf '%s' "$1" | sed -n 's/.*"dependencies":{\([^}]*\)}.*/\1/p')"
  [ -n "${deps}" ] || return 1
  [ -z "$(printf '%s' "${deps}" | sed 's/"[A-Za-z]*":"ok"//g; s/,//g')" ]
}
healthy="no"
body=""
for _ in $(seq 1 120); do
  body="$(curl -fsS "${HEALTH_URL}" 2>/dev/null || true)"
  if health_ok "${body}"; then
    healthy="yes"
    break
  fi
  sleep 2
done
if [ "${healthy}" != "yes" ]; then
  err "Last /healthz answer: ${body:-none}"
  err "Last app log lines:"
  compose logs --tail 30 app >&2 2>/dev/null || true
  die "the app did not report healthy at ${HEALTH_URL} within 4 minutes"
fi

PHASE="rebuilding the search index"
log "Rebuilding the search index..."
# The app also rebuilds a missing index on its own at boot, holding a lock; a
# second rebuild waits for it, then runs once more over the restored data.
search_note=""
for _ in $(seq 1 36); do
  if reindex_out="$(compose exec -T app liaison search reindex 2>&1)"; then
    search_note="rebuilt"
    break
  fi
  printf '%s' "${reindex_out}" | grep -q 'another search index rebuild is running' || {
    printf '%s\n' "${reindex_out}" | tail -n 20 >&2
    die "the search index rebuild failed"
  }
  sleep 5
done
unset reindex_out
[ -n "${search_note}" ] || search_note="still being rebuilt by the app (started at boot)"

PHASE="verifying"
log "Verifying..."
orgs="$(psql_value "SELECT count(*) FROM kernel.organizations")"
files="$(psql_value "SELECT count(*) FROM kernel.files")"
[ "${orgs}" = "${B_ORGS}" ] || die "organizations: ${orgs} restored, ${B_ORGS} in the backup"
[ "${files}" = "${B_FILES}" ] || die "file rows: ${files} restored, ${B_FILES} in the backup"
sample="none"
if [ "${B_OBJECTS}" != "0" ]; then
  key="$(psql_value "SELECT storage_key FROM kernel.files ORDER BY created_at DESC LIMIT 1")"
  if [ -z "${key}" ] || ! grep -qF "\"key\":$(printf '%s' "${key}" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')" "${STAGE}/objects/index.jsonl"; then
    # No file row points at an archived object; read back the first archived one.
    key="$(head -n 1 "${STAGE}/objects/index.jsonl" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')"
  fi
  app_run --user "${ME}" -v "${STAGE}/objects:/backup:ro" -- bun /liaison-backup/objects.ts check /backup "${key}" >/dev/null ||
    die "the sample object does not read back identically"
  sample="ok"
fi
migration_head="$(printf '%s' "${body}" | sed -n 's/.*"migrationHead":"\([^"]*\)".*/\1/p' | cut -c1-12)"
PHASE="done"

log ""
log "Restore OK."
log "  health: all dependencies ok (migration head ${migration_head:-?})"
log "  organizations: ${orgs}, file rows: ${files}, objects: ${B_OBJECTS}, sample object read back: ${sample}"
log "  search index: ${search_note}"
log ""
log "After the move, outside this host:"
NEW_BASE="$(env_get BASE_URL)"
log "  - DNS: point the instance's name at this host, and its TLS proxy (or tunnel) at 127.0.0.1:${APP_PORT_HOST:-3000}."
if [ -n "${BASE_URL_NEW}" ] && [ "${OLD_BASE_URL}" != "${BASE_URL_NEW}" ]; then
  log "  - The URL changed (${OLD_BASE_URL} -> ${NEW_BASE}). The backup carried the deployment's"
  log "    OAuth clients; in Google Cloud, add the new redirect URIs to each of them, then remove the old:"
  log "      Google sign-in (GOOGLE_OAUTH_CLIENT_ID): ${NEW_BASE}/api/auth/oauth/callback"
  log "      Gmail (GMAIL_OAUTH_CLIENT_ID): ${NEW_BASE}/api/connections/callback"
  log "    and the same in any per-org OAuth client (Microsoft, Shopify, Facebook, ...)."
  log "  - Webhooks registered at external services still call the old URL: Gmail push"
  log "    (Pub/Sub push subscription endpoint), Shopify and Facebook webhooks, and any"
  log "    system that posts tickets to ${OLD_BASE_URL}/webhooks/... Update each one."
else
  log "  - If people reach this instance at a new URL, rerun with --base-url, then update the"
  log "    OAuth redirect URIs and the webhooks registered at external services (Gmail push,"
  log "    Shopify, Facebook, ticket intake callers)."
fi
log "  - SMTP, AI provider keys and other host settings come from this host's deploy/.env, not the backup."
log "  - Stop the old instance's app (docker compose ... stop app) if it still runs, so two"
log "    instances never sync the same mailboxes or answer the same webhooks."
