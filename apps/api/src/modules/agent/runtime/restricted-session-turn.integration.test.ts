// SPDX-License-Identifier: FSL-1.1-ALv2
// A restricted (device-flow) session's message is not a turn a person typed:
// a program holding a capped token sent it, and nothing proves a person is
// behind it (auth/session-ceiling.ts). Driven through the real routes and agent
// loop with the scripted provider, against a person's normal session, which
// stays as it was:
//
//  - the run frame says so, on both ways a message starts a turn;
//  - a `requiresHumanTurn` tool parks instead of running;
//  - the message does not clear the thread's outside-text mark.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { z } from "zod"
import { app } from "~/app"
import { sql } from "~/db"
import * as eventBusModule from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import {
  clearScriptedTurns,
  setScriptedTurn,
} from "~/modules/agent/providers/scripted-model-provider"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { setTaintFlag } from "~/modules/agent/scopes/taint"
import { toolRegistry } from "~/modules/apps/app-registries"
import { signAccessToken } from "~/modules/auth/jwt"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const ORIG_PROVIDER = process.env.LIAISON_MODEL_PROVIDER

const PROBE = "kernel__test_restricted_probe"
const NEEDS_PERSON = "kernel__test_restricted_needs_person"

/** The frame each probe call ran in, by its key. */
const probed = new Map<string, { humanTurn: boolean; sessionRestricted: boolean }>()
/** The `requiresHumanTurn` tool's handler ran, by its key. */
const ran = new Set<string>()

let owner: minimal.Session
let agentId: string
let restrictedBearer: string
const scriptedThreads: string[] = []

async function freshThread(): Promise<string> {
  const threadId = await minimal.thread(owner.orgId, owner.userId)
  scriptedThreads.push(threadId)
  await sql`UPDATE kernel.threads SET type = 'agent_chat' WHERE id = ${threadId}`
  await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
    VALUES (${threadId}, ${agentId}, ${owner.orgId}, 'agent')`
  return threadId
}

async function until<T>(
  read: () => T | Promise<T>,
  ok: (v: T) => boolean,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v) || Date.now() > end) return v
    await Bun.sleep(50)
  }
}

/** A message through POST /api/agent/chat, its stream read to the end. */
async function chat(bearer: string, threadId: string, content: string): Promise<void> {
  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ threadId, content }),
  })
  expect(res.status).toBe(200)
  await res.text()
}

/** A message through POST /api/threads/:id/messages; the agent's turn is detached from it. */
async function post(bearer: string, threadId: string, content: string): Promise<void> {
  const res = await app.request(`/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  })
  expect(res.status).toBeLessThan(300)
}

async function isMarked(threadId: string): Promise<boolean> {
  const [row] = await sql<{ tainted: boolean }[]>`
    SELECT tainted FROM kernel.threads WHERE id = ${threadId}`
  return row?.tainted === true
}

async function parkedCount(threadId: string, toolName: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.approval_requests
    WHERE thread_id = ${threadId} AND tool_name = ${toolName} AND status = 'pending'`
  return row?.n ?? 0
}

describe("a restricted session's message", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    process.env.LIAISON_MODEL_PROVIDER = "scripted"
    owner = await minimal.adminSession((await createTestOrg()).id)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@rs-${crypto.randomUUID().slice(0, 8)}`}, 'Sam',
              '["*"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${owner.orgId}, '10.00000000', '0.00000000', 'EUR') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00000000', '5.00000000', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
    toolRegistry.set([owner.orgId, "kernel", "test_restricted_probe"], {
      appName: "kernel",
      name: "test_restricted_probe",
      description: "Test only: record the run frame this call ran in.",
      requiredScopes: ["kernel:agent:web"],
      readOnly: true,
      params: z.object({ key: z.string() }),
      handler: async (raw: unknown) => {
        const { key } = z.object({ key: z.string() }).parse(raw)
        const frame = currentRunContext()
        probed.set(key, {
          humanTurn: frame?.humanTurn === true,
          sessionRestricted: frame?.sessionRestricted === true,
        })
        return { key }
      },
    })
    toolRegistry.set([owner.orgId, "kernel", "test_restricted_needs_person"], {
      appName: "kernel",
      name: "test_restricted_needs_person",
      description: "Test only: a tool that needs a turn a person typed.",
      requiredScopes: ["kernel:agent:web"],
      requiresHumanTurn: true,
      params: z.object({ key: z.string() }),
      handler: async (raw: unknown) => {
        const { key } = z.object({ key: z.string() }).parse(raw)
        ran.add(key)
        return { key }
      },
    })
    const [versions] = await sql<{ auth_version: number; permission_version: number }[]>`
      SELECT auth_version, permission_version FROM kernel.users WHERE id = ${owner.userId}`
    restrictedBearer = await signAccessToken(
      {
        userId: owner.userId,
        orgId: owner.orgId,
        name: "Owner",
        authVersion: versions?.auth_version ?? 1,
        permissionVersion: versions?.permission_version ?? 1,
        scopes: ["kernel:*"],
        dimensionGrants: {},
        restricted: true,
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    toolRegistry.delete([owner.orgId, "kernel", "test_restricted_probe"])
    toolRegistry.delete([owner.orgId, "kernel", "test_restricted_needs_person"])
    await Promise.all(scriptedThreads.map((t) => clearScriptedTurns(t)))
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    if (ORIG_PROVIDER !== undefined) process.env.LIAISON_MODEL_PROVIDER = ORIG_PROVIDER
    else delete process.env.LIAISON_MODEL_PROVIDER
    broadcastSpy.mockRestore()
    await releaseTestLock()
  })

  it("through /api/agent/chat is not a typed turn; a person's is", async () => {
    for (const [who, bearer, humanTurn] of [
      ["restricted", restrictedBearer, false],
      ["person", "", true],
    ] as const) {
      const threadId = await freshThread()
      const key = `chat-${who}-${crypto.randomUUID()}`
      await setScriptedTurn(threadId, [
        { toolCalls: [{ name: PROBE, args: { key } }] },
        { text: "Done." },
      ])
      await chat(bearer || owner.bearer, threadId, "hello")
      expect(probed.get(key)).toEqual({ humanTurn, sessionRestricted: !humanTurn })
    }
  })

  it("posted to a conversation is not a typed turn; a person's is", async () => {
    for (const [who, bearer, humanTurn] of [
      ["restricted", restrictedBearer, false],
      ["person", "", true],
    ] as const) {
      const threadId = await freshThread()
      const key = `post-${who}-${crypto.randomUUID()}`
      await setScriptedTurn(threadId, [
        { toolCalls: [{ name: PROBE, args: { key } }] },
        { text: "Done." },
      ])
      await post(bearer || owner.bearer, threadId, "hello")
      await until(
        () => probed.get(key),
        (seen) => seen !== undefined,
      )
      expect(probed.get(key)).toEqual({ humanTurn, sessionRestricted: !humanTurn })
    }
  })

  it("parks a tool that needs a typed turn; a person's message runs it", async () => {
    const parkedThread = await freshThread()
    const parked = `needs-restricted-${crypto.randomUUID()}`
    await setScriptedTurn(parkedThread, [
      { toolCalls: [{ name: NEEDS_PERSON, args: { key: parked } }] },
      { text: "Done." },
    ])
    await chat(restrictedBearer, parkedThread, "run it")
    expect(ran.has(parked)).toBe(false)
    expect(await parkedCount(parkedThread, "kernel:test_restricted_needs_person")).toBe(1)

    const typedThread = await freshThread()
    const typed = `needs-person-${crypto.randomUUID()}`
    await setScriptedTurn(typedThread, [
      { toolCalls: [{ name: NEEDS_PERSON, args: { key: typed } }] },
      { text: "Done." },
    ])
    await chat(owner.bearer, typedThread, "run it")
    expect(ran.has(typed)).toBe(true)
    expect(await parkedCount(typedThread, "kernel:test_restricted_needs_person")).toBe(0)
  })

  it("keeps the thread's outside-text mark; a person's message clears it", async () => {
    const restrictedThread = await freshThread()
    await setTaintFlag(restrictedThread, owner.orgId)
    await setScriptedTurn(restrictedThread, [{ text: "Done." }])
    await chat(restrictedBearer, restrictedThread, "go on")
    expect(await isMarked(restrictedThread)).toBe(true)

    const typedThread = await freshThread()
    await setTaintFlag(typedThread, owner.orgId)
    await setScriptedTurn(typedThread, [{ text: "Done." }])
    await chat(owner.bearer, typedThread, "go on")
    expect(await isMarked(typedThread)).toBe(false)
  })
})
