// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"

/**
 * `kernel.scope_disclosure_policy` (S7, D4): an admin marks a scope
 * non-disclosable, per org, default disclosable.
 *
 * Every read and write below goes through `withRlsContext`, i.e. the app's
 * `liaison_rls` role with the real GUCs, never the privileged connection. The
 * privileged connection is used only to seed fixtures and to prove, from
 * outside the policy, that a denied write really landed nothing.
 */
describe("kernel.scope_disclosure_policy", () => {
  const ORG_A = crypto.randomUUID()
  const ORG_B = crypto.randomUUID()
  const A_ADMIN = crypto.randomUUID()
  const A_MEMBER = crypto.randomUUID()
  const B_MEMBER = crypto.randomUUID()
  const tag = ORG_A.slice(0, 8)

  const ADMIN_SCOPE = "kernel:agents:admin"
  const SCOPE_A = "finance:invoices:read"
  const SCOPE_B = "hr:salaries:read"

  const ctx = (userId: string, orgId: string, scopes: string[]): UserContext => ({
    actorType: "user",
    userId,
    orgId,
    scopes,
    dimensionGrants: {},
  })

  beforeAll(async () => {
    for (const [id, name, slug] of [
      [ORG_A, "DisclosureOrgA", `disclosure-a-${tag}`],
      [ORG_B, "DisclosureOrgB", `disclosure-b-${tag}`],
    ] as const) {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${id}, ${name}, ${slug})`
    }
    for (const [id, orgId, name] of [
      [A_ADMIN, ORG_A, "a-admin"],
      [A_MEMBER, ORG_A, "a-member"],
      [B_MEMBER, ORG_B, "b-member"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${orgId}, ${`disclosure-${name}-${tag}@test.com`}, ${name}, 'x')`
    }
    // One seeded row per org, written from outside RLS so the SELECT and
    // isolation cases do not depend on the write policy under test.
    await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope, disclosable)
      VALUES (${ORG_A}, ${SCOPE_A}, false)`
    await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope, disclosable)
      VALUES (${ORG_B}, ${SCOPE_B}, false)`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.scope_disclosure_policy WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
  })

  it("has the columns S7 names, with disclosable NOT NULL defaulting to true", async () => {
    const cols = extractRows<{
      column_name: string
      data_type: string
      is_nullable: string
      column_default: string | null
    }>(
      await db.execute(drizzleSql`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'kernel' AND table_name = 'scope_disclosure_policy'
      `),
    )
    const byName = new Map(cols.map((c) => [c.column_name, c]))

    expect([...byName.keys()].sort()).toEqual(
      ["disclosable", "id", "org_id", "scope", "updated_at"].sort(),
    )

    expect(byName.get("id")?.data_type).toBe("uuid")
    expect(byName.get("id")?.is_nullable).toBe("NO")
    expect(byName.get("id")?.column_default).toContain("gen_random_uuid")

    expect(byName.get("org_id")?.data_type).toBe("uuid")
    expect(byName.get("org_id")?.is_nullable).toBe("NO")

    expect(byName.get("scope")?.data_type).toBe("text")
    expect(byName.get("scope")?.is_nullable).toBe("NO")

    expect(byName.get("disclosable")?.data_type).toBe("boolean")
    expect(byName.get("disclosable")?.is_nullable).toBe("NO")
    expect(byName.get("disclosable")?.column_default).toBe("true")

    expect(byName.get("updated_at")?.is_nullable).toBe("NO")
    expect(byName.get("updated_at")?.column_default).toContain("now()")
  })

  it("is unique per org and scope", async () => {
    const idx = extractRows<{ indexdef: string }>(
      await db.execute(drizzleSql`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'kernel' AND tablename = 'scope_disclosure_policy'
      `),
    )
    const unique = idx.filter(
      (i) =>
        i.indexdef.includes("UNIQUE") &&
        i.indexdef.includes("org_id") &&
        i.indexdef.includes("scope") &&
        !i.indexdef.includes("(id)"),
    )
    expect(unique.length).toBe(1)

    let duplicated = false
    try {
      await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope) VALUES (${ORG_A}, ${SCOPE_A})`
      duplicated = true
    } catch {
      duplicated = false
    }
    expect(duplicated).toBe(false)
  })

  it("has RLS enabled and forced", async () => {
    const rls = extractRows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      await db.execute(drizzleSql`
        SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'kernel' AND c.relname = 'scope_disclosure_policy'
      `),
    )
    expect(rls.length).toBe(1)
    expect(rls[0].relrowsecurity).toBe(true)
    expect(rls[0].relforcerowsecurity).toBe(true)
  })

  it("any org member can select scope_disclosure_policy rows", async () => {
    const rows = await withRlsContext(ctx(A_MEMBER, ORG_A, []), async (tx) =>
      extractRows<{ scope: string }>(
        await tx.execute(
          drizzleSql`SELECT scope FROM kernel.scope_disclosure_policy WHERE org_id = ${ORG_A}`,
        ),
      ),
    )
    expect(rows.map((r) => r.scope)).toContain(SCOPE_A)
  })

  it("an org never sees another org's rows", async () => {
    const seenByA = await withRlsContext(ctx(A_MEMBER, ORG_A, ["*"]), async (tx) =>
      extractRows<{ scope: string }>(
        await tx.execute(drizzleSql`SELECT scope FROM kernel.scope_disclosure_policy`),
      ),
    )
    expect(seenByA.map((r) => r.scope)).not.toContain(SCOPE_B)

    const seenByB = await withRlsContext(ctx(B_MEMBER, ORG_B, ["*"]), async (tx) =>
      extractRows<{ scope: string }>(
        await tx.execute(drizzleSql`SELECT scope FROM kernel.scope_disclosure_policy`),
      ),
    )
    expect(seenByB.map((r) => r.scope)).toEqual([SCOPE_B])
  })

  it("a member without kernel:agents:admin cannot insert a scope_disclosure_policy row", async () => {
    const scope = `denied:${tag}`
    let failed = false
    try {
      await withRlsContext(ctx(A_MEMBER, ORG_A, ["finance:invoices:read"]), (tx) =>
        tx.execute(
          drizzleSql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope, disclosable)
            VALUES (${ORG_A}, ${scope}, false)`,
        ),
      )
    } catch {
      failed = true
    }
    expect(failed).toBe(true)

    // Nothing landed, seen from outside the policy.
    const landed = extractRows<{ scope: string }>(
      await db.execute(
        drizzleSql`SELECT scope FROM kernel.scope_disclosure_policy WHERE scope = ${scope}`,
      ),
    )
    expect(landed).toEqual([])
  })

  it("a new row inserted by an admin is disclosable by default", async () => {
    const scope = `default:${tag}`
    const inserted = await withRlsContext(ctx(A_ADMIN, ORG_A, [ADMIN_SCOPE]), async (tx) =>
      extractRows<{ disclosable: boolean }>(
        await tx.execute(
          drizzleSql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope)
            VALUES (${ORG_A}, ${scope}) RETURNING disclosable`,
        ),
      ),
    )
    expect(inserted.length).toBe(1)
    expect(inserted[0].disclosable).toBe(true)
  })

  it("an admin can mark a scope non-disclosable, a non-admin cannot", async () => {
    const scope = `tighten:${tag}`
    await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope) VALUES (${ORG_A}, ${scope})`

    // A non-admin's UPDATE matches no row under the policy: 0 rows, value intact.
    const byMember = await withRlsContext(
      ctx(A_MEMBER, ORG_A, ["finance:invoices:read"]),
      async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(
            drizzleSql`UPDATE kernel.scope_disclosure_policy SET disclosable = false
            WHERE org_id = ${ORG_A} AND scope = ${scope} RETURNING id`,
          ),
        ),
    )
    expect(byMember).toEqual([])

    const stillOpen = extractRows<{ disclosable: boolean }>(
      await db.execute(
        drizzleSql`SELECT disclosable FROM kernel.scope_disclosure_policy WHERE scope = ${scope}`,
      ),
    )
    expect(stillOpen[0].disclosable).toBe(true)

    const byAdmin = await withRlsContext(ctx(A_ADMIN, ORG_A, [ADMIN_SCOPE]), async (tx) =>
      extractRows<{ disclosable: boolean }>(
        await tx.execute(
          drizzleSql`UPDATE kernel.scope_disclosure_policy SET disclosable = false
            WHERE org_id = ${ORG_A} AND scope = ${scope} RETURNING disclosable`,
        ),
      ),
    )
    expect(byAdmin.length).toBe(1)
    expect(byAdmin[0].disclosable).toBe(false)
  })

  it("an admin of one org cannot write another org's row", async () => {
    let failed = false
    try {
      await withRlsContext(ctx(A_ADMIN, ORG_A, [ADMIN_SCOPE]), (tx) =>
        tx.execute(
          drizzleSql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope, disclosable)
            VALUES (${ORG_B}, ${`cross:${tag}`}, false)`,
        ),
      )
    } catch {
      failed = true
    }
    expect(failed).toBe(true)

    const updated = await withRlsContext(ctx(A_ADMIN, ORG_A, [ADMIN_SCOPE]), async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`UPDATE kernel.scope_disclosure_policy SET disclosable = true
            WHERE scope = ${SCOPE_B} RETURNING id`,
        ),
      ),
    )
    expect(updated).toEqual([])
  })

  it("has no DELETE policy, so a tightened row cannot be dropped to loosen it", async () => {
    const policies = extractRows<{ policyname: string; cmd: string }>(
      await db.execute(drizzleSql`
        SELECT policyname, cmd FROM pg_policies
        WHERE schemaname = 'kernel' AND tablename = 'scope_disclosure_policy'
      `),
    )
    expect(policies.filter((p) => p.cmd === "DELETE")).toEqual([])

    // Even an admin: deleting the row would silently restore the default
    // `disclosable = true`, which is exactly the loosening S7 forbids.
    const deleted = await withRlsContext(ctx(A_ADMIN, ORG_A, [ADMIN_SCOPE]), async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`DELETE FROM kernel.scope_disclosure_policy
            WHERE org_id = ${ORG_A} AND scope = ${SCOPE_A} RETURNING id`,
        ),
      ),
    )
    expect(deleted).toEqual([])

    const survivor = extractRows<{ disclosable: boolean }>(
      await db.execute(
        drizzleSql`SELECT disclosable FROM kernel.scope_disclosure_policy
          WHERE org_id = ${ORG_A} AND scope = ${SCOPE_A}`,
      ),
    )
    expect(survivor[0].disclosable).toBe(false)
  })
})
