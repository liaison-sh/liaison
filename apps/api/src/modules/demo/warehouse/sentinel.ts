// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The constants that make the demo org's `database` connection inert.
//
// A demo org needs a `database` CONNECTION row or the whole oracle surface
// (`db_list_reads`, `db_describe`, `db_read`, `db_query`) answers
// `not_connected`. Demo mode REFUSES connections, and a demo org must never
// hold a real credential, so the seeder installs a connection whose
// `connectionString` is the literal sentinel below: a string that is not a DSN,
// carries no host, no role and no password, and could not be dialled if
// somebody tried.
//
// The runtime half is `resolve.ts`: for an org that passes BOTH demo gates (the
// process flag and the org marker) the sentinel resolves to the warehouse's OWN
// connection, read from `LIAISON_DEMO_WAREHOUSE_DATABASE_URL` in the server
// environment: a dedicated LOGIN role that is a member of no Liaison role and
// holds SELECT on the warehouse schema and on nothing else. So:
//
//   * nothing secret is stored in the demo org's data: an operator reading
//     `kernel.connected_accounts` sees a sentinel and learns nothing,
//   * the demo query never runs as the application's own login, so no SQL that
//     slips past the read-only guard (a `set_config('role', ...)`, say) has a
//     privileged role to step into: there is none to reach,
//   * the role's grants are the wall: neither a curated read nor an ad hoc
//     `db_query` nor `db_describe` can see one row of Liaison's own tables.
//
// With the variable unset the demo warehouse is REFUSED, never served over the
// application's connection.

/** The schema the demo analytics warehouse lives in. */
export const DEMO_WAREHOUSE_SCHEMA = "demo_warehouse"

/** The env variable holding the warehouse's own DSN (see the header). */
export const DEMO_WAREHOUSE_DSN_ENV = "LIAISON_DEMO_WAREHOUSE_DATABASE_URL"

/**
 * Login role names the warehouse connection may use. The prefix is a guard,
 * not a convention: provisioning rewrites this role's password and attributes,
 * so it must never be pointed at the application's own login or a real one.
 */
export const DEMO_WAREHOUSE_LOGIN_PATTERN = /^liaison_demo_warehouse[a-z0-9_]*$/

/**
 * The stand-in for a Postgres DSN. Not a credential, not derived from one, and
 * recognisably not one to anybody who reads the row. `resolveCredentialMode`
 * treats it as direct mode, and `resolve.ts` swaps it for the real handle
 * before a transport is ever built.
 */
export const DEMO_WAREHOUSE_SENTINEL_DSN = "liaison-demo-warehouse-not-a-dsn"

/** The adapter name the demo catalog registers under. */
export const DEMO_WAREHOUSE_ADAPTER = "resonant-warehouse"

/** True when `value` is the sentinel and not a real connection string. */
export function isDemoWarehouseSentinel(value: string | undefined): boolean {
  return value === DEMO_WAREHOUSE_SENTINEL_DSN
}
