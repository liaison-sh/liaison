// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4m-T33: the long memory harness, scenario 1 of spec-memory.md's validation
// list, "recall past the window", with its falsifiable counter.
//
// WHAT IS PROVEN. A DM carrying about 80,000 tokens of conversation states one
// carrier account number ONCE, early. The turn that asks for it runs the real
// production path: the checkpoint advance fires between turns and cuts the
// stating message out of the rendered history for good, auto recall searches
// the transcript index and injects the hit into the ephemeral runtime context
// tail, and the answer carries the number. The harness asserts WHERE the number
// came from, not only that it appeared: it is in the tail and in no byte of the
// cached prefix.
//
// THE FALSIFIABLE COUNTER. The same question, with retrieval switched off in
// the HARNESS (auto recall and memory_search stubbed through the module, never
// a production switch), must fail to produce the number, and the harness
// asserts that it does. Without that half a pass would only mean the window
// still held the fact.
//
// NO FUNDED KEY. The Anthropic key on this machine has no credit, so every
// model backed step is scripted through the production test seams: the turn
// stream, the checkpoint summarizer, and consolidation's flush and extractor.
// The scripted reader may cite only what the captured request carried, which is
// what makes the counter meaningful. See helpers/long-memory.ts.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import * as searchClientModule from "~/infra/search/client"
import { CheckpointTestAccess } from "~/modules/agent/context/checkpoint"
import * as memoryRecallModule from "~/modules/agent/memory/memory-recall"
import * as memorySearchModule from "~/modules/agent/memory/memory-search"
import { ExternalSearchHandlersTestAccess } from "~/modules/search/external-handlers"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { type CapturedTurn, installRequestCapture } from "./helpers/capture-requests"
import {
  answerFromRequest,
  driveTurn,
  dropWorld,
  insertMessage,
  padded,
  readerStream,
  seedWorld,
} from "./helpers/long-memory"

const ORG_ID = "4d000000-0000-4000-8000-000000000101"
const USER_ID = "4d000000-0000-4000-8000-000000000102"
const THREAD_ID = "4d000000-0000-4000-8000-000000000103"
const AGENT_ID = "4d000000-0000-4000-8000-000000000104"

/** Stated once, early, and never again. */
const ACCOUNT_NUMBER = "KRY-55123"
const FACT_LINE = `The Kryptonite carrier account number is ${ACCOUNT_NUMBER}, agreed with the carrier.`
const QUESTION = "What is the Kryptonite carrier account number we agreed with the carrier?"

/** 50 padded messages of 6,500 chars is about 81,000 tokens of raw history. */
const FILLER_MESSAGES = 50
const INDEX_NAME = `test_p4mt33_${crypto.randomUUID().slice(0, 8)}`
const THREADS_READ = "kernel:threads:read"

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

const spies: Array<{ mockRestore: () => void }> = []
const ORIG_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

let factMessageId = ""

async function seedConversation(): Promise<void> {
  // Two padded exchanges, then the fact, then the rest: early, and once.
  for (let i = 0; i < 2; i++) {
    await insertMessage({
      orgId: ORG_ID,
      threadId: THREAD_ID,
      authorId: USER_ID,
      authorType: "user",
      content: padded(`Opening note ${i} about the shipment plan.`),
    })
  }
  const fact = await insertMessage({
    orgId: ORG_ID,
    threadId: THREAD_ID,
    authorId: USER_ID,
    authorType: "user",
    content: FACT_LINE,
  })
  factMessageId = fact.id
  for (let i = 0; i < FILLER_MESSAGES; i++) {
    await insertMessage({
      orgId: ORG_ID,
      threadId: THREAD_ID,
      // The initiating human is the author_id of an agent post too; the agent
      // is named by author_type / author_agent_id (modules/threads/message.ts).
      authorId: USER_ID,
      authorType: i % 2 === 0 ? "agent" : "user",
      ...(i % 2 === 0 ? { authorAgentId: AGENT_ID } : {}),
      content: padded(`Routine logistics exchange ${i}, nothing decided here.`),
    })
  }
}

/** Index the transcript so the verbatim leg of memory_search has a substrate. */
async function indexTranscript(): Promise<void> {
  const { expectedSettings } = await import("~/modules/search/drift")
  const created = await meili.createIndex(INDEX_NAME, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const applied = await meili
    .index(INDEX_NAME)
    .updateSettings(expectedSettings({ registeredReadScopes: [THREADS_READ], dimensionFields: [] }))
  await meili.tasks.waitForTask(applied.taskUid)
  const { processMessageIndexerJob } = await import("~/modules/search/message-indexer")
  await processMessageIndexerJob({ action: "upsert", orgId: ORG_ID, messageId: factMessageId })
}

interface ScenarioRun {
  answer: string
  turn: CapturedTurn
}

/** Ask the question once, with retrieval either live or switched off. */
async function askOnce(opts: { retrievalDisabled: boolean }): Promise<ScenarioRun> {
  const local: Array<{ mockRestore: () => void }> = []
  if (opts.retrievalDisabled) {
    // THE COUNTER, in the harness only: both server side retrieval paths are
    // stubbed at the module boundary. Production keeps no such switch.
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
  const capture = installRequestCapture({
    currentAgentKey: () => AGENT_ID,
    script: (turn) => {
      captured.push(turn)
      return readerStream(answerFromRequest(turn))
    },
  })
  try {
    const answer = await driveTurn({
      orgId: ORG_ID,
      threadId: THREAD_ID,
      userId: USER_ID,
      agentId: AGENT_ID,
      content: QUESTION,
    })
    expect(captured.length).toBeGreaterThan(0)
    return { answer, turn: captured[0] }
  } finally {
    capture.restore()
    for (const s of local) s.mockRestore()
  }
}

describe("P4m-T33 long memory scenario 1, recall past the window", () => {
  let live: ScenarioRun
  let disabled: ScenarioRun
  let checkpointCount = 0

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-long-memory-stub"
    ExternalSearchHandlersTestAccess.reset()
    spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_NAME))
    spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue(
        meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
      ),
    )
    // The checkpoint summary is a cheap model call with no stream seam of its
    // own. It is scripted, and deliberately carries NO account number: a
    // summary that quoted the fact would answer the question without recall and
    // the counter would prove nothing.
    CheckpointTestAccess.setSummarizer(
      async () => "Summary of the shipment planning conversation so far. No figures retained.",
    )
    await seedWorld({
      orgId: ORG_ID,
      userId: USER_ID,
      userEmail: "longmemory@test.com",
      agents: [
        {
          id: AGENT_ID,
          handle: "@longmemory",
          displayName: "Long Memory",
          kind: "personal",
          ownerUserId: USER_ID,
        },
      ],
      threads: [{ id: THREAD_ID, handle: "long-memory-dm" }],
    })
    await seedConversation()
    await indexTranscript()

    // THE COUNTER RUNS FIRST, on purpose. The live run's own ANSWER is written
    // into the thread as a message, so a counter run after it would find the
    // number in the raw tail and prove nothing about retrieval. This order also
    // means the checkpoint advance, which fires on the first driven turn, has
    // already cut the stating message out before either question is asked.
    disabled = await askOnce({ retrievalDisabled: true })
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.agent_thread_checkpoints
      WHERE thread_id = ${THREAD_ID} AND agent_id = ${AGENT_ID}`
    checkpointCount = rows[0]?.n ?? 0
    live = await askOnce({ retrievalDisabled: false })
  })

  afterAll(async () => {
    CheckpointTestAccess.setSummarizer()
    for (const s of spies) s.mockRestore()
    spies.length = 0
    resetOrgRuntimeForTest(ORG_ID)
    if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await meili.deleteIndex(INDEX_NAME).catch(() => undefined)
    await dropWorld(ORG_ID)
    await releaseTestLock()
  })

  it("recalls a carrier account number stated once before the checkpoint advanced", () => {
    expect(checkpointCount).toBeGreaterThanOrEqual(1)
    expect(live.answer).toContain(ACCOUNT_NUMBER)
  })

  it("the recalled number reaches the turn through the ephemeral tail and not the rendered history", () => {
    expect(live.turn.tailText).toContain(ACCOUNT_NUMBER)
    // The stating message is behind the checkpoint boundary: it is in no byte
    // of the cached prefix, so the tail is the only way it reached the turn.
    expect(live.turn.prefixText).not.toContain(ACCOUNT_NUMBER)
  })

  it("the same question fails with retrieval disabled", () => {
    expect(disabled.answer).not.toContain(ACCOUNT_NUMBER)
    // And the number is in no part of the request at all, so no reader, and no
    // model, could have answered with it.
    expect(disabled.turn.tailText).not.toContain(ACCOUNT_NUMBER)
    expect(disabled.turn.prefixText).not.toContain(ACCOUNT_NUMBER)
  })
})
