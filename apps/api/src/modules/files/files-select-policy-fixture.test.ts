// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two test files borrow `kernel.files`'s SELECT policy so their handlers can
// resolve a seeded file under RLS. How they gave it back was the bug.
//
// They ran `DROP POLICY ...; CREATE POLICY ...` as loose statements outside any
// transaction, so a run killed between the two left the table with no SELECT
// policy at all, for every later process on that database. And they put back a
// hard-coded `USING (false)`, which is only what the builder produces when the
// fileParent registry is EMPTY: in a process where apps are registered that
// replaced the real policy with deny-everything and every later file read no
// files.
//
// Fails-without-fix: the restored policy is `false` rather than what the
// registry describes, and a failed replacement leaves no policy behind.
import { afterAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { manifestFileParentRegistry } from "~/modules/apps/app-registries"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import {
  applyFilesSelectPolicyStatements,
  installPermissiveFilesSelectPolicy,
  restoreFilesSelectPolicy,
} from "~/tests/helpers/files-select-policy"

const ORG = randomUUID()
const APP = "fx15policy"
const ENTITY = "member"

async function filesSelectQual(): Promise<string | null> {
  const rows = (await sql`
    SELECT pg_get_expr(polqual, polrelid) AS q
    FROM pg_policy
    WHERE polname = 'files_select' AND polrelid = 'kernel.files'::regclass
  `) as unknown as Array<{ q: string | null }>
  return rows.length === 0 ? null : rows[0].q
}

afterAll(async () => {
  manifestFileParentRegistry.delete([ORG, APP, ENTITY])
  await rebuildFilesSelectPolicy()
})

describe("borrowing the kernel.files SELECT policy gives back what the registry describes", () => {
  it("restores the built policy, not a deny-everything placeholder", async () => {
    // A process with a registered file parent, which is what production is.
    // `kernel.users` is a real table carrying the `id` and `org_id` the builder
    // joins on, so the generated policy type-checks.
    manifestFileParentRegistry.set([ORG, APP, ENTITY], {
      tableName: "users",
      schemaRef: "kernel",
      joinOn: "id",
      readScope: `${APP}:members:read`,
      writeScope: `${APP}:members:write`,
    })
    // The catalog holds no fixture app: build from the registry's parents.
    const parents = CatalogDerivationsTestAccess.registryFileParents()
    await rebuildFilesSelectPolicy({ parents })
    const built = await filesSelectQual()
    expect(built).toBeTruthy()
    expect(built).toContain(APP)
    expect(built).not.toBe("false")

    await installPermissiveFilesSelectPolicy()
    const borrowed = await filesSelectQual()
    expect(borrowed).toContain("rls_ctx.org_id()")

    await restoreFilesSelectPolicy({ parents })
    expect(await filesSelectQual()).toBe(built)
  }, 60_000)

  it("leaves the previous policy in place when the replacement fails", async () => {
    const before = await filesSelectQual()
    expect(before).toBeTruthy()

    // The drop lands, the create does not. Outside a transaction that is how
    // `kernel.files` ends up with no SELECT policy at all.
    let failed = false
    try {
      await applyFilesSelectPolicyStatements([
        `DROP POLICY IF EXISTS files_select ON kernel.files`,
        `CREATE POLICY files_select ON kernel.files FOR SELECT TO liaison_rls USING (no_such_column)`,
      ])
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    expect(await filesSelectQual()).toBe(before)
  }, 60_000)
})
