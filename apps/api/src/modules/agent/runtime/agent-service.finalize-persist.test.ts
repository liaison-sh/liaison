// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A turn's reply write must never leave the turn running. Model output can hold
// characters Postgres refuses (U+0000 in a tool call's arguments), and a write
// that fails for any reason must still end the turn and show the failure.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { agents } from "~/db/schema/kernel/agents"
import { creditBalances, modelPricing } from "~/db/schema/kernel/credits"
import { threadParticipants, threads } from "~/db/schema/kernel/threads"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { seedOrgRow, seedUserRows } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

function fakeAgentStreamText() {
  return {
    fullStream: (async function* () {
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

const ORG_ID = "00000000-0000-0000-0000-000000ac0191"
const USER_ID = "00000000-0000-0000-0000-000000ac0192"
const THREAD_ID = "00000000-0000-0000-0000-000000ac0193"

const actor = {
  actorType: "user" as const,
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

async function turnRow(turnId: string) {
  const [row] = await sql`
    SELECT state, failure_reason, error_code, agent_message_id
    FROM kernel.agent_turns WHERE id = ${turnId}
  `
  return row
}

async function lastAgentMessage() {
  const [row] = await sql`
    SELECT id, content, metadata FROM kernel.messages
    WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
    ORDER BY created_at DESC LIMIT 1
  `
  return row
}

describe("agent-service finalize: the reply write never strands the turn", () => {
  beforeAll(async () => {
    await acquireTestLock()
    AgentServiceTestAccess.setStreamText(fakeAgentStreamText as never)
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    await seedOrgRow(
      { id: ORG_ID, name: "NulFinalizeOrg", slug: "nul-finalize-org" },
      { onConflict: "skip" },
    )
    await seedUserRows(
      [{ id: USER_ID, orgId: ORG_ID, email: "nulfinalize@test.com", name: "Nul Finalize" }],
      { onConflict: "skip" },
    )
    await withPrivilegedDb(ORG_ID, "test-nul-finalize-seed", async (tx) => {
      await tx
        .insert(agents)
        .values({
          orgId: ORG_ID,
          kind: "personal",
          handle: "@nulfinalize",
          displayName: "Test agent",
          ownerUserId: USER_ID,
          scopeCeiling: ["*"],
        })
        .onConflictDoNothing()
      await tx
        .insert(threads)
        .values({
          id: THREAD_ID,
          orgId: ORG_ID,
          handle: "nul-finalize-chat",
          type: "agent_chat",
          createdBy: USER_ID,
        })
        .onConflictDoNothing()
      await tx
        .insert(threadParticipants)
        .values({ threadId: THREAD_ID, userId: USER_ID, orgId: ORG_ID })
        .onConflictDoNothing()
    })
    await withSystemDb("test-nul-finalize-pricing", async (db) => {
      await db
        .insert(modelPricing)
        .values({
          provider: "anthropic",
          modelId: "claude-haiku-4-5-nulfin",
          displayName: "Claude Haiku NulFin",
          inputCostPerM: "1.00",
          outputCostPerM: "5.00",
          contextWindow: 200000,
          autoEligible: true,
          tierMinimum: "starter",
        })
        .onConflictDoNothing()
      await db
        .insert(creditBalances)
        .values({
          orgId: ORG_ID,
          includedBalance: "10.00000000",
          purchasedBalance: "0",
          currency: "EUR",
        })
        .onConflictDoNothing()
    })
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  it("persists a reply whose tool call arguments, results and text hold U+0000", async () => {
    const { runAgentChat } = await import("./agent-service")
    const result = await runAgentChat({
      threadId: THREAD_ID,
      content: "nul in the model output",
      actor,
      orgId: ORG_ID,
    })

    const done = await result.finalize({
      usage: { promptTokens: 10, completionTokens: 5 },
      finishReason: "stop",
      text: "Done\u0000 here",
      reasoning: "thinking\u0000",
      steps: [
        {
          toolCalls: [
            { toolCallId: "call-nul-1", toolName: "kernel__web_search", args: { name: "\u0000" } },
          ],
          toolResults: [{ toolCallId: "call-nul-1", result: { note: "a\u0000b" } }],
        },
      ],
    })

    expect(done.finishReason).toBe("stop")
    const msg = await lastAgentMessage()
    expect(msg?.content).toBe("Done here")
    const meta = msg?.metadata as {
      toolCalls?: Array<{ args?: { name?: string } }>
      reasoning?: string
    }
    expect(meta.toolCalls?.[0]?.args?.name).toBe("")
    expect(JSON.stringify(meta)).not.toContain("\\u0000")
    const turn = await turnRow(result.turnId)
    expect(turn?.state).toBe("done")
    expect(turn?.agent_message_id).toBe(msg?.id)
  })

  it("ends the turn failed and shows the failure when the reply write throws", async () => {
    const { runAgentChat } = await import("./agent-service")
    const result = await runAgentChat({
      threadId: THREAD_ID,
      content: "a reply that cannot be written",
      actor,
      orgId: ORG_ID,
    })

    // A BigInt cannot be serialised into jsonb: the reply's metadata write throws.
    const done = await result.finalize({
      usage: { promptTokens: 10, completionTokens: 5 },
      finishReason: "stop",
      text: "Here is what I found",
      steps: [
        {
          toolCalls: [
            { toolCallId: "call-big-1", toolName: "kernel__web_search", args: { n: 1n } },
          ],
          toolResults: [{ toolCallId: "call-big-1", result: { ok: true } }],
        },
      ],
    })

    expect(done.finishReason).toBe("error")
    const turn = await turnRow(result.turnId)
    expect(turn?.state).toBe("failed")
    expect(turn?.failure_reason).toBe("turn")
    expect(turn?.error_code).toBe("reply_persist_failed")
    const msg = await lastAgentMessage()
    expect(turn?.agent_message_id).toBe(msg?.id)
    // The failure line only: the turn's text needs scopes that were never computed.
    expect(String(msg?.content)).toContain("could not be saved")
    expect(String(msg?.content)).not.toContain("Here is what I found")
    const meta = msg?.metadata as { finishReason?: string; errorCode?: string; turnId?: string }
    expect(meta.finishReason).toBe("error")
    expect(meta.errorCode).toBe("reply_persist_failed")
    expect(meta.turnId).toBe(result.userMessageId)
  })
})
