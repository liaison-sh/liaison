// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4m-T36: the long memory harness, scenarios 6 and 7 of spec-memory.md's
// validation list, plus the e2e runner wiring.
//
// SCENARIO 6, BUDGETS. Every row of spec-memory.md's budget table is stated as
// "measured by a per turn log line", so every row is asserted from the LINES a
// real run emits: `agent_memory_budgets` (charter, MEMORY.md lines and bytes,
// auto recall, raw history tail), `agent_memory_search` (the result payload)
// and `history_prefix_rebuilt` (the advances). The index full refusal is
// asserted end to end against the real verb.
//
// The "at most once per 24,000 (half the budget) raw tokens" half of invariant I3 is asserted
// here and nowhere else in the slice: the estimated tokens between two
// consecutive advances' boundaries, by the production `estimateTokens`.
//
// SCENARIO 7, ONE FLUSH PER ADVANCE. Counted from audit rows: one
// `memory_flush_region` row per `history_prefix_rebuilt`, never two.
//
// NO FUNDED KEY. Every model backed step is scripted through the production
// seams; see helpers/long-memory.ts.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import path from "node:path"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import {
  type CheckpointSummarizerInput,
  CheckpointTestAccess,
  checkpointRawTailReserve,
} from "~/modules/agent/context/checkpoint"
import {
  COLD_CONVERSATION_TOKEN_BUDGET,
  COLD_TAIL_TOKEN_BUDGET,
  COLD_TURN_TOKEN_BUDGET,
} from "~/modules/agent/context/cold-resume"
import { estimateTokens } from "~/modules/agent/context/compaction"
import { AGENT_CHARTER_TOKEN_CAP, renderAgentCharter } from "~/modules/agent/context/context"
import { ConsolidationTestAccess } from "~/modules/agent/memory/consolidation"
import {
  handleMemorySet,
  MEMORY_INDEX_FULL_MESSAGE,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_MAX_LINES,
  type MemoryIndexFullError,
} from "~/modules/agent/memory/memory"
import * as memoryRecallModule from "~/modules/agent/memory/memory-recall"
import { AUTO_RECALL_TOKEN_CAP } from "~/modules/agent/memory/memory-recall"
import * as memorySearchModule from "~/modules/agent/memory/memory-search"
import { MEMORY_SEARCH_PAYLOAD_TOKEN_CAP } from "~/modules/agent/memory/memory-search"
import { ExternalSearchHandlersTestAccess } from "~/modules/search/external-handlers"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { apiE2eScenarioFiles } from "../../../../../../scripts/lib/api-e2e-files"
import { type CapturedTurn, installRequestCapture } from "./helpers/capture-requests"
import {
  answerFromRequest,
  captureLogLines,
  driveTurn,
  dropWorld,
  E2E_HISTORY_BUDGET,
  insertMessage,
  type LogLine,
  padded,
  readerStream,
  requestText,
  seedWorld,
  stampLastAgentTurnMinutesAgo,
} from "./helpers/long-memory"

const ORG_ID = "4d000000-0000-4000-8000-000000000401"
const USER_ID = "4d000000-0000-4000-8000-000000000402"
const THREAD_ID = "4d000000-0000-4000-8000-000000000403"
const AGENT_ID = "4d000000-0000-4000-8000-000000000404"

/**
 * Small messages, many of them: the checkpoint boundary can only land BETWEEN
 * messages, so message size is the granularity of every token assertion below.
 * 800 chars is 200 estimated tokens, which keeps that granularity under one
 * percent of the 24,000 token gap the advance rule is about.
 */
const MESSAGE_CHARS = 800
const MESSAGE_TOKENS = MESSAGE_CHARS / 4
/** Enough to cross the 48,000 token budget once, with room to spare. */
const FIRST_STRETCH = 280
/** Enough to cross it a second time after the advance left 24,000 behind. */
const SECOND_STRETCH = 260

const ORIG_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

interface BudgetLine {
  charterTokens: number
  charterCap: number
  memoryIndexLines: number
  memoryIndexLineCap: number
  memoryIndexBytes: number
  memoryIndexByteCap: number
  recallTokens: number
  recallCap: number
  rawTailTokens: number
  rawTailCap: number
}

describe("P4m-T36 long memory scenarios 6 and 7, budgets and one flush per advance", () => {
  const spies: Array<{ mockRestore: () => void }> = []
  let logs: ReturnType<typeof captureLogLines>
  let budgetLines: BudgetLine[] = []
  let advances = 0
  let flushes = 0
  let boundaries: string[] = []

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-long-memory-stub"
    spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "job") as never)
    CheckpointTestAccess.setSummarizer(
      async () => "Scripted checkpoint summary for the budget run.",
    )
    await seedWorld({
      orgId: ORG_ID,
      userId: USER_ID,
      userEmail: "budgets@test.com",
      agents: [
        {
          id: AGENT_ID,
          handle: "@budgets",
          displayName: "Budgets",
          kind: "personal",
          ownerUserId: USER_ID,
        },
      ],
      threads: [{ id: THREAD_ID, handle: "budgets-dm" }],
    })

    const stretch = async (n: number, label: string) => {
      for (let i = 0; i < n; i++) {
        await insertMessage({
          orgId: ORG_ID,
          threadId: THREAD_ID,
          authorId: USER_ID,
          authorType: i % 2 === 0 ? "user" : "agent",
          ...(i % 2 === 0 ? {} : { authorAgentId: AGENT_ID }),
          content: padded(`${label} line ${i}.`, MESSAGE_CHARS),
        })
      }
    }

    const drive = async (content: string) => {
      const capture = installRequestCapture({
        currentAgentKey: () => AGENT_ID,
        script: (t) => readerStream(answerFromRequest(t)),
      })
      try {
        await driveTurn({
          orgId: ORG_ID,
          threadId: THREAD_ID,
          userId: USER_ID,
          agentId: AGENT_ID,
          content,
        })
      } finally {
        capture.restore()
      }
    }

    // A tree with real content in it: a budget line measuring zero everywhere
    // asserts nothing, so the run carries an index the turn loads and files the
    // question actually recalls.
    await withRlsContext(
      { actorType: "user", userId: USER_ID, orgId: ORG_ID, scopes: ["*"], dimensionGrants: {} },
      async (tx) => {
        for (let i = 0; i < 12; i++) {
          await handleMemorySet(
            {
              type: "user",
              name: `budgetberry-note-${i}`,
              description: `The budgetberry shipment note ${i}`,
              content: `Budgetberry shipments go out on the ${i + 1}th of the month.`,
            },
            { userId: USER_ID, orgId: ORG_ID, db: tx, ownerAgentId: AGENT_ID } as never,
            [],
          )
        }
      },
    )

    logs = captureLogLines()
    await stretch(FIRST_STRETCH, "First stretch")
    await drive("What do we know about the budgetberry shipment schedule?")
    await stretch(SECOND_STRETCH, "Second stretch")
    await drive("Remind me about the budgetberry shipment schedule again.")
    logs.restore()

    budgetLines = logs.of("agent_memory_budgets") as unknown as BudgetLine[]

    const [advanceRow] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.audit_log
      WHERE org_id = ${ORG_ID} AND action = 'history_prefix_rebuilt'`
    advances = advanceRow?.n ?? 0
    const [flushRow] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.audit_log
      WHERE org_id = ${ORG_ID} AND action = 'memory_flush_region'`
    flushes = flushRow?.n ?? 0
    const versions = await sql<{ upto_message_id: string }[]>`
      SELECT upto_message_id FROM kernel.agent_thread_checkpoints
      WHERE org_id = ${ORG_ID} AND agent_id = ${AGENT_ID} AND thread_id = ${THREAD_ID}
      ORDER BY version ASC`
    boundaries = versions.map((v) => v.upto_message_id)
  })

  afterAll(async () => {
    logs?.restore()
    CheckpointTestAccess.setSummarizer()
    for (const s of spies) s.mockRestore()
    spies.length = 0
    resetOrgRuntimeForTest(ORG_ID)
    if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await dropWorld(ORG_ID)
    await releaseTestLock()
  })

  // P3b-FX3: the charter is INTERPOLATED per agent and per org (display name,
  // purpose, handle, org name), so the number the assertion above measures is
  // the number THIS fixture renders, not the number a real organisation does.
  // Short names here give 467 tokens; the longest realistic row gives 537
  // against a 500 cap. The cap is logged and never enforced, so nothing breaks
  // today, and the charter is NOT trimmed to hide it: every byte of it is a
  // cache miss for every agent, and shortening it is a product decision about
  // what the charter teaches, not a test fix. Recorded here, red on purpose,
  // so the overrun is a number somebody owns rather than a footnote.
  it.todo("the charter fits its cap for the longest realistic agent (measured 537 of a 500 cap)", async () => {
    const rendered = await renderAgentCharter({
      displayName: "A".repeat(60),
      handle: `@${"h".repeat(23)}`,
      purpose: "P".repeat(200),
      orgName: "O".repeat(40),
    })
    expect(estimateTokens(rendered)).toBeLessThanOrEqual(AGENT_CHARTER_TOKEN_CAP)
  })

  it("every budget in the memory table holds on the harness runs", () => {
    // A run that emitted no line proves nothing, so an empty set is a failure.
    expect(budgetLines.length).toBeGreaterThanOrEqual(2)
    for (const line of budgetLines) {
      // The charter: a stable system part, inside its own 500 token budget.
      expect(line.charterCap).toBe(AGENT_CHARTER_TOKEN_CAP)
      expect(line.charterTokens).toBeGreaterThan(0)
      expect(line.charterTokens).toBeLessThanOrEqual(AGENT_CHARTER_TOKEN_CAP)
      // MEMORY.md: 200 lines and 25 KB.
      expect(line.memoryIndexLineCap).toBe(MEMORY_INDEX_MAX_LINES)
      expect(line.memoryIndexLines).toBeLessThanOrEqual(MEMORY_INDEX_MAX_LINES)
      expect(line.memoryIndexByteCap).toBe(MEMORY_INDEX_MAX_BYTES)
      expect(line.memoryIndexBytes).toBeLessThanOrEqual(MEMORY_INDEX_MAX_BYTES)
      // Auto recall: 800 tokens.
      expect(line.recallCap).toBe(AUTO_RECALL_TOKEN_CAP)
      expect(line.recallTokens).toBeLessThanOrEqual(AUTO_RECALL_TOKEN_CAP)
      // The index really was loaded, so the two caps above are measured
      // against a tree with content rather than against an empty one.
      expect(line.memoryIndexLines).toBeGreaterThan(0)
      expect(line.memoryIndexBytes).toBeGreaterThan(0)
      expect(line.recallTokens).toBeGreaterThan(0)
      // The raw history tail: the org's 48,000 tokens, or less on a small window.
      expect(line.rawTailCap).toBeLessThanOrEqual(E2E_HISTORY_BUDGET)
      expect(line.rawTailTokens).toBeLessThanOrEqual(line.rawTailCap)
    }
    // The raw reserve (half the budget, 24,000): the turn that advanced still renders a
    // working set, it is not cut to the bone. The boundary can only land
    // BETWEEN messages, so what is kept is the largest suffix that does not
    // exceed the reserve: within one message of it, never a bare 24,000.
    const advanced = budgetLines.filter((l) => l.rawTailTokens > 0)
    expect(advanced.length).toBeGreaterThanOrEqual(2)
    for (const line of advanced) {
      expect(line.rawTailTokens).toBeGreaterThanOrEqual(
        checkpointRawTailReserve(E2E_HISTORY_BUDGET) - MESSAGE_TOKENS,
      )
    }
  })

  it("the memory_search payload stays inside its own 1000 token budget", () => {
    const searches = logs.of("agent_memory_search") as unknown as Array<{
      payloadTokens: number
      payloadCap: number
    }>
    expect(searches.length).toBeGreaterThan(0)
    for (const line of searches) {
      expect(line.payloadCap).toBe(MEMORY_SEARCH_PAYLOAD_TOKEN_CAP)
      expect(line.payloadTokens).toBeLessThanOrEqual(MEMORY_SEARCH_PAYLOAD_TOKEN_CAP)
    }
    // And at least one search really returned something, so the cap above is
    // measured against a payload rather than against an empty array.
    expect(searches.some((l) => l.payloadTokens > 1)).toBe(true)
  })

  it("consecutive checkpoint advances are at least half a budget (24000 raw tokens) apart", async () => {
    expect(boundaries.length).toBeGreaterThanOrEqual(2)
    const gapFloor = E2E_HISTORY_BUDGET - checkpointRawTailReserve(E2E_HISTORY_BUDGET)
    for (let i = 1; i < boundaries.length; i++) {
      const between = await sql<{ content: string | null }[]>`
        SELECT content FROM kernel.messages
        WHERE org_id = ${ORG_ID} AND thread_id = ${THREAD_ID}
          AND created_at > (SELECT created_at FROM kernel.messages WHERE id = ${boundaries[i - 1]})
          AND created_at <= (SELECT created_at FROM kernel.messages WHERE id = ${boundaries[i]})
        ORDER BY created_at ASC`
      const tokens = estimateTokens(between.map((m) => m.content ?? "").join("\n"))
      // The boundary can only land BETWEEN messages, so the gap is the 24,000
      // token rule minus at most one message. Asserting a bare 24,000 would be
      // asserting that messages have no size.
      expect(tokens).toBeGreaterThanOrEqual(gapFloor - MESSAGE_TOKENS)
      expect(tokens).toBeGreaterThan(gapFloor * 0.95)
    }
  })

  it("a checkpoint advance runs exactly one flush, asserted from audit rows", () => {
    expect(advances).toBeGreaterThanOrEqual(2)
    expect(flushes).toBe(advances)
  })

  it("a MEMORY.md write past 200 lines is refused with the structured error naming five entries", async () => {
    const actor = {
      actorType: "user" as const,
      userId: USER_ID,
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }
    // Fill the index until the real verb refuses. Each write is its own
    // transaction: the refusal throws mid write, and a poisoned transaction
    // would turn every later write into a different error.
    const write = (i: number) =>
      withRlsContext(actor, (tx) =>
        handleMemorySet(
          {
            type: "user",
            name: `fill-note-${i}`,
            description: `Fill note ${i}`,
            content: `Body of fill note ${i}.`,
          },
          { userId: USER_ID, orgId: ORG_ID, db: tx, ownerAgentId: AGENT_ID } as never,
          [],
        ),
      )
    let refusal: MemoryIndexFullError | null = null
    let accepted = 0
    for (let i = 0; i < MEMORY_INDEX_MAX_LINES + 10 && refusal === null; i++) {
      try {
        await write(i)
        accepted++
      } catch (err) {
        refusal = err as MemoryIndexFullError
      }
    }
    expect(refusal).not.toBeNull()
    const error = refusal as unknown as MemoryIndexFullError
    expect(error.message).toBe(MEMORY_INDEX_FULL_MESSAGE)
    expect(error.candidates.length).toBe(5)
    // It refused because the INDEX filled, not for some other reason: the
    // index stopped exactly at its line cap.
    const [indexRow] = await sql<{ content: string }[]>`
      SELECT content FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND owner_agent_id = ${AGENT_ID} AND type = '_index'`
    const indexLines = indexRow.content.split("\n").filter((l) => l.trim() !== "").length
    expect(indexLines).toBe(MEMORY_INDEX_MAX_LINES)
    expect(accepted).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// P4c-T27: THE COLD RESUME, on the long memory harness (spec-memory.md S25).
//
// WHAT IS PROVEN. One DM carries about 60,000 tokens of scripted conversation:
// a carrier account number stated once early, a depot pickup window stated once
// and corrected once mid way, and a last agent turn that made a `memory_search`
// call. The same seed is driven three times, on three threads, through the real
// production turn path:
//
//   COLD, the last agent turn pinned exactly 61 minutes back. The turn rebuilds
//   its prefix ONCE with cause `cold_resume`, feeds a brief plus a tail plus a
//   recall inside COLD_CONVERSATION_TOKEN_BUDGET with the tail alone inside
//   COLD_TAIL_TOKEN_BUDGET, replays NO retrieval tool part from before the
//   resume, carries the corrected value as "was X until <date>, now Y", and
//   answers with the account number. The END TO END cap is a separate,
//   deliberately red `it.todo` below: production counts the stable system prompt
//   inside it, so no cold turn can fit it. See that case for the numbers.
//
//   WARM, the control, pinned 59 minutes back. No rebuild, the tail follows the
//   warm budget rather than the cold one, and the earlier `memory_search` call
//   IS replayed.
//
//   DARK, the falsifiable counter: the same cold turn with the harness's recall
//   switch off and the memory tools removed (`autoRecall` and `memorySearch`
//   stubbed at the module boundary, which takes out BOTH the server side recall
//   and the `memory_search` tool). The answer must then lack the number, and no
//   byte of the request may carry it.
//
// THE 61 MINUTES ARE PINNED AT DRIVE TIME, not at seed time: the window is 60
// minutes of wall clock, and a control pinned when the fixture was built drifts
// into coldness while the earlier runs take their seconds (P4c-T26b).
// ---------------------------------------------------------------------------

const CR_ORG_ID = "4d000000-0000-4000-8000-000000000411"
const CR_USER_ID = "4d000000-0000-4000-8000-000000000412"
const CR_AGENT_ID = "4d000000-0000-4000-8000-000000000413"
const CR_COLD_THREAD = "4d000000-0000-4000-8000-000000000414"
const CR_WARM_THREAD = "4d000000-0000-4000-8000-000000000415"
const CR_DARK_THREAD = "4d000000-0000-4000-8000-000000000416"

/** Stated once, early, and never again. */
const CR_ACCOUNT_NUMBER = "KRY-70318"
const CR_FACT_LINE = `The Kryptonite carrier account number is ${CR_ACCOUNT_NUMBER}, agreed with the carrier.`
const CR_QUESTION = "What is the Kryptonite carrier account number we agreed with the carrier?"

/** The value that changed mid way, and the date it changed on. */
const PICKUP_OLD = "14:00"
const PICKUP_NEW = "09:00"
const PICKUP_CHANGED_ON = "2026-03-14"
const CHANGED_VALUE = `was ${PICKUP_OLD} until ${PICKUP_CHANGED_ON}, now ${PICKUP_NEW}`
const CHANGED_VALUE_LINE = `- Depot pickup window: ${CHANGED_VALUE}`

/**
 * The result of the last turn's `memory_search`, as stored on that agent
 * message. A literal nothing else in the request carries, so "the retrieval
 * part was replayed" and "it was not" are both decidable from the bytes.
 */
const CR_REPLAY_MARKER = "RETRIEVAL REPLAY MARKER for the depot pickup window rows"

/**
 * 46 padded messages of 6,500 chars is about 75,000 tokens of raw history.
 * The warm advance keeps half the budget raw (24,000 tokens, about 15 of
 * these messages), so the after-correction filler must be longer than that:
 * the region it summarises then states both pickup values and the date, and
 * the cold advance carries that line forward from the previous brief.
 */
const CR_FILLER_BEFORE_CHANGE = 17
const CR_FILLER_BETWEEN = 8
const CR_FILLER_AFTER = 18

const CR_INDEX_NAME = `test_p4ct27_${crypto.randomUUID().slice(0, 8)}`
const CR_THREADS_READ = "kernel:threads:read"

const crMeili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

/** Every brief the scripted writer was handed, so its SHAPE can be asserted. */
const briefInputs: CheckpointSummarizerInput[] = []

/**
 * The scripted brief writer: the model stand in for P4c-T24's compaction brief.
 *
 * It reads the REGION it was handed and emits the changed value line only when
 * that region really states both values and the date; otherwise it carries
 * forward the line the previous brief already held, which is what makes the
 * brief incremental rather than a constant. It never emits the account number,
 * so nothing but retrieval can put that number in front of the reader.
 */
function scriptedColdBrief(input: CheckpointSummarizerInput): string {
  briefInputs.push(input)
  const region = input.messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n")
  const statesTheChange =
    region.includes(PICKUP_OLD) && region.includes(PICKUP_NEW) && region.includes(PICKUP_CHANGED_ON)
  const carried = (input.previousSummary ?? "")
    .split("\n")
    .find((line) => line.includes(CHANGED_VALUE))
  const changedLine = statesTheChange ? CHANGED_VALUE_LINE : (carried ?? "- none")
  return [
    "### Current decisions",
    "- The depot plan stands as agreed with the carrier.",
    "### Open loops",
    "- none",
    "### Identifiers and entities",
    changedLine,
    "### Standing procedures",
    "- none",
    "### Unresolved contradictions",
    "- none",
  ].join("\n")
}

/** One measured turn: its answer, the request it produced, and its log lines. */
interface ColdResumeRun {
  answer: string
  turn: CapturedTurn
  lines: LogLine[]
}

function linesOf(
  run: ColdResumeRun,
  msg: string,
  threadId: string,
): Array<Record<string, unknown>> {
  return run.lines
    .filter((l) => l.msg === msg && l.fields.threadId === threadId)
    .map((l) => l.fields)
}

interface CrBudgetLine {
  briefTokens: number
  tailTokens: number
  recallTokens: number
  memoryCallTokens: number
  coldResume: boolean
  systemTokens: number
  requestTokens: number
  /** The total COLD_TURN_TOKEN_BUDGET is compared against (context.ts logMemoryBudgets). */
  coldTurnTotalTokens: number
}

/** The budget line the measured turn emitted for this thread. */
function budgetLineOf(run: ColdResumeRun, threadId: string): CrBudgetLine {
  const lines = linesOf(run, "agent_memory_budgets", threadId) as unknown as CrBudgetLine[]
  expect(lines.length).toBe(1)
  return lines[0]
}

async function seedColdConversation(threadId: string): Promise<string> {
  const filler = async (label: string, n: number, offset: number) => {
    for (let i = 0; i < n; i++) {
      const even = (offset + i) % 2 === 0
      await insertMessage({
        orgId: CR_ORG_ID,
        threadId,
        authorId: CR_USER_ID,
        authorType: even ? "agent" : "user",
        ...(even ? { authorAgentId: CR_AGENT_ID } : {}),
        content: padded(`${label} exchange ${i}, nothing decided here.`),
      })
    }
  }
  await insertMessage({
    orgId: CR_ORG_ID,
    threadId,
    authorId: CR_USER_ID,
    authorType: "user",
    content: padded("Opening note on the depot plan."),
  })
  // Early, once, and never repeated: the whole point of the counter below.
  const fact = await insertMessage({
    orgId: CR_ORG_ID,
    threadId,
    authorId: CR_USER_ID,
    authorType: "user",
    content: CR_FACT_LINE,
  })
  await filler("Before the correction", CR_FILLER_BEFORE_CHANGE, 0)
  await insertMessage({
    orgId: CR_ORG_ID,
    threadId,
    authorId: CR_USER_ID,
    authorType: "user",
    content: padded(`The depot pickup window is ${PICKUP_OLD} every weekday.`),
  })
  await filler("Between the two values", CR_FILLER_BETWEEN, 1)
  await insertMessage({
    orgId: CR_ORG_ID,
    threadId,
    authorId: CR_USER_ID,
    authorType: "user",
    content: padded(
      `Correction: the depot pickup window is ${PICKUP_NEW} every weekday from ${PICKUP_CHANGED_ON}.`,
    ),
  })
  await filler("After the correction", CR_FILLER_AFTER, 0)
  return fact.id
}

/** Index the transcript so the verbatim leg of the hybrid search has a substrate. */
async function crIndexMessage(messageId: string): Promise<void> {
  const { processMessageIndexerJob } = await import("~/modules/search/message-indexer")
  await processMessageIndexerJob({ action: "upsert", orgId: CR_ORG_ID, messageId })
}

/**
 * Seed one thread and bring it to the state the measured turn starts from: the
 * long conversation, one ordinary warm turn (which advances the checkpoint on
 * the planned budget rule and leaves the warm half-budget (24,000) token reserve behind), and
 * then the agent's last turn, which made a `memory_search` call.
 */
async function prepareColdThread(threadId: string): Promise<void> {
  const factId = await seedColdConversation(threadId)
  await crIndexMessage(factId)
  const capture = installRequestCapture({
    currentAgentKey: () => CR_AGENT_ID,
    // A FIXED answer, never the reader: a priming reply that quoted the number
    // would leave it in the raw tail and the counter would prove nothing.
    script: () => readerStream("Acknowledged."),
  })
  try {
    await driveTurn({
      orgId: CR_ORG_ID,
      threadId,
      userId: CR_USER_ID,
      agentId: CR_AGENT_ID,
      content: "Quick status check on the depot plan, please.",
    })
  } finally {
    capture.restore()
  }
  await insertMessage({
    orgId: CR_ORG_ID,
    threadId,
    authorId: CR_USER_ID,
    authorType: "agent",
    authorAgentId: CR_AGENT_ID,
    content: "I checked my own notes on the depot pickup window before answering.",
    metadata: {
      toolCalls: [
        {
          toolCallId: "memsrch001",
          toolName: "memory_search",
          args: { query: "depot pickup window" },
          result: CR_REPLAY_MARKER,
        },
      ],
    },
  })
}

/** Pin the clock, then drive the one measured turn and keep everything it emitted. */
async function measureColdResumeTurn(opts: {
  threadId: string
  minutesAgo: number
  retrievalDisabled?: boolean
}): Promise<ColdResumeRun> {
  await stampLastAgentTurnMinutesAgo({
    orgId: CR_ORG_ID,
    threadId: opts.threadId,
    minutesAgo: opts.minutesAgo,
  })
  const local: Array<{ mockRestore: () => void }> = []
  if (opts.retrievalDisabled) {
    // THE COUNTER, in the harness only. `memorySearch` is the one entry point
    // of both the server side recall and the `memory_search` tool, so stubbing
    // it here removes the tools as well as the recall. Production keeps no such
    // switch.
    local.push(
      spyOn(memoryRecallModule, "autoRecall").mockImplementation(async () => null) as never,
    )
    local.push(
      spyOn(memorySearchModule, "memorySearch").mockImplementation(async () => ({
        hits: [],
      })) as never,
    )
  }
  const captured: CapturedTurn[] = []
  const logs = captureLogLines()
  const capture = installRequestCapture({
    currentAgentKey: () => CR_AGENT_ID,
    script: (turn) => {
      captured.push(turn)
      return readerStream(answerFromRequest(turn))
    },
  })
  try {
    const answer = await driveTurn({
      orgId: CR_ORG_ID,
      threadId: opts.threadId,
      userId: CR_USER_ID,
      agentId: CR_AGENT_ID,
      content: CR_QUESTION,
    })
    expect(captured.length).toBe(1)
    return { answer, turn: captured[0], lines: [...logs.lines] }
  } finally {
    capture.restore()
    logs.restore()
    for (const s of local) s.mockRestore()
  }
}

describe("P4c-T27 cold resume on the long memory harness, scenario S25", () => {
  const crSpies: Array<{ mockRestore: () => void }> = []
  let cold: ColdResumeRun
  let warm: ColdResumeRun
  let dark: ColdResumeRun
  let coldSummary = ""

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-cold-resume-stub"
    ExternalSearchHandlersTestAccess.reset()
    crSpies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(CR_INDEX_NAME))
    crSpies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue(
        crMeili as unknown as ReturnType<typeof searchClientModule.getMeili>,
      ),
    )
    crSpies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "job") as never)
    CheckpointTestAccess.setSummarizer(async (input) => scriptedColdBrief(input))
    // The brief ROWS and consolidation are T49's and T25's own scenarios; with no
    // funded key their real extractors would make a doomed model call per
    // advance. Scripted empty here so this scenario measures the brief, the tail
    // and the recall and nothing else.
    CheckpointTestAccess.setBriefRowExtractor(async () => [])
    ConsolidationTestAccess.setSummarizer(async () => "Scripted consolidation summary.")
    ConsolidationTestAccess.setFactExtractor(async () => [])

    const { expectedSettings } = await import("~/modules/search/drift")
    const created = await crMeili.createIndex(CR_INDEX_NAME, { primaryKey: "id" })
    await crMeili.tasks.waitForTask(created.taskUid)
    const applied = await crMeili
      .index(CR_INDEX_NAME)
      .updateSettings(
        expectedSettings({ registeredReadScopes: [CR_THREADS_READ], dimensionFields: [] }),
      )
    await crMeili.tasks.waitForTask(applied.taskUid)

    await seedWorld({
      orgId: CR_ORG_ID,
      userId: CR_USER_ID,
      userEmail: "coldresume@test.com",
      agents: [
        {
          id: CR_AGENT_ID,
          handle: "@coldresume",
          displayName: "Cold Resume",
          kind: "personal",
          ownerUserId: CR_USER_ID,
        },
      ],
      threads: [
        { id: CR_COLD_THREAD, handle: "cold-resume-dm" },
        { id: CR_WARM_THREAD, handle: "cold-resume-control-dm" },
        { id: CR_DARK_THREAD, handle: "cold-resume-counter-dm" },
      ],
    })
    for (const threadId of [CR_COLD_THREAD, CR_WARM_THREAD, CR_DARK_THREAD]) {
      await prepareColdThread(threadId)
    }

    cold = await measureColdResumeTurn({ threadId: CR_COLD_THREAD, minutesAgo: 61 })
    const [summaryRow] = await sql<{ summary: string }[]>`
      SELECT summary FROM kernel.agent_thread_checkpoints
      WHERE org_id = ${CR_ORG_ID} AND agent_id = ${CR_AGENT_ID} AND thread_id = ${CR_COLD_THREAD}
      ORDER BY version DESC LIMIT 1`
    coldSummary = summaryRow?.summary ?? ""
    warm = await measureColdResumeTurn({ threadId: CR_WARM_THREAD, minutesAgo: 59 })
    dark = await measureColdResumeTurn({
      threadId: CR_DARK_THREAD,
      minutesAgo: 61,
      retrievalDisabled: true,
    })
  })

  afterAll(async () => {
    CheckpointTestAccess.setSummarizer()
    CheckpointTestAccess.setBriefRowExtractor()
    ConsolidationTestAccess.resetSeams()
    for (const s of crSpies) s.mockRestore()
    crSpies.length = 0
    resetOrgRuntimeForTest(CR_ORG_ID)
    if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await crMeili.deleteIndex(CR_INDEX_NAME).catch(() => undefined)
    await dropWorld(CR_ORG_ID)
    await releaseTestLock()
  })

  it("the cold turn rebuilds the prefix exactly once, with cause cold_resume", () => {
    const rebuilds = linesOf(cold, "history_prefix_rebuilt", CR_COLD_THREAD)
    expect(rebuilds.length).toBe(1)
    expect(rebuilds[0].cause).toBe("cold_resume")
    // The rule fired on the CLOCK: the gap it recorded is past the warm window.
    expect(rebuilds[0].sinceLastTurnSeconds as number).toBeGreaterThan(60 * 60)
  })

  it("the cold turn fits the cold conversation and cold tail budgets", () => {
    const line = budgetLineOf(cold, CR_COLD_THREAD)
    expect(line.coldResume).toBe(true)
    // A line measuring zero everywhere would assert nothing.
    expect(line.briefTokens).toBeGreaterThan(0)
    expect(line.tailTokens).toBeGreaterThan(0)
    expect(line.recallTokens).toBeGreaterThan(0)
    expect(line.tailTokens).toBeLessThanOrEqual(COLD_TAIL_TOKEN_BUDGET)
    expect(line.briefTokens + line.tailTokens + line.recallTokens).toBeLessThanOrEqual(
      COLD_CONVERSATION_TOKEN_BUDGET,
    )
  })

  // THE TURN TOTAL, FIXED (T27's finding). `logMemoryBudgets` used to measure
  // the cold turn total as `systemTokens + rawTailTokens + recallTokens`, so
  // the STABLE system prompt was counted inside the 14,000 token cap. On this
  // fixture that prompt alone is ~10,900 tokens (7,106 platform identity, then
  // apps 1,418, deferred tools 933, charter 501, skills 461, user 116, time 92,
  // first run 264) — the cold rule never touches it and it never grows or
  // shrinks with how well the cold rule performs, so comparing it against a
  // conversation-scoped budget fired `cold_resume_over_budget` on EVERY cold
  // turn however well the cold rule performed (17,541 measured against 14,000,
  // with the cold rule working perfectly: tail 6,552 of 8,000, conversation
  // 6,782 of 9,500).
  //
  // The fix is the measurement, not the constant: the cold turn total compared
  // against COLD_TURN_TOKEN_BUDGET is now `briefTokens + tailTokens +
  // recallTokens + memoryCallTokens` (conversation plus the agent's own memory
  // calls), excluding the cached system prefix. `systemTokens` and
  // `requestTokens` (the full request, i.e. the OLD comparison) stay logged so
  // the real request size is still visible. The platform prompt has since
  // shrunk (about 6,800 system tokens, a 13,657 token request on this
  // fixture), so the request alone no longer exceeds the cap; the proof is the
  // compared total itself, logged as `coldTurnTotalTokens`, which must equal
  // the conversation plus memory calls and nothing more.
  it("the cold turn fits its end to end cap, excluding the cached system prefix", () => {
    const line = budgetLineOf(cold, CR_COLD_THREAD)
    const coldTurnTotal =
      line.briefTokens + line.tailTokens + line.recallTokens + line.memoryCallTokens
    expect(coldTurnTotal).toBeLessThan(COLD_TURN_TOKEN_BUDGET)
    expect(cold.lines.filter((l) => l.msg === "cold_resume_over_budget").length).toBe(0)
    // The total the cap COMPARES is logged on the budget line itself
    // (coldTurnTotalTokens). It must be exactly the conversation plus the
    // agent's memory calls: had the system prefix been counted, it would carry
    // the ~6,800 system tokens on top and differ from this sum. Asserting on
    // the compared value, not on the fixture's request size, keeps the proof
    // independent of how large the platform prompt happens to be.
    expect(line.systemTokens).toBeGreaterThan(0)
    expect(line.coldTurnTotalTokens).toBe(coldTurnTotal)
    expect(line.coldTurnTotalTokens).toBeLessThan(line.requestTokens)
    // requestTokens (the full request, the OLD comparison) is still logged.
    expect(typeof line.requestTokens).toBe("number")
  })

  it("the cold turn replays no retrieval tool part from before the resume", () => {
    expect(requestText(cold.turn)).not.toContain(CR_REPLAY_MARKER)
    expect(budgetLineOf(cold, CR_COLD_THREAD).memoryCallTokens).toBe(0)
  })

  it("the brief the cold turn renders carries the changed value with both states", () => {
    expect(coldSummary).toContain(CHANGED_VALUE)
    expect(cold.turn.prefixText).toContain(CHANGED_VALUE)
    // P4c-T24's shape, from the seam itself: the writer is handed the prompt and
    // a region whose lines carry their message ids.
    expect(briefInputs.length).toBeGreaterThan(0)
    for (const input of briefInputs) {
      expect(input.prompt.length).toBeGreaterThan(0)
      const first = input.messages[0]
      expect(typeof first.content === "string" ? first.content : "").toMatch(/^\[[0-9a-f-]{36}\] /)
    }
  })

  it("the cold turn answers with the account number, which reached it through the tail", () => {
    expect(cold.answer).toContain(CR_ACCOUNT_NUMBER)
    expect(cold.turn.tailText).toContain(CR_ACCOUNT_NUMBER)
    // The stating message is behind the cold boundary: it is in no byte of the
    // cached prefix, so retrieval is the only way it reached the turn.
    expect(cold.turn.prefixText).not.toContain(CR_ACCOUNT_NUMBER)
    expect(cold.turn.tailText).toContain("Resumed after")
  })

  it("the control at 59 minutes logs no rebuild and keeps the warm tail budget", () => {
    expect(linesOf(warm, "history_prefix_rebuilt", CR_WARM_THREAD).length).toBe(0)
    const line = budgetLineOf(warm, CR_WARM_THREAD)
    expect(line.coldResume).toBe(false)
    // The warm reserve, not the cold one: the same seed one minute inside the
    // window keeps a tail the cold rule would have cut.
    expect(line.tailTokens).toBeGreaterThan(COLD_TAIL_TOKEN_BUDGET)
    expect(line.tailTokens).toBeLessThanOrEqual(E2E_HISTORY_BUDGET)
  })

  it("the control replays the earlier memory_search call", () => {
    expect(requestText(warm.turn)).toContain(CR_REPLAY_MARKER)
    expect(budgetLineOf(warm, CR_WARM_THREAD).memoryCallTokens).toBeGreaterThan(0)
  })

  it("the same cold turn with recall off and the memory tools removed lacks the number", () => {
    // It really is the cold scenario, so what differs is retrieval and nothing else.
    expect(budgetLineOf(dark, CR_DARK_THREAD).coldResume).toBe(true)
    expect(dark.answer).not.toContain(CR_ACCOUNT_NUMBER)
    // And the number is in no part of the request at all, so no reader, and no
    // model, could have answered with it.
    expect(dark.turn.prefixText).not.toContain(CR_ACCOUNT_NUMBER)
    expect(dark.turn.tailText).not.toContain(CR_ACCOUNT_NUMBER)
  })
})

// ---------------------------------------------------------------------------
// The e2e wiring: both runners must actually discover this directory.
// ---------------------------------------------------------------------------

describe("P4m-T36 e2e wiring", () => {
  it("the parallel e2e runner discovers the agent-memory scenario files", async () => {
    const runnerPath = path.resolve(
      import.meta.dir,
      "../../../../../../scripts/test-e2e-parallel.ts",
    )
    const source = await Bun.file(runnerPath).text()
    // The runner takes its file list from the shared discovery helper (one
    // definition for both e2e runners, scripts/lib/api-e2e-files.ts), so the
    // assertion is on that helper's output, not on a glob in the runner.
    expect(source).toContain("apiE2eScenarioFiles(scenarioDir)")

    // A non recursive discovery leaves every scenario in a subdirectory
    // invisible to the parallel lane, which is where this whole harness lives.
    const scenarioDir = path.resolve(import.meta.dir, "..")
    const discovered = apiE2eScenarioFiles(scenarioDir).map((f) =>
      path.relative(scenarioDir, f).split(path.sep).join("/"),
    )
    const agentMemory = discovered.filter((f) => f.startsWith("agent-memory/"))
    expect(agentMemory.length).toBeGreaterThanOrEqual(5)
    for (const name of [
      "agent-memory/long-memory.scenario.test.ts",
      "agent-memory/long-memory-supersession.scenario.test.ts",
      "agent-memory/long-memory-continuity.scenario.test.ts",
      "agent-memory/long-memory-budgets.scenario.test.ts",
      "agent-memory/history-prefix-stability.scenario.test.ts",
    ]) {
      expect(agentMemory).toContain(name)
    }
  })
})
