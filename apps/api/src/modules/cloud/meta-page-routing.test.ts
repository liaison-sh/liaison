// SPDX-License-Identifier: FSL-1.1-ALv2
// The server's Meta callback routes a Page's deliveries by the Page ids each
// org's Social app recorded (`metaOrgsForPageIds`, real Postgres). The stored
// list is not trusted on its own: an org whose Facebook account is
// disconnected, or whose token Meta rejected, gets nothing, so a Page handed
// over to another org reaches only the org that holds it now.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { metaOrgsForPageIds } from "~/modules/cloud/cell-webhooks"
import { insertAppRow, jsonCell } from "~/seed/factories/app-tables"
import { seedConnectedAccountRow } from "~/seed/factories/org/platform-rows"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const PAGE = `page-${randomUUID().slice(0, 8)}`
let createdTable = false
let createdSchema = false
const orgs: string[] = []

async function org(label: string): Promise<{ id: string; user: string }> {
  const id = randomUUID()
  const user = randomUUID()
  await seedOrgRow({ id, name: label, slug: `mpr-${id.slice(0, 8)}` })
  await seedUserRow({
    id: user,
    orgId: id,
    email: `mpr-${user.slice(0, 8)}@test.com`,
    passwordHash: "hash",
    name: label,
    status: "active",
  })
  orgs.push(id)
  return { id, user }
}

/** An org whose Facebook account `account` recorded `pages`, its connection in `status` (null: no row). */
async function recorded(
  o: { id: string; user: string },
  account: string,
  pages: string[],
  status: "active" | "error" | "disconnected" | null,
) {
  await withSystemDb("test-social-sync-state", (db) =>
    insertAppRow(db, "social", "sync_state", {
      org_id: o.id,
      platform: "facebook",
      account_external_id: account,
      source_type: "discovery",
      active: true,
      metadata: jsonCell({ meta_page_ids: pages }),
    }),
  )
  if (status === null) return
  await seedConnectedAccountRow({
    orgId: o.id,
    appName: "social",
    connectionName: "facebook",
    ownerType: "org",
    ownerId: null,
    providerType: "oauth2",
    identifier: account,
    status,
    createdBy: o.user,
  })
}

beforeAll(async () => {
  await acquireTestLock()
  const [r] = await sql`SELECT to_regclass('app_social.sync_state') IS NOT NULL AS ok`
  if (!r?.ok) {
    // This database has not registered the Social app: the columns the router reads.
    createdTable = true
    const [schema] = await sql`SELECT to_regnamespace('app_social') IS NOT NULL AS ok`
    createdSchema = !schema?.ok
    await sql`CREATE SCHEMA IF NOT EXISTS app_social`
    await sql`CREATE TABLE app_social.sync_state (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL,
      platform text NOT NULL,
      account_external_id text NOT NULL,
      source_type text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    )`
    // The privileged role the router reads and the factory writes as
    // (registration grants it on a real install).
    await sql`GRANT USAGE ON SCHEMA app_social TO liaison_admin`
    await sql`GRANT SELECT, INSERT ON app_social.sync_state TO liaison_admin`
  }
})

afterAll(async () => {
  if (createdSchema) await sql`DROP SCHEMA app_social CASCADE`
  else if (createdTable) await sql`DROP TABLE app_social.sync_state`
  else if (orgs.length)
    await sql`DELETE FROM app_social.sync_state WHERE org_id = ANY(${orgs}::uuid[])`
  if (orgs.length) {
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ANY(${orgs}::uuid[])`
    await sql`DELETE FROM kernel.users WHERE org_id = ANY(${orgs}::uuid[])`
    await sql`DELETE FROM kernel.organizations WHERE id = ANY(${orgs}::uuid[])`
  }
  await releaseTestLock()
})

describe("metaOrgsForPageIds", () => {
  test("a Page handed over: only the org whose account is still connected gets it", async () => {
    const before = await org("Previous holder")
    const now = await org("Current holder")
    // The previous holder still has the Page on its stored list, but its account is disconnected.
    await recorded(before, "fb-user-a", [PAGE], "disconnected")
    await recorded(now, "fb-user-b", [PAGE], "active")
    const owners = await metaOrgsForPageIds([PAGE])
    expect(owners.get(PAGE)).toEqual([now.id])
  })

  test("a rejected token or no connection row: no delivery", async () => {
    const page = `${PAGE}-x`
    const rejected = await org("Token rejected")
    const gone = await org("No connection")
    await recorded(rejected, "fb-user-c", [page], "error")
    await recorded(gone, "fb-user-d", [page], null)
    expect((await metaOrgsForPageIds([page])).get(page)).toBeUndefined()
  })
})
