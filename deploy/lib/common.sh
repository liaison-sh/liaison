# shellcheck shell=bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Shared helpers for deploy/backup.sh, deploy/restore.sh and deploy/move.sh.
# Sourced, never run. Expects DEPLOY_DIR and PROJECT_NAME to be set.

log() { printf '%s\n' "$*" >&2; }
err() { printf 'error: %s\n' "$*" >&2; }
die() {
  err "$*"
  exit 1
}

# The compose command for this stack. LIAISON_IMAGE is resolved once (see
# resolve_app_image) so every `run` uses the image the stack really runs.
compose() {
  docker compose -p "${PROJECT_NAME}" -f "${DEPLOY_DIR}/docker-compose.yml" \
    --env-file "${DEPLOY_DIR}/.env" "$@"
}

# The host tools every script needs, plus any named by the caller (curl for
# restore's health check). Checked first, before anything else happens.
# shellcheck disable=SC2120 # arguments are optional
require_tools() {
  local t
  for t in docker tar gzip awk sed "$@"; do
    command -v "${t}" >/dev/null 2>&1 || die "${t} is not installed or not on PATH (install it, then rerun)"
  done
  docker info >/dev/null 2>&1 || die "the docker daemon is not reachable (is Docker running?)"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
  [ -f "${DEPLOY_DIR}/.env" ] || die "${DEPLOY_DIR}/.env not found (run deploy/quickstart.sh once, or create it from deploy/.env.example)"
}

# Value of KEY in deploy/.env, empty when absent. Never printed by callers.
env_get() {
  awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' \
    "${DEPLOY_DIR}/.env"
}

# Portable in-place `KEY=value` (adds the line when KEY is absent). Keeps the
# file's mode: the temp file is created next to it and written through cat.
env_set() {
  local key="$1" value="$2" file="${DEPLOY_DIR}/.env" tmp
  tmp="$(mktemp "${DEPLOY_DIR}/.env.tmp.XXXXXX")"
  # The value travels in the environment, not on awk's command line: it stays
  # out of the process list and awk does not interpret its backslashes.
  LIAISON_ENV_VALUE="${value}" awk -v k="${key}" '
    index($0, k "=") == 1 { if (!done) print k "=" ENVIRON["LIAISON_ENV_VALUE"]; done = 1; next }
    { print }
    END { if (!done) print k "=" ENVIRON["LIAISON_ENV_VALUE"] }
  ' "${file}" >"${tmp}"
  cat "${tmp}" >"${file}"
  rm -f "${tmp}"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

# Bytes of a file, GNU or BSD stat.
size_of() {
  wc -c <"$1" | tr -d ' '
}

# The image the app service runs: LIAISON_IMAGE from the environment or .env,
# else the image of the existing app container, else the compose default.
resolve_app_image() {
  if [ -z "${LIAISON_IMAGE:-}" ]; then
    LIAISON_IMAGE="$(env_get LIAISON_IMAGE)"
  fi
  if [ -z "${LIAISON_IMAGE:-}" ]; then
    local cid
    cid="$(compose ps -a -q app 2>/dev/null | head -n 1 || true)"
    if [ -n "${cid}" ]; then
      LIAISON_IMAGE="$(docker inspect --format '{{.Config.Image}}' "${cid}" 2>/dev/null || true)"
    fi
  fi
  if [ -z "${LIAISON_IMAGE:-}" ]; then
    # The compose default: the one image that is not an infrastructure image.
    LIAISON_IMAGE="$(compose config --images 2>/dev/null |
      awk '!/^(postgres|redis|getmeili\/|chrislusf\/|busybox)/' | head -n 1 || true)"
  fi
  [ -n "${LIAISON_IMAGE:-}" ] || die "could not tell which Liaison image the app runs (set LIAISON_IMAGE)"
  export LIAISON_IMAGE
}

# Run a one-off command in the app image on the stack's network, with the
# app's environment (object store endpoint and scoped credentials) and the
# helper scripts mounted read only at /liaison-backup. Extra docker compose run
# flags (volumes) come first, then `--`, then the command.
app_run() {
  local flags=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do
    flags+=("$1")
    shift
  done
  [ "${1:-}" = "--" ] && shift
  compose run --rm --no-deps -T \
    -e HOME=/tmp \
    -v "${DEPLOY_DIR}/lib:/liaison-backup:ro" \
    "${flags[@]}" \
    --entrypoint "$1" app "${@:2}"
}

wait_service_healthy() {
  local svc="$1" i cid state
  for i in $(seq 1 60); do
    cid="$(compose ps -q "${svc}" 2>/dev/null | head -n 1 || true)"
    if [ -n "${cid}" ]; then
      state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${cid}" 2>/dev/null || true)"
      [ "${state}" = "healthy" ] && return 0
    fi
    sleep 2
    : "${i}"
  done
  die "${svc} did not become healthy (docker compose logs ${svc})"
}

# psql as the bootstrap superuser inside the postgres container.
psql_super() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -X -q -U liaison "$@"
}

# One value from a query (unaligned, tuples only).
psql_value() {
  psql_super -d "${2:-liaison}" -At -c "$1"
}

# Keep the KEEP newest archives of DIR, counting CURRENT (the one just written).
# Only names this tooling writes rotate (liaison-backup-<YYYYMMDD>T<HHMMSS>Z.tar.gz,
# which sort by time); a hand-named archive (liaison-backup-before-upgrade.tar.gz)
# is never touched, and neither is CURRENT.
rotate_archives() {
  local dir="$1" keep="$2" current="$3" old f
  old="$(find "${dir}" -maxdepth 1 -type f -name 'liaison-backup-*.tar.gz' |
    grep -E '/liaison-backup-[0-9]{8}T[0-9]{6}Z\.tar\.gz$' | grep -vxF "${current}" |
    sort -r | tail -n +"${keep}" || true)"
  [ -n "${old}" ] || return 0
  while IFS= read -r f; do
    rm -f "${f}"
    log "Rotation: removed $(basename "${f}")"
  done <<EOF
${old}
EOF
}
