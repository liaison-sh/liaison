// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4a-T09: a discoverable thread (a channel) is READABLE AS METADATA by any
// member of its org, so the opt-in join flow can list it. Its messages are not:
// messages_select stays participant-gated, and a non-member who lists a channel
// receives no message content (spec-home.md "Discoverable channels and read
// access").
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"

const ORG = crypto.randomUUID()
const MEMBER = crypto.randomUUID()
const OUTSIDER = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let CHANNEL = ""
let PRIVATE_THREAD = ""

function ctx(userId: string): UserContext {
  return { actorType: "user", userId, orgId: ORG, scopes: [], dimensionGrants: {} }
}

async function seedThread(handle: string, discoverable: boolean): Promise<string> {
  const [thread] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by, discoverable)
    VALUES (${ORG}, ${handle}, 'thread', ${MEMBER}, ${discoverable}) RETURNING id`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
    VALUES (${thread!.id}, ${MEMBER}, ${ORG})`
  await sql`INSERT INTO kernel.messages
    (thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${thread!.id}, ${ORG}, ${MEMBER}, 'user', ${`secret in ${handle}`}, '{}')`
  return thread!.id
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'P4a T09', ${`p4a-t09-${tag}`})`
  for (const [id, email] of [
    [MEMBER, `p4a-t09-member-${tag}@test.com`],
    [OUTSIDER, `p4a-t09-outsider-${tag}@test.com`],
  ]) {
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${id}, ${ORG}, ${email}, 'P4a', 'active', 'hash')`
  }
  CHANNEL = await seedThread(`p4a-t09-channel-${tag}`, true)
  PRIVATE_THREAD = await seedThread(`p4a-t09-private-${tag}`, false)
})

afterAll(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

function rowsFor(userId: string, query: ReturnType<typeof drizzleSql>) {
  return withRlsContext(ctx(userId), async (tx) => {
    const result = await tx.execute(query)
    return (result as unknown as { length: number }).length
  })
}

describe("discoverable threads are readable as metadata", () => {
  it("a non-member can select a discoverable thread's row metadata", async () => {
    const n = await rowsFor(
      OUTSIDER,
      drizzleSql`SELECT id, handle, title FROM kernel.threads WHERE id = ${CHANNEL}`,
    )
    expect(n).toBe(1)
  })

  it("a non-member cannot select messages in a discoverable thread they have not joined", async () => {
    const n = await rowsFor(
      OUTSIDER,
      drizzleSql`SELECT id FROM kernel.messages WHERE thread_id = ${CHANNEL}`,
    )
    expect(n).toBe(0)
  })

  it("a non-member cannot select a non-discoverable thread's row metadata", async () => {
    const n = await rowsFor(
      OUTSIDER,
      drizzleSql`SELECT id FROM kernel.threads WHERE id = ${PRIVATE_THREAD}`,
    )
    expect(n).toBe(0)
  })

  it("a member still reads their own non-discoverable thread", async () => {
    const n = await rowsFor(
      MEMBER,
      drizzleSql`SELECT id FROM kernel.threads WHERE id = ${PRIVATE_THREAD}`,
    )
    expect(n).toBe(1)
  })

  it("a member still reads the messages of a thread they belong to", async () => {
    const n = await rowsFor(
      MEMBER,
      drizzleSql`SELECT id FROM kernel.messages WHERE thread_id = ${CHANNEL}`,
    )
    expect(n).toBe(1)
  })
})
