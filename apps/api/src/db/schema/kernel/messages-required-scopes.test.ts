// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"

/**
 * kernel.messages carries the two columns the read-time visibility predicate
 * is defined over: `required_scopes` (NOT NULL with NO default, since 0066)
 * and `disclosure_list` (nullable, default null).
 *
 * 0059 gave required_scopes a `'{}'` default so ADD COLUMN could fill the
 * existing rows. That default also quietly completed any INSERT that left the
 * column out, which is exactly an untagged write: the empty set is satisfied
 * by every member, so whatever the message quoted went to the whole room.
 * 0066 drops it, so omitting the column now raises 23502 and every writer has
 * to say what the row may quote.
 */
describe("kernel.messages visibility columns", () => {
  const ORG_ID = crypto.randomUUID()
  const USER_ID = crypto.randomUUID()
  const THREAD_ID = crypto.randomUUID()
  const tag = ORG_ID.slice(0, 8)

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'MsgScopesOrg', ${`msg-scopes-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_ID}, ${ORG_ID}, ${`msg-scopes-${tag}@test.com`}, 'Msg Scopes User', 'x')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${`msg-scopes-${tag}`}, ${USER_ID})`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("an insert that omits requiredScopes is refused, so nothing lands untagged", async () => {
    // The enforcement FX2 exists for: with no default behind it, NOT NULL has
    // nothing to fall back on and the write fails instead of publishing.
    // The query is awaited inside an async function: postgres.js queries are lazy
    // and only run on `.then()`, which `expect(query).rejects` never calls.
    await expect(
      (async () => {
        await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, content)
          VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'no scopes given')`
      })(),
    ).rejects.toThrow(/null value in column "required_scopes"/)

    // NOT NULL is a schema guarantee, not just a default: an explicit null is refused too.
    await expect(
      (async () => {
        await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
          VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'explicit null', NULL)`
      })(),
    ).rejects.toThrow(/null value in column "required_scopes"/)
  })

  it("a named tag lands exactly as given, and the empty set stays available", async () => {
    const [tagged] = await sql<{ required_scopes: string[] }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'tagged', ARRAY['crm:deals:read']::text[])
      RETURNING required_scopes
    `
    expect(tagged?.required_scopes).toEqual(["crm:deals:read"])

    // `[]` stays expressible: it is the positive assertion "this carries no
    // scoped data", which a human post or a fixed system notice still makes.
    const [open] = await sql<{ required_scopes: string[] }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'carries nothing scoped', '{}'::text[])
      RETURNING required_scopes
    `
    expect(open?.required_scopes).toEqual([])
  })

  it("messages.disclosureList is nullable and defaults to null", async () => {
    const [row] = await sql<{ disclosure_list: string[] | null }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'no disclosure given', '{}'::text[])
      RETURNING disclosure_list
    `
    expect(row?.disclosure_list).toBeNull()

    // A set value round-trips as a uuid array.
    const [set] = await sql<{ disclosure_list: string[] | null }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, disclosure_list)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'disclosed', '{}'::text[], ARRAY[${USER_ID}]::uuid[])
      RETURNING disclosure_list
    `
    expect(set?.disclosure_list).toEqual([USER_ID])
  })
})
