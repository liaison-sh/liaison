// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Roles are cluster wide. A test that replays migrations on a scratch database
// still runs their role statements on the whole cluster: a migration that
// takes back a login's extra memberships (the request login split does) takes
// them back from every database on the server, including the ones other
// checkouts and suites are using, whose later migrations granted them.
//
// `keepClusterRoleMemberships` snapshots every role membership before such a
// test and returns the restore its teardown runs: each membership the replay
// took away is granted again, with its options and its grantor. Memberships
// the replay added are the test's own to remove (its scratch login's, say).
import type postgres from "postgres"

export interface RoleMembership {
  role: string
  member: string
  grantor: string
  admin: boolean
  inherit: boolean
  set: boolean
}

const key = (m: RoleMembership): string => `${m.role}\0${m.member}\0${m.grantor}`

export async function listRoleMemberships(sql: postgres.Sql): Promise<RoleMembership[]> {
  return sql<RoleMembership[]>`
    SELECT r.rolname AS role, u.rolname AS member, g.rolname AS grantor,
           a.admin_option AS admin, a.inherit_option AS inherit, a.set_option AS set
      FROM pg_auth_members a
      JOIN pg_roles r ON r.oid = a.roleid
      JOIN pg_roles u ON u.oid = a.member
      JOIN pg_roles g ON g.oid = a.grantor`
}

/** The cluster's memberships now; the returned function grants back any that went missing. */
export async function keepClusterRoleMemberships(
  sql: postgres.Sql,
): Promise<() => Promise<RoleMembership[]>> {
  const before = await listRoleMemberships(sql)
  return async () => {
    const now = new Set((await listRoleMemberships(sql)).map(key))
    const roles = new Set(
      (await sql<{ name: string }[]>`SELECT rolname AS name FROM pg_roles`).map((r) => r.name),
    )
    const restored: RoleMembership[] = []
    for (const m of before) {
      if (now.has(key(m))) continue
      // A role the test itself dropped since (its scratch login) has nothing to get back.
      if (!roles.has(m.role) || !roles.has(m.member) || !roles.has(m.grantor)) continue
      const opt = (b: boolean) => (b ? "TRUE" : "FALSE")
      await sql.unsafe(
        `GRANT "${m.role}" TO "${m.member}" WITH ADMIN ${opt(m.admin)}, INHERIT ${opt(m.inherit)}, SET ${opt(m.set)} GRANTED BY "${m.grantor}"`,
      )
      restored.push(m)
    }
    return restored
  }
}
