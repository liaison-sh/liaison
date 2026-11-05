// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4m-T35: the long memory harness, scenarios 4 and 5 of spec-memory.md's
// validation list.
//
// SCENARIO 4, ROUTINE CONTINUITY. Two ticks of one routine whose prompt never
// mentions `watch_state`. A tick's rendered history is anchored at its own
// trigger message, so the first tick's conversation is in no byte of the second
// tick's prefix; the second tick still answers with what the first concluded,
// because auto recall for a tick queries the routine's own output thread first
// (spec-memory.md "Routine ticks"). The harness asserts both halves: the marker
// is in the tail and NOT in the prefix.
//
// SCENARIO 5, TWO AGENTS IN ONE CHANNEL. Two agents share a channel with
// different join points and different ceilings. Each advance flushes its own
// region, recorded as an audit row, so the two regions can be compared: the
// late joiner's region starts after its own seat was created and carries
// nothing above its ceiling, while the early joiner's covers the whole stretch.
//
// NO FUNDED KEY. Every model backed step is scripted through the production
// seams; see helpers/long-memory.ts.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { CheckpointTestAccess } from "~/modules/agent/context/checkpoint"
import { ExternalSearchHandlersTestAccess } from "~/modules/search/external-handlers"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { type CapturedTurn, installRequestCapture } from "./helpers/capture-requests"
import {
  answerFromRequest,
  driveTurn,
  dropWorld,
  insertMessage,
  lastAgentReply,
  padded,
  readerStream,
  seedWorld,
} from "./helpers/long-memory"

const ORIG_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

// ---------------------------------------------------------------------------
// Scenario 4: routine continuity
// ---------------------------------------------------------------------------

const S4_ORG = "4d000000-0000-4000-8000-000000000301"
const S4_USER = "4d000000-0000-4000-8000-000000000302"
const S4_THREAD = "4d000000-0000-4000-8000-000000000303"
const S4_AGENT = "4d000000-0000-4000-8000-000000000304"
const S4_ROUTINE = "4d000000-0000-4000-8000-000000000305"
const S4_INDEX = `test_p4mt35s4_${crypto.randomUUID().slice(0, 8)}`

/** The first tick's conclusion, in the harness's account-number shape. */
const TICK_ONE_CONCLUSION = "KTK-42424"
/**
 * The tick triggers, phrased the way a routine's own prompt phrases them. They
 * are not keyword lines: a tick asks a question, which is what makes the
 * transcript leg's matching rule load bearing.
 */
const TICK_ONE_TRIGGER = "Review the overnight carrier rates for today."
const TICK_TWO_TRIGGER = "Which carrier account should we bill against today?"

/** No `watch_state`: the whole point of the scenario. */
const ROUTINE_PROMPT =
  "Each morning, review the overnight carrier rates and report the account we should bill against."

describe("P4m-T35 long memory scenario 4, routine continuity", () => {
  const spies: Array<{ mockRestore: () => void }> = []
  let secondTickAnswer = ""
  let secondTurn: CapturedTurn
  let routinePrompt = ""

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-long-memory-stub"
    ExternalSearchHandlersTestAccess.reset()
    spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(S4_INDEX))
    spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue(
        meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
      ),
    )
    spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "job") as never)
    const { expectedSettings } = await import("~/modules/search/drift")
    const created = await meili.createIndex(S4_INDEX, { primaryKey: "id" })
    await meili.tasks.waitForTask(created.taskUid)
    const applied = await meili
      .index(S4_INDEX)
      .updateSettings(
        expectedSettings({ registeredReadScopes: ["kernel:threads:read"], dimensionFields: [] }),
      )
    await meili.tasks.waitForTask(applied.taskUid)

    await seedWorld({
      orgId: S4_ORG,
      userId: S4_USER,
      userEmail: "routinetick@test.com",
      agents: [
        {
          id: S4_AGENT,
          handle: "@routinetick",
          displayName: "Routine Tick",
          kind: "personal",
          ownerUserId: S4_USER,
        },
      ],
      threads: [{ id: S4_THREAD, handle: "routine-tick-log", type: "thread" }],
    })
    await sql`INSERT INTO kernel.routines
      (id, org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone, prompt,
       scopes, visibility, status, created_by_actor_type, output_thread_id)
      VALUES (${S4_ROUTINE}, ${S4_ORG}, ${S4_USER}, ${S4_AGENT}, 'carrier-rates', 'Nightly carrier rates',
              'recurring', '0 8 * * *', 'UTC', ${ROUTINE_PROMPT}, '{}', 'personal', 'active', 'user', ${S4_THREAD})`
    const [routine] = await sql<{ prompt: string }[]>`
      SELECT prompt FROM kernel.routines WHERE id = ${S4_ROUTINE}`
    routinePrompt = routine.prompt

    // A THREAD WITH A HISTORY. A two document index has degenerate term
    // statistics, and a lexical engine's matching rule is only meaningful over
    // a corpus: these are the routine's earlier, uneventful entries.
    for (let i = 0; i < 10; i++) {
      await insertMessage({
        orgId: S4_ORG,
        threadId: S4_THREAD,
        authorId: S4_USER,
        authorType: i % 2 === 0 ? "user" : "agent",
        ...(i % 2 === 0 ? {} : { authorAgentId: S4_AGENT }),
        content: `Earlier entry ${i}: the overnight carrier rates were unchanged and nothing was decided.`,
      })
    }

    // TICK ONE concludes something specific.
    const firstCapture = installRequestCapture({
      currentAgentKey: () => S4_AGENT,
      script: () =>
        readerStream(`Today's conclusion: bill against carrier account ${TICK_ONE_CONCLUSION}.`),
    })
    try {
      await driveTurn({
        orgId: S4_ORG,
        threadId: S4_THREAD,
        userId: S4_USER,
        agentId: S4_AGENT,
        content: TICK_ONE_TRIGGER,
        routineId: S4_ROUTINE,
      })
    } finally {
      firstCapture.restore()
    }
    const tickOneReply = await lastAgentReply(S4_ORG, S4_THREAD)
    expect(tickOneReply).toContain(TICK_ONE_CONCLUSION)

    // The transcript index is the recall substrate. In production the outbox
    // feeds the indexer; here the same production job is run directly.
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM kernel.messages WHERE org_id = ${S4_ORG} AND thread_id = ${S4_THREAD}
      ORDER BY created_at ASC, id ASC`
    const { processMessageIndexerJob } = await import("~/modules/search/message-indexer")
    for (const row of rows) {
      await processMessageIndexerJob({ action: "upsert", orgId: S4_ORG, messageId: row.id })
    }

    // TICK TWO asks the same question again, with no watch_state anywhere.
    const secondCapture = installRequestCapture({
      currentAgentKey: () => S4_AGENT,
      script: (t) => {
        secondTurn = t
        return readerStream(answerFromRequest(t))
      },
    })
    try {
      secondTickAnswer = await driveTurn({
        orgId: S4_ORG,
        threadId: S4_THREAD,
        userId: S4_USER,
        agentId: S4_AGENT,
        content: TICK_TWO_TRIGGER,
        routineId: S4_ROUTINE,
      })
    } finally {
      secondCapture.restore()
    }
  })

  afterAll(async () => {
    for (const s of spies) s.mockRestore()
    spies.length = 0
    resetOrgRuntimeForTest(S4_ORG)
    if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await meili.deleteIndex(S4_INDEX).catch(() => undefined)
    await sql`DELETE FROM kernel.routines WHERE org_id = ${S4_ORG}`
    await dropWorld(S4_ORG)
    await releaseTestLock()
  })

  it("the second routine tick references the first tick's conclusion with no watch_state in the prompt", () => {
    expect(routinePrompt).not.toContain("watch_state")
    expect(secondTickAnswer).toContain(TICK_ONE_CONCLUSION)
  })

  it("the tick reads the earlier conclusion through recall and not through its own rendered history", () => {
    // A tick anchors its history at its OWN trigger message, so the first
    // tick's transcript is in no byte of the second tick's cached prefix.
    expect(secondTurn.prefixText).not.toContain(TICK_ONE_CONCLUSION)
    expect(secondTurn.tailText).toContain(TICK_ONE_CONCLUSION)
  })
})

// ---------------------------------------------------------------------------
// Scenario 5: two agents in one channel
// ---------------------------------------------------------------------------

const S5_ORG = "4d000000-0000-4000-8000-000000000311"
const S5_USER = "4d000000-0000-4000-8000-000000000312"
const S5_THREAD = "4d000000-0000-4000-8000-000000000313"
const AGENT_LOGISTICS = "4d000000-0000-4000-8000-000000000314"
const AGENT_SUPPORT = "4d000000-0000-4000-8000-000000000315"
const S5_HIGH_SCOPE = "crm:deals:read"

/** Enough padded messages before and after the late join to cross 48,000 twice. */
const PRE_JOIN_MESSAGES = 32
const POST_JOIN_MESSAGES = 34
/** Messages above the late joiner's ceiling, posted after it joined. */
const ABOVE_CEILING_MESSAGES = 2

interface FlushRegionRow {
  agent_id: string
  from_message_id: string
  message_count: number
}

describe("P4m-T35 long memory scenario 5, two agents in one channel", () => {
  const spies: Array<{ mockRestore: () => void }> = []
  const preJoinIds: string[] = []
  const aboveCeilingIds: string[] = []
  let flushRegions: FlushRegionRow[] = []
  let joinedAt: string

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-long-memory-stub"
    spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "job") as never)
    CheckpointTestAccess.setSummarizer(async () => "Scripted per agent checkpoint summary.")
    await seedWorld({
      orgId: S5_ORG,
      userId: S5_USER,
      userEmail: "twoagents@test.com",
      agents: [
        {
          id: AGENT_LOGISTICS,
          handle: "@logisticsdesk",
          displayName: "Logistics",
          kind: "role",
          scopeCeiling: ["*"],
        },
        {
          id: AGENT_SUPPORT,
          handle: "@supportdesk",
          displayName: "Support",
          kind: "role",
          // A NARROWER CEILING: the high scope messages are outside it.
          scopeCeiling: ["kernel:threads:read"],
        },
      ],
      threads: [{ id: S5_THREAD, handle: "two-agent-channel", type: "thread" }],
    })
    // The early joiner is in the room from the first message.
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type, created_at)
      VALUES (${S5_THREAD}, ${AGENT_LOGISTICS}, ${S5_ORG}, 'agent', ${new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()}::timestamptz)`

    // An explicit clock, one second per message, so the late joiner's seat sits
    // unambiguously between two messages (see insertMessage's note).
    const base = Date.now() - 3 * 60 * 60 * 1000
    let clock = 0
    const post = async (content: string, requiredScopes: string[] = []) => {
      clock += 1
      return insertMessage({
        orgId: S5_ORG,
        threadId: S5_THREAD,
        authorId: S5_USER,
        authorType: "user",
        content,
        requiredScopes,
        createdAt: new Date(base + clock * 1000),
      })
    }

    for (let i = 0; i < PRE_JOIN_MESSAGES; i++) {
      const msg = await post(padded(`Channel message ${i}, before the support desk joined.`))
      preJoinIds.push(msg.id)
    }
    // The late joiner takes its seat here, and nothing before it is its own.
    clock += 1
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type, created_at)
      VALUES (${S5_THREAD}, ${AGENT_SUPPORT}, ${S5_ORG}, 'agent', ${new Date(base + clock * 1000).toISOString()}::timestamptz)`
    const [seat] = await sql<{ created_at: string }[]>`
      SELECT created_at FROM kernel.thread_participants
      WHERE thread_id = ${S5_THREAD} AND agent_id = ${AGENT_SUPPORT}`
    joinedAt = seat.created_at

    for (let i = 0; i < POST_JOIN_MESSAGES; i++) {
      await post(padded(`Channel message ${i}, after the support desk joined.`))
    }
    for (let i = 0; i < ABOVE_CEILING_MESSAGES; i++) {
      const msg = await post(padded(`Commercially sensitive note ${i}.`), [S5_HIGH_SCOPE])
      aboveCeilingIds.push(msg.id)
    }

    const driveFor = async (agentId: string) => {
      const capture = installRequestCapture({
        currentAgentKey: () => agentId,
        script: (t) => readerStream(answerFromRequest(t)),
      })
      try {
        await driveTurn({
          orgId: S5_ORG,
          threadId: S5_THREAD,
          userId: S5_USER,
          agentId,
          content: "Status please.",
        })
      } finally {
        capture.restore()
      }
    }
    await driveFor(AGENT_LOGISTICS)
    await driveFor(AGENT_SUPPORT)

    flushRegions = await sql<FlushRegionRow[]>`
      SELECT agent_id,
             metadata ->> 'fromMessageId' AS from_message_id,
             (metadata ->> 'messageCount')::int AS message_count
      FROM kernel.audit_log
      WHERE org_id = ${S5_ORG} AND action = 'memory_flush_region'
      ORDER BY timestamp ASC`
  })

  afterAll(async () => {
    CheckpointTestAccess.setSummarizer()
    for (const s of spies) s.mockRestore()
    spies.length = 0
    resetOrgRuntimeForTest(S5_ORG)
    if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await dropWorld(S5_ORG)
    await releaseTestLock()
  })

  it("each agent in a channel checkpoints only messages after its own join and within its ceiling", async () => {
    const logistics = flushRegions.filter((r) => r.agent_id === AGENT_LOGISTICS)
    const support = flushRegions.filter((r) => r.agent_id === AGENT_SUPPORT)
    // One advance each, and each advance flushed its own region exactly once.
    expect(logistics.length).toBe(1)
    expect(support.length).toBe(1)

    // The early joiner's region starts at the very first message of the room.
    expect(logistics[0].from_message_id).toBe(preJoinIds[0])
    // The late joiner's region starts after its seat was created, so it carries
    // none of the pre join stretch at all.
    expect(preJoinIds).not.toContain(support[0].from_message_id)
    const [firstSupportMessage] = await sql<{ created_at: string }[]>`
      SELECT created_at FROM kernel.messages WHERE id = ${support[0].from_message_id}`
    expect(new Date(firstSupportMessage.created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(joinedAt).getTime(),
    )

    // And its region is the smaller of the two by at least the pre join stretch.
    expect(logistics[0].message_count).toBeGreaterThan(support[0].message_count)
    expect(logistics[0].message_count - support[0].message_count).toBeGreaterThanOrEqual(
      PRE_JOIN_MESSAGES,
    )
  })

  it("a message above the late joiner's ceiling is in neither its checkpoint region nor its tail", async () => {
    const support = flushRegions.filter((r) => r.agent_id === AGENT_SUPPORT)
    expect(aboveCeilingIds).not.toContain(support[0].from_message_id)
    // The narrow ceiling really was narrower: the wide agent's summary covers
    // the sensitive notes, so their absence below is the ceiling, not the clock.
    const [summaryRow] = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.agent_thread_checkpoints
      WHERE org_id = ${S5_ORG} AND agent_id = ${AGENT_SUPPORT} ORDER BY version DESC LIMIT 1`
    expect(summaryRow.required_scopes).not.toContain(S5_HIGH_SCOPE)
  })
})
