#!/bin/sh
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Postgres cluster-init hook (fresh clusters only — runs ONCE, at first
# cluster initialization, before the app or migration step ever connect,
# same mechanism as 00-rls-roles.sh / 10-app-role.sh).
#
# Provisions `liaison_readonly`: an ALLOW-LIST read-only role (Task 7 §7.1,
# C1) granted SELECT ONLY on the explicit tables/columns the active
# database-connector catalog reads — never `GRANT SELECT ON ALL TABLES`.
# Secret columns (kernel.users.password_hash, connected_accounts.*_encrypted,
# organizations.settings, …) are never granted at all — the primary wall,
# independent of the app-layer SECRET_COLUMNS belt.
#
# The grants file this script executes (`generated/readonly-grants.sql`) is
# NOT a copy — it IS the single checked-in
# `apps/api/src/modules/apps/connections/sql/generated/readonly-grants.sql` file that
# `scripts/db-readonly-role.ts` (the existing-cluster path) also executes,
# bind-mounted read-only alongside this script by `deploy/docker-compose.yml`
# (see that file's postgres `volumes:` comment). One generated SQL file, two
# consumers, no shell/TS sync problem, no second hand-maintained copy.
# Regenerate it with `bun run scripts/db-readonly-role.ts --regenerate` after
# any catalog change, and verify with
# `bun run scripts/db-readonly-role.ts --check-sync` (fails loudly if the
# checked-in file is stale relative to the catalog).
#
# On an EXISTING cluster (this hook does not re-fire on an already-initialized
# data volume — same caveat as 00-rls-roles.sh/10-app-role.sh), use
# `bun run scripts/db-readonly-role.ts --create` instead.
#
# Password: read from LIAISON_READONLY_PASSWORD (never baked into the image
# or the generated grants file — the grants file carries no secret).
set -eu

if [ -z "${LIAISON_READONLY_PASSWORD:-}" ]; then
  echo "postgres-init: LIAISON_READONLY_PASSWORD is required to provision liaison_readonly" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Where compose bind-mounts the canonical generated grants file. Default
# /tmp/liaison-grants: a path the postgres image already has, which a bind
# mount can therefore land on under docker's overlayfs snapshotter (a missing
# container path fails the container there). The legacy location, a `generated/`
# subdirectory next to this script, stays as a fallback so an already-deployed
# compose file keeps working.
GRANTS_DIR="${LIAISON_GRANTS_DIR:-/tmp/liaison-grants}"
GRANTS_FILE="$GRANTS_DIR/readonly-grants.sql"

if [ ! -f "$GRANTS_FILE" ] && [ -f "$SCRIPT_DIR/generated/readonly-grants.sql" ]; then
  GRANTS_FILE="$SCRIPT_DIR/generated/readonly-grants.sql"
fi

if [ ! -f "$GRANTS_FILE" ]; then
  echo "postgres-init: $GRANTS_FILE not found — mount apps/api/src/modules/apps/connections/sql/generated/ at $GRANTS_DIR (see deploy/docker-compose.yml), or run 'bun run scripts/db-readonly-role.ts --regenerate' to (re)create the canonical file" >&2
  exit 1
fi

# The role and its password first: they need nothing else to exist.
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set readonly_password="$LIAISON_READONLY_PASSWORD" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_readonly') THEN
    CREATE ROLE liaison_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS CONNECTION LIMIT 4;
  END IF;
END $$;
ALTER ROLE liaison_readonly PASSWORD :'readonly_password';
SQL

# The grants name tables in schemas the migrations and app registrations
# create. On a fresh cluster, which is when postgres runs this hook, none of
# them exists yet: applying the grants then failed the whole cluster init
# (postgres exited 3, and came back on restart with no password on this role).
# So the grants wait until every schema they name exists. This script is safe
# to run again once the app has started once, from the deploy directory:
#   docker compose exec -T postgres sh /docker-entrypoint-initdb.d/20-readonly-role.sh
# (deploy/quickstart.sh does it after the first healthy start).
missing=""
# shellcheck disable=SC2013 # schema names are single words
for schema in $(sed -n 's/^GRANT USAGE ON SCHEMA \([a-z_]*\) TO .*/\1/p' "$GRANTS_FILE" | sort -u); do
  present="$(psql -X -At --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -c "SELECT 1 FROM pg_namespace WHERE nspname = '$schema'")"
  [ "$present" = "1" ] || missing="$missing $schema"
done
if [ -n "$missing" ]; then
  echo "postgres-init: liaison_readonly created with its password; grants deferred until the app has created:$missing"
  echo "postgres-init: after the app's first start, run: docker compose exec -T postgres sh /docker-entrypoint-initdb.d/20-readonly-role.sh"
  exit 0
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$GRANTS_FILE"

echo "postgres-init: read-only role liaison_readonly provisioned (allow-list grants applied, password set)"
