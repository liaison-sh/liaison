#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Back up a self-hosted Liaison (the deploy/docker-compose.yml stack) into ONE
# archive that deploy/restore.sh can bring back on this machine or another:
#
#   ./deploy/backup.sh [--keep N] [--project NAME] [--dir PATH]
#
# The archive, deploy/backups/liaison-backup-<UTC timestamp>.tar.gz (mode 600,
# in a mode 700 directory), holds:
#   db.dump        Postgres, custom format, one consistent snapshot (pg_dump)
#   roles.sql      the database roles, without passwords (pg_dumpall --roles-only)
#   objects/       every object of the object-store bucket, with an index
#                  (key, size, content type, sha256)
#   data.tar.gz    the app's data directory (deploy/data: installed app packages,
#                  push key files), without the maintenance flags
#   secrets.env    the keys stored data cannot be read without, and the
#                  deployment's OAuth clients (see DATA_SECRETS, CARRIED_CONFIG)
#   manifest.json  Liaison image and version, migration highwater, timestamp,
#                  counts and checksums
#
# The search index is not copied: restore.sh rebuilds it from the database.
#
# Flags:
#   --keep N          After a good backup, delete all but the N newest archives.
#   --project NAME    Docker Compose project name (default: liaison).
#   --dir PATH        Where archives go (default: deploy/backups).
#   -h, --help        Show this help.
#
# Made for cron: non-interactive, prints progress on stderr and the archive
# path alone on stdout, exits non-zero on any failure. It never prints a
# secret value. The archive itself holds the keys: guard it like deploy/.env.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
DEPLOY_DIR="${SCRIPT_DIR}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-liaison}"
BACKUP_DIR="${DEPLOY_DIR}/backups"
KEEP=""

# shellcheck source-path=SCRIPTDIR source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

# The variables stored data cannot be read or used without. They travel in the
# archive's secrets.env and restore.sh writes them into the target's .env.
# Everything else in .env is per host (URLs, ports, database and object-store
# passwords, SMTP, provider keys) and stays with the host.
#
#   JWT_SECRET            signs sessions' access tokens, file links, MCP tokens,
#                         and keys a few stored HMACs (api-connector credential
#                         versions, ticket self-send markers)
#   ENCRYPTION_KEY        every stored secret: connected account tokens, OAuth
#                         client secrets, TOTP secrets, MCP connection secrets,
#                         encrypted app settings (docs/runbooks/key-rotation.md)
#   BYOK_ENCRYPTION_KEY   organizations' own model provider keys
#   VAPID_*               browser push subscriptions are bound to this key pair
#                         (copied when set)
#
# Carried configuration (copied when set): the deployment-level OAuth clients.
# They decrypt nothing, but connected Gmail accounts hold refresh tokens issued
# to that client and Google sign-in is configured by it, so a move without them
# silently drops both.
#
#   GOOGLE_OAUTH_CLIENT_ID / _SECRET   "Sign in with Google"
#   GMAIL_OAUTH_CLIENT_ID / _SECRET    the deployment's Gmail client
#   GOOGLE_DRIVE_OAUTH_CLIENT_ID / _SECRET  the deployment's Google Drive client
#   GOOGLE_MARKETING_OAUTH_CLIENT_ID / _SECRET  its Google Ads and YouTube client
#   SHOPIFY_APP_CLIENT_ID / _SECRET    its Shopify app (also the webhook key)
#   GOOGLE_PICKER_API_KEY / GOOGLE_CLOUD_PROJECT_NUMBER
#                                      the Google Picker of the Drive client's
#                                      project: without them a moved instance
#                                      drops Drive's picked-files mode
#   META_APP_ID / META_APP_SECRET      the instance Meta app (managed edition):
#                                      pages are subscribed to that app, and the
#                                      server's Meta callback token derives from
#                                      its secret
#   APNS_KEY_PATH / _KEY_ID / _TEAM_ID / _BUNDLE_ID
#                                      iOS push: device tokens are bound to the
#                                      team and bundle, and the .p8 key file
#                                      lives under deploy/data, which travels
#
# Personal mailbox encryption needs nothing here: its keys are wrapped by each
# member's own credentials and travel inside the database.
#
# scripts/backup-secrets.test.ts keeps this list in sync with the code.
DATA_SECRETS_REQUIRED=(JWT_SECRET ENCRYPTION_KEY BYOK_ENCRYPTION_KEY)
DATA_SECRETS_OPTIONAL=(VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT)
CARRIED_CONFIG=(GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GMAIL_OAUTH_CLIENT_ID GMAIL_OAUTH_CLIENT_SECRET
  GOOGLE_DRIVE_OAUTH_CLIENT_ID GOOGLE_DRIVE_OAUTH_CLIENT_SECRET GOOGLE_MARKETING_OAUTH_CLIENT_ID
  GOOGLE_MARKETING_OAUTH_CLIENT_SECRET SHOPIFY_APP_CLIENT_ID SHOPIFY_APP_CLIENT_SECRET
  GOOGLE_PICKER_API_KEY GOOGLE_CLOUD_PROJECT_NUMBER
  META_APP_ID META_APP_SECRET
  APNS_KEY_PATH APNS_KEY_ID APNS_TEAM_ID APNS_BUNDLE_ID)

print_help() {
  sed -n '4,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --keep)
      [ $# -ge 2 ] || die "--keep requires a number"
      KEEP="$2"
      case "${KEEP}" in '' | *[!0-9]* | 0) die "--keep must be a positive number" ;; esac
      shift 2
      ;;
    --project)
      [ $# -ge 2 ] || die "--project requires a value"
      PROJECT_NAME="$2"
      shift 2
      ;;
    --dir)
      [ $# -ge 2 ] || die "--dir requires a path"
      BACKUP_DIR="$2"
      shift 2
      ;;
    -h | --help)
      print_help
      exit 0
      ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

require_tools
resolve_app_image

# The archive holds the data keys: its directory must be private. A new one is
# created mode 700; an existing one that others can enter is refused rather
# than silently changed (it may be shared on purpose, then pick another --dir).
if [ -d "${BACKUP_DIR}" ]; then
  # shellcheck disable=SC2012 # the mode string of one known path; portable across GNU and BSD
  mode="$(ls -ld "${BACKUP_DIR}" | cut -c5-10)"
  [ "${mode}" = "------" ] ||
    die "${BACKUP_DIR} is readable or enterable by other users (group and other permissions: ${mode}); archives hold the data keys. Run: chmod 700 ${BACKUP_DIR}  (or choose another --dir)"
else
  mkdir -p "${BACKUP_DIR}"
  chmod 700 "${BACKUP_DIR}"
  log "Created ${BACKUP_DIR} (mode 700)."
fi
BACKUP_DIR="$(cd "${BACKUP_DIR}" && pwd)"

# One backup at a time per directory (cron plus a manual run, or a move during
# the nightly run). A lock left by a dead run is taken over.
LOCK="${BACKUP_DIR}/.backup.lock"
if ! mkdir "${LOCK}" 2>/dev/null; then
  holder="$(cat "${LOCK}/pid" 2>/dev/null || true)"
  if [ -n "${holder}" ] && kill -0 "${holder}" 2>/dev/null; then
    die "another backup is running (pid ${holder}); wait for it, or remove ${LOCK} if that process is not a backup"
  fi
  rm -rf "${LOCK}"
  mkdir "${LOCK}" || die "could not take the backup lock ${LOCK}"
  log "Took over a stale lock left by an earlier run${holder:+ (pid ${holder})}."
fi
echo "$$" >"${LOCK}/pid"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="liaison-backup-${TS}"
STAGE="$(mktemp -d "${BACKUP_DIR}/.${NAME}.XXXXXX")"
PARTIAL="${BACKUP_DIR}/.${NAME}.tar.gz.partial"
ARCHIVE="${BACKUP_DIR}/${NAME}.tar.gz"
[ ! -e "${ARCHIVE}" ] || die "${ARCHIVE} already exists (two runs in the same second?)"
cleanup() { rm -rf "${STAGE}" "${PARTIAL}" "${LOCK}"; }
trap cleanup EXIT

# --- Preflight: the services holding data must be up. ----------------------
for svc in postgres objectstore; do
  cid="$(compose ps -q "${svc}" 2>/dev/null | head -n 1 || true)"
  [ -n "${cid}" ] && [ "$(docker inspect --format '{{.State.Running}}' "${cid}")" = "true" ] ||
    die "the ${svc} service of project '${PROJECT_NAME}' is not running (start the stack first)"
done

# --- Secrets ------------------------------------------------------------------
log "Collecting the data keys from deploy/.env..."
{
  echo "# Liaison data keys from backup ${NAME}. Keep this file secret."
  for k in "${DATA_SECRETS_REQUIRED[@]}"; do
    v="$(env_get "${k}")"
    [ -n "${v}" ] || die "${k} is empty in deploy/.env; stored data cannot be read without it"
    printf '%s=%s\n' "${k}" "${v}"
  done
  for k in "${DATA_SECRETS_OPTIONAL[@]}" "${CARRIED_CONFIG[@]}"; do
    v="$(env_get "${k}")"
    [ -z "${v}" ] || printf '%s=%s\n' "${k}" "${v}"
  done
} >"${STAGE}/secrets.env"
unset v

# --- Database -------------------------------------------------------------------
log "Dumping Postgres (one consistent snapshot)..."
compose exec -T postgres pg_dump -U liaison -d liaison -Fc >"${STAGE}/db.dump"
compose exec -T postgres pg_dumpall -U liaison --roles-only --no-role-passwords >"${STAGE}/roles.sql"
# A dump pg_restore cannot list is not a dump.
compose exec -T postgres pg_restore --list <"${STAGE}/db.dump" >/dev/null ||
  die "pg_restore cannot read the dump just written"

ORGS="$(psql_value "SELECT count(*) FROM kernel.organizations")"
FILES="$(psql_value "SELECT count(*) FROM kernel.files")"
MIG_COUNT="$(psql_value "SELECT count(*) FROM drizzle.__drizzle_migrations")"
MIG_WHEN="$(psql_value "SELECT coalesce(max(created_at), 0) FROM drizzle.__drizzle_migrations")"

# --- Objects --------------------------------------------------------------------
log "Copying the object-store bucket..."
mkdir -p "${STAGE}/objects"
OBJ_REPORT="$(app_run --user "$(id -u):$(id -g)" -v "${STAGE}/objects:/backup" \
  -- bun /liaison-backup/objects.ts dump /backup)"
OBJECTS="$(printf '%s' "${OBJ_REPORT}" | sed -n 's/.*"objects":\([0-9]*\).*/\1/p')"
OBJECT_BYTES="$(printf '%s' "${OBJ_REPORT}" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"
[ -n "${OBJECTS}" ] || die "the object copy did not report a count"

# --- App data directory ---------------------------------------------------------
log "Copying the app data directory..."
app_run -- tar -czf - -C /var/lib/liaison \
  --exclude ./maintenance --exclude ./maintenance-version . >"${STAGE}/data.tar.gz"
gzip -t "${STAGE}/data.tar.gz"

# --- Manifest -------------------------------------------------------------------
RELEASE="$(app_run -- cat /app/.liaison-release.json 2>/dev/null || true)"
VERSION="$(printf '%s' "${RELEASE}" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
JOURNAL="$(app_run -- cat /app/apps/api/src/db/migrations/meta/_journal.json)"
MIG_TAG="$(printf '%s\n' "${JOURNAL}" | awk -v w="${MIG_WHEN}" '
  /"when":/ { gsub(/[^0-9]/, "", $0); cur = $0 }
  /"tag":/ && cur == w { sub(/.*"tag": *"/, ""); sub(/".*/, ""); print; exit }')"
IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${LIAISON_IMAGE}" 2>/dev/null || true)"

json_str() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
checksums=""
for f in db.dump roles.sql secrets.env data.tar.gz objects/index.jsonl; do
  checksums="${checksums}${checksums:+,}
    $(json_str "${f}"): { \"sha256\": $(json_str "$(sha256_of "${STAGE}/${f}")"), \"bytes\": $(size_of "${STAGE}/${f}") }"
done
secret_names=""
while IFS='=' read -r k _; do
  case "${k}" in '' | \#*) continue ;; esac
  secret_names="${secret_names}${secret_names:+, }$(json_str "${k}")"
done <"${STAGE}/secrets.env"

cat >"${STAGE}/manifest.json" <<EOF
{
  "format": "liaison-backup/1",
  "createdAt": $(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)"),
  "liaison": {
    "image": $(json_str "${LIAISON_IMAGE}"),
    "imageId": $(json_str "${IMAGE_ID}"),
    "version": $(json_str "${VERSION:-unknown}")
  },
  "baseUrl": $(json_str "$(env_get BASE_URL)"),
  "migrations": {
    "applied": ${MIG_COUNT},
    "highwaterWhen": ${MIG_WHEN},
    "highwaterTag": $(json_str "${MIG_TAG}")
  },
  "counts": {
    "organizations": ${ORGS},
    "files": ${FILES},
    "objects": ${OBJECTS},
    "objectBytes": ${OBJECT_BYTES:-0}
  },
  "secrets": [${secret_names}],
  "checksums": {${checksums}
  }
}
EOF

# --- Archive and verify ---------------------------------------------------------
log "Writing the archive..."
tar -czf "${PARTIAL}" -C "${STAGE}" .
gzip -t "${PARTIAL}"
for f in db.dump roles.sql secrets.env data.tar.gz objects/index.jsonl manifest.json; do
  tar -xOzf "${PARTIAL}" "./${f}" >"${STAGE}/.verify"
  if [ "$(sha256_of "${STAGE}/.verify")" != "$(sha256_of "${STAGE}/${f}")" ]; then
    die "${f} does not read back from the archive identically"
  fi
done
rm -f "${STAGE}/.verify"
in_archive="$(tar -tzf "${PARTIAL}" | grep -c '^\./objects/data/[0-9]' || true)"
[ "${in_archive}" = "${OBJECTS}" ] || die "the archive holds ${in_archive} objects, the bucket had ${OBJECTS}"

chmod 600 "${PARTIAL}"
mv "${PARTIAL}" "${ARCHIVE}"

# --- Rotation -------------------------------------------------------------------
[ -z "${KEEP}" ] || rotate_archives "${BACKUP_DIR}" "${KEEP}" "${ARCHIVE}"

SIZE="$(du -h "${ARCHIVE}" | awk '{ print $1 }')"
log "Backup OK: ${SIZE} ${ARCHIVE}"
log "  ${ORGS} organization(s), ${FILES} file row(s), ${OBJECTS} object(s), migrations ${MIG_COUNT} (${MIG_TAG:-?}), Liaison ${VERSION:-unknown}"
log "  It holds the data keys: keep it as private as deploy/.env, and copy it off this host."
printf '%s\n' "${ARCHIVE}"
