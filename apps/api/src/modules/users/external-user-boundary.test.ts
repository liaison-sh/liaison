// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The database boundary around an external user (a client who signs in to the
// portal): on the member side a restrictive policy hides the row, on the portal
// side the role reaches kernel tables not at all. Everything runs through the
// real roles on the real request login; a privileged test sees past both.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient, sql } from "~/db"
import { type PortalClient, withPortalContext } from "~/db/portal-rls"
import { type UserContext, withRlsContext } from "~/db/rls"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG_ID = crypto.randomUUID()
const COMPANY_ID = crypto.randomUUID()
const EXTERNAL_ID = crypto.randomUUID()
const OTHER_EXTERNAL_ID = crypto.randomUUID()
const MEMBER_ID = crypto.randomUUID()
const ROLE_ID = crypto.randomUUID()

const member: UserContext = {
  actorType: "user",
  userId: MEMBER_ID,
  orgId: ORG_ID,
  scopes: [],
  dimensionGrants: {},
}
const portalAdmin: UserContext = { ...member, scopes: ["kernel:portal:admin"] }

function pgCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.cause?.code ?? e?.code ?? "unknown"
}

function pgMessage(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string } } | null
  return e?.cause?.message ?? e?.message ?? ""
}

/** The rows, or the error the statement raised, so the transaction goes on (a savepoint). */
async function outcome(savepoint: () => Promise<Record<string, unknown>[]>) {
  try {
    return { rows: await savepoint() }
  } catch (err) {
    return { code: pgCode(err), message: pgMessage(err) }
  }
}

const inRls = (tx: RlsClient, statement: string) =>
  outcome(() =>
    tx.transaction(async (sp) =>
      extractRows<Record<string, unknown>>(await sp.execute(drizzleSql.raw(statement))),
    ),
  )

const inPortal = (tx: PortalClient, statement: string) =>
  outcome(() =>
    tx.transaction(async (sp) =>
      extractRows<Record<string, unknown>>(await sp.execute(drizzleSql.raw(statement))),
    ),
  )

beforeAll(async () => {
  await sql.unsafe(
    insertSql("kernel.organizations", {
      id: ORG_ID,
      name: "External boundary",
      slug: `ext-boundary-${ORG_ID.slice(0, 8)}`,
    }),
  )
  await sql.unsafe(
    insertSql("kernel.users", {
      id: MEMBER_ID,
      org_id: ORG_ID,
      email: `member-${MEMBER_ID.slice(0, 8)}@example.com`,
      name: "Member",
    }),
  )
  for (const id of [EXTERNAL_ID, OTHER_EXTERNAL_ID]) {
    await sql.unsafe(
      insertSql("kernel.users", {
        id,
        org_id: ORG_ID,
        email: `client-${id.slice(0, 8)}@example.com`,
        name: "Client",
        user_type: "external",
        company_id: COMPANY_ID,
      }),
    )
  }
  await sql.unsafe(
    insertSql("kernel.roles", {
      id: ROLE_ID,
      org_id: ORG_ID,
      name: `plain-${ROLE_ID.slice(0, 8)}`,
    }),
  )
})

afterAll(async () => {
  await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("the portal role", () => {
  it("kernel.users, kernel.contacts and app_projects.tasks raise permission denied under the portal role", async () => {
    const results = await withPortalContext({ orgId: ORG_ID, userId: EXTERNAL_ID }, async (tx) => ({
      users: await inPortal(tx, "SELECT * FROM kernel.users LIMIT 1"),
      contacts: await inPortal(tx, "SELECT * FROM kernel.contacts LIMIT 1"),
      tasks: await inPortal(tx, "SELECT * FROM app_projects.tasks LIMIT 1"),
    }))
    // Rows returned here is a boundary failure, not a test to adjust.
    for (const result of Object.values(results)) {
      expect(result.code).toBe("42501")
      expect(result.rows).toBeUndefined()
    }
  })

  it("portal.me returns only the caller", async () => {
    const rows = await withPortalContext({ orgId: ORG_ID, userId: EXTERNAL_ID }, async (tx) =>
      extractRows<{ id: string }>(await tx.execute(drizzleSql`SELECT * FROM portal.me`)),
    )
    expect(rows.map((r) => r.id)).toEqual([EXTERNAL_ID])
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      ["company_id", "email", "id", "locale", "name", "timezone"].sort(),
    )
  })

  it("a member id in the context returns none", async () => {
    // withPortalContext refuses a member, so the role is entered by hand: the
    // view itself has to hold if a context ever carries a member's id.
    const rows = await withRlsContext(member, async (tx) => {
      await tx.execute(drizzleSql`SELECT set_config('role', 'liaison_portal', true)`)
      return extractRows<{ id: string }>(await tx.execute(drizzleSql`SELECT id FROM portal.me`))
    })
    expect(rows).toEqual([])
  })
})

describe("the member side of the boundary", () => {
  it("under liaison_rls a member reads no external row, a holder of the portal admin scope does", async () => {
    const read = (ctx: UserContext) =>
      withRlsContext(ctx, async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`SELECT id FROM kernel.users WHERE org_id = ${ORG_ID}`),
        ).map((r) => r.id),
      )
    expect(await read(member)).toEqual([MEMBER_ID])
    expect((await read(portalAdmin)).sort()).toEqual(
      [MEMBER_ID, EXTERNAL_ID, OTHER_EXTERNAL_ID].sort(),
    )
  })

  it("users_members_only keeps an index scan on users by id", async () => {
    const plan = await withRlsContext(member, async (tx) => {
      // On a small table the planner prefers a scan for its own reasons; with
      // scans priced out it still picks one only if the policy blocks the index.
      await tx.execute(drizzleSql`SELECT set_config('enable_seqscan', 'off', true)`)
      const rows = extractRows<{ "QUERY PLAN": string }>(
        await tx.execute(
          drizzleSql.raw(`EXPLAIN SELECT * FROM kernel.users WHERE id = '${MEMBER_ID}'`),
        ),
      )
      return rows.map((r) => r["QUERY PLAN"]).join("\n")
    })
    expect(plan).toContain("Index Scan using users_pkey")
    expect(plan).toContain("Index Cond: (id = ")
    expect(plan).not.toContain("Seq Scan")
  })

  it("as liaison_rls without the portal scope, inserting a role for an external user raises", async () => {
    const result = await withRlsContext(member, (tx) =>
      inRls(
        tx,
        insertSql(
          "kernel.user_roles",
          { user_id: EXTERNAL_ID, role_id: ROLE_ID, org_id: ORG_ID },
          { returning: "user_id" },
        ),
      ),
    )
    // The trigger's own words: the row is invisible to this role, so a trigger
    // that read it as the caller would let the insert through.
    expect(result.message).toContain("an external user holds no role")
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.user_roles WHERE user_id = ${EXTERNAL_ID}`
    expect(count?.n).toBe(0)
  })

  it("inserting a role for an external user raises on a privileged connection too", async () => {
    await expect(
      sql.unsafe(
        insertSql("kernel.user_roles", { user_id: EXTERNAL_ID, role_id: ROLE_ID, org_id: ORG_ID }),
      ),
    ).rejects.toThrow("an external user holds no role")
  })

  it("a role for a member still inserts", async () => {
    await withRlsContext(member, async (tx) => {
      await tx.execute(
        drizzleSql.raw(
          insertSql("kernel.user_roles", { user_id: MEMBER_ID, role_id: ROLE_ID, org_id: ORG_ID }),
        ),
      )
    })
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.user_roles WHERE user_id = ${MEMBER_ID}`
    expect(count?.n).toBe(1)
  })

  it("as liaison_rls, changing user_type raises", async () => {
    const result = await withRlsContext(member, (tx) =>
      inRls(
        tx,
        `UPDATE kernel.users SET user_type = 'external', company_id = '${COMPANY_ID}'
          WHERE id = '${MEMBER_ID}' RETURNING id`,
      ),
    )
    expect(result.message).toContain("user_type cannot change")
    const [row] = await sql<{ user_type: string }[]>`
      SELECT user_type FROM kernel.users WHERE id = ${MEMBER_ID}`
    expect(row?.user_type).toBe("member")
  })

  it("changing user_type raises on a privileged connection, and another column still updates", async () => {
    await expect(
      sql`UPDATE kernel.users SET user_type = 'member', company_id = NULL WHERE id = ${EXTERNAL_ID}`,
    ).rejects.toThrow("user_type cannot change")
    await sql`UPDATE kernel.users SET name = 'Client renamed' WHERE id = ${EXTERNAL_ID}`
    const [row] = await sql<
      { name: string }[]
    >`SELECT name FROM kernel.users WHERE id = ${EXTERNAL_ID}`
    expect(row?.name).toBe("Client renamed")
  })

  it("external with null company_id violates the check", async () => {
    const id = crypto.randomUUID()
    await expect(
      sql.unsafe(
        insertSql("kernel.users", {
          id,
          org_id: ORG_ID,
          email: `nocompany-${id.slice(0, 8)}@example.com`,
          name: "X",
          user_type: "external",
        }),
      ),
    ).rejects.toThrow("users_external_company_check")
  })

  it("a member with a company_id violates the check", async () => {
    const id = crypto.randomUUID()
    await expect(
      sql.unsafe(
        insertSql("kernel.users", {
          id,
          org_id: ORG_ID,
          email: `membercompany-${id.slice(0, 8)}@example.com`,
          name: "X",
          company_id: COMPANY_ID,
        }),
      ),
    ).rejects.toThrow("users_external_company_check")
  })
})
