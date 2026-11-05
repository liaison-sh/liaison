// SPDX-License-Identifier: FSL-1.1-ALv2
// P4m-T12: past conversations and conversation summaries are folders in the
// tree. Episodes get ONE index line per thread (one line per episode would
// flood MEMORY.md), and a checkpoint is never part of the recall substrate: it
// is a render artefact of the transcript, which is itself searchable.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"

const ORG_ID = "00000000-0000-0000-0000-000000d80001"
const USER_A = "00000000-0000-0000-0000-000000d80002"
const AGENT_A = "00000000-0000-0000-0000-000000d80003"
const THREAD_LOGISTICS = "00000000-0000-0000-0000-000000d80004"
const THREAD_SUPPORT = "00000000-0000-0000-0000-000000d80005"
/** A ROLE agent in the same thread: its checkpoint is not in this tree. */
const AGENT_ROLE = "00000000-0000-0000-0000-000000d80006"

const actorA: UserContext = {
  actorType: "user",
  userId: USER_A,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

function ctxFor(tx: unknown) {
  return { userId: USER_A, orgId: ORG_ID, db: tx, scopes: [] } as never
}

describe("episodes and checkpoints in the tree", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'EpiOrg', 'epi-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_A}, ${ORG_ID}, 'epi-a@test.com', 'Epi A', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT_A}, ${ORG_ID}, 'personal', '@epi-a', 'Liaison', ${USER_A})
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${AGENT_ROLE}, ${ORG_ID}, 'role', '@epi-role', 'Epi Role', '["*"]'::jsonb)
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD_LOGISTICS}, ${ORG_ID}, 'logistics', 'thread', ${USER_A})
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD_SUPPORT}, ${ORG_ID}, 'support', 'thread', ${USER_A})
      ON CONFLICT DO NOTHING`
    // The reader must be able to see the thread itself: a checkpoint is
    // rendered through the thread's own visibility, never around it.
    for (const threadId of [THREAD_LOGISTICS, THREAD_SUPPORT]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, participant_type)
        VALUES (${threadId}, ${USER_A}, ${ORG_ID}, 'user') ON CONFLICT DO NOTHING`
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
  })

  it("memory_view on the episodes folder lists one subfolder per thread", async () => {
    const { writeEpisode, memoryView } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      await writeEpisode(
        {
          threadId: THREAD_LOGISTICS,
          threadHandle: "logistics",
          closedOn: "2026-09-12",
          description: "carrier switch",
          body: "Quinn asked about DHL.",
        },
        ctxFor(tx),
        [],
      )
      await writeEpisode(
        {
          threadId: THREAD_SUPPORT,
          threadHandle: "support",
          closedOn: "2026-09-12",
          description: "refund policy",
          body: "Ana asked about refunds.",
        },
        ctxFor(tx),
        [],
      )
      const listing = (await memoryView({ path: "episodes" }, ctxFor(tx))) as {
        entries: string[]
      }
      expect(listing.entries.length).toBe(2)
      expect(listing.entries).toEqual(["episodes/logistics/", "episodes/support/"])
    })
  })

  it("writing three episodes for one thread adds exactly one MEMORY.md line carrying the count", async () => {
    const { writeEpisode } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      for (const day of ["2026-09-10", "2026-09-11", "2026-09-12"]) {
        await writeEpisode(
          {
            threadId: THREAD_LOGISTICS,
            threadHandle: "logistics",
            closedOn: day,
            description: `day ${day}`,
            body: "what happened",
          },
          ctxFor(tx),
          [],
        )
      }
    })
    const [index] = await sql<{ content: string }[]>`SELECT content FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type = '_index' AND name = '_index'`
    const lines = index.content.split("\n").filter((l) => l.trim() !== "")
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain("episodes/logistics/")
    expect(lines[0]).toContain("3")
  })

  it("memory_view renders the current checkpoint version for a thread", async () => {
    const { memoryView } = await import("./memory")
    for (const [version, summary] of [
      [1, "the first summary"],
      [2, "the second summary"],
    ] as const) {
      await sql`INSERT INTO kernel.agent_thread_checkpoints
        (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes,
         token_estimate, version)
        VALUES (${ORG_ID}, ${AGENT_A}, ${THREAD_LOGISTICS}, NULL, ${summary}, '{}', 42, ${version})`
    }
    await withRlsContext(actorA, async (tx) => {
      const file = (await memoryView({ path: "checkpoints/logistics.md" }, ctxFor(tx))) as {
        body: string
      }
      expect(file.body).toContain("version: 2")
      expect(file.body).toContain("tokenEstimate: 42")
      expect(file.body.endsWith("the second summary")).toBe(true)
    })
  })

  // FX1 item 5 (invariant I5, sessions are per agent): the checkpoint render
  // was keyed by (orgId, thread handle) and nothing else, so in a thread two
  // agents both checkpointed, the personal agent's own tree rendered whichever
  // version number happened to be highest. That is another agent's summary of
  // the same conversation, reached through this agent's memory tree.
  it("a personal tree never renders another agent's checkpoint for the same thread", async () => {
    const { memoryView } = await import("./memory")
    await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes,
       token_estimate, version)
      VALUES (${ORG_ID}, ${AGENT_A}, ${THREAD_LOGISTICS}, NULL, 'MINE_V1', '{}', 42, 1)`
    await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes,
       token_estimate, version)
      VALUES (${ORG_ID}, ${AGENT_ROLE}, ${THREAD_LOGISTICS}, NULL, 'THEIRS_V7', '{}', 42, 7)`
    await withRlsContext(actorA, async (tx) => {
      const file = (await memoryView({ path: "checkpoints/logistics.md" }, ctxFor(tx))) as {
        body: string
      }
      expect(file.body).toContain("MINE_V1")
      expect(file.body).not.toContain("THEIRS_V7")
      expect(file.body).toContain("version: 1")
    })
  })

  it("a thread checkpointed only by another agent has no file in this tree", async () => {
    const { memoryView } = await import("./memory")
    await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes,
       token_estimate, version)
      VALUES (${ORG_ID}, ${AGENT_ROLE}, ${THREAD_SUPPORT}, NULL, 'THEIRS_ONLY', '{}', 42, 1)`
    await withRlsContext(actorA, async (tx) => {
      await expect(memoryView({ path: "checkpoints/support.md" }, ctxFor(tx))).rejects.toThrow(
        /No memory file at/,
      )
    })
  })

  // FX1 item 10: the thread handle becomes a path segment, and it comes from
  // the thread row, not from the path grammar. An out of grammar handle wrote a
  // row whose path every verb then refused as illegal: the episode existed and
  // was unreachable.
  it("writeEpisode refuses a thread handle that is not a legal path segment", async () => {
    const { writeEpisode } = await import("./memory")
    await withRlsContext(actorA, async (tx) => {
      await expect(
        writeEpisode(
          {
            threadId: THREAD_LOGISTICS,
            threadHandle: "Logistics Q3/../etc",
            closedOn: "2026-09-12",
            description: "carrier switch",
            body: "Quinn asked about DHL.",
          },
          ctxFor(tx),
          [],
        ),
      ).rejects.toThrow(/legal thread handle/i)
    })
    const rows = await sql`SELECT id FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type = 'episode'`
    expect(rows.length).toBe(0)
  })

  it("a checkpoint path is never returned by the tree's searchable path set", async () => {
    const { writeEpisode, searchablePaths } = await import("./memory")
    await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes,
       token_estimate, version)
      VALUES (${ORG_ID}, ${AGENT_A}, ${THREAD_LOGISTICS}, NULL, 'a summary', '{}', 42, 1)`
    const paths = await withRlsContext(actorA, async (tx) => {
      await writeEpisode(
        {
          threadId: THREAD_LOGISTICS,
          threadHandle: "logistics",
          closedOn: "2026-09-12",
          description: "carrier switch",
          body: "Quinn asked about DHL.",
        },
        ctxFor(tx),
        [],
      )
      return await searchablePaths(ctxFor(tx))
    })
    expect(paths.filter((p) => p.startsWith("checkpoints/")).length).toBe(0)
    expect(paths).toContain("episodes/logistics/2026-09-12.md")
    expect(paths).not.toContain("MEMORY.md")
  })
})
