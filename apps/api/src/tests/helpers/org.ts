// SPDX-License-Identifier: FSL-1.1-ALv2

import crypto from "node:crypto"
import { desc } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { initializedOrgRuntimes } from "~/modules/apps/app-registries"
import { appSchemaDdlReuse } from "~/modules/apps/runtime"
import { bootstrapRegister } from "~/modules/auth/auth"
import { truncateOrgTables } from "~/tests/route-test-setup"

/**
 * Run `fn` with app registration applying the full schema DDL even where the
 * app schema is already current at its DDL stamp (`appSchemaDdlReuse` off).
 * The previous setting is restored afterwards.
 */
export async function withFullAppSchemaDdl<T>(fn: () => Promise<T>): Promise<T> {
  const previous = appSchemaDdlReuse.enabled
  appSchemaDdlReuse.enabled = false
  try {
    return await fn()
  } finally {
    appSchemaDdlReuse.enabled = previous
  }
}

/**
 * Bootstrap a fresh org + admin user for an integration test and return the
 * created org's `{ id }`. Wraps `bootstrapRegister` (which also calls
 * `ensureAppsForOrg`). `bootstrapRegister` enforces a single-org invariant, so
 * this first truncates all org-scoped kernel tables — the consuming test file
 * MUST hold the test lock (`acquireTestLock` in `beforeAll`,
 * `releaseTestLock` in `afterAll`). Safe to call from `beforeEach`: each call
 * yields exactly one fresh org. Resolves the orgId by reading the most
 * recently created organization.
 *
 * App registration reuses the app schemas an earlier registration in this
 * database already brought current (`appSchemaDdlReuse`, as in production); the
 * `schema-ddl-reuse-equivalence` test (modules/apps) proves the rows are the ones the full
 * registration writes. `reuseAppSchemaDdl: false` forces the full DDL.
 */
export async function createTestOrg(
  opts: { email?: string; password?: string; reuseAppSchemaDdl?: boolean } = {},
): Promise<{ id: string }> {
  await truncateOrgTables()
  // The kernel.apps row from prior orgs is gone after truncateOrgTables, but
  // the in-memory `initializedOrgRuntimes` Set still remembers them — meaning
  // `ensureAppsForOrg(prevOrgId)` would short-circuit on a stale entry without
  // actually re-populating the registries. Clearing here keeps the in-memory
  // app runtime aligned with the freshly-truncated DB so the next bootstrap's
  // ensureAppsForOrg actually re-registers every app for the new orgId.
  initializedOrgRuntimes.clear()
  const register = () =>
    bootstrapRegister(
      opts.email ?? `a${crypto.randomUUID()}@t.co`,
      "password" in opts ? opts.password : "Passw0rd!",
      "A",
    )
  if (opts.reuseAppSchemaDdl === false) await withFullAppSchemaDdl(register)
  else await register()
  return withSystemDb("test-create-org-lookup", async (db) => {
    const [row] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .orderBy(desc(organizations.createdAt))
      .limit(1)
    if (!row) throw new Error("createTestOrg: no organization found after bootstrap")
    return { id: row.id }
  })
}
