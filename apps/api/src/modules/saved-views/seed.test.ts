// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { manifestRegistry } from "~/modules/apps/app-registries"
import { seedManifestDefaults } from "~/modules/saved-views/seed"

const ORG = "00000000-0000-0000-0000-0000000099b1"
const APP = "test-seed-app"

beforeAll(async () => {
  await sql`DELETE FROM kernel.saved_views WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await sql`INSERT INTO kernel.organizations(id, name, slug)
    VALUES (${ORG}, 'sv-seed', 'sv-seed')`
  manifestRegistry.set([ORG, APP], {
    name: APP,
    savedViews: {
      inbox: {
        defaults: [
          { key: "my-open", name: "My open", payload: { smartFilter: "needs-attention" } },
          { key: "unassigned", name: "Unassigned", payload: { assignedTo: null } },
        ],
      },
    },
    uiBundleUrl: null,
  })
})

afterEach(async () => {
  await sql`DELETE FROM kernel.saved_views WHERE org_id = ${ORG}`
})

afterAll(async () => {
  manifestRegistry.delete([ORG, APP])
  await sql`DELETE FROM kernel.saved_views WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("seedManifestDefaults", () => {
  it("inserts one row per manifest savedViews defaults entry", async () => {
    await withPrivilegedDb(ORG, "test-seed", (tx) => seedManifestDefaults(tx, ORG))
    const rows = await sql`
      SELECT manifest_key, name, is_default, owner_user_id, shared_with_org, app, view_id
      FROM kernel.saved_views
      WHERE org_id = ${ORG} ORDER BY manifest_key`
    expect(rows.length).toBe(2)
    expect(rows[0].manifest_key).toBe("my-open")
    expect(rows[0].is_default).toBe(true)
    expect(rows[0].owner_user_id).toBeNull()
    expect(rows[0].shared_with_org).toBe(true)
    expect(rows[0].app).toBe(APP)
    expect(rows[0].view_id).toBe("inbox")
  })

  it("is idempotent — second call inserts nothing new", async () => {
    await withPrivilegedDb(ORG, "test-seed", (tx) => seedManifestDefaults(tx, ORG))
    const before = (
      await sql`SELECT count(*)::int as c FROM kernel.saved_views WHERE org_id=${ORG}`
    )[0].c
    await withPrivilegedDb(ORG, "test-seed", (tx) => seedManifestDefaults(tx, ORG))
    const after = (
      await sql`SELECT count(*)::int as c FROM kernel.saved_views WHERE org_id=${ORG}`
    )[0].c
    expect(after).toBe(before)
  })

  it("does not overwrite admin-renamed defaults", async () => {
    await withPrivilegedDb(ORG, "test-seed", (tx) => seedManifestDefaults(tx, ORG))
    await sql`UPDATE kernel.saved_views SET name='Admin Renamed'
              WHERE org_id=${ORG} AND manifest_key='my-open'`
    await withPrivilegedDb(ORG, "test-seed", (tx) => seedManifestDefaults(tx, ORG))
    const rows =
      await sql`SELECT name FROM kernel.saved_views WHERE org_id=${ORG} AND manifest_key='my-open'`
    expect(rows[0].name).toBe("Admin Renamed")
  })
})
