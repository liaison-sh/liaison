// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4m-T15: the bounded history load (spec-memory.md L4, budgets table).

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { rootLogger } from "~/lib/logger"
import {
  advanceCheckpoint,
  CheckpointTestAccess,
  checkpointRawTailReserve,
  historyBudget,
  loadBoundedHistory,
  loadCurrentCheckpoint,
  loadFrozenCore,
  stripRetrievalToolParts,
  trimHistoryToBudget,
} from "~/modules/agent/context/checkpoint"
import { BRIEF_CORE_TOKEN_BUDGET } from "~/modules/agent/context/cold-resume"
import { estimateTokens } from "~/modules/agent/context/compaction"
import { assembleContext, stepInputBreakdown } from "~/modules/agent/context/context"
import {
  loadOrgHistorySettings,
  setOrgHistorySettings,
} from "~/modules/agent/context/history-settings"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "4c000000-0000-4000-8000-000000000001"
const USER_ID = "4c000000-0000-4000-8000-000000000002"
const AGENT_ID = "4c000000-0000-4000-8000-000000000003"
const SMALL_THREAD = "4c000000-0000-4000-8000-000000000004"
const BIG_THREAD = "4c000000-0000-4000-8000-000000000005"
const LEGACY_THREAD = "4c000000-0000-4000-8000-000000000006"
const ADVANCE_THREAD = "4c000000-0000-4000-8000-000000000007"
/** Big enough that 100 messages are over the raw reserve (24,000 tokens at a 48,000 budget). */
const FAT_MESSAGE_CHARS = 2_000

/**
 * The window these tests run under: 40 percent of it is a 48,000 token history
 * budget, so a few hundred seeded rows cross it (a 1M window gets 256,000).
 */
const TEST_WINDOW = 120_000

const actor: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

/** Seed `count` user messages in thread order, returning their ids in order. */
async function seedMessages(
  threadId: string,
  count: number,
  padTo = 0,
  from = 1,
): Promise<string[]> {
  const ids: string[] = []
  for (let i = from; i < from + count; i++) {
    const id = crypto.randomUUID()
    ids.push(id)
    const body = `Message ${i}`
    const content = padTo > body.length ? body + "x".repeat(padTo - body.length) : body
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, created_at, required_scopes)
      VALUES (${id}, ${threadId}, ${ORG_ID}, ${USER_ID}, 'user', ${content},
        ${new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 1000).toISOString()}, '{}')`
  }
  return ids
}

async function seedThread(threadId: string, handle: string): Promise<void> {
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${threadId}, ${ORG_ID}, ${handle}, 'agent_chat', ${USER_ID})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
    VALUES (${threadId}, ${USER_ID}, ${ORG_ID})`
}

describe("P4m-T15 bounded history load", () => {
  let bigIds: string[] = []
  let advanceIds: string[] = []

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'CheckpointOrg', 'checkpoint-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'checkpoint@test.com', 'Checkpoint')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling, system_prompt)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', '@checkpoint', 'Checkpoint', ${USER_ID}, '["*"]'::jsonb, 'You help.')`
    await seedThread(SMALL_THREAD, "checkpoint-small")
    await seedThread(BIG_THREAD, "checkpoint-big")
    await seedThread(LEGACY_THREAD, "checkpoint-legacy")
    await seedThread(ADVANCE_THREAD, "checkpoint-advance")
    await seedMessages(SMALL_THREAD, 30)
    bigIds = await seedMessages(BIG_THREAD, 400)
    await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
      VALUES (${ORG_ID}, ${AGENT_ID}, ${BIG_THREAD}, ${bigIds[299]}, 'Summary of the first 300 messages.', '{}', 42, 1)`
    advanceIds = await seedMessages(ADVANCE_THREAD, 400, FAT_MESSAGE_CHARS)
    await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
      VALUES (${ORG_ID}, ${AGENT_ID}, ${ADVANCE_THREAD}, ${advanceIds[299]}, 'Version one summary.', '{}', 5, 1)`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_briefs WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_brief_marks WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_episodes WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("historyBudget gives 256k to every window that holds it, and clamps the small ones", () => {
    // 1M-class windows (DeepSeek V4.1 Flash 1,048,576; Claude Opus/Sonnet
    // 1,000,000; GPT-5.4 and Gemini 1,048,576): the full 256,000.
    expect(historyBudget(1_048_576)).toBe(256_000)
    expect(historyBudget(1_000_000)).toBe(256_000)
    // The smallest unclamped window: 0.8 x 440,000 - 96,000 = 256,000.
    expect(historyBudget(440_000)).toBe(256_000)
    // Mistral Small 262,144: 0.8w - 96k = 113,715.
    expect(historyBudget(262_144)).toBe(113_715)
    // Claude Haiku 200,000: 40 percent (80,000) beats 0.8w - 96k (64,000).
    expect(historyBudget(200_000)).toBe(80_000)
    // Mistral Large 128,000 and a custom server's default 32,768.
    expect(historyBudget(128_000)).toBe(51_200)
    expect(historyBudget(32_768)).toBe(13_107)
    // The window these tests run under: a 48,000 budget.
    expect(historyBudget(TEST_WINDOW)).toBe(48_000)
    // Unknown window: the cap.
    expect(historyBudget(0)).toBe(256_000)
  })

  it("historyBudget honours a configured cap, floored at 32k, and still clamps to the window", () => {
    expect(historyBudget(1_048_576, 100_000)).toBe(100_000)
    expect(historyBudget(1_048_576, 500_000)).toBe(500_000)
    expect(historyBudget(1_048_576, 1_000)).toBe(32_000)
    expect(historyBudget(200_000, 500_000)).toBe(80_000)
    expect(historyBudget(0, 64_000)).toBe(64_000)
  })

  it("an advance folds the tail to half the budget, so the next advance is half a budget away", () => {
    expect(checkpointRawTailReserve(256_000)).toBe(128_000)
    expect(checkpointRawTailReserve(48_000)).toBe(24_000)
  })

  it("a thread under the budget loads every raw message and no checkpoint", async () => {
    const loaded = await loadBoundedHistory({
      threadId: SMALL_THREAD,
      orgId: ORG_ID,
      actor,
      agentId: AGENT_ID,
      contextWindow: TEST_WINDOW,
    })
    expect(loaded.checkpoint).toBeNull()
    expect(loaded.messages.length).toBe(30)
    expect(loaded.overBudget).toBe(false)
  })

  it("a thread over the budget loads the checkpoint summary followed by only the tail after uptoMessageId", async () => {
    const loaded = await loadBoundedHistory({
      threadId: BIG_THREAD,
      orgId: ORG_ID,
      actor,
      agentId: AGENT_ID,
      contextWindow: TEST_WINDOW,
    })
    expect(loaded.checkpoint?.summary).toBe("Summary of the first 300 messages.")
    expect(loaded.messages.length).toBe(100)
    expect(loaded.messages[0].content).toBe("Message 301")
  })

  // --- A50: the raw tail cap is ENFORCED on the turn, not by the next advance
  describe("the raw tail cap is enforced on the turn being assembled", () => {
    const BUDGET_THREAD = "4c000000-0000-4000-8000-0000000000c1"
    const TOOL_THREAD = "4c000000-0000-4000-8000-0000000000c2"
    const TOOL_ADVANCE_THREAD = "4c000000-0000-4000-8000-0000000000c3"

    it("a 70 message tail of 900 tokens each comes back under the budget, with the checkpoint brief", async () => {
      await seedThread(BUDGET_THREAD, "checkpoint-budget")
      // 900 tokens per message, 70 messages: 63,000 raw tokens against 48,000.
      const ids = await seedMessages(BUDGET_THREAD, 70, 900 * 4)
      await sql`INSERT INTO kernel.agent_thread_checkpoints
        (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
        VALUES (${ORG_ID}, ${AGENT_ID}, ${BUDGET_THREAD}, null, 'Everything before the tail.', '{}', 20, 1)`

      const loaded = await loadBoundedHistory({
        threadId: BUDGET_THREAD,
        orgId: ORG_ID,
        actor,
        agentId: AGENT_ID,
        contextWindow: TEST_WINDOW,
      })
      // The LOAD still returns the whole tail: the advance summarizes from it.
      expect(loaded.budgetTokens).toBe(48_000)
      expect(loaded.messages.length).toBe(70)
      expect(loaded.overBudget).toBe(true)

      // The PROMPT is capped.
      const ctx = await assembleContext({
        threadId: BUDGET_THREAD,
        orgId: ORG_ID,
        actor,
        agentId: AGENT_ID,
        contextWindow: TEST_WINDOW,
      })
      const historyTokens = estimateTokens(
        ctx.messages
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n"),
      )
      expect(historyTokens).toBeLessThanOrEqual(48_000)
      // The brief rides in front of the trimmed tail and is never a candidate.
      const rendered = ctx.messages
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n")
      expect(rendered).toContain("Everything before the tail.")
      // Trimmed from the OLDEST end: the newest message is always kept.
      expect(rendered).not.toContain("Message 1x")
      expect(rendered).toContain("Message 70")
      expect(ids.length).toBe(70)
    })

    it("a replayed tool result counts against the budget, not only the row's text", async () => {
      await seedThread(TOOL_THREAD, "checkpoint-tool-budget")
      // Twenty agent rows whose TEXT is a few tokens each and whose stored tool
      // result is the replay cap. Measured on content alone this tail reads as
      // near zero and sails over the budget unseen.
      const fat = "y".repeat(60_000)
      for (let i = 0; i < 20; i++) {
        const meta = JSON.stringify({
          toolCalls: [
            { toolCallId: `c${i}`, toolName: "tickets__get", args: {}, result: { body: fat } },
          ],
        })
        await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_agent_id, author_type, content, metadata, created_at, required_scopes)
          VALUES (${TOOL_THREAD}, ${ORG_ID}, ${USER_ID}, ${AGENT_ID}, 'agent', 'Read it.', ${meta}::jsonb,
            ${new Date(Date.UTC(2026, 0, 2, 0, 0, 0) + i * 1000).toISOString()}, '{}')`
      }
      const loaded = await loadBoundedHistory({
        threadId: TOOL_THREAD,
        orgId: ORG_ID,
        actor,
        agentId: AGENT_ID,
        contextWindow: TEST_WINDOW,
      })
      // Measured on content alone this tail is 20 rows of "Read it.", under a
      // hundred tokens, and every replayed result rode along unseen.
      const contentOnly = estimateTokens(loaded.messages.map((m) => m.content ?? "").join("\n"))
      expect(contentOnly).toBeLessThan(100)
      expect(loaded.estimatedTokens).toBeGreaterThan(50 * contentOnly)
      expect(loaded.estimatedTokens).toBeGreaterThan(5_000)
      // ...and the trim measures the same way, so a tail of tool results is
      // trimmable at all.
      const trimmed = trimHistoryToBudget(loaded.messages, 2_000)
      expect(trimmed.droppedRows).toBeGreaterThan(0)
      expect(trimmed.keptTokens).toBeLessThanOrEqual(2_000)
    })

    // THE REGRESSION THE TRIM ROUND LEFT BEHIND. The budget measure became row
    // complete (text plus the replayed tool calls) while the RESERVE measure
    // stayed on `content` alone, so a tool heavy tail was over the budget by
    // tens of thousands of tokens and still found no boundary: every turn came
    // back "under-reserve", no checkpoint was ever written, and the thread's
    // `agentContextFrom` stayed null while the prefix grew without bound.
    it("an over budget tail of tool results advances the checkpoint, and is never reported under-reserve", async () => {
      await seedThread(TOOL_ADVANCE_THREAD, "checkpoint-tool-advance")
      // Ten 2,000 char fields per result: the replay cap keeps 16,000 chars of
      // it, so one row costs about 4,000 tokens on replay while its TEXT is
      // eight characters. Twenty five rows clear the 48,000 token budget.
      const fatResult = Object.fromEntries(
        Array.from({ length: 10 }, (_, f) => [`field${f}`, "z".repeat(2_000)]),
      )
      for (let i = 0; i < 25; i++) {
        const meta = JSON.stringify({
          toolCalls: [
            { toolCallId: `a${i}`, toolName: "tickets__get", args: {}, result: fatResult },
          ],
        })
        await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_agent_id, author_type, content, metadata, created_at, required_scopes)
          VALUES (${TOOL_ADVANCE_THREAD}, ${ORG_ID}, ${USER_ID}, ${AGENT_ID}, 'agent', 'Read it.', ${meta}::jsonb,
            ${new Date(Date.UTC(2026, 0, 3, 0, 0, 0) + i * 1000).toISOString()}, '{}')`
      }
      const loaded = await loadBoundedHistory({
        threadId: TOOL_ADVANCE_THREAD,
        orgId: ORG_ID,
        actor,
        agentId: AGENT_ID,
        contextWindow: TEST_WINDOW,
      })
      expect(loaded.overBudget).toBe(true)
      expect(loaded.estimatedTokens).toBeGreaterThan(60_000)

      CheckpointTestAccess.setSummarizer(async () => "The tool heavy stretch, summarized.")
      try {
        const result = await advanceCheckpoint({
          agentId: AGENT_ID,
          threadId: TOOL_ADVANCE_THREAD,
          orgId: ORG_ID,
          actor,
          contextWindow: TEST_WINDOW,
        })
        expect(result.reason).not.toBe("under-reserve")
        expect(result.advanced).toBe(true)
      } finally {
        CheckpointTestAccess.setSummarizer(undefined)
      }
      const after = await loadCurrentCheckpoint({
        agentId: AGENT_ID,
        threadId: TOOL_ADVANCE_THREAD,
        orgId: ORG_ID,
        actor,
      })
      expect(after?.uptoMessageId).not.toBeNull()
    })

    // The caller logs a skip on the TAIL, not on the reason: an over budget
    // tail that does not advance is the failure, whatever it is called.
    it("a skipped advance reports the measurement the caller logs", async () => {
      CheckpointTestAccess.setSummarizer(async () => null)
      try {
        const result = await advanceCheckpoint({
          agentId: AGENT_ID,
          threadId: TOOL_ADVANCE_THREAD,
          orgId: ORG_ID,
          actor,
          contextWindow: TEST_WINDOW,
        })
        expect(result.advanced).toBe(false)
        expect(typeof result.overBudget).toBe("boolean")
        expect(result.budgetTokens).toBe(48_000)
        expect(result.estimatedTokens).toBeGreaterThan(0)
      } finally {
        CheckpointTestAccess.setSummarizer(undefined)
      }
    })
  })

  // --- A50: what a STEP'S input is made of, and which part the budget governs
  describe("the step input decomposition", () => {
    const BREAKDOWN_THREAD = "4c000000-0000-4000-8000-0000000000c4"

    it("the assembled history is under the budget and the budget line reports the tail the turn feeds", async () => {
      await seedThread(BREAKDOWN_THREAD, "checkpoint-breakdown")
      // 70 messages of 900 tokens: 63,000 raw tokens against 48,000.
      await seedMessages(BREAKDOWN_THREAD, 70, 900 * 4)
      const infoSpy = spyOn(rootLogger, "info")
      try {
        const ctx = await assembleContext({
          threadId: BREAKDOWN_THREAD,
          orgId: ORG_ID,
          actor,
          agentId: AGENT_ID,
          contextWindow: TEST_WINDOW,
        })
        const breakdown = stepInputBreakdown({
          system: ctx.system,
          messages: ctx.messages as Array<{ role: string; content: unknown }>,
          historyBudgetTokens: 48_000,
        })
        // THE PART THE BUDGET GOVERNS, on its own.
        expect(breakdown.historyTokens).toBeLessThanOrEqual(48_000)
        // ...and it is not the whole request: the system prefix is outside it.
        expect(breakdown.nonHistoryTokens).toBeGreaterThan(0)
        expect(breakdown.totalTokens).toBe(breakdown.nonHistoryTokens + breakdown.historyTokens)

        // The per turn budget line reports the tail this turn FEEDS. It used to
        // report the stored tail, so it read 63,000 beside a 48,000 cap on a
        // turn whose prompt carried 48,000, and the cap looked advisory.
        const line = infoSpy.mock.calls.find(
          (args) => typeof args[1] === "string" && args[1] === "agent_memory_budgets",
        )
        expect(line).toBeDefined()
        const measured = line?.[0] as {
          tailTokens: number
          rawTailCap: number
          rawTailStoredTokens: number
        }
        expect(measured.tailTokens).toBeLessThanOrEqual(measured.rawTailCap)
        expect(measured.rawTailStoredTokens).toBeGreaterThan(measured.rawTailCap)
      } finally {
        infoSpy.mockRestore()
      }
    })

    it("tool schemas and the runtime context tail are counted outside the history", () => {
      const breakdown = stepInputBreakdown({
        system: [{ role: "system", content: "<agent-identity>You help.</agent-identity>" }],
        messages: [
          { role: "user", content: "x".repeat(400) },
          {
            role: "user",
            content: `<runtime-context note="ephemeral">\nthe time is now\n</runtime-context>`,
          },
        ],
        tools: {
          tickets__get: { description: "Read a ticket", inputSchema: { id: "string" } },
          boxtal__quote: { description: "Quote a shipment", inputSchema: { weight: "number" } },
        },
        historyBudgetTokens: 48_000,
      })
      expect(breakdown.toolCount).toBe(2)
      expect(breakdown.toolSchemaTokens).toBeGreaterThan(0)
      expect(breakdown.runtimeContextTokens).toBeGreaterThan(0)
      // The 400 character user message, and nothing else, is history.
      expect(breakdown.historyTokens).toBe(100)
      expect(breakdown.nonHistoryTokens).toBe(
        breakdown.systemTokens + breakdown.toolSchemaTokens + breakdown.runtimeContextTokens,
      )
      expect(breakdown.systemParts[0].label).toBe("agent-identity")
    })
  })

  it("an existing compaction summary row still slices the raw tail for one release", async () => {
    await seedMessages(LEGACY_THREAD, 3)
    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, metadata, created_at, required_scopes)
      VALUES (${LEGACY_THREAD}, ${ORG_ID}, ${USER_ID}, 'system', 'Legacy summary', '{"type":"compaction_summary"}'::jsonb,
        '2026-01-01T00:00:10Z', '{}')`
    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, created_at, required_scopes)
      VALUES (${LEGACY_THREAD}, ${ORG_ID}, ${USER_ID}, 'user', 'After the legacy summary', '2026-01-01T00:00:11Z', '{}')`
    const loaded = await loadBoundedHistory({
      threadId: LEGACY_THREAD,
      orgId: ORG_ID,
      actor,
      agentId: AGENT_ID,
      contextWindow: TEST_WINDOW,
    })
    expect(loaded.messages.length).toBe(2)
    expect(loaded.messages[0].content).toBe("Legacy summary")
    expect(loaded.messages[1].content).toBe("After the legacy summary")
  })

  // --- P4m-T16: the advance, incremental and between turns -----------------

  it("an advance summarizes only the messages between the old and the new upto message", async () => {
    const seen: Array<{ count: number; previous: string | null }> = []
    CheckpointTestAccess.setSummarizer(async (input) => {
      seen.push({ count: input.messages.length, previous: input.previousSummary })
      return "Version two summary."
    })
    try {
      const result = await advanceCheckpoint({
        agentId: AGENT_ID,
        threadId: ADVANCE_THREAD,
        orgId: ORG_ID,
        actor,
        contextWindow: TEST_WINDOW,
      })
      expect(result.advanced).toBe(true)
      expect(seen.length).toBe(1)
      // The DELTA, never the thread: 100 raw messages after the prior
      // checkpoint, of which only the ones past the reserve are summarized.
      expect(seen[0].count).toBeLessThanOrEqual(101)
      expect(seen[0].count).toBeLessThan(400)
      expect(seen[0].previous).toBe("Version one summary.")
    } finally {
      CheckpointTestAccess.setSummarizer()
    }
  })

  // --- P4c-T49: the advance writes brief rows and freezes the core ---------

  it("an advance writes the region's brief rows and freezes the core on the checkpoint row", async () => {
    const BRIEF_THREAD = "4c000000-0000-4000-8000-00000000000b"
    await seedThread(BRIEF_THREAD, "checkpoint-brief")
    const briefIds = await seedMessages(BRIEF_THREAD, 400, FAT_MESSAGE_CHARS)
    CheckpointTestAccess.setSummarizer(async () => "Brief thread summary.")
    CheckpointTestAccess.setBriefRowExtractor(async ({ region }) => [
      {
        kind: "decision" as const,
        key: "the carrier",
        value: "DHL",
        messageIds: [region[0].id],
      },
    ])
    try {
      const result = await advanceCheckpoint({
        agentId: AGENT_ID,
        threadId: BRIEF_THREAD,
        orgId: ORG_ID,
        actor,
        contextWindow: TEST_WINDOW,
      })
      expect(result.advanced).toBe(true)

      const [row] = (await sql`
        SELECT id FROM kernel.agent_thread_checkpoints
        WHERE thread_id = ${BRIEF_THREAD} AND agent_id = ${AGENT_ID}
        ORDER BY version DESC LIMIT 1`) as unknown as Array<{ id: string }>
      const core = await loadFrozenCore({ orgId: ORG_ID, checkpointId: row.id })
      expect(core).toContain("[decision] the carrier: DHL")

      // The mark moved with the rows, so a second agent advancing over the same
      // stretch would extract nothing.
      const [mark] = (await sql`
        SELECT extracted_upto_message_id FROM kernel.thread_brief_marks
        WHERE thread_id = ${BRIEF_THREAD}`) as unknown as Array<{
        extracted_upto_message_id: string
      }>
      expect(mark.extracted_upto_message_id).toBe(result.uptoMessageId as string)
      expect(briefIds).toContain(mark.extracted_upto_message_id as string)
    } finally {
      CheckpointTestAccess.setSummarizer()
      CheckpointTestAccess.setBriefRowExtractor()
    }
  })

  it("an advance leaves half the budget (24,000 of 48,000) raw in the tail", async () => {
    const loaded = await loadBoundedHistory({
      threadId: ADVANCE_THREAD,
      orgId: ORG_ID,
      actor,
      agentId: AGENT_ID,
      contextWindow: TEST_WINDOW,
    })
    expect(loaded.checkpoint?.version).toBe(2)
    const reserve = checkpointRawTailReserve(48_000)
    const drift = Math.abs(loaded.estimatedTokens - reserve)
    expect(drift / reserve).toBeLessThanOrEqual(0.05)
  })

  it("an advance writes a new version and never mutates the previous one", async () => {
    const rows = await sql`
      SELECT version, summary FROM kernel.agent_thread_checkpoints
      WHERE org_id = ${ORG_ID} AND thread_id = ${ADVANCE_THREAD} ORDER BY version`
    expect(rows.map((r) => r.version as number)).toEqual([1, 2])
    expect(rows[0].summary).toBe("Version one summary.")
    expect(rows[1].summary).toBe("Version two summary.")
  })

  it("an advance with a tail under the budget writes no version", async () => {
    const before = await sql`
      SELECT count(*)::int AS n FROM kernel.agent_thread_checkpoints
      WHERE org_id = ${ORG_ID} AND thread_id = ${SMALL_THREAD}`
    const result = await advanceCheckpoint({
      agentId: AGENT_ID,
      threadId: SMALL_THREAD,
      orgId: ORG_ID,
      actor,
      contextWindow: TEST_WINDOW,
    })
    expect(result.advanced).toBe(false)
    expect(result.reason).toBe("under-budget")
    const after = await sql`
      SELECT count(*)::int AS n FROM kernel.agent_thread_checkpoints
      WHERE org_id = ${ORG_ID} AND thread_id = ${SMALL_THREAD}`
    expect(after[0].n).toBe(before[0].n)
  })
  // --- Hysteresis: one advance, then a long run of turns that do not advance --
  describe("an advance is followed by many turns that do not advance", () => {
    const HYST_THREAD = "4c000000-0000-4000-8000-0000000000d1"

    it("never advances on the turns right after an advance, and advances again only half a budget later", async () => {
      await seedThread(HYST_THREAD, "checkpoint-hysteresis")
      // 70 rows of 900 tokens: 63,000 raw tokens against the 48,000 budget.
      await seedMessages(HYST_THREAD, 70, 900 * 4)
      CheckpointTestAccess.setSummarizer(async () => "Hysteresis summary.")
      const outcomes: string[] = []
      try {
        const turn = async () => {
          const r = await advanceCheckpoint({
            agentId: AGENT_ID,
            threadId: HYST_THREAD,
            orgId: ORG_ID,
            actor,
            contextWindow: TEST_WINDOW,
          })
          outcomes.push(r.advanced ? "advanced" : (r.reason ?? "skipped"))
        }
        await turn()
        expect(outcomes).toEqual(["advanced"])
        // Each later "turn" adds one 900 token message. The tail starts near
        // 24,000 tokens, so the next 26 turns stay under the 48,000 budget.
        let next = 71
        for (let i = 0; i < 26; i++) {
          await seedMessages(HYST_THREAD, 1, 900 * 4, next++)
          await turn()
        }
        expect(outcomes.filter((o) => o === "advanced")).toHaveLength(1)
        expect(new Set(outcomes.slice(1))).toEqual(new Set(["under-budget"]))
        // Keep going until the tail crosses the budget again: exactly one more advance.
        for (let i = 0; i < 6; i++) {
          await seedMessages(HYST_THREAD, 1, 900 * 4, next++)
          await turn()
        }
        expect(outcomes.filter((o) => o === "advanced")).toHaveLength(2)
      } finally {
        CheckpointTestAccess.setSummarizer()
      }
    })
  })

  // --- The org's own budget (Settings > AI models > Conversation history) ----
  describe("the org history budget setting", () => {
    it("is honoured by the bounded load, clamped to the window, and cleared back to the default", async () => {
      const load = () =>
        loadBoundedHistory({
          threadId: SMALL_THREAD,
          orgId: ORG_ID,
          actor,
          agentId: AGENT_ID,
          contextWindow: 1_048_576,
        })
      expect((await load()).budgetTokens).toBe(256_000)
      await setOrgHistorySettings(ORG_ID, { budgetTokens: 64_000 })
      try {
        expect((await load()).budgetTokens).toBe(64_000)
        // A small window still clamps the org's value.
        const small = await loadBoundedHistory({
          threadId: SMALL_THREAD,
          orgId: ORG_ID,
          actor,
          agentId: AGENT_ID,
          contextWindow: TEST_WINDOW,
        })
        expect(small.budgetTokens).toBe(48_000)
        await setOrgHistorySettings(ORG_ID, { warmCompaction: false })
        // Setting one field keeps the other.
        expect((await load()).budgetTokens).toBe(64_000)
        expect((await loadOrgHistorySettings(ORG_ID)).warmCompaction).toBe(false)
      } finally {
        await setOrgHistorySettings(ORG_ID, { budgetTokens: null, warmCompaction: true })
      }
      expect((await load()).budgetTokens).toBe(256_000)
      expect(await loadOrgHistorySettings(ORG_ID)).toEqual({
        budgetTokens: null,
        warmCompaction: true,
      })
    })
  })

  // --- P4m-T18: history_prefix_rebuilt and the revoke forced rebuild -------

  describe("history prefix rebuild logging", () => {
    const LOG_THREAD = "4c000000-0000-4000-8000-000000000008"
    const SCOPED = "pennylane:payouts:read"
    let scopedMessageId = ""

    async function rebuildLines(cause: string): Promise<number> {
      const rows = await sql`
        SELECT count(*)::int AS n FROM kernel.audit_log
        WHERE org_id = ${ORG_ID} AND action = 'history_prefix_rebuilt'
          AND entity_id = ${LOG_THREAD} AND metadata->>'cause' = ${cause}`
      return rows[0].n as number
    }

    beforeAll(async () => {
      CheckpointTestAccess.resetReportedRevokes()
      await seedThread(LOG_THREAD, "checkpoint-log")
      const ids = await seedMessages(LOG_THREAD, 4)
      scopedMessageId = ids[3]
      await sql`UPDATE kernel.messages SET required_scopes = ARRAY[${SCOPED}]::text[]
        WHERE id = ${scopedMessageId}`
      await sql`INSERT INTO kernel.agent_thread_checkpoints
        (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
        VALUES (${ORG_ID}, ${AGENT_ID}, ${LOG_THREAD}, ${ids[0]}, 'Log thread summary.', '{}', 5, 1)`
    })

    it("a checkpoint advance logs history prefix rebuilt with cause checkpoint", async () => {
      CheckpointTestAccess.setSummarizer(async () => "Advance for the log thread.")
      try {
        const before = await rebuildLines("checkpoint")
        const result = await advanceCheckpoint({
          agentId: AGENT_ID,
          threadId: ADVANCE_THREAD,
          orgId: ORG_ID,
          actor,
          contextWindow: TEST_WINDOW,
          force: true,
        })
        expect(result.advanced).toBe(true)
        const rows = await sql`
          SELECT count(*)::int AS n FROM kernel.audit_log
          WHERE org_id = ${ORG_ID} AND action = 'history_prefix_rebuilt'
            AND entity_id = ${ADVANCE_THREAD} AND metadata->>'cause' = 'checkpoint'`
        expect(rows[0].n).toBe(2)
        expect(before).toBe(0)
      } finally {
        CheckpointTestAccess.setSummarizer()
      }
    })

    it("a revoke that hides a rendered message forces a rebuild logged with cause revoke", async () => {
      const ctx = await assembleContext({
        threadId: LOG_THREAD,
        orgId: ORG_ID,
        actor,
        agentId: AGENT_ID,
        // The turn's floor no longer covers the scoped message: RLS still
        // returns it (the human holds "*"), the turn may not read it.
        effectiveScope: ["kernel:threads:read"],
      })
      const rendered = ctx.messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n")
      expect(rendered).not.toContain("Message 4")
      expect(await rebuildLines("revoke")).toBe(1)
      // A second turn with the same hidden set is the SAME rebuild, not a new
      // one: the prefix was rebuilt once and every later turn renders it.
      await assembleContext({
        threadId: LOG_THREAD,
        orgId: ORG_ID,
        actor,
        agentId: AGENT_ID,
        effectiveScope: ["kernel:threads:read"],
      })
      expect(await rebuildLines("revoke")).toBe(1)
    })

    it("a grant that reveals an older message inserts nothing into the prefix", async () => {
      // The revealed message is BEFORE the checkpoint boundary, so the
      // immutable summary already covers it and the raw tail never grows a
      // message backwards.
      const hiddenBefore = crypto.randomUUID()
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, created_at, required_scopes)
        VALUES (${hiddenBefore}, ${LOG_THREAD}, ${ORG_ID}, ${USER_ID}, 'user', 'Revealed later', '2026-01-01T00:00:00.500Z', ARRAY[${SCOPED}]::text[])`
      const before = await assembleContext({
        threadId: LOG_THREAD,
        orgId: ORG_ID,
        actor,
        agentId: AGENT_ID,
        effectiveScope: ["kernel:threads:read", SCOPED],
      })
      const countBefore = before.messages.length
      const linesBefore = await rebuildLines("revoke")
      const after = await assembleContext({
        threadId: LOG_THREAD,
        orgId: ORG_ID,
        actor,
        agentId: AGENT_ID,
        effectiveScope: ["kernel:threads:read", SCOPED],
      })
      expect(after.messages.length).toBe(countBefore)
      const rendered = after.messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n")
      expect(rendered).not.toContain("Revealed later")
      expect(await rebuildLines("revoke")).toBe(linesBefore)
    })

    it("a normal turn logs no rebuild", async () => {
      const before = await sql`
        SELECT count(*)::int AS n FROM kernel.audit_log
        WHERE org_id = ${ORG_ID} AND action = 'history_prefix_rebuilt' AND entity_id = ${SMALL_THREAD}`
      for (let i = 0; i < 10; i++) {
        await assembleContext({
          threadId: SMALL_THREAD,
          orgId: ORG_ID,
          actor,
          agentId: AGENT_ID,
          effectiveScope: ["*"],
        })
      }
      const after = await sql`
        SELECT count(*)::int AS n FROM kernel.audit_log
        WHERE org_id = ${ORG_ID} AND action = 'history_prefix_rebuilt' AND entity_id = ${SMALL_THREAD}`
      expect(before[0].n).toBe(0)
      expect(after[0].n).toBe(0)
    })
  })
  // --- P4m-T19: per agent checkpoints and per agent tails -----------------

  describe("per agent checkpoints in a multi agent thread", () => {
    const CH_THREAD = "4c000000-0000-4000-8000-000000000009"
    const AGENT_A = "4c000000-0000-4000-8000-00000000000a"
    const AGENT_B = "4c000000-0000-4000-8000-00000000000b"
    const SCOPED = "pennylane:payouts:read"
    let chIds: string[] = []

    beforeAll(async () => {
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
        VALUES (${AGENT_A}, ${ORG_ID}, 'role', '@ckalpha', 'Alpha', '["*"]'::jsonb, 'You are alpha.')`
      // B's ceiling deliberately excludes the scoped message's scope.
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
        VALUES (${AGENT_B}, ${ORG_ID}, 'role', '@ckbeta', 'Beta', '["kernel:threads:read"]'::jsonb, 'You are beta.')`
      await seedThread(CH_THREAD, "checkpoint-channel")
      // A is seated from the start; B joins after the first 20 messages.
      await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type, created_at)
        VALUES (${CH_THREAD}, ${AGENT_A}, ${ORG_ID}, 'agent', '2025-12-31T00:00:00Z')`
      chIds = await seedMessages(CH_THREAD, 40, FAT_MESSAGE_CHARS)
      const [{ created_at: joinAt }] = await sql`
        SELECT created_at FROM kernel.messages WHERE id = ${chIds[20]}`
      await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type, created_at)
        VALUES (${CH_THREAD}, ${AGENT_B}, ${ORG_ID}, 'agent', ${joinAt})`
      // One message above B's ceiling, inside the region both agents cover.
      await sql`UPDATE kernel.messages SET required_scopes = ARRAY[${SCOPED}]::text[]
        WHERE id = ${chIds[30]}`
    })

    it("two agents in one channel keep two checkpoints and neither sees the other's", async () => {
      const regions: Record<string, number> = {}
      CheckpointTestAccess.setSummarizer(async (input) => {
        regions.last = input.messages.length
        return "Channel summary."
      })
      try {
        for (const agentId of [AGENT_A, AGENT_B]) {
          const result = await advanceCheckpoint({
            agentId,
            threadId: CH_THREAD,
            orgId: ORG_ID,
            actor,
            contextWindow: TEST_WINDOW,
            force: true,
            // A fixed reserve, so the regions below depend on the seating only.
            tailReserveTokens: 12_000,
          })
          expect(result.advanced).toBe(true)
          regions[agentId] = result.summarizedCount ?? 0
        }
      } finally {
        CheckpointTestAccess.setSummarizer()
      }
      const rows = await sql`
        SELECT agent_id FROM kernel.agent_thread_checkpoints
        WHERE org_id = ${ORG_ID} AND thread_id = ${CH_THREAD}`
      expect(rows.length).toBe(2)
      // Agent A's checkpoint is invisible to agent B: the read is keyed by the
      // owning agent, so B's own load never returns A's row.
      const forB = await loadCurrentCheckpoint({
        agentId: AGENT_B,
        threadId: CH_THREAD,
        orgId: ORG_ID,
        actor,
      })
      const forA = await loadCurrentCheckpoint({
        agentId: AGENT_A,
        threadId: CH_THREAD,
        orgId: ORG_ID,
        actor,
      })
      expect(forA?.id).not.toBe(forB?.id)
      // The two agents summarize DIFFERENT regions of the same stored rows.
      // A is seated from the start, so its tail is all 40 messages and the
      // 12,000 token reserve leaves the oldest 16 to summarize. B joined at
      // the 21st message, so its tail is 20 messages, under the reserve: the
      // forced advance summarizes all but the last two, minus the one message
      // above B's ceiling.
      expect(regions[AGENT_A]).toBe(16)
      expect(regions[AGENT_B]).toBe(17)
    })

    it("an agent's checkpoint contains only messages after its own join point", async () => {
      const seen: number[] = []
      CheckpointTestAccess.setSummarizer(async (input) => {
        seen.push(input.messages.length)
        return "Join point summary."
      })
      try {
        await sql`DELETE FROM kernel.agent_thread_checkpoints
          WHERE org_id = ${ORG_ID} AND thread_id = ${CH_THREAD} AND agent_id = ${AGENT_B}`
        // Give B the scope it lacked, so the ONLY thing narrowing its region
        // is the join point.
        await sql`UPDATE kernel.agents SET scope_ceiling = '["*"]'::jsonb WHERE id = ${AGENT_B}`
        const result = await advanceCheckpoint({
          agentId: AGENT_B,
          threadId: CH_THREAD,
          orgId: ORG_ID,
          actor,
          contextWindow: TEST_WINDOW,
          force: true,
        })
        expect(result.advanced).toBe(true)
        // 40 messages, B joined at the 21st, the forced boundary keeps the
        // last two raw: exactly the 18 covered messages after the join point.
        expect(seen[0]).toBe(18)
      } finally {
        CheckpointTestAccess.setSummarizer()
        await sql`UPDATE kernel.agents SET scope_ceiling = '["kernel:threads:read"]'::jsonb WHERE id = ${AGENT_B}`
      }
    })

    it("an agent's checkpoint excludes a message above its ceiling", async () => {
      const bodies: string[] = []
      CheckpointTestAccess.setSummarizer(async (input) => {
        bodies.push(
          input.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"),
        )
        return "Ceiling summary."
      })
      try {
        await sql`DELETE FROM kernel.agent_thread_checkpoints
          WHERE org_id = ${ORG_ID} AND thread_id = ${CH_THREAD} AND agent_id = ${AGENT_B}`
        const result = await advanceCheckpoint({
          agentId: AGENT_B,
          threadId: CH_THREAD,
          orgId: ORG_ID,
          actor,
          contextWindow: TEST_WINDOW,
          force: true,
        })
        expect(result.advanced).toBe(true)
        expect(bodies[0]).not.toContain("Message 31x")
        expect(bodies[0]).toContain("Message 32x")
      } finally {
        CheckpointTestAccess.setSummarizer()
      }
    })
  })
  // --- P4m-T23: a deleted message marks dependent artefacts stale ----------

  describe("deleted messages mark dependent artefacts stale", () => {
    const STALE_THREAD = "4c000000-0000-4000-8000-00000000000c"
    let staleIds: string[] = []

    beforeAll(async () => {
      await seedThread(STALE_THREAD, "checkpoint-stale")
      staleIds = await seedMessages(STALE_THREAD, 6)
      await sql`INSERT INTO kernel.agent_thread_checkpoints
        (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
        VALUES (${ORG_ID}, ${AGENT_ID}, ${STALE_THREAD}, ${staleIds[4]}, 'Stale thread summary.', '{}', 5, 1)`
      await sql`INSERT INTO kernel.agent_memory
        (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes,
         source_thread_id, episode_from_message_id, episode_to_message_id)
        VALUES (${ORG_ID}, ${USER_ID}, ${AGENT_ID}, 'episode', 'stale-episode', 'An episode of the stale thread',
         'body', 'episodes/checkpoint-stale/2026-01-01.md', '{}', ${STALE_THREAD}, ${staleIds[0]}, ${staleIds[5]})`
    })

    it("deleting a message marks the covering checkpoint stale", async () => {
      const { deleteMessage } = await import("~/modules/threads/message")
      const { withRlsContext } = await import("~/db/rls")
      await withRlsContext(actor, async (tx) =>
        deleteMessage(tx as never, {
          orgId: ORG_ID,
          userId: USER_ID,
          threadId: STALE_THREAD,
          messageId: staleIds[2],
        }),
      )
      const rows = await sql`
        SELECT count(*)::int AS n FROM kernel.agent_thread_checkpoints
        WHERE org_id = ${ORG_ID} AND stale_at IS NOT NULL`
      expect(rows[0].n).toBe(1)
      const mine = await sql`
        SELECT stale_at FROM kernel.agent_thread_checkpoints
        WHERE org_id = ${ORG_ID} AND thread_id = ${STALE_THREAD}`
      expect(mine[0].stale_at).not.toBeNull()
    })

    it("deleting a message marks the covering episode stale", async () => {
      const rows = await sql`
        SELECT count(*)::int AS n FROM kernel.agent_memory
        WHERE org_id = ${ORG_ID} AND type = 'episode' AND stale_at IS NOT NULL`
      expect(rows[0].n).toBe(1)
    })
  })
  // --- FX2 HIGH-1: a stale checkpoint is never rendered --------------------

  describe("a stale checkpoint is not rendered", () => {
    const FORGET_THREAD = "4c000000-0000-4000-8000-00000000000d"
    const SECRET = "The vault code is 4471."
    let ids: string[] = []

    beforeAll(async () => {
      await seedThread(FORGET_THREAD, "checkpoint-staleload")
      ids = await seedMessages(FORGET_THREAD, 6)
      await sql`UPDATE kernel.messages SET content = ${SECRET} WHERE id = ${ids[2]}`
      await sql`INSERT INTO kernel.agent_thread_checkpoints
        (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
        VALUES (${ORG_ID}, ${AGENT_ID}, ${FORGET_THREAD}, ${ids[3]},
          ${`They agreed on this. ${SECRET}`}, '{}', 5, 1)`
      const { deleteMessage } = await import("~/modules/threads/message")
      const { withRlsContext } = await import("~/db/rls")
      await withRlsContext(actor, async (tx) =>
        deleteMessage(tx as never, {
          orgId: ORG_ID,
          userId: USER_ID,
          threadId: FORGET_THREAD,
          messageId: ids[2],
        }),
      )
    })

    it("the turn after the delete renders the raw tail, without the stale summary text", async () => {
      const loaded = await loadBoundedHistory({
        threadId: FORGET_THREAD,
        orgId: ORG_ID,
        actor,
        agentId: AGENT_ID,
        contextWindow: TEST_WINDOW,
      })
      expect(loaded.checkpoint).toBeNull()
      expect(loaded.staleCheckpoint?.version).toBe(1)
      // The whole surviving thread, not the slice after the stale boundary.
      expect(loaded.messages.length).toBe(5)
      const rendered = loaded.messages.map((m) => m.content ?? "").join("\n")
      expect(rendered).not.toContain(SECRET)
    })

    it("the next advance writes a clean version and clears the stale flag", async () => {
      CheckpointTestAccess.setSummarizer(async (input) => {
        // A stale summary must never be folded forward: it quotes the message
        // the human deleted.
        expect(input.previousSummary).toBeNull()
        return "A clean summary."
      })
      try {
        const result = await advanceCheckpoint({
          agentId: AGENT_ID,
          threadId: FORGET_THREAD,
          orgId: ORG_ID,
          actor,
          contextWindow: TEST_WINDOW,
          force: true,
        })
        expect(result.advanced).toBe(true)
        expect(result.version).toBe(2)
      } finally {
        CheckpointTestAccess.setSummarizer()
      }
      const rows = await sql`
        SELECT version, summary, stale_at FROM kernel.agent_thread_checkpoints
        WHERE org_id = ${ORG_ID} AND thread_id = ${FORGET_THREAD} ORDER BY version`
      expect(rows.map((r) => r.version as number)).toEqual([1, 2])
      expect(rows[1].summary).toBe("A clean summary.")
      expect(rows.every((r) => r.stale_at === null)).toBe(true)
      const loaded = await loadBoundedHistory({
        threadId: FORGET_THREAD,
        orgId: ORG_ID,
        actor,
        agentId: AGENT_ID,
        contextWindow: TEST_WINDOW,
      })
      expect(loaded.checkpoint?.version).toBe(2)
      expect(loaded.staleCheckpoint).toBeNull()
    })
  })

  describe("P4c-T50 the brief writer never sees a retrieval tool part (A50)", () => {
    const SEARCH_RESULT = "recalled: the DHL account number is 4711"

    function row(metadata: unknown): any {
      return {
        id: crypto.randomUUID(),
        threadId: SMALL_THREAD,
        orgId: ORG_ID,
        authorId: USER_ID,
        authorType: "agent",
        content: "looking into it",
        metadata,
        requiredScopes: [],
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }
    }

    it("the brief input never contains a retrieval tool part", () => {
      const input = [
        row({
          toolCalls: [
            { toolCallId: "a", toolName: "memory_search", args: {}, result: SEARCH_RESULT },
            { toolCallId: "b", toolName: "tickets_get", args: {}, result: "ticket 12" },
          ],
        }),
        row({ toolCalls: [{ toolCallId: "c", toolName: "threads_search", args: {} }] }),
        row(null),
      ]
      const stripped = stripRetrievalToolParts(input)
      const serialized = JSON.stringify(stripped)

      expect(serialized).not.toContain("memory_search")
      expect(serialized).not.toContain("threads_search")
      expect(serialized).not.toContain(SEARCH_RESULT)
      // A business tool part is a fact of the conversation and stays.
      expect(serialized).toContain("tickets_get")
      // The message text is never touched, and nothing is deleted from the row.
      expect(stripped.every((r) => r.content === "looking into it")).toBe(true)
      expect(stripped.length).toBe(3)
      expect(JSON.stringify(input)).toContain("memory_search")
    })
  })

  // --- P4c-T23: the cold resume advance ------------------------------------

  describe("P4c-T23 the cold resume advance", () => {
    const COLD_TAIL_THREAD = "4c000000-0000-4000-8000-00000000000f"
    const COLD_LOG_THREAD = "4c000000-0000-4000-8000-000000000010"

    it("advance with tailReserveTokens 8000 leaves at most 8000 raw tokens", async () => {
      await seedThread(COLD_TAIL_THREAD, "checkpoint-cold-tail")
      // 40 fat messages: well over 8,000 estimated tokens, and under the
      // 48,000 token budget, so only the cold rule could compress them.
      await seedMessages(COLD_TAIL_THREAD, 40, FAT_MESSAGE_CHARS)
      CheckpointTestAccess.setSummarizer(async () => "Cold tail summary.")
      try {
        const result = await advanceCheckpoint({
          agentId: AGENT_ID,
          threadId: COLD_TAIL_THREAD,
          orgId: ORG_ID,
          actor,
          contextWindow: TEST_WINDOW,
          force: true,
          tailReserveTokens: 8_000,
        })
        expect(result.advanced).toBe(true)
      } finally {
        CheckpointTestAccess.setSummarizer()
      }
      const loaded = await loadBoundedHistory({
        threadId: COLD_TAIL_THREAD,
        orgId: ORG_ID,
        actor,
        agentId: AGENT_ID,
        contextWindow: TEST_WINDOW,
      })
      const tailTokens = loaded.messages.reduce(
        (sum, m) => sum + estimateTokens(m.content ?? ""),
        0,
      )
      expect(tailTokens).toBeLessThanOrEqual(8_000)
      // A tail of nothing would pass the line above for the wrong reason, and
      // the default reserve would have left 24,000.
      expect(tailTokens).toBeGreaterThan(0)
      expect(checkpointRawTailReserve(48_000)).toBeGreaterThan(8_000)
    })

    it("a cold_resume advance logs history_prefix_rebuilt with cause cold_resume and sinceLastTurnSeconds", async () => {
      await seedThread(COLD_LOG_THREAD, "checkpoint-cold-log")
      await seedMessages(COLD_LOG_THREAD, 40, FAT_MESSAGE_CHARS)
      CheckpointTestAccess.setSummarizer(async () => "Cold log summary.")
      try {
        const result = await advanceCheckpoint({
          agentId: AGENT_ID,
          threadId: COLD_LOG_THREAD,
          orgId: ORG_ID,
          actor,
          contextWindow: TEST_WINDOW,
          force: true,
          tailReserveTokens: 8_000,
          cause: "cold_resume",
          sinceLastTurnSeconds: 3_700,
        })
        expect(result.advanced).toBe(true)
      } finally {
        CheckpointTestAccess.setSummarizer()
      }
      const rows = await sql`
        SELECT metadata FROM kernel.audit_log
        WHERE org_id = ${ORG_ID} AND entity_id = ${COLD_LOG_THREAD}
          AND action = 'history_prefix_rebuilt'`
      expect(rows.length).toBe(1)
      const metadata = rows[0].metadata as { cause?: string; sinceLastTurnSeconds?: number }
      expect(metadata.cause).toBe("cold_resume")
      expect(metadata.sinceLastTurnSeconds).toBe(3_700)
    })
  })

  // --- P4c-T24: the brief replaces the generic summary ----------------------

  describe("P4c-T24 the brief replaces the generic summary", () => {
    const BRIEF_FIVE_THREAD = "4c000000-0000-4000-8000-000000000021"
    const BRIEF_CLIP_THREAD = "4c000000-0000-4000-8000-000000000022"
    const BRIEF_SUPERSEDE_THREAD = "4c000000-0000-4000-8000-000000000023"
    const BRIEF_RETRIEVAL_THREAD = "4c000000-0000-4000-8000-000000000024"

    /** The prompt file itself, read here so the assertion cannot share a bug with the loader. */
    async function promptFile(): Promise<string> {
      return readFile(
        path.resolve(import.meta.dir, "..", "prompts", "compaction-brief.md"),
        "utf-8",
      )
    }

    /** The persisted summary of the newest checkpoint version of a thread. */
    async function persistedSummary(threadId: string): Promise<{ summary: string; core: string }> {
      const [row] = (await sql`
        SELECT id, summary FROM kernel.agent_thread_checkpoints
        WHERE thread_id = ${threadId} AND agent_id = ${AGENT_ID}
        ORDER BY version DESC LIMIT 1`) as unknown as Array<{ id: string; summary: string }>
      const core = await loadFrozenCore({ orgId: ORG_ID, checkpointId: row.id })
      return { summary: row.summary, core: core ?? "" }
    }

    it("a checkpoint advance writes a brief with the five sections and message ids on every line", async () => {
      await seedThread(BRIEF_FIVE_THREAD, "checkpoint-brief-five")
      await seedMessages(BRIEF_FIVE_THREAD, 40, FAT_MESSAGE_CHARS)
      const file = await promptFile()
      let seenPrompt = ""
      let seenMessages: Array<{ role: string; content: unknown }> = []
      // The scripted writer ECHOES its prompt back as the brief, so the five
      // sections the prompt names are exactly what gets split and persisted.
      CheckpointTestAccess.setSummarizer(async (input) => {
        seenPrompt = input.prompt
        seenMessages = input.messages
        return input.prompt
      })
      try {
        const result = await advanceCheckpoint({
          agentId: AGENT_ID,
          threadId: BRIEF_FIVE_THREAD,
          orgId: ORG_ID,
          actor,
          contextWindow: TEST_WINDOW,
          force: true,
          tailReserveTokens: 8_000,
        })
        expect(result.advanced).toBe(true)
      } finally {
        CheckpointTestAccess.setSummarizer()
      }

      // The prompt IS the brief file, byte for byte.
      expect(seenPrompt).toBe(file)
      // Every line of the region carries its message id, which is what makes
      // the brief's attribution rule followable.
      expect(seenMessages.length).toBeGreaterThan(0)
      expect(
        seenMessages.every(
          (m) => typeof m.content === "string" && /^\[[0-9a-f-]{36}\] /.test(m.content),
        ),
      ).toBe(true)

      const { summary, core } = await persistedSummary(BRIEF_FIVE_THREAD)
      // The core carries the three current-state sections...
      expect(core).toContain("### Current decisions")
      expect(core).toContain("### Open loops")
      expect(core).toContain("### Identifiers and entities")
      expect(summary.startsWith(core)).toBe(true)
      // ...and the region's episode carries the other two, so all five survive.
      const [episode] = (await sql`
        SELECT title, body FROM kernel.thread_episodes WHERE thread_id = ${BRIEF_FIVE_THREAD}`) as unknown as Array<{
        title: string
        body: string
      }>
      expect(episode.body).toContain("### Standing procedures")
      expect(episode.body).toContain("### Unresolved contradictions")
      // The title is the region's date span, then its first decision.
      expect(episode.title).toContain("2026-01-01")
      // The episode rides forward as a TITLE only, never as its body.
      expect(summary).toContain(episode.title)
      expect(summary).not.toContain("### Unresolved contradictions")
    })

    it("the core is clipped to 400 tokens on a line boundary and logged", async () => {
      await seedThread(BRIEF_CLIP_THREAD, "checkpoint-brief-clip")
      const ids = await seedMessages(BRIEF_CLIP_THREAD, 40, FAT_MESSAGE_CHARS)
      const lines = ["### Current decisions"]
      for (let i = 0; i < 200; i++) {
        lines.push(`- decision number ${i} is that the carrier stays the same [${ids[0]}]`)
      }
      const longCore = lines.join("\n")
      CheckpointTestAccess.setSummarizer(async () => longCore)
      const infoSpy = spyOn(rootLogger, "info")
      try {
        const result = await advanceCheckpoint({
          agentId: AGENT_ID,
          threadId: BRIEF_CLIP_THREAD,
          orgId: ORG_ID,
          actor,
          contextWindow: TEST_WINDOW,
          force: true,
          tailReserveTokens: 8_000,
        })
        expect(result.advanced).toBe(true)
        const clipped = infoSpy.mock.calls.some(
          (args) => typeof args[1] === "string" && args[1] === "brief_core_clipped",
        )
        expect(clipped).toBe(true)
        // The brief writer's cost is measured on every advance.
        const written = infoSpy.mock.calls.find(
          (args) => typeof args[1] === "string" && args[1] === "checkpoint_brief_written",
        )
        expect(written).toBeDefined()
        const measured = written?.[0] as { brief_tokens_in: number; brief_tokens_out: number }
        expect(measured.brief_tokens_in).toBeGreaterThan(0)
        expect(measured.brief_tokens_out).toBeGreaterThan(0)
      } finally {
        infoSpy.mockRestore()
        CheckpointTestAccess.setSummarizer()
      }

      const { summary, core } = await persistedSummary(BRIEF_CLIP_THREAD)
      expect(estimateTokens(core)).toBeLessThanOrEqual(BRIEF_CORE_TOKEN_BUDGET)
      // Clipped, not empty: the core still says something.
      expect(core.length).toBeGreaterThan(0)
      expect(estimateTokens(longCore)).toBeGreaterThan(BRIEF_CORE_TOKEN_BUDGET)
      // ON A LINE BOUNDARY: every surviving line is a whole line of the input.
      const original = new Set(longCore.split("\n"))
      expect(core.split("\n").every((line) => original.has(line))).toBe(true)
      expect(summary.startsWith(core)).toBe(true)
    })

    it("a region with a superseded value keeps both states in one line", async () => {
      await seedThread(BRIEF_SUPERSEDE_THREAD, "checkpoint-brief-supersede")
      const ids = await seedMessages(BRIEF_SUPERSEDE_THREAD, 40, FAT_MESSAGE_CHARS)
      const both = `- the carrier for order 1042: was UPS until 2026-01-05, now DHL [${ids[0]}, ${ids[1]}]`
      CheckpointTestAccess.setSummarizer(
        async () => `### Current decisions\n${both}\n\n### Open loops\nnone`,
      )
      try {
        const result = await advanceCheckpoint({
          agentId: AGENT_ID,
          threadId: BRIEF_SUPERSEDE_THREAD,
          orgId: ORG_ID,
          actor,
          contextWindow: TEST_WINDOW,
          force: true,
          tailReserveTokens: 8_000,
        })
        expect(result.advanced).toBe(true)
      } finally {
        CheckpointTestAccess.setSummarizer()
      }
      const { summary, core } = await persistedSummary(BRIEF_SUPERSEDE_THREAD)
      // ONE line carrying BOTH states: the superseded value is never dropped
      // and never presented as current.
      expect(core).toContain(both)
      expect(summary).toContain("was UPS until 2026-01-05, now DHL")
      const carrierLines = core.split("\n").filter((l) => l.includes("UPS"))
      expect(carrierLines.length).toBe(1)
      expect(carrierLines[0]).toContain("DHL")
    })

    it("the brief input carries no retrieval tool call", async () => {
      await seedThread(BRIEF_RETRIEVAL_THREAD, "checkpoint-brief-retrieval")
      const SEARCH_RESULT = "recalled: the DHL account number is 4711"
      // Written BEFORE the padded messages, so it lands inside the summarized
      // region rather than in the raw tail the advance leaves behind.
      await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_agent_id, author_type, content, metadata, created_at, required_scopes)
        VALUES (${BRIEF_RETRIEVAL_THREAD}, ${ORG_ID}, ${USER_ID}, ${AGENT_ID}, 'agent', 'looking into it',
          ${JSON.stringify({
            toolCalls: [
              { toolCallId: "a", toolName: "memory_search", args: {}, result: SEARCH_RESULT },
              { toolCallId: "b", toolName: "tickets_get", args: {}, result: "ticket 12" },
            ],
          })}::jsonb, '2026-01-01T00:00:00Z', '{}')`
      await seedMessages(BRIEF_RETRIEVAL_THREAD, 40, FAT_MESSAGE_CHARS)
      let seen = ""
      CheckpointTestAccess.setSummarizer(async (input) => {
        seen = JSON.stringify(input.messages)
        return "### Current decisions\n- nothing changed [x]"
      })
      try {
        const result = await advanceCheckpoint({
          agentId: AGENT_ID,
          threadId: BRIEF_RETRIEVAL_THREAD,
          orgId: ORG_ID,
          actor,
          contextWindow: TEST_WINDOW,
          force: true,
          tailReserveTokens: 8_000,
        })
        expect(result.advanced).toBe(true)
      } finally {
        CheckpointTestAccess.setSummarizer()
      }
      // The retrieval call and its result never reach the writer...
      expect(seen).toContain("looking into it")
      expect(seen).not.toContain("memory_search")
      expect(seen).not.toContain(SEARCH_RESULT)
      // ...while the business tool call, a fact of the conversation, does.
      expect(seen).toContain("tickets_get")
    })
  })
})
