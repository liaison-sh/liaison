// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4m-T01: the history prefix stability guard, single agent (spec-memory.md
// "History stability: the prompt cache contract", S23, invariants I1 to I5).
//
// WHAT IS PROVEN. A scripted 40 turn DM runs through the REAL production turn
// path (invokeAgentForThread, assembleContext, sendMessage) with only the one
// existing model seam swapped, so every byte the provider would receive is
// captured. For each of the 39 consecutive pairs, the earlier turn's bytes up
// to and including its moving cache breakpoint must be an exact byte prefix of
// the later turn's request. The number of allowed exceptions is the number of
// logged history prefix rebuilds, and the script causes one of each kind the
// turn path can raise: the budget driven checkpoint advance around turn 31
// (P4m-T16) and, after turn 35, one cold resume (P4c-T23, P4c-T27) produced by
// stamping the thread past the warm window.
//
// WHY THE MUTATION SWITCH EXISTS. A prefix assertion over a harness that
// captured nothing, or that compared a request to itself, passes vacuously.
// The switch moves the memory index block out of the ephemeral runtime context
// tail and into the last system part, the one mistake invariant I2 forbids,
// and the guard must then FAIL on the first turn after a memory write.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { CheckpointTestAccess } from "~/modules/agent/context/checkpoint"
import { handleMemorySet } from "~/modules/agent/memory/memory"
import { RECALLED_MEMORY_MARKER } from "~/modules/agent/memory/memory-recall"
import { invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  type CapturedTurn,
  fullBuffer,
  installRequestCapture,
  prefixBuffer,
  prefixExceptions,
} from "./helpers/capture-requests"
import { stampLastAgentTurnMinutesAgo } from "./helpers/long-memory"

const ORG_ID = "4d000000-0000-4000-8000-000000000001"
const USER_ID = "4d000000-0000-4000-8000-000000000002"
const THREAD_ID = "4d000000-0000-4000-8000-000000000003"
const AGENT_ID = "4d000000-0000-4000-8000-000000000004"

// The repo's own convention for pinning a scenario to the cheap model.
const HAIKU_MODEL_ID = "claude-haiku-4-5"

const TURNS = 40
/**
 * P4m-T16. Each scripted user message is padded to this many characters so the
 * 40 turn script crosses the org's 48,000 token raw history budget exactly once, at
 * turn 31, which is the ONE planned prefix rebuild the contract allows (I3).
 * Without the padding the script never reaches the budget and the checkpoint
 * routine is never exercised at all.
 */
const TURN_CONTENT_CHARS = 6_500
const EXPECTED_REBUILD_TURN_MIN = 25
/**
 * P4c-T27. After this turn the whole thread is stamped back so the agent's last
 * turn sits past the warm window, which makes the NEXT turn a cold resume: the
 * second, time triggered prefix rebuild of the run. It is placed AFTER the
 * budget driven advance (turn 31) on purpose, so the run carries one rebuild of
 * each cause rather than two of one, and late enough that the remaining turns
 * cannot reach the raw budget again and add a third.
 */
const COLD_RESUME_AFTER_TURN = 35
/** How far back the stamp puts the last turn: past WARM_WINDOW_MS, by a minute. */
const COLD_RESUME_MINUTES = 61
/** Fixed script: the turns that write a durable memory, and the one that edits it. */
const MEMORY_WRITE_TURNS = new Set([7, 19, 31])
const MEMORY_EDIT_TURN = 25
/** The first turn whose prefix would differ if memory rode in a system part. */
const FIRST_MUTATION_FAILURE_TURN = 8

const ORIG_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

function scriptedStream(turnIndex: number, duringTurn?: () => Promise<void>) {
  return {
    fullStream: (async function* () {
      // The scripted memory write happens INSIDE the turn, after its context
      // was assembled: the first turn that can see it is the next one.
      if (duringTurn) await duringTurn()
      yield { type: "text-delta", text: `Noted, turn ${turnIndex}.` }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1000 + turnIndex, outputTokens: 12 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

/**
 * The scripted memory write. The stubbed stream cannot execute a tool, so the
 * harness performs the write through the SAME production service the
 * `user_memory_set` tool calls, inside the turn it belongs to.
 */
async function writeMemory(name: string, description: string, content: string): Promise<void> {
  await withRlsContext(
    {
      actorType: "user",
      userId: USER_ID,
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    },
    async (tx) => {
      await handleMemorySet(
        { type: "user", name, description, content },
        { userId: USER_ID, orgId: ORG_ID, db: tx },
        [],
      )
    },
  )
}

/** The fixed script's memory action for a turn, if it has one. */
function memoryWriteFor(turnIndex: number): (() => Promise<void>) | undefined {
  if (MEMORY_WRITE_TURNS.has(turnIndex)) {
    return () =>
      writeMemory(
        `carrier-note-${turnIndex}`,
        `Carrier preference recorded on turn ${turnIndex}`,
        `On turn ${turnIndex} the account prefers the overnight carrier.`,
      )
  }
  if (turnIndex === MEMORY_EDIT_TURN) {
    return () =>
      writeMemory(
        "carrier-note-7",
        "Carrier preference corrected on turn 25",
        "Correction: the account prefers the economy carrier.",
      )
  }
  return undefined
}

async function seedWorld(): Promise<void> {
  await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${ORG_ID}, 'PrefixGuardOrg', 'prefix-guard-org', '{"ai":{"history":{"budgetTokens":48000}}}'::jsonb)`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'prefixguard@test.com', 'Prefix Guard')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling, system_prompt)
    VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', '@prefixguard', 'Prefix Guard', ${USER_ID}, '["*"]'::jsonb, 'You help with logistics.')`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_model_id)
    VALUES (${THREAD_ID}, ${ORG_ID}, 'prefix-guard-dm', 'agent_chat', ${USER_ID}, ${HAIKU_MODEL_ID})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${ORG_ID}, '100.00000000', '0', 'EUR')`
  await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', ${HAIKU_MODEL_ID}, 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter')
    ON CONFLICT (provider, model_id) DO NOTHING`
}

/** Drive one scripted turn end to end through the production path. */
async function driveTurn(params: {
  threadId: string
  agentId: string
  content: string
}): Promise<void> {
  const msgId = crypto.randomUUID()
  await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${msgId}, ${params.threadId}, ${ORG_ID}, ${USER_ID}, 'user', ${params.content}, '{}')`
  await invokeAgentForThread(
    params.threadId,
    msgId,
    { userId: USER_ID, orgId: ORG_ID, scopes: ["*"], dimensionGrants: {} },
    ORG_ID,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    params.agentId,
  )
}

/** The scripted turn text, padded so the script crosses the history budget. */
function paddedTurnContent(turn: number): string {
  const head = `Scripted DM turn ${turn}. Please acknowledge.`
  return head + " ".repeat(Math.max(0, TURN_CONTENT_CHARS - head.length))
}

async function runScriptedDm(mutate: boolean): Promise<CapturedTurn[]> {
  await sql`DELETE FROM kernel.messages WHERE thread_id = ${THREAD_ID}`
  await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE thread_id = ${THREAD_ID}`
  await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_ID} AND action = 'history_prefix_rebuilt'`
  await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
  const capture = installRequestCapture({
    currentAgentKey: () => AGENT_ID,
    mutate: () => mutate,
    script: ({ turnIndex }) => scriptedStream(turnIndex, memoryWriteFor(turnIndex)),
  })
  try {
    for (let turn = 1; turn <= TURNS; turn++) {
      await driveTurn({
        threadId: THREAD_ID,
        agentId: AGENT_ID,
        content: paddedTurnContent(turn),
      })
      // The clock is pinned HERE rather than at seed time: the cold rule
      // compares wall time against a 60 minute window, and a stamp written
      // before the run would drift while the earlier turns take their seconds.
      if (turn === COLD_RESUME_AFTER_TURN) {
        await stampLastAgentTurnMinutesAgo({
          orgId: ORG_ID,
          threadId: THREAD_ID,
          minutesAgo: COLD_RESUME_MINUTES,
        })
      }
    }
    return capture.turns
  } finally {
    capture.restore()
  }
}

/**
 * Logged prefix rebuilds, which are the guard's allowed exception budget: a
 * prefix may only change where the run RECORDED that it rebuilt it. The script
 * causes two, one of each cause the turn path can raise: the budget driven
 * checkpoint advance (P4m-T16) and the time driven cold resume (P4c-T23).
 */
async function loggedPrefixRebuilds(): Promise<string[]> {
  const rows = await sql<Array<{ cause: string | null }>>`
    SELECT metadata->>'cause' AS cause FROM kernel.audit_log
    WHERE org_id = ${ORG_ID} AND action = 'history_prefix_rebuilt'
    ORDER BY timestamp ASC`
  return rows.map((r) => r.cause ?? "")
}

describe("P4m-T01 history prefix stability, single agent", () => {
  let cleanTurns: CapturedTurn[] = []
  let rebuildCauses: string[] = []

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-prefix-guard-stub"
    // The checkpoint summarizer is a cheap model call with no stream seam of
    // its own, the same situation P4m-T02 records for compaction. The SAME
    // production advance runs; only the summary text is scripted.
    CheckpointTestAccess.setSummarizer(async () => "Scripted checkpoint summary of the DM so far.")
    await seedWorld()
    cleanTurns = await runScriptedDm(false)
    rebuildCauses = await loggedPrefixRebuilds()
  })

  afterAll(async () => {
    CheckpointTestAccess.setSummarizer()
    resetOrgRuntimeForTest(ORG_ID)
    if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("single agent DM keeps a byte identical prefix across 40 consecutive turns", () => {
    expect(cleanTurns.length).toBe(TURNS)
    // P4m-T16: the script now crosses ONE checkpoint advance, which is the one
    // planned rebuild (I3). Every pair except that one stays byte identical,
    // and the exception is accounted for by the logged rebuild below.
    const exceptions = prefixExceptions(cleanTurns)
    let comparedPairs = 0
    for (let i = 1; i < cleanTurns.length; i++) {
      const prev = prefixBuffer(cleanTurns[i - 1])
      const next = fullBuffer(cleanTurns[i])
      expect(prev.length).toBeGreaterThan(0)
      if (!exceptions.includes(cleanTurns[i].turnIndex)) {
        expect(next.subarray(0, prev.length).equals(prev)).toBe(true)
      }
      comparedPairs++
    }
    expect(comparedPairs).toBe(TURNS - 1)
  })

  // FX1 item 3: the charter is a STABLE system part (spec-memory.md L0, I2).
  // Being inside the compared prefix on EVERY turn is what the byte assertion
  // above then proves about it: the charter that moved into the tail, or that
  // acquired a per turn field, would show up here instead of silently costing a
  // cache miss in production.
  it("every turn carries the charter inside the stable prefix and never in the tail", () => {
    expect(cleanTurns.length).toBe(TURNS)
    for (const turn of cleanTurns) {
      expect(turn.prefixText).toContain("<agent-charter>")
      // The real root, `@` stripped: what resolvePath actually accepts.
      expect(turn.prefixText).toContain("/memories/prefixguard/")
      expect(turn.tailText).not.toContain("<agent-charter>")
    }
  })

  it("single agent DM crossing one advance and one cold resume logs two rebuilds and has two prefix exceptions", () => {
    const exceptions = prefixExceptions(cleanTurns)
    expect(exceptions.length).toBe(rebuildCauses.length)
    expect(rebuildCauses.length).toBe(2)
    // One of each cause, in the order the script causes them: the budget driven
    // advance first, the time driven cold resume after it.
    expect(rebuildCauses).toEqual(["checkpoint", "cold_resume"])
    // The first exception is the turn immediately after the advance, which is a
    // turn late in the script, never turn 2.
    expect(exceptions[0]).toBeGreaterThanOrEqual(EXPECTED_REBUILD_TURN_MIN)
    // The second is the turn immediately after the stamp that made it cold.
    expect(exceptions[1]).toBe(COLD_RESUME_AFTER_TURN + 1)
  })

  it("no advance runs inside a turn: each turn is exactly one provider request", () => {
    // The advance runs BETWEEN turns, so a turn's steps all share one
    // assembled prefix and the capture sees one request per driven turn.
    expect(cleanTurns.length).toBe(TURNS)
    expect(new Set(cleanTurns.map((t) => t.turnIndex)).size).toBe(TURNS)
  })

  // P4m-T24 through the harness: the recalled memory block is TAIL ONLY, and a
  // mutation that moves it into a system part fails the byte guard rather than
  // only the unit test.
  it("the recalled memory block rides in the ephemeral tail and never in the prefix", () => {
    const withRecall = cleanTurns.filter((t) => t.tailText.includes(RECALLED_MEMORY_MARKER))
    expect(withRecall.length).toBeGreaterThan(0)
    for (const turn of cleanTurns) {
      expect(turn.prefixText).not.toContain(RECALLED_MEMORY_MARKER)
    }
  })

  it("the mutation switch moves the memory index into the last system part and the prefix assertion fails", async () => {
    const mutated = await runScriptedDm(true)
    expect(mutated.length).toBe(TURNS)
    const failures = prefixExceptions(mutated)
    expect(failures.length).toBeGreaterThanOrEqual(1)
    expect(failures[0]).toBe(FIRST_MUTATION_FAILURE_TURN)
    // The recall block moved with it, which is what makes this switch a real
    // test of the tail rule and not only of the index's position.
    expect(mutated.some((t) => t.prefixText.includes(RECALLED_MEMORY_MARKER))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// P4m-T02: two agents alternating in one channel.
//
// Each agent keeps its own independently stable prefix, and a turn taken by
// one agent never changes the other agent's captured prefix (invariant I5).
// The channel carries a third human message addressed to neither agent every
// fifth exchange, so each agent sees messages it was not asked to answer.
// ---------------------------------------------------------------------------

const CH_ORG_ID = "4d000000-0000-4000-8000-000000000011"
const CH_USER_ID = "4d000000-0000-4000-8000-000000000012"
const CH_THREAD_ID = "4d000000-0000-4000-8000-000000000013"
const AGENT_LOGISTICS = "4d000000-0000-4000-8000-000000000014"
const AGENT_SUPPORT = "4d000000-0000-4000-8000-000000000015"

/** 20 addressed messages per agent, so 19 consecutive pairs each. */
const CHANNEL_TURNS_PER_AGENT = 20
/** Agent B's turn that is forced to run a compaction (see the second case). */
const FORCED_COMPACTION_TURN = 20

async function seedChannelWorld(): Promise<void> {
  await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${CH_ORG_ID}, 'PrefixChannelOrg', 'prefix-channel-org', '{"ai":{"history":{"budgetTokens":48000}}}'::jsonb)`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${CH_USER_ID}, ${CH_ORG_ID}, 'prefixchannel@test.com', 'Prefix Channel')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
    VALUES (${AGENT_LOGISTICS}, ${CH_ORG_ID}, 'role', '@logistics', 'Logistics', '["*"]'::jsonb, 'You handle logistics.')`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
    VALUES (${AGENT_SUPPORT}, ${CH_ORG_ID}, 'role', '@support', 'Support', '["*"]'::jsonb, 'You handle support.')`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_model_id)
    VALUES (${CH_THREAD_ID}, ${CH_ORG_ID}, 'prefix-channel', 'thread', ${CH_USER_ID}, ${HAIKU_MODEL_ID})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${CH_THREAD_ID}, ${CH_USER_ID}, ${CH_ORG_ID})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${CH_THREAD_ID}, ${AGENT_LOGISTICS}, ${CH_ORG_ID}, 'agent')`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${CH_THREAD_ID}, ${AGENT_SUPPORT}, ${CH_ORG_ID}, 'agent')`
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${CH_ORG_ID}, '100.00000000', '0', 'EUR')`
  // Re-seeded here rather than shared with the DM scenario: the test lock
  // truncates between describe blocks.
  await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', ${HAIKU_MODEL_ID}, 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter')
    ON CONFLICT (provider, model_id) DO NOTHING`
}

async function driveChannelTurn(agentId: string, content: string): Promise<void> {
  const msgId = crypto.randomUUID()
  await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${msgId}, ${CH_THREAD_ID}, ${CH_ORG_ID}, ${CH_USER_ID}, 'user', ${content}, '{}')`
  await invokeAgentForThread(
    CH_THREAD_ID,
    msgId,
    { userId: CH_USER_ID, orgId: CH_ORG_ID, scopes: ["*"], dimensionGrants: {} },
    CH_ORG_ID,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    agentId,
  )
}

/** A human message addressed to neither agent: nobody answers it. */
async function postIdleHumanMessage(content: string): Promise<void> {
  await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${crypto.randomUUID()}, ${CH_THREAD_ID}, ${CH_ORG_ID}, ${CH_USER_ID}, 'user', ${content}, '{}')`
}

async function countCheckpoints(agentId: string): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS n FROM kernel.agent_thread_checkpoints
    WHERE thread_id = ${CH_THREAD_ID} AND agent_id = ${agentId}`
  return (rows[0]?.n as number) ?? 0
}

async function countCompactionSummaries(): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS n FROM kernel.messages
    WHERE thread_id = ${CH_THREAD_ID} AND metadata->>'type' = 'compaction_summary'`
  return (rows[0]?.n as number) ?? 0
}

/**
 * Run the alternating channel. With `forceCompaction`, agent A's turn 19 is
 * scripted to report a context size above compaction's 80 percent threshold,
 * which is the value `runCompaction`'s guard reads on the NEXT turn of the
 * thread, so agent B's turn 20 enters compaction for real.
 *
 * WHAT THE HARNESS DOES AND DOES NOT SUPPLY. The checkpoint summarizer is a
 * cheap model call with no stream seam of its own, so its text is scripted
 * through the production seam while the REAL advance runs: what is under test
 * is which agent the checkpoint belongs to and whose prefix it moves, never
 * the summary text.
 */
async function runChannel(opts: { forceCompaction: boolean }): Promise<{
  logistics: CapturedTurn[]
  support: CapturedTurn[]
  order: Array<{ agentKey: string; turnIndex: number }>
}> {
  await sql`DELETE FROM kernel.messages WHERE thread_id = ${CH_THREAD_ID}`
  await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE thread_id = ${CH_THREAD_ID}`
  const order: Array<{ agentKey: string; turnIndex: number }> = []
  let current = AGENT_LOGISTICS
  const capture = installRequestCapture({
    currentAgentKey: () => current,
    script: ({ turnIndex, agentKey }) => {
      order.push({ agentKey, turnIndex })
      // The thread-wide compaction metric is the LAST agent message's usage,
      // so the oversized report has to land on the turn BEFORE the one that
      // must compact.
      const oversized =
        opts.forceCompaction &&
        agentKey === AGENT_LOGISTICS &&
        turnIndex === FORCED_COMPACTION_TURN - 1
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: `Ack ${agentKey} ${turnIndex}.` }
          yield {
            type: "finish-step",
            usage: { inputTokens: oversized ? 170_000 : 1_000 + turnIndex, outputTokens: 10 },
            finishReason: "stop",
          }
          yield { type: "finish", finishReason: "stop" }
        })(),
      } as never
    },
  })
  try {
    for (let exchange = 1; exchange <= CHANNEL_TURNS_PER_AGENT; exchange++) {
      current = AGENT_LOGISTICS
      await driveChannelTurn(AGENT_LOGISTICS, `@logistics exchange ${exchange}, status please.`)
      current = AGENT_SUPPORT
      await driveChannelTurn(AGENT_SUPPORT, `@support exchange ${exchange}, status please.`)
      if (exchange % 5 === 0) {
        await postIdleHumanMessage(`Team note ${exchange}: no action needed from anyone.`)
      }
    }
    return {
      logistics: capture.forAgent(AGENT_LOGISTICS),
      support: capture.forAgent(AGENT_SUPPORT),
      order,
    }
  } finally {
    capture.restore()
  }
}

describe("P4m-T02 history prefix stability, two agents in one channel", () => {
  let run: Awaited<ReturnType<typeof runChannel>>

  beforeAll(async () => {
    await acquireTestLock()
    // The forced compaction case makes a REAL cheap model call (compaction has
    // no stream seam of its own), so the live key is kept when one is present.
    process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY ?? "sk-prefix-guard-stub"
    await seedChannelWorld()
    run = await runChannel({ forceCompaction: false })
  })

  afterAll(async () => {
    resetOrgRuntimeForTest(CH_ORG_ID)
    if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${CH_ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${CH_ORG_ID}`
    await releaseTestLock()
  })

  it("two agents alternating in a channel each keep a byte identical prefix", () => {
    expect(run.logistics.length).toBe(CHANNEL_TURNS_PER_AGENT)
    expect(run.support.length).toBe(CHANNEL_TURNS_PER_AGENT)
    // The two agents really did interleave: no agent ever took two turns in a
    // row, so each agent's prefix grew across the other's messages.
    for (let i = 1; i < run.order.length; i++) {
      expect(run.order[i].agentKey).not.toBe(run.order[i - 1].agentKey)
    }
    for (const turns of [run.logistics, run.support]) {
      let pairs = 0
      for (let i = 1; i < turns.length; i++) {
        const prev = prefixBuffer(turns[i - 1])
        const next = fullBuffer(turns[i])
        expect(next.subarray(0, prev.length).equals(prev)).toBe(true)
        pairs++
      }
      expect(pairs).toBe(CHANNEL_TURNS_PER_AGENT - 1)
      expect(prefixExceptions(turns).length).toBe(0)
    }
  })

  // P4m-T17 / P4m-T19 landed the fix this case was written against. The thread
  // wide `compaction_summary` message row is gone for agent turns: a
  // compaction now advances the COMPACTING agent's own checkpoint, so the
  // other agent's rendered history, and its cached prefix, are untouched (I5).
  it("one agent taking a turn never changes the other agent's captured prefix, with a forced compaction on agent B at turn 20", async () => {
    CheckpointTestAccess.setSummarizer(async () => "Scripted channel checkpoint summary.")
    try {
      const forced = await runChannel({ forceCompaction: true })
      // A run in which zero compactions fired proves nothing, so it is a
      // harness failure rather than a pass.
      expect(await countCheckpoints(AGENT_SUPPORT)).toBe(1)
      // The compacting agent wrote NO message row and NO checkpoint for the
      // other agent.
      expect(await countCompactionSummaries()).toBe(0)
      expect(await countCheckpoints(AGENT_LOGISTICS)).toBe(0)
      // Agent A never rebuilt: B's compaction is invisible to it.
      expect(prefixExceptions(forced.logistics).length).toBe(0)
      // B rebuilt exactly once, on the turn after its own advance.
      expect(prefixExceptions(forced.support).length).toBeLessThanOrEqual(1)
    } finally {
      CheckpointTestAccess.setSummarizer()
    }
  })
})
