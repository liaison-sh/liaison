// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Roles and role memberships are cluster wide. Two tests that replay the
 * migrations, each into a scratch database of its own, still write the same
 * role rows (`ALTER ROLE liaison_admin`, the request login's memberships), and
 * Postgres refuses the second writer with "tuple concurrently updated". An
 * advisory lock only counts within one database, so this one is taken in the
 * server's `postgres` maintenance database, which every test process shares:
 * one replay at a time on the cluster.
 */
import postgres from "postgres"
import { advisoryLockKey } from "~/db/advisory-lock"

const KEY = String(advisoryLockKey("tests:role-catalog-writes"))

/** Run `fn` holding the cluster's role-catalog lock. `serverUrl`: any database on the server, as a superuser. */
export async function withRoleCatalogLock<T>(
  serverUrl: string | URL,
  fn: () => Promise<T>,
): Promise<T> {
  const url = new URL(serverUrl.toString())
  url.pathname = "/postgres"
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} })
  try {
    await sql`SELECT pg_advisory_lock(${KEY}::bigint)`
    return await fn()
  } finally {
    await sql`SELECT pg_advisory_unlock(${KEY}::bigint)`.catch(() => {})
    await sql.end({ timeout: 5 })
  }
}
