// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S17 against a REAL row.
//
// The unit tests next door hand `buildPushPayload` a literal. This one writes a
// message through the product's own insert path (`sendMessage`), reads the row
// back out of `kernel.messages` with its real `required_scopes` column, and
// builds the payload from THAT. The difference matters: a column that came back
// as a string, a null, or a Postgres array in some other shape is exactly the
// input the literal never exercises, and "no content field" has to hold for the
// row the database actually stores.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { and, eq } from "drizzle-orm"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { messages, threads, users } from "~/db/schema/kernel"
import { buildPushPayload } from "~/modules/push/redact"
import { sendMessage } from "~/modules/threads/message"

const rlsDb = db as unknown as RlsClient
// sendMessage queues its event on the transaction; the outbox is not this
// test's subject, so the queue is a sink.
const originalTransaction = (rlsDb as { transaction: (fn: unknown) => unknown }).transaction.bind(
  rlsDb,
)
;(rlsDb as unknown as { transaction: unknown }).transaction = async (
  fn: (tx: unknown) => unknown,
) =>
  originalTransaction(async (tx: { queueEvent?: unknown }) => {
    tx.queueEvent = async () => {}
    return fn(tx)
  })

const ORG = "00000000-0000-0000-0000-0000000007b0"
const AUTHOR = "00000000-0000-0000-0000-0000000007b1"
const SCOPE = "pennylane:payouts:read"
const SECRET = "the payout run cleared, 41200 EUR to Acme"
let threadId = ""

describe("S17: a real scope-tagged message row produces a content-free payload", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'PushRedactOrg', 'push-redact-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${AUTHOR}, ${ORG}, 'push-redact@t.com', 'Alice', 'x') ON CONFLICT (id) DO NOTHING`
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, 'push-redact-thread', 'finance', ${AUTHOR}) RETURNING id`
    threadId = t.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${threadId}, ${AUTHOR}, ${ORG})`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.threads WHERE id = ${threadId}`
    await sql`DELETE FROM kernel.users WHERE id = ${AUTHOR}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  async function payloadForRealRow(requiredScopes: string[], content: string) {
    const sent = await sendMessage(rlsDb, {
      requiredScopes,
      orgId: ORG,
      userId: AUTHOR,
      threadId,
      content,
    })
    expect(sent?.id).toBeDefined()
    const [row] = await db
      .select({
        id: messages.id,
        threadId: messages.threadId,
        requiredScopes: messages.requiredScopes,
        content: messages.content,
        authorId: messages.authorId,
      })
      .from(messages)
      .where(and(eq(messages.id, sent?.id as string), eq(messages.orgId, ORG)))
    const [author] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, row.authorId))
    const [thread] = await db
      .select({ title: threads.title })
      .from(threads)
      .where(eq(threads.id, row.threadId))
    return buildPushPayload(
      {
        id: row.id,
        threadId: row.threadId,
        requiredScopes: row.requiredScopes,
        content: row.content,
        authorName: author?.name ?? "Unknown",
        threadTitle: thread?.title ?? null,
      },
      "mention",
      2,
    )
  }

  it("carries no content key at any depth for a tagged row", async () => {
    const payload = await payloadForRealRow([SCOPE], SECRET)
    // Structural: the key is absent, not empty.
    expect("content" in payload).toBe(false)
    expect("body" in payload).toBe(false)
    expect("title" in payload).toBe(false)
    // Textual: a renamed or nested leak is caught even if the key check is not.
    const serialized = JSON.stringify(payload)
    expect(serialized.includes("content")).toBe(false)
    expect(serialized.includes(SECRET)).toBe(false)
    expect(serialized.includes("payout")).toBe(false)
    expect(serialized.includes(SCOPE)).toBe(false)
    expect(serialized.includes("Alice")).toBe(false)
    expect(payload.deepLink).toBe(`liaison://thread/${threadId}`)
    expect(payload.badgeCount).toBe(2)
  })

  it("still carries the text for an untagged row written the same way", async () => {
    const payload = await payloadForRealRow([], "standup at ten")
    expect(payload.body).toBe("standup at ten")
    expect(payload.title).toBe("finance")
  })
})
