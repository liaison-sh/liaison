#!/bin/sh
# SPDX-License-Identifier: FSL-1.1-ALv2
# Postgres cluster-init hook (runs BEFORE 10-app-role.sh, alphabetically).
#
# WORKAROUND for a Liaison migration ordering bug: 0000_initial.sql references
# liaison_rls / liaison_admin in RLS policies (~line 866) but only CREATEs those
# roles (IF NOT EXISTS) ~line 1197 -- so a fresh-DB migrate fails with
# `role "liaison_rls" does not exist`. The migration comment itself says the roles
# "must exist BEFORE policies reference it", and the deploy already pre-creates
# liaison_app here for the same reason -- it just forgot the NOLOGIN roles.
#
# We pre-create them verbatim (NOBYPASSRLS NOLOGIN) so the policies resolve and the
# migration's later IF-NOT-EXISTS block is a no-op. 10-app-role.sh then upgrades
# liaison_app to LOGIN + password.
# Since the migrator itself pre-creates these roles (db/migrate.ts
# ensurePolicyRoles), this hook is only needed for images older than that; it
# stays because it is harmless (IF NOT EXISTS) and keeps old images working.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') THEN
    CREATE ROLE liaison_rls NOBYPASSRLS NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_admin') THEN
    CREATE ROLE liaison_admin NOBYPASSRLS NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_app') THEN
    CREATE ROLE liaison_app NOBYPASSRLS NOLOGIN;
  END IF;
END $$;
SQL
echo "postgres-init: pre-created NOLOGIN roles liaison_rls / liaison_admin / liaison_app"
