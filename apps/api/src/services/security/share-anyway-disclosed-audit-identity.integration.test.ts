// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A "Share anyway" disclosure persists the rerun's answer into the room. Each
// disclosed message's own durable audit row must NAME THE ACTING AGENT (A11),
// exactly as the `share_anyway` row does (T19): the disclosure holds the agent
// id, so a row that says an agent acted and names none is an assertion with
// nothing behind it.
//
// The identity rides the create event (T32) and both audit consumers persist
// it, so this drives the real outbox: shareAnyway, then the durable audit
// consumer, then `kernel.audit_log` read back for the returned message ids.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { type ShareAnywayRerun, shareAnyway } from "~/services/security/share-anyway"

const A = "shaudit:a:read"
const CEILING = [A]

describe("Share anyway: the disclosed message's audit row names the acting agent", () => {
  const ORG_ID = crypto.randomUUID()
  const THREAD_ID = crypto.randomUUID()
  // The requester's personal agent: the acting agent of the withheld turn.
  const AGENT_ID = crypto.randomUUID()
  const REQUESTER = crypto.randomUUID()
  const LACKER = crypto.randomUUID()
  const tag = ORG_ID.slice(0, 8)
  let turnId = ""

  const ctx = (userId: string, scopes: string[]): UserContext => ({
    actorType: "user",
    userId,
    orgId: ORG_ID,
    scopes,
    dimensionGrants: {},
  })

  const rerun: ShareAnywayRerun = async () => [
    { content: "the disclosed answer", requiredScopes: [A], agentAuthorLabel: "Requester's agent" },
  ]

  /** Drain the transactional outbox so the durable audit consumer has run. */
  async function drainOutbox(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await processOutboxBatch()
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  beforeAll(async () => {
    resetEventBus()
    initEventBus()
    DurableConsumersTestAccess.reset()
    // Real audit + timeline consumers; WS fan-out stubbed (no manager here).
    registerEventSubscribers({
      bufferAndBroadcast: async () => {},
      broadcast: async () => {},
    } as never)

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'ShareAnywayAuditOrg', ${`share-anyway-audit-${tag}`})`
    for (const [id, name] of [
      [REQUESTER, "requester"],
      [LACKER, "lacker"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG_ID}, ${`share-anyway-audit-${name}-${tag}@test.com`}, ${name}, 'x')`
    }
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${REQUESTER}, ${ORG_ID}, ${A})`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', ${`@share-anyway-audit-${tag}`}, 'Share anyway agent',
        ${REQUESTER}, ${JSON.stringify(CEILING)}::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${`share-anyway-audit-${tag}`}, 'thread', ${REQUESTER})`
    for (const userId of [REQUESTER, LACKER]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${THREAD_ID}, ${userId}, ${ORG_ID})`
    }
    const [turn] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${REQUESTER}, 'user', '@agent show the deal', '{}')
      RETURNING id`
    turnId = turn?.id ?? ""
  })

  afterAll(async () => {
    resetEventBus()
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG_ID}`.catch(() => {})
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("every disclosed message audits with the acting agent, not as an agent nobody names", async () => {
    const { messageIds } = await shareAnyway(
      ctx(REQUESTER, [A]),
      { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: AGENT_ID },
      { rerun },
    )
    expect(messageIds).toHaveLength(1)
    await drainOutbox()

    const rows = await sql<{ entity_id: string; actor_type: string; agent_id: string | null }[]>`
      SELECT entity_id, actor_type, agent_id
        FROM kernel.audit_log
       WHERE org_id = ${ORG_ID}
         AND action = 'message.create'
         AND entity_id = ANY(${messageIds}::text[])`
    expect(rows).toHaveLength(messageIds.length)
    for (const row of rows) {
      // T32 files the disclosed reply as an AGENT action; the agent it names
      // must be the one that acted, never null.
      expect(row.actor_type).toBe("agent")
      expect(row.agent_id).toBe(AGENT_ID)
    }
  })

  it("the disclosure's own share_anyway row and its messages name the same agent", async () => {
    const { messageIds } = await shareAnyway(
      ctx(REQUESTER, [A]),
      { turnId, requesterId: REQUESTER, roomId: THREAD_ID, agentId: AGENT_ID },
      { rerun },
    )
    await drainOutbox()

    const [share] = await sql<{ agent_id: string | null }[]>`
      SELECT agent_id FROM kernel.audit_log
       WHERE org_id = ${ORG_ID} AND action = 'share_anyway'
       ORDER BY timestamp DESC, id DESC LIMIT 1`
    const messageRows = await sql<{ agent_id: string | null }[]>`
      SELECT agent_id FROM kernel.audit_log
       WHERE org_id = ${ORG_ID}
         AND action = 'message.create'
         AND entity_id = ANY(${messageIds}::text[])`
    // One disclosure, one agent: the two halves of the trail agree, so an
    // audit search by agent id returns the whole disclosure or none of it.
    expect(share?.agent_id).toBe(AGENT_ID)
    expect(messageRows.map((r) => r.agent_id)).toEqual(messageIds.map(() => AGENT_ID))
  })
})
