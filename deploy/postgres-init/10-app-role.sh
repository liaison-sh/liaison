#!/bin/sh
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Postgres cluster init hook. The official postgres image runs every file in
# /docker-entrypoint-initdb.d ONCE, on first cluster initialisation, before the
# server accepts external connections — so this runs before the app or the
# migration step ever connect.
#
# It provisions `liaison_app`: the NON-superuser, NON-owner login role the
# running application authenticates as. The app must connect as a role that is
# subject to row-level security; the bootstrap `POSTGRES_USER` (`liaison`) is a
# superuser and a table owner, both of which BYPASS RLS, so it is reserved for
# migrations / DDL only (MIGRATION_DATABASE_URL).
#
# Why a role with LOGIN but NO ownership and NO BYPASSRLS:
#   * superusers and BYPASSRLS roles skip every RLS policy outright.
#   * the role that CREATEs a table OWNs it; owners skip RLS unless the table is
#     FORCE ROW LEVEL SECURITY. liaison_app never runs DDL, so it owns nothing.
# Together this guarantees per-org isolation policies actually apply to runtime
# traffic.
#
# The kernel baseline migration (0000_initial.sql) already defines liaison_app
# (NOBYPASSRLS NOLOGIN) and grants it membership in liaison_rls / liaison_admin /
# liaison_schema_admin plus the schema/table privileges. Because the migration
# guards role creation with `IF NOT EXISTS`, creating the role here first — with
# LOGIN and a password — wins: the migration finds it already present and leaves
# its LOGIN/password intact while wiring up the role memberships and grants.
#
# The password is read from LIAISON_APP_PASSWORD in the environment (never baked
# into the image). The role is created idempotently and its password is always
# (re)set to the current env value so credential rotation takes effect on a
# fresh cluster init.
set -eu

if [ -z "${LIAISON_APP_PASSWORD:-}" ]; then
  echo "postgres-init: LIAISON_APP_PASSWORD is required to provision the runtime app role" >&2
  exit 1
fi

# Use the per-session variable mechanism so the password is passed as data,
# not interpolated into the SQL text (avoids quoting/injection issues).
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set app_password="$LIAISON_APP_PASSWORD" \
  --set app_db="$POSTGRES_DB" <<'SQL'
-- NOTE: psql :'var' interpolation does NOT occur inside a dollar-quoted DO block,
-- so the role is ensured here (no password) and the password is applied by the
-- TOP-LEVEL ALTER below. (The original put PASSWORD :'app_password' inside the
-- DO block -> "syntax error at or near \":\"" on every fresh init.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_app') THEN
    CREATE ROLE liaison_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- LOGIN + password at top level (psql :'app_password' interpolates here).
ALTER ROLE liaison_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
  PASSWORD :'app_password';

-- Lets liaison_app open a connection to the application database. All table /
-- schema privileges (and the SET ROLE memberships in liaison_rls / liaison_admin
-- / liaison_schema_admin) are granted by the kernel baseline migration, which
-- runs next over MIGRATION_DATABASE_URL.
GRANT CONNECT ON DATABASE :"app_db" TO liaison_app;
SQL

echo "postgres-init: runtime role liaison_app provisioned (non-superuser, NOBYPASSRLS, LOGIN)"
