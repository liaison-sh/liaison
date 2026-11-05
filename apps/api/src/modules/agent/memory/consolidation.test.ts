// SPDX-License-Identifier: FSL-1.1-ALv2
// P4m-T25: the consolidation job, its episode close triggers, and the ONE
// flush per region that every close path shares.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import * as jobsModule from "~/infra/jobs/jobs"

const ORG_ID = crypto.randomUUID()
const USER_A = crypto.randomUUID()
const AGENT_A = crypto.randomUUID()
const THREAD_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

const enqueued: Array<{
  jobName: string
  jobId?: string
  delay?: number
  replaceDelayed?: boolean
  payload: unknown
}> = []
const spies: Array<{ mockRestore: () => void }> = []
let messageIds: string[] = []

async function seedMessages(count: number, scopes: string[] = []): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, author_type)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_A}, ${`consolidation line ${i}`}, ${scopes}::text[], 'user')
      RETURNING id`
    ids.push(row.id)
  }
  return ids
}

describe("consolidation", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'ConsolidationOrg', ${`consol-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_A}, ${ORG_ID}, ${`consol-${tag}@test.com`}, 'Consol A', 'x')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT_A}, ${ORG_ID}, 'personal', ${`consol${tag}`}, 'Liaison', ${USER_A}, '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${`consolthread${tag}`}, ${USER_A})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD_ID}, ${USER_A}, ${ORG_ID})`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  beforeEach(async () => {
    enqueued.length = 0
    spies.push(
      spyOn(jobsModule, "enqueueAppJob").mockImplementation(
        async (_app: string, jobName: string, payload: unknown, opts?: Record<string, unknown>) => {
          enqueued.push({
            jobName,
            jobId: opts?.jobId as string | undefined,
            delay: opts?.delay as number | undefined,
            replaceDelayed: opts?.replaceDelayed as boolean | undefined,
            payload,
          })
          return (opts?.jobId as string) ?? "job"
        },
      ),
    )
    messageIds = await seedMessages(5)
  })

  afterEach(async () => {
    for (const s of spies) s.mockRestore()
    spies.length = 0
    const { ConsolidationTestAccess } = await import("./consolidation")
    ConsolidationTestAccess.resetSeams()
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
  })

  it("an episode closes 6 hours after the last agent message and enqueues exactly one job", async () => {
    const { armQuietClose, EPISODE_QUIET_MS, consolidationJobId } = await import("./consolidation")
    await armQuietClose({ orgId: ORG_ID, agentId: AGENT_A, threadId: THREAD_ID })
    await armQuietClose({ orgId: ORG_ID, agentId: AGENT_A, threadId: THREAD_ID })
    expect(enqueued.length).toBe(2)
    expect(enqueued[0].delay).toBe(EPISODE_QUIET_MS)
    // Both arms carry the SAME job id, so the queue keeps exactly one job -- and
    // every arm asks to REPLACE the still-delayed one. Without that, BullMQ
    // deduplicates the re-arm and the deadline stays pinned to the FIRST turn,
    // closing the episode in the middle of a live conversation.
    expect(enqueued.every((e) => e.replaceDelayed === true)).toBe(true)
    const ids = new Set(enqueued.map((e) => e.jobId))
    expect(ids.size).toBe(1)
    expect([...ids][0]).toBe(
      consolidationJobId({
        orgId: ORG_ID,
        agentId: AGENT_A,
        threadId: THREAD_ID,
        closeReason: "quiet",
      }),
    )
  })

  it("a routine tick end and a checkpoint advance each close an episode", async () => {
    const { closeEpisode } = await import("./consolidation")
    await closeEpisode({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "routine-tick",
    })
    await closeEpisode({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "checkpoint",
    })
    expect(enqueued.length).toBe(2)
    expect(new Set(enqueued.map((e) => e.jobId)).size).toBe(2)
    expect(enqueued.every((e) => e.jobName === "agent-memory-consolidation")).toBe(true)
  })

  it("consolidation writes an audit row with actorType system and the agent id and the job id", async () => {
    const { runConsolidation, ConsolidationTestAccess } = await import("./consolidation")
    ConsolidationTestAccess.setFlush(async () => true)
    await runConsolidation({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet",
      jobId: "the-job-id",
    })
    const rows = await sql<{ actor_type: string; agent_id: string; metadata: any }[]>`
      SELECT actor_type, agent_id, metadata FROM kernel.audit_log
      WHERE org_id = ${ORG_ID} AND action = 'memory_flush_region'`
    expect(rows.length).toBe(1)
    expect(rows[0].actor_type).toBe("system")
    expect(rows[0].agent_id).toBe(AGENT_A)
    expect(rows[0].metadata.jobId).toBe("the-job-id")
  })

  it("past 200 model calls in a day the job defers and logs and never skips", async () => {
    const { runConsolidation, CONSOLIDATION_DAILY_MODEL_CALL_CAP, ConsolidationTestAccess } =
      await import("./consolidation")
    expect(CONSOLIDATION_DAILY_MODEL_CALL_CAP).toBe(200)
    let flushes = 0
    ConsolidationTestAccess.setFlush(async () => {
      flushes++
      return true
    })
    for (let i = 0; i < CONSOLIDATION_DAILY_MODEL_CALL_CAP; i++) {
      await sql`INSERT INTO kernel.audit_log (org_id, actor_type, agent_id, app, entity_type, entity_id, action)
        VALUES (${ORG_ID}, 'system', ${AGENT_A}, 'kernel', 'thread', ${THREAD_ID}, 'memory_consolidation')`
    }
    const result = await runConsolidation({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet",
      jobId: "over-cap",
    })
    expect(result.deferred).toBe(true)
    // The 201st call is never made, and the work is re-enqueued rather than
    // dropped: nothing is silently skipped.
    expect(flushes).toBe(0)
    expect(enqueued.some((e) => e.jobName === "agent-memory-consolidation")).toBe(true)
  })

  it("a 6 hour quiet close runs exactly one flush for its region", async () => {
    const { runConsolidation, ConsolidationTestAccess } = await import("./consolidation")
    let flushes = 0
    ConsolidationTestAccess.setFlush(async () => {
      flushes++
      return true
    })
    const payload = {
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet" as const,
      jobId: "quiet-1",
    }
    await runConsolidation(payload)
    expect(flushes).toBe(1)
    const audits = await sql`SELECT id FROM kernel.audit_log
      WHERE org_id = ${ORG_ID} AND action = 'memory_flush_region'`
    expect(audits.length).toBe(1)
    // The retried job re-enters the same region and finds it flushed.
    await runConsolidation(payload)
    expect(flushes).toBe(1)
  })

  it("a routine tick close runs exactly one flush and shares the region marker with a later checkpoint advance over the same region", async () => {
    const { runConsolidation, ConsolidationTestAccess } = await import("./consolidation")
    let flushes = 0
    ConsolidationTestAccess.setFlush(async () => {
      flushes++
      return true
    })
    await runConsolidation({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "routine-tick",
      jobId: "tick-1",
    })
    await runConsolidation({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "checkpoint",
      fromMessageId: messageIds[0],
      toMessageId: messageIds[4],
      jobId: "ckpt-1",
    })
    expect(flushes).toBe(1)
  })

  it("consecutive routine tick closes flush once, and the next one covers only the new messages", async () => {
    const { runConsolidation, ConsolidationTestAccess } = await import("./consolidation")
    const regions: string[][] = []
    ConsolidationTestAccess.setFlush(async (region) => {
      regions.push(region.map((m) => m.id))
      return true
    })
    ConsolidationTestAccess.setSummarizer(async (region) =>
      region.map((m) => m.content).join(" | "),
    )
    const tick = (jobId: string) =>
      runConsolidation({
        orgId: ORG_ID,
        agentId: AGENT_A,
        threadId: THREAD_ID,
        closeReason: "routine-tick" as const,
        jobId,
      })
    await tick("tick-a")
    await tick("tick-b")
    // An eternal output thread does not get re-summarized every tick: the
    // second tick has nothing new to cover.
    expect(regions.length).toBe(1)
    expect(regions[0]).toEqual(messageIds)

    const [fresh] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, author_type)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_A}, 'the tick after the flush', '{}'::text[], 'user')
      RETURNING id`
    await tick("tick-c")
    expect(regions.length).toBe(2)
    // The REGION SINCE THE LAST FLUSH, never the whole thread again.
    expect(regions[1]).toEqual([fresh.id])
  })

  it("the model backed seams are refused outside a test environment", async () => {
    const mod = await import("./consolidation")
    const seams: Array<[string, (fn?: never) => void]> = [
      ["ConsolidationTestAccess.setFlush", mod.ConsolidationTestAccess.setFlush as never],
      ["ConsolidationTestAccess.setSummarizer", mod.ConsolidationTestAccess.setSummarizer as never],
      [
        "ConsolidationTestAccess.setFactExtractor",
        mod.ConsolidationTestAccess.setFactExtractor as never,
      ],
    ]
    const { CheckpointTestAccess } = await import("~/modules/agent/context/checkpoint")
    seams.push(["CheckpointTestAccess.setSummarizer", CheckpointTestAccess.setSummarizer as never])
    const nodeEnv = process.env.NODE_ENV
    const bunEnv = process.env.BUN_ENV
    const argv = [...Bun.argv]
    process.env.NODE_ENV = "production"
    process.env.BUN_ENV = "production"
    Bun.argv.length = 0
    Bun.argv.push("bun", "server.ts")
    try {
      for (const [name, seam] of seams) {
        expect(() => seam()).toThrow(`${name} is only available in tests`)
      }
    } finally {
      Bun.argv.length = 0
      Bun.argv.push(...argv)
      if (nodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = nodeEnv
      if (bunEnv === undefined) delete process.env.BUN_ENV
      else process.env.BUN_ENV = bunEnv
    }
  })

  // --- P4m-T26: episode files, with disclosure list messages excluded -------

  it("an episode file carries the union of its messages required scopes", async () => {
    const { runConsolidation, ConsolidationTestAccess } = await import("./consolidation")
    ConsolidationTestAccess.setFlush(async () => true)
    ConsolidationTestAccess.setSummarizer(async (region) =>
      region.map((m) => m.content).join(" | "),
    )
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    for (const scope of ["a:one:read", "b:two:read", "c:three:read"]) {
      await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, author_type)
        VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_A}, ${`scoped by ${scope}`}, ${[scope]}::text[], 'user')`
    }
    await runConsolidation({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet",
      jobId: "episode-scopes",
    })
    const [row] = await sql<{ required_scopes: string[]; path: string; source_kind: string }[]>`
      SELECT required_scopes, path, source_kind FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type = 'episode'`
    expect(row).toBeDefined()
    expect([...row.required_scopes].sort()).toEqual(["a:one:read", "b:two:read", "c:three:read"])
    expect(row.path.startsWith(`episodes/consolthread${tag}/`)).toBe(true)
    expect(row.source_kind).toBe("consolidation")
  })

  it("a message carrying a disclosure list is excluded from the episode", async () => {
    const { runConsolidation, ConsolidationTestAccess } = await import("./consolidation")
    ConsolidationTestAccess.setFlush(async () => true)
    ConsolidationTestAccess.setSummarizer(async (region) =>
      region.map((m) => m.content).join(" | "),
    )
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    for (let i = 0; i < 4; i++) {
      await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, author_type)
        VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_A}, ${`plain line ${i}`}, '{}'::text[], 'user')`
    }
    await sql`INSERT INTO kernel.messages
      (thread_id, org_id, author_id, content, required_scopes, disclosure_list, author_type)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_A}, 'SHAREDANYWAY marker', ${["d:four:read"]}::text[],
        ${[USER_A]}::uuid[], 'user')`
    await runConsolidation({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet",
      jobId: "episode-disclosure",
    })
    const [row] = await sql<{ content: string; required_scopes: string[] }[]>`
      SELECT content, required_scopes FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type = 'episode'`
    expect(row.content).not.toContain("SHAREDANYWAY")
    expect(row.required_scopes).not.toContain("d:four:read")
  })

  it("a stale episode is rebuilt without the deleted message", async () => {
    const { runConsolidation, ConsolidationTestAccess } = await import("./consolidation")
    ConsolidationTestAccess.setFlush(async () => true)
    ConsolidationTestAccess.setSummarizer(async (region) =>
      region.map((m) => m.content).join(" | "),
    )
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    const ids: string[] = []
    for (const content of ["kept one", "DELETEDMARKER line", "kept two"]) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, author_type)
        VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_A}, ${content}, '{}'::text[], 'user') RETURNING id`
      ids.push(row.id)
    }
    await runConsolidation({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet",
      jobId: "episode-first",
    })
    const [before] = await sql<{ id: string; content: string }[]>`
      SELECT id, content FROM kernel.agent_memory WHERE org_id = ${ORG_ID} AND type = 'episode'`
    expect(before.content).toContain("DELETEDMARKER")
    // The human deletes the message; P4m-T23 marks the artefact stale.
    await sql`UPDATE kernel.messages SET deleted_at = now() WHERE id = ${ids[1]}`
    await sql`UPDATE kernel.agent_memory SET stale_at = now() WHERE id = ${before.id}`
    await runConsolidation({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet",
      jobId: "episode-rebuild",
    })
    const [after] = await sql<{ content: string; stale_at: Date | null }[]>`
      SELECT content, stale_at FROM kernel.agent_memory WHERE id = ${before.id}`
    expect(after.content).not.toContain("DELETEDMARKER")
    expect(after.stale_at).toBeNull()
  })

  it("a stale episode is rebuilt from its OWN range and the current region still gets its episode", async () => {
    const { runConsolidation, ConsolidationTestAccess } = await import("./consolidation")
    ConsolidationTestAccess.setFlush(async () => true)
    ConsolidationTestAccess.setSummarizer(async (region) =>
      region.map((m) => m.content).join(" | "),
    )
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    const first: string[] = []
    for (const content of ["opening line", "GONEMARKER line", "closing line"]) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, author_type)
        VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_A}, ${content}, '{}'::text[], 'user') RETURNING id`
      first.push(row.id)
    }
    await runConsolidation({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet",
      jobId: "own-range-first",
    })
    const [old] = await sql<{ id: string; content: string }[]>`
      SELECT id, content FROM kernel.agent_memory WHERE org_id = ${ORG_ID} AND type = 'episode'`
    expect(old.content).toContain("GONEMARKER")

    await sql`UPDATE kernel.messages SET deleted_at = now() WHERE id = ${first[1]}`
    await sql`UPDATE kernel.agent_memory SET stale_at = now() WHERE id = ${old.id}`
    // A NEW stretch of conversation, which is what this close is about.
    for (const content of ["NEWTOPIC opening", "NEWTOPIC closing"]) {
      await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, author_type)
        VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_A}, ${content}, '{}'::text[], 'user')`
    }
    await runConsolidation({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet",
      jobId: "own-range-second",
    })

    const [rebuilt] = await sql<{ content: string; stale_at: Date | null }[]>`
      SELECT content, stale_at FROM kernel.agent_memory WHERE id = ${old.id}`
    expect(rebuilt.stale_at).toBeNull()
    expect(rebuilt.content).not.toContain("GONEMARKER")
    // ITS OWN range, never this close's conversation.
    expect(rebuilt.content).toContain("opening line")
    expect(rebuilt.content).not.toContain("NEWTOPIC")
    // And the current region keeps an episode of its own.
    const fresh = await sql<{ id: string; content: string }[]>`
      SELECT id, content FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type = 'episode' AND id <> ${old.id}`
    expect(fresh.length).toBe(1)
    expect(fresh[0].content).toContain("NEWTOPIC")
  })

  // --- P4m-T27: facts, fine grained scopes, dedupe and supersession --------

  async function runWithFacts(
    facts: Array<{
      name: string
      description: string
      body: string
      sourceMessageIds: string[]
    }>,
    jobId: string,
  ) {
    const { runConsolidation, ConsolidationTestAccess } = await import("./consolidation")
    ConsolidationTestAccess.setFlush(async () => true)
    ConsolidationTestAccess.setSummarizer(async () => "An episode body.")
    ConsolidationTestAccess.setFactExtractor(async () => facts)
    // A close covers what has arrived SINCE THE LAST FLUSH, so a second pass
    // over the same thread is a second stretch of conversation, exactly as it
    // is in a live thread where the correction arrives in a later message.
    await seedMessages(1)
    return await runConsolidation({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet",
      jobId,
    })
  }

  // FX3-3. A ROLE AGENT HAS NO OWNING HUMAN, and both the episode writer and
  // the fact writer refused to write anything without one, so consolidation was
  // a no-op for every role agent in the org: no episode file, no fact, ever.
  // `agent_memory.user_id` has been nullable since the rekey and the tree is
  // keyed on `owner_agent_id`, so the owning human is provenance, not a key.
  it("consolidation writes an episode and a fact for a role agent with no owning human", async () => {
    const roleAgentId = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${roleAgentId}, ${ORG_ID}, 'role', ${`consolrole${tag}`}, 'Role Desk', '["*"]'::jsonb)`
    const { runConsolidation, ConsolidationTestAccess } = await import("./consolidation")
    ConsolidationTestAccess.setFlush(async () => true)
    ConsolidationTestAccess.setSummarizer(async () => "A role agent episode body.")
    ConsolidationTestAccess.setFactExtractor(async (region) => [
      {
        name: "role-desk-note",
        description: "What the role desk agreed",
        body: "The role desk agreed to the overnight carrier.",
        sourceMessageIds: [region[0].id],
      },
    ])
    const result = await runConsolidation({
      orgId: ORG_ID,
      agentId: roleAgentId,
      threadId: THREAD_ID,
      closeReason: "quiet",
    })
    expect(result.factsWritten).toBe(1)
    const rows = await sql<{ type: string; user_id: string | null }[]>`
      SELECT type, user_id FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND owner_agent_id = ${roleAgentId}`
    expect(rows.filter((r) => r.type === "episode").length).toBe(1)
    expect(rows.filter((r) => r.type === "user").length).toBe(1)
    // The rows belong to the AGENT, with no owning human on them at all.
    expect(rows.every((r) => r.user_id === null)).toBe(true)
    await sql`DELETE FROM kernel.agent_memory WHERE owner_agent_id = ${roleAgentId}`
    await sql`DELETE FROM kernel.agents WHERE id = ${roleAgentId}`
  })

  // A TOPIC FILE IS A FACT, IN THE AGENT'S OWN WORDS (spec-memory.md L5 step 3).
  // A long note pasted into the conversation came back from the extractor as a
  // candidate whose body WAS that note, and a permanent topic file was written
  // holding a verbatim copy of one message. The transcript already holds it.
  it("a candidate that is a copy of its own source message is not written", async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    const pasted = `Preamp launch readiness, pasted in full. ${"The tooling slip moves the pilot run. ".repeat(20)}`
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, author_type)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_A}, ${pasted}, '{}'::text[], 'user')
      RETURNING id`
    const result = await runWithFacts(
      [
        {
          name: "pasted-archive-note",
          description: "The pasted archive note",
          // The message, back again.
          body: pasted,
          sourceMessageIds: [row.id],
        },
      ],
      `verbatim-${tag}`,
    )
    expect(result.factsWritten).toBe(0)
    const written = await sql<{ name: string }[]>`
      SELECT name FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND owner_agent_id = ${AGENT_A} AND name = 'pasted-archive-note'`
    expect(written.length).toBe(0)
  })

  it("the same material said in the agent's own words IS written", async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    const pasted = `Preamp launch readiness, pasted in full. ${"The tooling slip moves the pilot run. ".repeat(20)}`
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, author_type)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_A}, ${pasted}, '{}'::text[], 'user')
      RETURNING id`
    const result = await runWithFacts(
      [
        {
          name: "preamp-pilot-run-slips",
          description: "The pilot run moves because of the tooling slip",
          body: "2026-09-17: the preamp pilot run moves out because tooling slipped.",
          sourceMessageIds: [row.id],
        },
      ],
      `own-words-${tag}`,
    )
    expect(result.factsWritten).toBe(1)
  })

  it("a fact carries the scopes of its own source messages and not the episode union", async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    const ids: string[] = []
    for (const scope of ["a:one:read", "b:two:read"]) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, author_type)
        VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_A}, ${`message under ${scope}`}, ${[scope]}::text[], 'user')
        RETURNING id`
      ids.push(row.id)
    }
    await runWithFacts(
      [
        {
          name: "drawn-from-a",
          description: "A fact drawn from the A message only",
          body: "Only the A message said this.",
          sourceMessageIds: [ids[0]],
        },
      ],
      "fact-scopes",
    )
    const [fact] = await sql<{ required_scopes: string[]; source_kind: string }[]>`
      SELECT required_scopes, source_kind FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND name = 'drawn-from-a'`
    expect(fact.required_scopes).toEqual(["a:one:read"])
    expect(fact.source_kind).toBe("consolidation")
    // The episode written in the same run carries the UNION, which is exactly
    // the difference the fine grained tagging buys.
    const [episode] = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type = 'episode'`
    expect([...episode.required_scopes].sort()).toEqual(["a:one:read", "b:two:read"])
  })

  it("a corrected fact supersedes the old row instead of deleting it", async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    const ids = await seedMessages(1)
    await runWithFacts(
      [
        {
          name: "carrier-account",
          description: "The carrier account number",
          body: "The carrier account number is 55123.",
          sourceMessageIds: ids,
        },
      ],
      "fact-v1",
    )
    await runWithFacts(
      [
        {
          name: "carrier-account",
          description: "The carrier account number",
          body: "The carrier account number is 99881.",
          sourceMessageIds: ids,
        },
      ],
      "fact-v2",
    )
    const rows = await sql<
      { id: string; content: string; supersedes_id: string | null; superseded_at: Date | null }[]
    >`SELECT id, content, supersedes_id, superseded_at FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND name LIKE 'carrier-account%' ORDER BY created_at ASC`
    expect(rows.length).toBe(2)
    expect(rows[0].superseded_at).not.toBeNull()
    expect(rows[1].supersedes_id).toBe(rows[0].id)
    expect(rows[1].content).toContain("99881")
  })

  it("a superseded row is absent from memory_search without includeSuperseded", async () => {
    const { memorySearch } = await import("./memory-search")
    const { withRlsContext } = await import("~/db/rls")
    const actor = {
      actorType: "user" as const,
      userId: USER_A,
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    const ids = await seedMessages(1)
    for (const [jobId, body] of [
      ["fact-s1", "The wolverine quota is 40."],
      ["fact-s2", "The wolverine quota is 65."],
    ] as const) {
      await runWithFacts(
        [
          {
            name: "wolverine-quota",
            description: "The wolverine quota",
            body,
            sourceMessageIds: ids,
          },
        ],
        jobId,
      )
    }
    const without = await withRlsContext(actor, (tx) =>
      memorySearch({ query: "wolverine quota" }, {
        userId: USER_A,
        orgId: ORG_ID,
        db: tx,
        scopes: ["*"],
      } as never),
    )
    expect(without.hits.filter((h) => (h.path ?? "").includes("wolverine")).length).toBe(1)
    const withAll = await withRlsContext(actor, (tx) =>
      memorySearch({ query: "wolverine quota", includeSuperseded: true }, {
        userId: USER_A,
        orgId: ORG_ID,
        db: tx,
        scopes: ["*"],
      } as never),
    )
    expect(withAll.hits.filter((h) => (h.path ?? "").includes("wolverine")).length).toBe(2)
  })

  it("a near duplicate description above the 0.8 trigram threshold is deduped and an unrelated one is not", async () => {
    const { DESCRIPTION_SIMILARITY_THRESHOLD } = await import("./consolidation")
    expect(DESCRIPTION_SIMILARITY_THRESHOLD).toBe(0.8)
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    const ids = await seedMessages(1)
    await runWithFacts(
      [
        {
          name: "style-one",
          description: "Prefers bullet points, terse summaries",
          body: "Keep it short.",
          sourceMessageIds: ids,
        },
      ],
      "dedupe-1",
    )
    await runWithFacts(
      [
        {
          name: "style-two",
          description: "Prefers bullet points and terse summaries",
          body: "Keep it very short.",
          sourceMessageIds: ids,
        },
      ],
      "dedupe-2",
    )
    const current = await sql<{ id: string; supersedes_id: string | null }[]>`
      SELECT id, supersedes_id FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type <> 'episode' AND type <> '_index' AND superseded_at IS NULL`
    expect(current.length).toBe(1)
    expect(current[0].supersedes_id).not.toBeNull()

    await runWithFacts(
      [
        {
          name: "dhl-lyon",
          description: "DHL account number for the Lyon warehouse",
          body: "The Lyon DHL account is 8811.",
          sourceMessageIds: ids,
        },
      ],
      "dedupe-3",
    )
    const after = await sql`SELECT id FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type <> 'episode' AND type <> '_index' AND superseded_at IS NULL`
    expect(after.length).toBe(2)
  })

  // THE EXTRACTOR'S ANSWER IS MODEL OUTPUT, NOT A TYPED VALUE. Whatever shape a
  // model returns reached the dedupe query as a bound parameter: a description
  // that came back as a boolean bound as one ("function similarity(text,
  // boolean) does not exist"), a NUL byte in a string is refused by Postgres
  // ("invalid byte sequence for encoding UTF8: 0x00"), a missing field dropped
  // its placeholder out of the SQL. One such candidate failed the whole job, on
  // every retry, so the well formed facts beside it were never written either.
  // Which shapes arrive depends on the model an instance runs.
  it("a malformed extractor candidate is dropped and the well formed ones beside it are written", async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    const ids = await seedMessages(1)
    const before = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type NOT IN ('episode', '_index') AND superseded_at IS NULL`
    const result = await runWithFacts(
      [
        {
          name: "carrier-cutoff",
          description: "Carrier pickup cutoff is 4pm on weekdays",
          body: "Parcels for the carrier must be ready by 4pm on weekdays.",
          sourceMessageIds: ids,
        },
        // A boolean where a string belongs.
        {
          name: "flag-fact",
          description: true,
          body: "A body.",
          sourceMessageIds: ids,
        } as never,
        // No description at all, and no source ids.
        { name: "bare-fact", body: "A body." } as never,
        // NUL bytes inside otherwise good strings: kept, without the NULs.
        {
          name: "invoice-day\u0000",
          description: "Invoices go out\u0000 on the first business day",
          body: "Invoices are sent on the first\u0000 business day of the month.",
          sourceMessageIds: ids,
        },
        // A non object entry in the array.
        "not a candidate" as never,
      ],
      "malformed-candidates",
    )
    expect(result.factsWritten).toBe(2)
    const rows = await sql<{ name: string; description: string; content: string }[]>`
      SELECT name, description, content FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type NOT IN ('episode', '_index') AND superseded_at IS NULL
        AND name IN ('carrier-cutoff', 'invoice-day')`
    expect(rows.map((r) => r.name).sort()).toEqual(["carrier-cutoff", "invoice-day"])
    const invoice = rows.find((r) => r.name === "invoice-day")
    expect(invoice?.description).toBe("Invoices go out on the first business day")
    expect(invoice?.content).not.toContain("\u0000")
    const after = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type NOT IN ('episode', '_index') AND superseded_at IS NULL`
    expect(after[0].n - before[0].n).toBe(2)
  })

  // --- P4m-T28: file consolidation, MEMORY.md rebuild and index upkeep -----

  async function seedFile(
    name: string,
    description: string,
    opts: {
      recallCount?: number
      lastRecalledAt?: string | null
      lastConfirmedAt?: string | null
      sourceKind?: string
      supersededAt?: string | null
      createdAt?: string
    } = {},
  ) {
    const [row] = await sql<{ id: string }[]>`INSERT INTO kernel.agent_memory
      (org_id, user_id, owner_agent_id, type, name, description, content, path,
       required_scopes, source_kind, recall_count, last_recalled_at, last_confirmed_at,
       superseded_at, created_at)
      VALUES (${ORG_ID}, ${USER_A}, ${AGENT_A}, 'project', ${name}, ${description},
        ${`Body of ${name}.`}, ${`project/${name}.md`}, '{}'::text[],
        ${opts.sourceKind ?? "consolidation"}, ${opts.recallCount ?? 0},
        ${opts.lastRecalledAt ?? null}, ${opts.lastConfirmedAt ?? null},
        ${opts.supersededAt ?? null}, ${opts.createdAt ?? new Date().toISOString()})
      RETURNING id`
    return row.id
  }

  async function readIndexLines(): Promise<string[]> {
    const [row] = await sql<{ content: string }[]>`SELECT content FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type = '_index'`
    return (row?.content ?? "").split("\n").filter((l) => l.trim() !== "")
  }

  it("a file recalled in three threads over fourteen days moves to the top of its type section", async () => {
    const { consolidateFiles } = await import("./consolidation")
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString()
    await seedFile("aaa-quiet", "A quiet file that sorts first by name", {
      lastRecalledAt: recent,
      recallCount: 1,
    })
    const promotedId = await seedFile("zzz-hot", "A hot file recalled everywhere", {
      recallCount: 5,
      lastRecalledAt: recent,
      lastConfirmedAt: recent,
    })
    for (const threadTag of ["t1", "t2", "t3"]) {
      await sql`INSERT INTO kernel.audit_log
        (org_id, actor_type, agent_id, app, entity_type, entity_id, action, metadata)
        VALUES (${ORG_ID}, 'system', ${AGENT_A}, 'kernel', 'thread', ${THREAD_ID}, 'memory_recalled',
          ${JSON.stringify({ memoryIds: [promotedId], threadId: `${THREAD_ID.slice(0, 30)}${threadTag}` })}::jsonb)`
    }
    await consolidateFiles({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet",
      jobId: "upkeep-promote",
    })
    const lines = await readIndexLines()
    expect(lines[0]).toContain("project/zzz-hot.md")
  })

  it("a file never recalled in 90 days loses its index line and keeps its file", async () => {
    const { consolidateFiles } = await import("./consolidation")
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString()
    await seedFile("recent-one", "A file recalled this week", {
      recallCount: 1,
      lastRecalledAt: new Date().toISOString(),
      createdAt: old,
    })
    await seedFile("forgotten-one", "A file nobody has read in months", { createdAt: old })
    await consolidateFiles({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet",
      jobId: "upkeep-demote",
    })
    const lines = await readIndexLines()
    expect(lines.some((l) => l.includes("project/recent-one.md"))).toBe(true)
    expect(lines.some((l) => l.includes("project/forgotten-one.md"))).toBe(false)
    // The FILE survives: it is still reachable through memory_view and search.
    const rows = await sql`SELECT id FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND path = 'project/forgotten-one.md'`
    expect(rows.length).toBe(1)
  })

  it("consolidation never deletes a file a human wrote", async () => {
    const { consolidateFiles } = await import("./consolidation")
    const longAgo = new Date(Date.now() - 200 * 86_400_000).toISOString()
    await seedFile("human-written", "A file a human wrote and nobody read", {
      sourceKind: "human",
      supersededAt: longAgo,
      recallCount: 0,
      createdAt: longAgo,
    })
    await seedFile("machine-written", "A file the job wrote and nobody read", {
      sourceKind: "consolidation",
      supersededAt: longAgo,
      recallCount: 0,
      createdAt: longAgo,
    })
    await consolidateFiles({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet",
      jobId: "upkeep-drop",
    })
    const human = await sql`SELECT id FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND path = 'project/human-written.md'`
    expect(human.length).toBe(1)
    const machine = await sql`SELECT id FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND name = 'machine-written'`
    expect(machine.length).toBe(0)
  })

  it("a rebuild of 240 candidate lines lands under 200 lines", async () => {
    const { consolidateFiles, MEMORY_INDEX_REBUILD_MAX_LINES } = await import("./consolidation")
    expect(MEMORY_INDEX_REBUILD_MAX_LINES).toBe(200)
    const recent = new Date().toISOString()
    for (let i = 0; i < 240; i++) {
      await seedFile(`bulk-${String(i).padStart(3, "0")}`, `Bulk file number ${i}`, {
        recallCount: 1,
        lastRecalledAt: recent,
      })
    }
    let threw = false
    try {
      await consolidateFiles({
        orgId: ORG_ID,
        agentId: AGENT_A,
        threadId: THREAD_ID,
        closeReason: "quiet",
        jobId: "upkeep-rebuild",
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    const lines = await readIndexLines()
    expect(lines.length).toBeLessThanOrEqual(200)
    expect(lines.length).toBeGreaterThan(0)
  })

  it("an older file's relative date is anchored on its own date, not on this region's", async () => {
    const { consolidateFiles } = await import("./consolidation")
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    // Written a month ago, and it says "yesterday" about a month ago.
    await sql`INSERT INTO kernel.agent_memory
      (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes,
       created_at, updated_at)
      VALUES (${ORG_ID}, ${USER_A}, ${AGENT_A}, 'project', 'oldnote', 'An old note',
        'The pallet shipped yesterday.', 'project/oldnote.md', '{}'::text[],
        '2026-08-01T09:00:00Z', '2026-08-01T09:00:00Z')`
    await consolidateFiles({
      orgId: ORG_ID,
      agentId: AGENT_A,
      threadId: THREAD_ID,
      closeReason: "quiet",
      jobId: "dates-own-anchor",
      toMessageId: messageIds[4],
    })
    const [row] = await sql<{ content: string }[]>`
      SELECT content FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND path = 'project/oldnote.md'`
    expect(row.content).toBe("The pallet shipped 2026-07-31.")
  })

  it("a relative date is rewritten to the absolute one the conversation meant", async () => {
    const { rewriteRelativeDates } = await import("./consolidation")
    const anchor = new Date("2026-09-11T12:00:00Z") // a Friday
    expect(rewriteRelativeDates("Ship it yesterday.", anchor)).toBe("Ship it 2026-09-10.")
    expect(rewriteRelativeDates("Ship it tomorrow.", anchor)).toBe("Ship it 2026-09-12.")
    expect(rewriteRelativeDates("Due last Monday.", anchor)).toBe("Due 2026-09-07.")
    // Not on the closed list: left verbatim rather than guessed at.
    expect(rewriteRelativeDates("Due in a fortnight.", anchor)).toBe("Due in a fortnight.")
  })

  // A personal-agent chat on Wednesday 2026-11-04 asked a colleague to "prepare one on thursday
  // for a pickup on friday"; the episode then said 2026-10-29 / 2026-10-30, the PAST Thursday and
  // Friday, and turned the agent's own "Thursday 5 November" into "2026-10-29 5 November".
  it("a bare weekday, or one that carries its date, is left as written", async () => {
    const { rewriteRelativeDates } = await import("./consolidation")
    const anchor = new Date("2026-11-04T16:15:00Z") // a Wednesday
    expect(rewriteRelativeDates("Prepare one on Thursday for a pickup on Friday.", anchor)).toBe(
      "Prepare one on Thursday for a pickup on Friday.",
    )
    expect(rewriteRelativeDates("Ready Thursday 5 November, pickup Friday, 6 Nov.", anchor)).toBe(
      "Ready Thursday 5 November, pickup Friday, 6 Nov.",
    )
    expect(rewriteRelativeDates("Pickup next Friday 13 November.", anchor)).toBe(
      "Pickup next Friday 13 November.",
    )
    // A direction word still resolves, both ways.
    expect(rewriteRelativeDates("Pickup next Friday.", anchor)).toBe("Pickup 2026-11-06.")
    expect(rewriteRelativeDates("We spoke last Monday.", anchor)).toBe("We spoke 2026-11-02.")
    expect(rewriteRelativeDates("Next Wednesday it ships.", anchor)).toBe("2026-11-11 it ships.")
  })
  // MEMORY IS WRITTEN ONLY WHEN THE USER ASKS (production, a personal agent):
  // a turn read orders, invoicing and mail, the person DENIED the agent's own
  // request to save a note about a customer, and twelve minutes later this job
  // wrote the customer's address and one order's price as `user` memories,
  // drawn from the turn's reply. What the memory writers may read is now what a
  // person typed, a denial writes nothing, and the agent's own approval rule
  // holds for the job too. The extractor is a stub: these tests check what it
  // is GIVEN and what it is ALLOWED to write.
  describe("memory is drawn only from what the person typed", () => {
    const threadIds: string[] = []

    async function newThread(tainted = false): Promise<string> {
      const { withSystemDb } = await import("~/db/privileged")
      const { threads, threadParticipants } = await import("~/db/schema/kernel")
      const id = crypto.randomUUID()
      await withSystemDb("consolidation-test-thread", async (db) => {
        await db.insert(threads).values({
          id,
          orgId: ORG_ID,
          handle: `typed${id.slice(0, 8)}`,
          createdBy: USER_A,
          tainted,
        })
        await db.insert(threadParticipants).values({ threadId: id, userId: USER_A, orgId: ORG_ID })
      })
      threadIds.push(id)
      return id
    }

    async function post(
      threadId: string,
      authorType: "user" | "agent" | "system",
      content: string,
    ): Promise<string> {
      const { withSystemDb } = await import("~/db/privileged")
      const { messages } = await import("~/db/schema/kernel")
      return withSystemDb("consolidation-test-message", async (db) => {
        const [row] = await db
          .insert(messages)
          .values({
            threadId,
            orgId: ORG_ID,
            authorId: USER_A,
            authorType,
            ...(authorType === "agent" ? { authorAgentId: AGENT_A } : {}),
            content,
            requiredScopes: [],
          })
          .returning({ id: messages.id })
        return row.id
      })
    }

    async function denyMemoryWrite(threadId: string): Promise<void> {
      const { withSystemDb } = await import("~/db/privileged")
      const { approvalRequests } = await import("~/db/schema/kernel")
      await withSystemDb("consolidation-test-approval", async (db) => {
        await db.insert(approvalRequests).values({
          orgId: ORG_ID,
          handle: `request-${threadId.slice(0, 6)}`,
          threadId,
          originatingThreadId: threadId,
          toolName: "kernel:memory_create",
          toolParams: { path: "user/customer-note.md", body: "A note on the customer." },
          currentPayload: { path: "user/customer-note.md", body: "A note on the customer." },
          expiresAt: new Date(Date.now() + 86_400_000),
          requestedBy: USER_A,
          agentId: AGENT_A,
          status: "denied",
          decidedBy: USER_A,
          decidedAt: new Date(),
        })
      })
    }

    /** Runs a close with stub writers that record exactly what they were given. */
    async function consolidate(threadId: string) {
      const { runConsolidation, ConsolidationTestAccess } = await import("./consolidation")
      const seen = { extractor: null as string[] | null, flush: null as string[] | null }
      ConsolidationTestAccess.setSummarizer(async () => "An episode body.")
      ConsolidationTestAccess.setFlush(async (region) => {
        seen.flush = region.map((m) => m.id)
        return true
      })
      // A stub that, like a model, writes whatever its input holds that looks
      // like a fact: the price and the address if it is shown them, the
      // preference if it is shown that.
      ConsolidationTestAccess.setFactExtractor(async (region) => {
        seen.extractor = region.map((m) => m.id)
        const facts = []
        for (const m of region) {
          if (m.content?.includes("EUR 360")) {
            facts.push({
              name: "product-unit-pricing",
              description: "The unit price of the product is EUR 360",
              body: "The unit price for 1 unit is EUR 360.",
              sourceMessageIds: [m.id],
            })
            facts.push({
              name: "customer-contact-details",
              description: "The customer's email and postal address",
              body: "buyer@example.test, 1 Example Street.",
              sourceMessageIds: [m.id],
            })
          }
          if (m.content?.includes("prefer French")) {
            facts.push({
              name: "language-for-contact",
              description: "Write to this contact in French",
              body: "The user prefers French when writing to this contact.",
              sourceMessageIds: [m.id],
            })
          }
        }
        return facts
      })
      const result = await runConsolidation({
        orgId: ORG_ID,
        agentId: AGENT_A,
        threadId,
        closeReason: "checkpoint",
      })
      const rows = await sql<{ name: string; type: string }[]>`
        SELECT name, type FROM kernel.agent_memory
        WHERE org_id = ${ORG_ID} AND source_thread_id = ${threadId} AND type = 'user'`
      return { result, seen, userRows: rows.map((r) => r.name) }
    }

    afterAll(async () => {
      for (const id of threadIds) {
        await sql`DELETE FROM kernel.approval_requests WHERE thread_id = ${id}`
        await sql`DELETE FROM kernel.messages WHERE thread_id = ${id}`
        await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${id}`
        await sql`DELETE FROM kernel.threads WHERE id = ${id}`
      }
    })

    it("a task request whose reply holds an address and a price writes no user memory", async () => {
      const threadId = await newThread()
      const asked = await post(
        threadId,
        "user",
        "Check the customer's message and prepare a proforma.",
      )
      await post(
        threadId,
        "agent",
        "Order found: 1 unit at EUR 360, ship to buyer@example.test, 1 Example Street. Proforma drafted.",
      )
      await post(threadId, "system", "Approved by the user: create proforma")
      const { seen, userRows, result } = await consolidate(threadId)
      // The writers are given what the person typed, and nothing else.
      expect(seen.extractor).toEqual([asked])
      expect(seen.flush).toEqual([asked])
      expect(result.factsWritten).toBe(0)
      expect(userRows).toEqual([])
    })

    it("a candidate citing a message the person did not type is not written", async () => {
      const threadId = await newThread()
      await post(threadId, "user", "Remember that I prefer French for this contact.")
      const reply = await post(threadId, "agent", "Noted. Their last order was 1 unit at EUR 360.")
      const { runConsolidation, ConsolidationTestAccess } = await import("./consolidation")
      ConsolidationTestAccess.setFlush(async () => true)
      ConsolidationTestAccess.setSummarizer(async () => "An episode body.")
      ConsolidationTestAccess.setFactExtractor(async () => [
        {
          name: "product-unit-pricing",
          description: "The unit price of the product is EUR 360",
          body: "The unit price for 1 unit is EUR 360.",
          sourceMessageIds: [reply],
        },
      ])
      const result = await runConsolidation({
        orgId: ORG_ID,
        agentId: AGENT_A,
        threadId,
        closeReason: "checkpoint",
      })
      expect(result.factsWritten).toBe(0)
    })

    it("a preference the person asked to remember is written", async () => {
      const threadId = await newThread()
      const asked = await post(threadId, "user", "Remember that I prefer French for this contact.")
      await post(threadId, "agent", "Got it, French from now on.")
      const { seen, userRows, result } = await consolidate(threadId)
      expect(seen.extractor).toEqual([asked])
      expect(result.factsWritten).toBe(1)
      expect(userRows).toEqual(["language-for-contact"])
    })

    it("a window in which the person denied a memory write writes nothing", async () => {
      const threadId = await newThread()
      await post(threadId, "user", "Remember that I prefer French for this contact.")
      await post(
        threadId,
        "agent",
        "Order found: 1 unit at EUR 360. Saving a note on the customer.",
      )
      await denyMemoryWrite(threadId)
      await post(threadId, "system", "Denied by the user: save a note on the customer")
      const { seen, userRows, result } = await consolidate(threadId)
      // Neither writer runs: the denial is the person's answer for this window.
      expect(seen.extractor).toBeNull()
      expect(seen.flush).toBeNull()
      expect(result.factsWritten).toBe(0)
      expect(userRows).toEqual([])
    })

    it("a memory write the agent would have needed an approval for is not written by the job", async () => {
      // The last turn read outside text, so the agent's own memory_create would
      // have waited for a person (host-approval-gates.ts).
      const threadId = await newThread(true)
      await post(threadId, "user", "Remember that I prefer French for this contact.")
      const { seen, userRows, result } = await consolidate(threadId)
      expect(seen.extractor).toBeNull()
      expect(result.factsWritten).toBe(0)
      expect(userRows).toEqual([])
    })
  })
})
