// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The API keys list (`apiKeys.list`, the Tickets settings page's API keys
// block) lists the keys that still work. A revoked key stops authenticating
// and leaves the list; its row stays in the table for history.

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

const rows = (r: unknown): any[] => (r as any).rows ?? r

let orgId: string
let userId: string

beforeAll(async () => {
  const slug = `apikeys-list-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("api-keys-list-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), ${slug}, ${slug}) RETURNING id`),
    )[0].id
    userId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id`),
    )[0].id
  })
  await ensureAppsForOrg(orgId, {})
})

describe("apiKeys.list", () => {
  it("lists live keys only: a revoked key leaves the list, its row is kept", async () => {
    const actor = { actorType: "user" as const, userId }
    await withPrivilegedDb(orgId, "api-keys-list", async (tx) => {
      const kept = (await runAdminOp(
        tx as never,
        orgId,
        "apiKeysCreate",
        { label: "kept" },
        actor,
      )) as any
      const revoked = (await runAdminOp(
        tx as never,
        orgId,
        "apiKeysCreate",
        { label: "revoked" },
        actor,
      )) as any
      const before = (await runAdminOp(tx as never, orgId, "apiKeysList", {}, actor)) as any[]
      expect(before.map((k) => k.label).sort()).toEqual(["kept", "revoked"])

      await runAdminOp(tx as never, orgId, "apiKeysRevoke", { id: revoked.id }, actor)

      const after = (await runAdminOp(tx as never, orgId, "apiKeysList", {}, actor)) as any[]
      expect(after.map((k) => k.id)).toEqual([kept.id])

      const stored = rows(
        await tx.execute(drizzleSql`
          SELECT revoked_at FROM app_tickets.api_keys WHERE id = ${revoked.id}::uuid`),
      )
      expect(stored).toHaveLength(1)
      expect(stored[0].revoked_at).not.toBeNull()
    })
  })
})
