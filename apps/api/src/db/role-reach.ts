// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Is the connecting login privileged, or can it step into a role that is?"
// The database connector asks it of every target database before running
// anything.

/**
 * Rows naming why the login is unsafe for the connector; no rows means it is
 * confined:
 *
 *  - the login itself is a superuser (it can `SET ROLE` to anything, and
 *    `SET SESSION AUTHORIZATION` too),
 *  - or it can step into a superuser or BYPASSRLS role with `SET ROLE` (or a
 *    `set_config('role', ...)` a guard failed to catch),
 *  - or it holds one of the roles that reach the database server's own files or
 *    run programs on it (`COPY ... PROGRAM`, server-side file reads), which a
 *    read-only analytics login never needs.
 *
 * `pg_has_role(..., 'MEMBER')` is true for direct and indirect membership
 * whether or not the privilege is inherited, so this errs towards refusing. A
 * login that itself holds BYPASSRLS (but not superuser) is not refused: it has
 * nothing further to step into, and a deliberately granted read-only reporting
 * login over a whole database has exactly that shape.
 */
export const PRIVILEGED_ROLE_REACH_SQL = `SELECT r.rolname AS rolname
   FROM pg_roles r
   WHERE (r.rolname = session_user AND r.rolsuper)
      OR ((r.rolsuper OR r.rolbypassrls
           OR r.rolname IN ('pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files'))
        AND r.rolname <> session_user
        AND pg_has_role(session_user, r.oid, 'MEMBER'))
   ORDER BY r.rolname
   LIMIT 5`
