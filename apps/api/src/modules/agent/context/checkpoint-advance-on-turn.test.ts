// SPDX-License-Identifier: FSL-1.1-ALv2
//
// spec-memory.md A50: the checkpoint advances when the raw tail passes the
// history budget (48,000 tokens, or 40 percent of the model's window). The
// advance runs BETWEEN turns, so ONE ordinary turn on a thread whose tail is
// already over the budget must leave a checkpoint behind, and the thread read
// must then carry `agentContextFrom`.
//
// This drives the REAL turn path (POST /threads/:id/messages) with the model
// and the brief writer stubbed, because the failure this pins was a thread of
// 70 long messages that ended a turn with `agentContextFrom` still null and no
// boundary row at all.

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
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
import { advanceCheckpoint, CheckpointTestAccess } from "~/modules/agent/context/checkpoint"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

setDefaultTimeout(120_000)

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

/** The org's history budget (its `ai.history.budgetTokens`, set below). */
const ORG_HISTORY_BUDGET = 48_000

/** One seeded note, sized so 70 of them clear the 48,000 token budget. */
const NOTE_CHARS = 3_800

let orgId = ""
let userId = ""
let token = ""
let threadId = ""
let agentId = ""

function slowlessStream(params: { onStepFinish?: (s: unknown) => unknown }) {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "The biggest risk is the preamp tooling slip." }
      yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 4 } }
      await params.onStepFinish?.({ toolCalls: [], usage: { inputTokens: 5, outputTokens: 4 } })
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

async function settle(ms = 8000) {
  await new Promise((r) => setTimeout(r, ms))
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-checkpoint-stub"
  AgentServiceTestAccess.setStreamText(slowlessStream as never)
  // The brief writer, stubbed: the advance aborts rather than write a version
  // whose brief lost its region, and a real model call is not what is under
  // test here.
  CheckpointTestAccess.setSummarizer(async () => "## Working set\n\n- the preamp launch")

  orgId = (await createTestOrg()).id
  // The org's history budget: 48,000 tokens (Settings > AI models), which 70
  // seeded notes clear. The default (256,000) would need hundreds.
  await sql`UPDATE kernel.organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{ai}', '{"history":{"budgetTokens":48000}}'::jsonb, true) WHERE id = ${orgId}`
  const user = await minimal.person(orgId)
  userId = user.id
  for (const scope of ["kernel:threads:read", "kernel:threads:write"]) {
    await minimal.grantScope(userId, scope)
  }
  const [row] = await withSystemDb("ckpt-token", (db) =>
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
  const perms = await withPrivilegedDb(orgId, "ckpt-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  token = await signAccessToken(
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

  await withSystemDb("ckpt-seed", async (db) => {
    await db
      .insert(modelPricing)
      .values({
        provider: "anthropic",
        modelId: "claude-haiku-4-5-ckpt",
        displayName: "Checkpoint Haiku",
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

  agentId = await withPrivilegedDb(orgId, "ckpt-agent", async (tx) => {
    const [a] = await tx
      .insert(agents)
      .values({
        orgId,
        kind: "personal",
        ownerUserId: userId,
        handle: `@ckpt-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "App Review",
        scopeCeiling: ["kernel:threads:read", "kernel:threads:write"],
      })
      .returning({ id: agents.id })
    return a.id
  })

  threadId = await withPrivilegedDb(orgId, "ckpt-thread", async (tx) => {
    const [t] = await tx
      .insert(threads)
      .values({
        orgId,
        handle: `ckpt-${crypto.randomUUID().slice(0, 8)}`,
        title: null,
        type: "thread",
        createdBy: userId,
      })
      .returning({ id: threads.id })
    await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId, role: "owner" })
    await tx
      .insert(threadParticipants)
      .values({ threadId: t.id, agentId, orgId, participantType: "agent" })
    return t.id
  })
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
    VALUES (${userId}, ${threadId}, ${orgId})`

  // 70 long notes: about 66,500 raw tokens, against a 48,000 token budget.
  for (let i = 0; i < 70; i++) {
    const body =
      `note ${i}: ${"the preamp launch readiness note ".repeat(Math.ceil(NOTE_CHARS / 34))}`.slice(
        0,
        NOTE_CHARS,
      )
    await sql`INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${threadId}, ${orgId}, ${userId}, 'user', ${body}, '{}'::text[])`
  }
})

afterAll(async () => {
  AgentServiceTestAccess.setStreamText()
  CheckpointTestAccess.setSummarizer()
  if (ORIG_ANTHROPIC_KEY === undefined) delete process.env.LIAISON_ANTHROPIC_API_KEY
  else process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
  await sql`DELETE FROM kernel.messages WHERE org_id = ${orgId}`
  await releaseTestLock()
})

describe("a turn on a thread whose raw tail is past the budget", () => {
  // THE BRANCH THE ADVANCE ACTUALLY DIES IN when a deployment cannot run the
  // brief writer (no auto-eligible model, no credits for it, a provider that
  // refuses the call): it writes nothing and says `no-summary`, rather than
  // claiming an advance whose brief lost its region. The caller reports it as
  // `checkpoint_advance_skipped`; before that the whole failure was a warn on
  // another module's logger with no thread id on it.
  it("writes nothing and reports no-summary when the brief writer yields nothing", async () => {
    CheckpointTestAccess.setSummarizer(async () => null)
    const result = await advanceCheckpoint({
      agentId,
      threadId,
      orgId,
      actor: {
        actorType: "user",
        userId,
        orgId,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
        dimensionGrants: {},
      },
      contextWindow: 200000,
    })
    expect(result.advanced).toBe(false)
    expect(result.reason).toBe("no-summary")
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM kernel.agent_thread_checkpoints
      WHERE thread_id = ${threadId} AND agent_id = ${agentId}`
    expect(rows.length).toBe(0)
    CheckpointTestAccess.setSummarizer(async () => "## Working set\n\n- the preamp launch")
  })

  it("advances the checkpoint and the thread read carries the boundary", async () => {
    const tailChars = await sql<{ chars: string }[]>`
      SELECT COALESCE(SUM(length(content)), 0)::text AS chars FROM kernel.messages
      WHERE thread_id = ${threadId}`
    // The premise of the test, stated rather than assumed.
    expect(Number(tailChars[0].chars) / 4).toBeGreaterThan(ORG_HISTORY_BUDGET)

    const res = await app.request(`/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `@[App Review](agent:${agentId}) given everything above, what is the single biggest risk to the preamp launch right now?`,
      }),
    })
    expect(res.status).toBe(200)
    await settle()

    const checkpoints = await sql<{ upto_message_id: string | null; version: number }[]>`
      SELECT upto_message_id, version FROM kernel.agent_thread_checkpoints
      WHERE thread_id = ${threadId} AND agent_id = ${agentId}`
    expect(checkpoints.length).toBeGreaterThan(0)
    expect(checkpoints[0].upto_message_id).not.toBeNull()

    const detail = await app.request(`/api/threads/${threadId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as { data: { agentContextFrom?: string | null } }
    expect(body.data.agentContextFrom).toBe(checkpoints[0].upto_message_id)
  })
})
