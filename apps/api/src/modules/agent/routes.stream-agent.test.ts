// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The chat route (POST /agent/chat) mirrors its turn onto the thread as
// `agent_stream` frames. Those frames named no agent, so the web keyed the run
// on the null slot and headed the live block (and the failure block) with the
// generic "Personal agent" label, whatever the acting agent was called. Every
// other emitter (the @-mention mirror, the failed-turn report) names it; this
// one does too, on the streamed frames and on the error frame.
//
// In a thread other people read, the mirror hands their sockets the answer
// only: a step's text before its tool call is working notes and never goes out.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { flushEventHandlers, onEvent } from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const TEAMMATE = crypto.randomUUID()
const NARRATION = "I'll look at the inbox first."
const ANSWER = "Two new orders came in."
const tag = ORG.slice(0, 8)

function answering() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "hello from Base" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

function narrating() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: NARRATION }
      yield { type: "tool-call", toolCallId: "call-rsa-0", toolName: "probe__look", input: {} }
      yield { type: "tool-result", toolCallId: "call-rsa-0", toolName: "probe__look", output: {} }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "tool-calls",
      }
      yield { type: "text-delta", text: ANSWER }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

function failing() {
  return {
    fullStream: (async function* () {
      yield { type: "error", error: new Error("No API key available for provider anthropic") }
    })(),
  } as never
}

const frames: Array<{ threadId: string; action: string; data: Record<string, unknown> }> = []
let token = ""

async function seedThread(handle: string, withTeammate = false): Promise<string> {
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${handle}, ${withTeammate ? "thread" : "agent_chat"}, ${USER}) RETURNING id`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${t.id}, ${USER}, ${ORG})`
  if (withTeammate) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${t.id}, ${TEAMMATE}, ${ORG})`
  }
  return t.id
}

function streamedText(threadId: string): string {
  return frames
    .filter((f) => f.threadId === threadId && f.action === "delta")
    .map((f) => String(f.data.delta ?? ""))
    .join("")
}

async function chat(threadId: string): Promise<void> {
  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ threadId, content: "what is new?" }),
  })
  expect(res.status).toBe(200)
  // Drain the SSE body so the route's stream loop runs to completion.
  await res.text()
  // The mirror broadcasts fire-and-forget: wait for the terminal frame.
  for (let i = 0; i < 100; i++) {
    await flushEventHandlers()
    if (
      frames.some((f) => f.threadId === threadId && (f.action === "done" || f.action === "error"))
    )
      return
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("the chat route's agent_stream frames name the acting agent", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Stream Agent Org', ${`rsa-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`rsa-${tag}@t.com`}, 'Taylor')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${TEAMMATE}, ${ORG}, ${`rsa-mate-${tag}@t.com`}, 'Robin')`
    // The acting agent carries its own name: the frame must let the web say it.
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'personal', ${`@rsa-${tag}`}, 'Base', ${USER}, '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER}, ${ORG}, '*')`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${ORG}, '10.00000000', '5.00000000', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing
        (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT (provider, model_id) DO NOTHING`
    token = await signAccessToken(
      {
        userId: USER,
        orgId: ORG,
        name: "Taylor",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
    onEvent(
      async (event) => {
        if (event.entity !== "agent_stream") return
        const data = (event.data ?? {}) as Record<string, unknown>
        frames.push({ threadId: String(data.threadId ?? ""), action: event.action, data })
      },
      { delivery: "per-replica" },
    )
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  it("every streamed frame of an answering turn carries the agent id", async () => {
    const threadId = await seedThread(`rsa-ok-${tag}`)
    AgentServiceTestAccess.setStreamText(answering as never)
    await chat(threadId)
    const mine = frames.filter((f) => f.threadId === threadId)
    expect(mine.map((f) => f.action)).toContain("delta")
    expect(mine.map((f) => f.action)).toContain("done")
    for (const f of mine) expect(f.data.agentId).toBe(AGENT)
  })

  it("the error frame of a failed turn carries the agent id", async () => {
    const threadId = await seedThread(`rsa-err-${tag}`)
    AgentServiceTestAccess.setStreamText(failing as never)
    await chat(threadId)
    const errors = frames.filter((f) => f.threadId === threadId && f.action === "error")
    expect(errors.length).toBeGreaterThan(0)
    for (const f of errors) expect(f.data.agentId).toBe(AGENT)
  })

  it("in a thread a teammate reads, the mirror sends the answer but not the notes", async () => {
    const threadId = await seedThread(`rsa-shared-${tag}`, true)
    AgentServiceTestAccess.setStreamText(narrating as never)
    await chat(threadId)
    expect(streamedText(threadId)).toBe(ANSWER)
    const actions = frames.filter((f) => f.threadId === threadId).map((f) => f.action)
    expect(actions).toContain("tool_call")
    expect(actions).toContain("done")
  })

  it("in a private agent chat, the mirror sends every line as written", async () => {
    const threadId = await seedThread(`rsa-private-${tag}`)
    AgentServiceTestAccess.setStreamText(narrating as never)
    await chat(threadId)
    expect(streamedText(threadId)).toBe(NARRATION + ANSWER)
  })
})
