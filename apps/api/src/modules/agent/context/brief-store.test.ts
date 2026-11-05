// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T49: the brief as rows.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import {
  advanceMark,
  getEpisode,
  openLoopWithClosure,
  regionPastMark,
  renderCore,
  upsertBriefRows,
} from "~/modules/agent/context/brief-store"
import { BRIEF_CORE_TOKEN_BUDGET } from "~/modules/agent/context/cold-resume"
import { estimateTokens } from "~/modules/agent/context/compaction"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "49000000-0000-4000-8000-000000000001"
const USER_ID = "49000000-0000-4000-8000-000000000002"
/** Seated from the start of the thread. */
const AGENT_EARLY = "49000000-0000-4000-8000-000000000003"
/** Seated halfway in: everything before its seat is none of its business. */
const AGENT_LATE = "49000000-0000-4000-8000-000000000004"
const THREAD = "49000000-0000-4000-8000-000000000005"
const OTHER_THREAD = "49000000-0000-4000-8000-000000000006"

/** Message ids, in thread order, for both threads. */
let ids: string[] = []
let otherIds: string[] = []

function at(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60_000).toISOString()
}

async function seedMessages(threadId: string, count: number, offset = 0): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID()
    out.push(id)
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, created_at, required_scopes)
      VALUES (${id}, ${threadId}, ${ORG_ID}, ${USER_ID}, 'user', ${`Message ${offset + i}`}, ${at(offset + i)}, '{}')`
  }
  return out
}

/** Every brief row of one key, in the order the store decided. */
async function chainFor(key: string): Promise<
  Array<{
    id: string
    value: string
    status: string
    superseded_by: string | null
    closing_message_id: string | null
  }>
> {
  return (await sql`
    SELECT b.id, b.value, b.status, b.superseded_by, b.closing_message_id
    FROM kernel.thread_briefs b
    JOIN kernel.messages m ON m.id = b.first_message_id
    WHERE b.thread_id = ${THREAD} AND b.key = ${key}
    ORDER BY m.created_at ASC, m.id ASC`) as unknown as Array<{
    id: string
    value: string
    status: string
    superseded_by: string | null
    closing_message_id: string | null
  }>
}

describe("P4c-T49 the brief as rows", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'BriefOrg', 'brief-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'brief@test.com', 'Brief')`
    for (const [id, handle] of [
      [AGENT_EARLY, "@brief-early"],
      [AGENT_LATE, "@brief-late"],
    ] as const) {
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling, system_prompt)
        VALUES (${id}, ${ORG_ID}, 'personal', ${handle}, 'Brief', ${USER_ID}, '["*"]'::jsonb, 'You help.')`
    }
    for (const [tid, handle] of [
      [THREAD, "brief-main"],
      [OTHER_THREAD, "brief-other"],
    ] as const) {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${tid}, ${ORG_ID}, ${handle}, 'agent_chat', ${USER_ID})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${tid}, ${USER_ID}, ${ORG_ID})`
    }
    ids = await seedMessages(THREAD, 14)
    otherIds = await seedMessages(OTHER_THREAD, 3, 100)
    // The early agent sat down before the thread's first message, the late one
    // just before message index 8.
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type, created_at)
      VALUES (${THREAD}, ${AGENT_EARLY}, ${ORG_ID}, 'agent', ${at(-1)})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type, created_at)
      VALUES (${THREAD}, ${AGENT_LATE}, ${ORG_ID}, 'agent', ${at(7.5)})`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${ORG_ID})`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_briefs WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_episodes WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_brief_marks WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("a decision that changes is one current row and one superseded row linked to it", async () => {
    await withPrivilegedDb(ORG_ID, "test", (tx) =>
      upsertBriefRows(tx, {
        orgId: ORG_ID,
        threadId: THREAD,
        agentId: AGENT_EARLY,
        rows: [
          {
            kind: "decision",
            key: "carrier for order 1042",
            value: "DHL",
            messageIds: [ids[0]],
          },
        ],
      }),
    )
    await withPrivilegedDb(ORG_ID, "test", (tx) =>
      upsertBriefRows(tx, {
        orgId: ORG_ID,
        threadId: THREAD,
        agentId: AGENT_EARLY,
        rows: [
          {
            kind: "decision",
            key: "carrier for order 1042",
            value: "UPS",
            messageIds: [ids[2]],
          },
        ],
      }),
    )
    const chain = await chainFor("carrier for order 1042")
    expect(chain.map((r) => `${r.value}:${r.status}`)).toEqual(["DHL:superseded", "UPS:current"])
    expect(chain[0].superseded_by).toBe(chain[1].id)
    expect(chain[1].superseded_by).toBeNull()
  })

  it("an open loop whose closure is planted becomes closed with the closing message id", async () => {
    await withPrivilegedDb(ORG_ID, "test", (tx) =>
      upsertBriefRows(tx, {
        orgId: ORG_ID,
        threadId: THREAD,
        agentId: AGENT_EARLY,
        rows: [
          {
            kind: "open_loop",
            key: "ship date for order 1042",
            value: "still owed to the customer",
            messageIds: [ids[1]],
          },
        ],
      }),
    )
    let chain = await chainFor("ship date for order 1042")
    expect(chain.map((r) => r.status)).toEqual(["current"])

    await withPrivilegedDb(ORG_ID, "test", (tx) =>
      upsertBriefRows(tx, {
        orgId: ORG_ID,
        threadId: THREAD,
        agentId: AGENT_EARLY,
        rows: [
          {
            kind: "open_loop",
            key: "ship date for order 1042",
            value: "given as the 14th",
            messageIds: [ids[3]],
            closes: true,
            closingMessageId: ids[3],
          },
        ],
      }),
    )
    chain = await chainFor("ship date for order 1042")
    expect(chain.map((r) => r.status)).toEqual(["closed", "closed"])
    expect(chain[0].closing_message_id).toBe(ids[3])
    expect(chain[1].closing_message_id).toBe(ids[3])
  })

  it("two agents advancing over the same region write the rows once and both cores carry them", async () => {
    const region = ids.slice(4, 6).map((id, i) => ({ id, createdAt: new Date(at(4 + i)) }))
    const row = {
      kind: "identifier" as const,
      key: "DHL account number",
      value: "882 441 07",
      messageIds: [ids[4]],
    }

    // Each agent runs the same advance-time sequence: what is past the mark,
    // write it, move the mark.
    for (const agentId of [AGENT_EARLY, AGENT_LATE]) {
      await withPrivilegedDb(ORG_ID, "test", async (tx) => {
        const pending = await regionPastMark(tx, { orgId: ORG_ID, threadId: THREAD, region })
        if (pending.length === 0) return
        await upsertBriefRows(tx, {
          orgId: ORG_ID,
          threadId: THREAD,
          agentId,
          rows: [row],
        })
        await advanceMark(tx, {
          orgId: ORG_ID,
          threadId: THREAD,
          uptoMessageId: pending[pending.length - 1].id,
        })
      })
    }

    const written = (await sql`
      SELECT id, written_by_agent_id FROM kernel.thread_briefs
      WHERE thread_id = ${THREAD} AND key = 'DHL account number'`) as unknown as Array<{
      id: string
      written_by_agent_id: string
    }>
    expect(written.length).toBe(1)
    expect(written[0].written_by_agent_id).toBe(AGENT_EARLY)

    for (const agentId of [AGENT_EARLY, AGENT_LATE]) {
      const core = await withPrivilegedDb(ORG_ID, "test", (tx) =>
        renderCore(tx, {
          orgId: ORG_ID,
          threadId: THREAD,
          agentId,
          uptoMessageId: ids[13],
          // Both agents' join points are at or before message 4, so the row is
          // inside both windows.
          joinPointMessageId: ids[0],
        }),
      )
      expect(core).toContain("DHL account number: 882 441 07")
    }
  })

  it("two concurrent advances on one thread leave one consistent supersession chain", async () => {
    const write = (value: string, messageId: string) =>
      withPrivilegedDb(ORG_ID, "test", (tx) =>
        upsertBriefRows(tx, {
          orgId: ORG_ID,
          threadId: THREAD,
          agentId: AGENT_EARLY,
          rows: [
            {
              kind: "decision" as const,
              key: "pallet or parcel",
              value,
              messageIds: [messageId],
            },
          ],
        }),
      )
    await Promise.all([write("pallet", ids[5]), write("parcel", ids[6])])

    const chain = await chainFor("pallet or parcel")
    expect(chain.length).toBe(2)
    expect(chain.filter((r) => r.status === "current").length).toBe(1)
    // The chain is a single link, and the CURRENT row is the one whose first
    // message is later, whichever transaction happened to commit second.
    expect(chain[0].status).toBe("superseded")
    expect(chain[0].superseded_by).toBe(chain[1].id)
    expect(chain[1].value).toBe("parcel")
  })

  it("a newer row supersedes by message id even when the writer emitted them out of order", async () => {
    await withPrivilegedDb(ORG_ID, "test", (tx) =>
      upsertBriefRows(tx, {
        orgId: ORG_ID,
        threadId: THREAD,
        agentId: AGENT_EARLY,
        rows: [
          // Emitted newest FIRST, which a model does whenever it is summarizing
          // backwards from the end of a region.
          {
            kind: "procedure",
            key: "how returns are booked",
            value: "through Boxtal",
            messageIds: [ids[9]],
          },
          {
            kind: "procedure",
            key: "how returns are booked",
            value: "by hand",
            messageIds: [ids[8]],
          },
        ],
      }),
    )
    const chain = await chainFor("how returns are booked")
    expect(chain.map((r) => `${r.value}:${r.status}`)).toEqual([
      "by hand:superseded",
      "through Boxtal:current",
    ])
  })

  it("a hit on an open loop carries its closure", async () => {
    const [anchor] = (await sql`
      SELECT b.id FROM kernel.thread_briefs b
      WHERE b.thread_id = ${THREAD} AND b.key = 'ship date for order 1042'
        AND b.first_message_id = ${ids[1]}`) as unknown as Array<{ id: string }>
    const followed = await withPrivilegedDb(ORG_ID, "test", (tx) =>
      openLoopWithClosure(tx, anchor.id),
    )
    expect(followed.length).toBeGreaterThanOrEqual(2)
    expect(followed.length).toBeLessThanOrEqual(4)
    expect(followed[0].id).toBe(anchor.id)
    const closure = followed[followed.length - 1]
    expect(closure.value).toBe("given as the 14th")
    expect(closure.closingMessageId).toBe(ids[3])
  })

  it("the core rendered from rows is newest first, current only, under 400 tokens", async () => {
    // Enough rows that the budget, not the row count, is what ends the core.
    await withPrivilegedDb(ORG_ID, "test", (tx) =>
      upsertBriefRows(tx, {
        orgId: ORG_ID,
        threadId: THREAD,
        agentId: AGENT_EARLY,
        rows: Array.from({ length: 12 }, (_, i) => ({
          kind: "identifier" as const,
          key: `bulk key ${i}`,
          value: "v".repeat(300),
          messageIds: [ids[12]],
        })),
      }),
    )
    const core = await withPrivilegedDb(ORG_ID, "test", (tx) =>
      renderCore(tx, {
        orgId: ORG_ID,
        threadId: THREAD,
        agentId: AGENT_EARLY,
        uptoMessageId: ids[13],
      }),
    )
    expect(estimateTokens(core)).toBeLessThanOrEqual(BRIEF_CORE_TOKEN_BUDGET)
    // Current only: the superseded DHL decision never appears.
    expect(core).not.toContain("carrier for order 1042: DHL")
    // Newest first: the bulk rows are anchored at message 12, later than every
    // other row written above, so they head the core.
    expect(core.split("\n")[0]).toContain("bulk key")
  })

  it("two turns inside the window replay a byte identical core", async () => {
    const render = () =>
      withPrivilegedDb(ORG_ID, "test", (tx) =>
        renderCore(tx, {
          orgId: ORG_ID,
          threadId: THREAD,
          agentId: AGENT_EARLY,
          uptoMessageId: ids[13],
          joinPointMessageId: ids[0],
        }),
      )
    const first = await render()
    const second = await render()
    expect(second).toBe(first)
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true)
  })

  it("a row from before an agent's join point is absent from its core and its search", async () => {
    // Anchored at message 2, well before the late agent's seat.
    await withPrivilegedDb(ORG_ID, "test", (tx) =>
      upsertBriefRows(tx, {
        orgId: ORG_ID,
        threadId: THREAD,
        agentId: AGENT_EARLY,
        rows: [
          {
            kind: "contradiction",
            key: "who signs off refunds",
            value: "said twice, two different people",
            messageIds: [ids[2]],
          },
        ],
      }),
    )
    const early = await withPrivilegedDb(ORG_ID, "test", (tx) =>
      renderCore(tx, {
        orgId: ORG_ID,
        threadId: THREAD,
        agentId: AGENT_EARLY,
        uptoMessageId: ids[11],
        joinPointMessageId: ids[0],
      }),
    )
    const late = await withPrivilegedDb(ORG_ID, "test", (tx) =>
      renderCore(tx, {
        orgId: ORG_ID,
        threadId: THREAD,
        agentId: AGENT_LATE,
        uptoMessageId: ids[11],
        joinPointMessageId: ids[8],
      }),
    )
    expect(early).toContain("who signs off refunds")
    expect(late).not.toContain("who signs off refunds")

    // In SEARCH the rule is enforced at recall, by memory search's database
    // re-check on the row's anchor message (memory-search.test.ts, "a brief row
    // from before the recalling agent's seat"). The document itself publishes
    // no agent reach: nothing filtered on it, and it went stale when seats did.
    const [row] = (await sql`
      SELECT id FROM kernel.thread_briefs
      WHERE thread_id = ${THREAD} AND key = 'who signs off refunds'`) as unknown as Array<{
      id: string
    }>
    const { buildBriefRowDocument } = await import("~/modules/search/message-indexer")
    const doc = await buildBriefRowDocument(ORG_ID, row.id)
    expect(doc).not.toBeNull()
    expect(doc?.participant_agent_ids).toBeUndefined()
    expect(doc?.thread_id).toBe(THREAD)
  })

  it("memory_episode returns the body and memory_open accepts a row id", async () => {
    const episodeId = crypto.randomUUID()
    await sql`INSERT INTO kernel.thread_episodes
      (id, org_id, thread_id, title, span_start_message_id, span_end_message_id, body)
      VALUES (${episodeId}, ${ORG_ID}, ${THREAD}, 'Booking the 1042 shipment', ${ids[0]}, ${ids[3]},
        'The carrier moved from DHL to UPS and the ship date was given as the 14th.')`

    const stored = await withPrivilegedDb(ORG_ID, "test", (tx) => getEpisode(tx, episodeId))
    expect(stored?.body).toContain("ship date was given as the 14th")

    const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
    const { toolRegistry } = await import("~/modules/apps/app-registries")
    await registerKernelAgentTools(ORG_ID)
    try {
      const ctx = { orgId: ORG_ID, userId: USER_ID, db: sql, scopes: ["*"] }

      const episodeTool = toolRegistry.get([ORG_ID, "kernel", "memory_episode"])
      expect(episodeTool).toBeDefined()
      const runEpisode = episodeTool!.handler as (p: unknown, c: unknown) => Promise<unknown>
      const episode = (await runEpisode({ id: episodeId }, ctx)) as {
        found: boolean
        body?: string
      }
      expect(episode.found).toBe(true)
      expect(episode.body).toContain("ship date was given as the 14th")

      // memory_open, handed a BRIEF ROW id, opens the window around that row's
      // own first message rather than refusing an id it does not recognise.
      const [briefRow] = (await sql`
        SELECT id FROM kernel.thread_briefs
        WHERE thread_id = ${THREAD} AND key = 'carrier for order 1042' AND status = 'current'`) as unknown as Array<{
        id: string
      }>
      const openTool = toolRegistry.get([ORG_ID, "kernel", "memory_open"])
      const runOpen = openTool!.handler as (p: unknown, c: unknown) => Promise<unknown>
      const opened = (await runOpen({ messageId: briefRow.id, before: 1, after: 1 }, ctx)) as {
        messages: Array<{ messageId: string }>
      }
      expect(opened.messages.length).toBeGreaterThan(0)
      expect(opened.messages.map((m) => m.messageId)).toContain(ids[2])
    } finally {
      toolRegistry.deleteByPrefix([ORG_ID])
    }
  })

  it("a brief row of another thread is invisible", async () => {
    await withPrivilegedDb(ORG_ID, "test", (tx) =>
      upsertBriefRows(tx, {
        orgId: ORG_ID,
        threadId: OTHER_THREAD,
        agentId: AGENT_EARLY,
        rows: [
          {
            kind: "identifier",
            key: "a secret of the other room",
            value: "never leaves it",
            messageIds: [otherIds[0]],
          },
        ],
      }),
    )
    const core = await withPrivilegedDb(ORG_ID, "test", (tx) =>
      renderCore(tx, {
        orgId: ORG_ID,
        threadId: THREAD,
        agentId: AGENT_EARLY,
        uptoMessageId: ids[13],
      }),
    )
    expect(core).not.toContain("a secret of the other room")

    const [row] = (await sql`
      SELECT id FROM kernel.thread_briefs WHERE thread_id = ${OTHER_THREAD}`) as unknown as Array<{
      id: string
    }>
    const { buildBriefRowDocument } = await import("~/modules/search/message-indexer")
    const doc = await buildBriefRowDocument(ORG_ID, row.id)
    expect(doc?.thread_id).toBe(OTHER_THREAD)
    expect(doc?.thread_id).not.toBe(THREAD)
  })
})
