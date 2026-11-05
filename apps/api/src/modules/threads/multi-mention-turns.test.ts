// SPDX-License-Identifier: FSL-1.1-ALv2
//
// spec-agents.md A29/A30: a room may address several agents at once, and every
// agent a message NAMES takes a turn. One reply for two mentions is an agent
// silently ignoring somebody, which is the one failure mode the dispatch
// refusal lines exist to prevent.

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  creditBalances,
  modelPricing,
  threadParticipants,
  threads,
  users,
} from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { env } from "~/lib/env"
import * as agentServiceModule from "~/modules/agent/runtime/agent-service"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

setDefaultTimeout(60_000)

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

/** Every agent turn started in this file, captured where every turn starts. */
const startedTurns: Promise<unknown>[] = []
const realInvokeAgentForThread = agentServiceModule.invokeAgentForThread
const invokeSpy = spyOn(agentServiceModule, "invokeAgentForThread").mockImplementation(((
  ...args: Parameters<typeof realInvokeAgentForThread>
) => {
  const turn = realInvokeAgentForThread(...args)
  startedTurns.push(turn)
  if (startedTurns.length >= 2) releaseOverlap()
  return turn
}) as typeof realInvokeAgentForThread)

let orgId = ""
let userId = ""
let token = ""
let threadId = ""
let alphaId = ""
let betaId = ""

async function seatAgentlessThread(): Promise<string> {
  return withPrivilegedDb(orgId, "multi-mention-thread", async (tx) => {
    const [t] = await tx
      .insert(threads)
      .values({
        orgId,
        handle: `mm-${crypto.randomUUID().slice(0, 8)}`,
        title: "Two agents, one question",
        type: "thread",
        createdBy: userId,
      })
      .returning({ id: threads.id })
    await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId, role: "owner" })
    return t.id
  })
}

async function makeAgent(handle: string, displayName: string): Promise<string> {
  return withPrivilegedDb(orgId, "multi-mention-agent", async (tx) => {
    const [a] = await tx
      .insert(agents)
      .values({
        orgId,
        kind: "role",
        handle,
        displayName,
        scopeCeiling: ["kernel:threads:read", "kernel:threads:write"],
      })
      .returning({ id: agents.id })
    return a.id
  })
}

/** Every agent-authored row in the room, by the agent that wrote it. */
async function repliesByAgent(): Promise<Record<string, number>> {
  const rows = await sql<{ author_agent_id: string | null }[]>`
    SELECT author_agent_id FROM kernel.messages
    WHERE thread_id = ${threadId} AND author_type = 'agent'`
  const out: Record<string, number> = {}
  for (const r of rows) {
    if (!r.author_agent_id) continue
    out[r.author_agent_id] = (out[r.author_agent_id] ?? 0) + 1
  }
  return out
}

/**
 * Two mentions in one room OVERLAP in production, and an instant stub never
 * puts two runs in the thread at once. So a turn holds mid-stream until the
 * second mention's turn has also been dispatched, which proves the second
 * dispatch happens while the first run is live, without a fixed delay. If the
 * second is never dispatched, the hold gives up after OVERLAP_FALLBACK_MS so
 * the first still finishes and the assertions, not a hang, report it.
 */
const OVERLAP_FALLBACK_MS = 2500
let releaseOverlap: () => void = () => {}
const overlapReached = new Promise<void>((r) => {
  releaseOverlap = r
})

function slowStream(params: { onStepFinish?: (s: unknown) => unknown }) {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "Working" }
      let fallback: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        overlapReached,
        new Promise((r) => {
          fallback = setTimeout(r, OVERLAP_FALLBACK_MS)
        }),
      ])
      clearTimeout(fallback)
      yield { type: "text-delta", text: " on it." }
      yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 4 } }
      await params.onStepFinish?.({ toolCalls: [], usage: { inputTokens: 5, outputTokens: 4 } })
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

/**
 * Waits for the fire-and-forget dispatches to run to completion: every turn
 * started (captured at `invokeAgentForThread`, whose promise resolves once the
 * turn's finalize has persisted its reply) has settled. Bounded by the same
 * 9 s the test used to sleep; on timeout the assertions report what is missing.
 */
async function settle(timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs
  let awaited = -1
  while (awaited !== startedTurns.length && Date.now() < deadline) {
    await new Promise((r) => setImmediate(r))
    awaited = startedTurns.length
    await Promise.race([
      Promise.allSettled(startedTurns),
      new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now()))),
    ])
  }
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-multi-mention-stub"
  AgentServiceTestAccess.setStreamText(slowStream as never)
  orgId = (await createTestOrg()).id
  const user = await minimal.person(orgId, { role: "member" })
  userId = user.id
  for (const scope of ["kernel:threads:read", "kernel:threads:write"]) {
    await minimal.grantScope(userId, scope)
  }
  token = await (async () => {
    const [row] = await withSystemDb("multi-mention-token", (db) =>
      db
        .select({
          name: users.name,
          authVersion: users.authVersion,
          permissionVersion: users.permissionVersion,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    )
    const perms = await withPrivilegedDb(orgId, "multi-mention-perms", (tx) =>
      loadEffectivePermissions(tx, userId, orgId),
    )
    return signAccessToken(
      {
        userId,
        orgId,
        name: row?.name ?? "Tester",
        authVersion: row?.authVersion ?? 1,
        permissionVersion: row?.permissionVersion ?? 1,
        roles: perms.roles,
        scopes: perms.scopes,
        dimensionGrants: perms.dimensionGrants,
      },
      env.JWT_SECRET,
    )
  })()
  await withSystemDb("multi-mention-seed", async (db) => {
    await db
      .insert(modelPricing)
      .values({
        provider: "anthropic",
        modelId: "claude-haiku-4-5-mm",
        displayName: "Multi mention Haiku",
        inputCostPerM: "1.00",
        outputCostPerM: "5.00",
        contextWindow: 200000,
        autoEligible: true,
        tierMinimum: "starter",
      })
      .onConflictDoNothing()
    await db
      .insert(creditBalances)
      .values({ orgId, includedBalance: "10.00000000", purchasedBalance: "0", currency: "EUR" })
      .onConflictDoNothing()
  })
  alphaId = await makeAgent(`@mm-alpha-${crypto.randomUUID().slice(0, 6)}`, "Alpha Desk")
  betaId = await makeAgent(`@mm-beta-${crypto.randomUUID().slice(0, 6)}`, "Beta Desk")
  threadId = await seatAgentlessThread()
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
    VALUES (${userId}, ${threadId}, ${orgId})`
})

afterAll(async () => {
  invokeSpy.mockRestore()
  AgentServiceTestAccess.setStreamText()
  if (ORIG_ANTHROPIC_KEY === undefined) delete process.env.LIAISON_ANTHROPIC_API_KEY
  else process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
  await sql`DELETE FROM kernel.messages WHERE org_id = ${orgId}`
  await releaseTestLock()
})

describe("a message that names two agents", () => {
  it("gives BOTH mentioned agents a turn", async () => {
    const res = await app.request(`/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `@[Alpha Desk](agent:${alphaId}) and @[Beta Desk](agent:${betaId}) please both describe what you do`,
      }),
    })
    expect(res.status).toBe(200)
    await settle()
    const byAgent = await repliesByAgent()
    expect(byAgent[alphaId] ?? 0).toBeGreaterThan(0)
    expect(byAgent[betaId] ?? 0).toBeGreaterThan(0)
  })
})
