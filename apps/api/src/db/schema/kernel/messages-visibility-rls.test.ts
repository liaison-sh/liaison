// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { generateRequiredScopesVisibilityClause } from "~/modules/permissions/rls-generator"

/**
 * The messages SELECT policy enforces read-time visibility in the database:
 * room membership AND (the viewer holds every required scope OR is on the
 * disclosure list). Every read below goes through `withRlsContext`, i.e. the
 * app's `liaison_rls` role with the real GUCs, never a superuser.
 */
describe("kernel.messages SELECT policy: requiredScopes visibility", () => {
  const ORG_ID = crypto.randomUUID()
  const THREAD_ID = crypto.randomUUID()
  const HOLDER = crypto.randomUUID() // member, holds the scope
  const LACKER = crypto.randomUUID() // member, lacks the scope
  const DISCLOSED = crypto.randomUUID() // member, lacks the scope, on the disclosure list
  const OUTSIDER = crypto.randomUUID() // same org, not a member
  const tag = ORG_ID.slice(0, 8)

  const SCOPE = "crm:deals:read"
  let scopedId = ""
  let disclosedId = ""
  let openId = ""

  const ctx = (userId: string, scopes: string[]): UserContext => ({
    actorType: "user",
    userId,
    orgId: ORG_ID,
    scopes,
    dimensionGrants: {},
  })

  async function visibleIds(userId: string, scopes: string[]): Promise<string[]> {
    return withRlsContext(ctx(userId, scopes), async (tx) => {
      const rows = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`SELECT id FROM kernel.messages WHERE thread_id = ${THREAD_ID} ORDER BY created_at`,
        ),
      )
      return rows.map((r) => r.id)
    })
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'MsgVisRlsOrg', ${`msg-vis-rls-${tag}`})`
    for (const [id, name] of [
      [HOLDER, "holder"],
      [LACKER, "lacker"],
      [DISCLOSED, "disclosed"],
      [OUTSIDER, "outsider"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG_ID}, ${`msg-vis-${name}-${tag}@test.com`}, ${name}, 'x')`
    }
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${`msg-vis-rls-${tag}`}, ${HOLDER})`
    for (const userId of [HOLDER, LACKER, DISCLOSED]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${THREAD_ID}, ${userId}, ${ORG_ID})`
    }
    const [scoped] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${HOLDER}, 'scoped', ARRAY[${SCOPE}]::text[])
      RETURNING id`
    const [disclosed] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, disclosure_list)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${HOLDER}, 'disclosed', ARRAY[${SCOPE}]::text[], ARRAY[${DISCLOSED}]::uuid[])
      RETURNING id`
    const [open] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${HOLDER}, 'open', '{}')
      RETURNING id`
    scopedId = scoped?.id ?? ""
    disclosedId = disclosed?.id ?? ""
    openId = open?.id ?? ""
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("a member who holds the requiredScopes can SELECT it", async () => {
    const ids = await visibleIds(HOLDER, [SCOPE])
    expect(ids).toContain(scopedId)
    expect(ids).toContain(disclosedId)
    // A covering wildcard grant counts the same way hasScope does.
    expect(await visibleIds(HOLDER, ["crm:*"])).toContain(scopedId)
  })

  it("a member who lacks a message's requiredScopes and is not in its disclosureList cannot SELECT it", async () => {
    const ids = await visibleIds(LACKER, ["tickets:read"])
    expect(ids).not.toContain(scopedId)
    expect(ids).not.toContain(disclosedId)
    // No grants at all (the __none__ sentinel) is refused the same way.
    expect(await visibleIds(LACKER, [])).not.toContain(scopedId)
  })

  it("a member in the disclosureList but lacking the scope can still SELECT it", async () => {
    const ids = await visibleIds(DISCLOSED, [])
    expect(ids).toContain(disclosedId)
    expect(ids).not.toContain(scopedId)
  })

  it("a message with empty requiredScopes is visible to every member", async () => {
    expect(await visibleIds(HOLDER, [SCOPE])).toContain(openId)
    expect(await visibleIds(LACKER, ["tickets:read"])).toContain(openId)
    expect(await visibleIds(DISCLOSED, [])).toContain(openId)
  })

  it("a non-member sees nothing, even with every scope", async () => {
    expect(await visibleIds(OUTSIDER, ["*"])).toEqual([])
    expect(await visibleIds(OUTSIDER, [SCOPE])).toEqual([])
  })

  it("the privileged connection still reads every row", async () => {
    const rows = extractRows<{ id: string }>(
      await db.execute(drizzleSql`SELECT id FROM kernel.messages WHERE thread_id = ${THREAD_ID}`),
    )
    expect(rows.map((r) => r.id).sort()).toEqual([scopedId, disclosedId, openId].sort())
  })

  it("the migration embeds the generator's visibility clause verbatim", () => {
    const migration = readFileSync(
      join(import.meta.dir, "../../migrations/0060_messages_select_required_scopes.sql"),
      "utf8",
    )
    // 0060 predates the rls_ctx readers (0184-0186 rewrote the installed
    // policy to them), so it reads the variables directly.
    const clause = generateRequiredScopesVisibilityClause({
      requiredScopesColumn: "required_scopes",
      disclosureListColumn: "disclosure_list",
    })
      .replaceAll("rls_ctx.scopes()", "current_setting('app.current_scopes', true)")
      .replaceAll("rls_ctx.user_id()", "current_setting('app.current_user_id', true)")
    expect(migration).toContain(clause)
  })
})
