// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S8, A7, A8: an agent mentioned in a reply answers IN the reply thread, and
// its context is the root plus the replies, not the channel. The channel's
// checkpoint is neither read nor advanced by such a turn; a channel turn's raw
// tail leaves channel-hidden replies out. Every line the turn writes lands in
// the reply thread: the answer, a gated tool's approval card (and the notices
// posted on it later), a dispatch refusal line.
//
// The model is the one double (the stream seam); the rows, the dispatch, the
// history load and the persistence are real.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { flushEventHandlers, onEvent } from "~/infra/events/event-bus"
import { loadBoundedHistory } from "~/modules/agent/context/checkpoint"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { persistAgentTurn } from "~/modules/agent/runtime/persist-agent-turn"
import { runAgentReinvoke } from "~/modules/agent/runtime/reinvoke"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { postDualSystemMessages } from "~/modules/approvals/event-data"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { dispatchAgentMention } from "~/modules/threads/agent-dispatch-guard"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const CALLER = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""
let beforeMsg = ""
let root = ""
let chatter = ""
let replyOne = ""

const actor = {
  actorType: "user" as const,
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {} as Record<string, string[]>,
}

const prompts: string[] = []

function fakeStream(params: { messages: unknown }) {
  prompts.push(JSON.stringify(params.messages))
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "the agent answer" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 3, outputTokens: 2 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

let seq = 0
async function seed(content: string, replyRootId: string | null = null): Promise<string> {
  seq += 1
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, content, required_scopes, reply_root_id, created_at)
    VALUES (${THREAD}, ${ORG}, ${USER}, 'user', ${content}, '{}'::text[], ${replyRootId},
            ${`2031-01-01T00:00:${String(seq).padStart(2, "0")}Z`}::timestamptz)
    RETURNING id`
  return row.id
}

async function checkpointVersions(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.agent_thread_checkpoints
    WHERE agent_id = ${AGENT} AND thread_id = ${THREAD}`
  return row.n
}

beforeAll(async () => {
  await acquireTestLock()
  AgentServiceTestAccess.setStreamText(fakeStream as never)
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Reply Turn Org', ${`rtt-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`rtt-${tag}@t.com`}, 'Reply User')`
  for (const [id, handle, name] of [
    [AGENT, `@rtt-agent-${tag}`, "Helper"],
    [CALLER, `@rtt-caller-${tag}`, "Caller"],
  ]) {
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${id}, ${ORG}, 'role', ${handle}, ${name}, '["*"]'::jsonb)`
  }
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${ORG}, '10.00000000', '5.00000000', 'EUR')`
  await sql`INSERT INTO kernel.model_pricing
      (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter')
    ON CONFLICT (provider, model_id) DO NOTHING`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, title, type, agent_model_id, created_by)
    VALUES (${ORG}, ${`rtt-${tag}`}, 'Channel', 'thread', 'claude-haiku-4-5', ${USER}) RETURNING id`
  THREAD = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${THREAD}, ${AGENT}, ${ORG}, 'agent')`

  beforeMsg = await seed("channel before the root")
  root = await seed("the root question about invoices")
  chatter = await seed("unrelated channel chatter about lunch")
  replyOne = await seed("reply one: the March invoice", root)
  // A checkpoint of the CHANNEL covering the first message: a reply turn must
  // not render it, and must not write another version.
  await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
    VALUES (${ORG}, ${AGENT}, ${THREAD}, ${beforeMsg}, 'CHANNEL CHECKPOINT SUMMARY', '{}'::text[], 5, 1)`
})

afterAll(async () => {
  AgentServiceTestAccess.setStreamText()
  toolRegistry.delete([ORG, "rtt_app", "gated"])
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.reply_thread_followers WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("an agent turn started in a reply thread (S8, A7, A8)", () => {
  it("the bounded history of a reply turn is the root and its replies, with no channel checkpoint", async () => {
    const reply = await loadBoundedHistory({
      threadId: THREAD,
      orgId: ORG,
      actor,
      agentId: AGENT,
      replyRootId: root,
    })
    expect(reply.messages.map((m) => m.id)).toEqual([root, replyOne])
    expect(reply.checkpoint).toBeNull()
  })

  it("a channel turn's raw tail leaves out a reply the channel does not show", async () => {
    const channel = await loadBoundedHistory({
      threadId: THREAD,
      orgId: ORG,
      actor,
      agentId: AGENT,
    })
    const ids = channel.messages.map((m) => m.id)
    expect(ids).toContain(chatter)
    expect(ids).not.toContain(replyOne)
  })

  it("answers in the reply thread, from the reply thread's context, without touching the channel checkpoint", async () => {
    const trigger = await seed("@Helper what do you think?", root)
    const versionsBefore = await checkpointVersions()
    prompts.length = 0
    await invokeAgentForThread(
      THREAD,
      trigger,
      actor,
      ORG,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      AGENT,
    )
    const [answer] = await sql<{ reply_root_id: string | null; also_in_channel: boolean }[]>`
      SELECT reply_root_id, also_in_channel FROM kernel.messages
      WHERE thread_id = ${THREAD} AND author_type = 'agent' AND content = 'the agent answer'`
    expect(answer).toEqual({ reply_root_id: root, also_in_channel: false })
    const prompt = prompts.join("\n")
    expect(prompt).toContain("the root question about invoices")
    expect(prompt).toContain("reply one: the March invoice")
    expect(prompt).not.toContain("unrelated channel chatter")
    expect(prompt).not.toContain("CHANNEL CHECKPOINT SUMMARY")
    expect(await checkpointVersions()).toBe(versionsBefore)
  })

  // QA THR-10: the channel's state line read the typing announcement of a
  // reply turn as its own ("Queued" under the channel list). The frames name
  // the reply thread, so the channel can leave them to the panel.
  it("announces a reply turn's typing start and stop with the reply root", async () => {
    const frames: Array<{ action: string; data: Record<string, unknown> }> = []
    onEvent(
      async (event) => {
        if (event.entity === "typing" && event.entityId === THREAD) {
          frames.push({ action: event.action, data: (event.data ?? {}) as Record<string, unknown> })
        }
      },
      { delivery: "per-replica" },
    )
    const trigger = await seed("@Helper and the April one?", root)
    await invokeAgentForThread(
      THREAD,
      trigger,
      actor,
      ORG,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      AGENT,
    )
    // typing:stop is broadcast fire-and-forget from the turn's finally.
    for (let i = 0; i < 50 && !frames.some((f) => f.action === "stop"); i++) {
      await new Promise((r) => setTimeout(r, 10))
      await flushEventHandlers()
    }
    const actions = frames.map((f) => f.action)
    expect(actions).toContain("start")
    expect(actions).toContain("stop")
    for (const f of frames) expect(f.data.replyRootId).toBe(root)
  })

  it("persistAgentTurn writes the answer under the root it is given", async () => {
    const sent = await persistAgentTurn({
      write: (fn) => withPrivilegedDb(ORG, "rtt-persist", (tx) => fn(tx as never)),
      orgId: ORG,
      userId: USER,
      threadId: THREAD,
      agentId: AGENT,
      content: "persisted in the thread",
      endsTurn: true,
      requiredScopes: [],
      replyRootId: root,
      metadata: {},
    })
    expect(sent?.replyRootId).toBe(root)
  })

  it("a gated tool called in a reply turn puts its approval card, and the notices on it, in the reply thread", async () => {
    toolRegistry.set([ORG, "rtt_app", "gated"], {
      appName: "rtt_app",
      name: "gated",
      description: "Reply-thread gated test tool",
      requiredScopes: ["rtt_app:write"],
      gated: true,
      handler: async () => ({ ok: true }),
    } as never)
    const result = await runContextStore.run(
      {
        runId: crypto.randomUUID(),
        parentRunId: null,
        rootRunId: crypto.randomUUID(),
        nestingDepth: 0,
        replyRoot: { threadId: THREAD, rootMessageId: root },
        turnScopeAccumulator: createTurnScopeAccumulator(),
      },
      () =>
        executeTool({
          toolName: "rtt_app:gated",
          orgId: ORG,
          actor,
          threadId: THREAD,
          params: { message: "hello" },
        }),
    )
    const requestId = result.blocked?.approvalRequestId
    expect(requestId).toBeTruthy()
    const [card] = await sql<{ reply_root_id: string | null }[]>`
      SELECT reply_root_id FROM kernel.messages
      WHERE thread_id = ${THREAD} AND metadata->>'type' = 'approval-created'
        AND metadata->>'requestId' = ${requestId!}`
    expect(card.reply_root_id).toBe(root)

    await withPrivilegedDb(ORG, "rtt-notice", (tx) =>
      postDualSystemMessages(tx, {
        requiredScopes: [],
        orgId: ORG,
        threadId: THREAD,
        originatingThreadId: THREAD,
        requesterId: USER,
        actorUserId: USER,
        content: "Approval decided",
        metadata: { type: "approval-decision", requestId },
        agentId: null,
      }),
    )
    const [notice] = await sql<{ reply_root_id: string | null }[]>`
      SELECT reply_root_id FROM kernel.messages
      WHERE thread_id = ${THREAD} AND content = 'Approval decided'`
    expect(notice.reply_root_id).toBe(root)

    // The failed bundle's re-invocation posts its context, and the healing
    // turn answers, in the same reply thread.
    prompts.length = 0
    await runAgentReinvoke({
      orgId: ORG,
      threadId: THREAD,
      bundleId: requestId!,
      requesterId: USER,
      context: "step one failed: retry the invoice",
      agentId: AGENT,
    })
    const [context] = await sql<{ reply_root_id: string | null }[]>`
      SELECT reply_root_id FROM kernel.messages
      WHERE thread_id = ${THREAD} AND metadata->>'type' = 'bundle-reinvoke'`
    expect(context.reply_root_id).toBe(root)
    expect(prompts.join("\n")).not.toContain("unrelated channel chatter")
  })

  it("a dispatch refused inside a reply thread says so in the reply thread", async () => {
    const trigger = await seed("an agent asks without a stated scope", root)
    const outcome = await dispatchAgentMention(
      (fn) => withRlsContext(actor, (tx) => fn(tx as never)) as never,
      {
        orgId: ORG,
        threadId: THREAD,
        calleeAgentId: AGENT,
        callerAgentId: CALLER,
        parentMessageId: trigger,
        triggerMessageId: trigger,
        questionText: "?",
        actor,
        adderName: "Reply User",
        replyRootId: root,
      },
    )
    expect(outcome.allowed).toBe(false)
    const lines = await sql<{ reply_root_id: string | null }[]>`
      SELECT reply_root_id FROM kernel.messages
      WHERE thread_id = ${THREAD} AND author_type = 'system' AND created_at > now() - interval '1 minute'
        AND metadata IS NULL`
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.reply_root_id === root)).toBe(true)
  })
})
