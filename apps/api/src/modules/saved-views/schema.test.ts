// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"

const ORG = "00000000-0000-0000-0000-0000000009a1"
const USER = "00000000-0000-0000-0000-0000000009a2"

beforeAll(async () => {
  await sql`DELETE FROM kernel.saved_views WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE id = ${USER}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await sql`INSERT INTO kernel.organizations(id, name, slug)
    VALUES (${ORG}, 'sv-org', 'sv-org')`
  await sql`INSERT INTO kernel.users(id, org_id, email, name, status)
    VALUES (${USER}, ${ORG}, 'sv@test', 'sv', 'active')`
})

afterEach(async () => {
  await sql`DELETE FROM kernel.saved_views WHERE org_id = ${ORG}`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.saved_views WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE id = ${USER}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

async function tryInsert(query: () => Promise<unknown>): Promise<{ ok: boolean; message: string }> {
  try {
    await query()
    return { ok: true, message: "" }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

describe("kernel.saved_views schema", () => {
  it("rejects rows with owner_user_id=NULL when not (is_default AND shared_with_org)", async () => {
    const r = await tryInsert(
      () =>
        sql`INSERT INTO kernel.saved_views(org_id, app, view_id, name, payload, owner_user_id, shared_with_org, is_default)
          VALUES (${ORG}, 'tickets', 'inbox', 'x', '{}'::jsonb, NULL, false, false)`,
    )
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/chk_owner_or_default/)
  })

  it("accepts manifest defaults (NULL owner, shared, is_default)", async () => {
    const inserted = await sql`
      INSERT INTO kernel.saved_views(org_id, app, view_id, manifest_key, name, payload, owner_user_id, shared_with_org, is_default)
      VALUES (${ORG}, 'tickets', 'inbox', 'my-open', 'My open', '{"smartFilter":"needs-attention"}'::jsonb, NULL, true, true)
      RETURNING id`
    expect(inserted[0]?.id).toBeTruthy()
  })

  it("enforces unique (org, app, view_id, manifest_key) for is_default rows", async () => {
    await sql`INSERT INTO kernel.saved_views(org_id, app, view_id, manifest_key, name, payload, owner_user_id, shared_with_org, is_default)
      VALUES (${ORG}, 'tickets', 'inbox', 'dup', 'Dup', '{}'::jsonb, NULL, true, true)`
    const r = await tryInsert(
      () =>
        sql`INSERT INTO kernel.saved_views(org_id, app, view_id, manifest_key, name, payload, owner_user_id, shared_with_org, is_default)
          VALUES (${ORG}, 'tickets', 'inbox', 'dup', 'Dup2', '{}'::jsonb, NULL, true, true)`,
    )
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/unique|duplicate/i)
  })

  it("approval_requests.metadata defaults to empty object", async () => {
    const rows = await sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'kernel' AND table_name = 'approval_requests' AND column_name = 'metadata'`
    expect(rows[0]?.column_default).toContain("'{}'")
  })

  it("requires saved-view share scope before inserting or updating shared rows through RLS", async () => {
    const baseCtx = {
      actorType: "user" as const,
      userId: USER,
      orgId: ORG,
      scopes: [],
      dimensionGrants: {},
    }

    const inserted = await withRlsContext(
      { ...baseCtx, scopes: ["kernel:saved_views:share"] },
      async (tx) => {
        const [row] = await tx.execute(
          drizzleSql`INSERT INTO kernel.saved_views(org_id, app, view_id, name, payload, owner_user_id, shared_with_org)
          VALUES (${ORG}, 'tickets', 'inbox', 'shared', '{}'::jsonb, ${USER}, true)
          RETURNING id`,
        )
        return row as { id: string }
      },
    )

    const insertWithoutShare = await tryInsert(() =>
      withRlsContext(baseCtx, async (tx) => {
        await tx.execute(
          drizzleSql`INSERT INTO kernel.saved_views(org_id, app, view_id, name, payload, owner_user_id, shared_with_org)
            VALUES (${ORG}, 'tickets', 'inbox', 'denied', '{}'::jsonb, ${USER}, true)`,
        )
      }),
    )
    expect(insertWithoutShare.ok).toBe(false)

    await sql`UPDATE kernel.saved_views SET shared_with_org = false WHERE id = ${inserted.id}`

    const updateWithoutShare = await tryInsert(() =>
      withRlsContext(baseCtx, async (tx) => {
        await tx.execute(
          drizzleSql`UPDATE kernel.saved_views SET shared_with_org = true WHERE id = ${inserted.id}`,
        )
      }),
    )
    expect(updateWithoutShare.ok).toBe(false)
  })
})
