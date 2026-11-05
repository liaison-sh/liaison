// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THREAD POSTS FROM A TURN THAT READ OUTSIDE TEXT.
//
// A post lands in an internal thread, attributed to the agent ("{User}'s agent") and read only by
// the org's participants. It is not an exfiltration channel, so after the turn read a ticket or a
// web page (threads.tainted) threads_reply and threads_create still run: no taint_escalation
// approval, in the default "standard" protection and in "hardened". Scope taint (who may read what
// the turn read) still applies to the post; that is covered by threads-create-taint.test.ts.
// These tests drive the REAL tool bridge and the real kernel tools.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { ActorContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { initializedOrgRuntimes, toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000d6001"
const REQUESTER = "00000000-0000-4000-8000-0000000d6002"
const COWORKER = "00000000-0000-4000-8000-0000000d6003"
const CHAT = "00000000-0000-4000-8000-0000000d6006"
const TEAM_THREAD = "00000000-0000-4000-8000-0000000d6007"

const SCOPES = ["kernel:users:read", "kernel:threads:read", "kernel:threads:write"]

const actor: ActorContext = {
  actorType: "user",
  userId: REQUESTER,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: {},
}

function freshFrame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    effectiveScope: SCOPES,
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
}

async function run<T>(body: (tools: any) => Promise<T>): Promise<T> {
  const frame = freshFrame()
  const tools = buildToolSet(ORG, actor, CHAT, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  return runContextStore.run(frame, () => body(tools))
}

async function setProtection(mode: "standard" | "hardened"): Promise<void> {
  await sql`UPDATE kernel.organizations
    SET settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ webContentProtection: mode })}::jsonb
    WHERE id = ${ORG}`
}

async function taintEscalations(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.approval_requests
    WHERE org_id = ${ORG} AND reason = 'taint_escalation'`
  return row?.n ?? 0
}

async function agentPostsIn(threadId: string, content: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.messages
    WHERE thread_id = ${threadId} AND author_type = 'agent' AND content = ${content}`
  return row?.n ?? 0
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_references WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
}

async function seedThread(id: string, handle: string, type: string, members: string[]) {
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${id}, ${ORG}, ${handle}, ${type}, ${REQUESTER}) ON CONFLICT DO NOTHING`
  for (const userId of members) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${id}, ${userId}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${userId}, ${id}, ${ORG}) ON CONFLICT DO NOTHING`
  }
}

describe("thread posts from a turn that read outside text", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Thread Post Untrusted Org', 'thread-post-untrusted-org') ON CONFLICT DO NOTHING`
    for (const [id, name] of [
      [REQUESTER, "Requester"],
      [COWORKER, "Coworker Untrusted"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${`${id}@untrusted.test`}, ${name}, 'active', 'hash')
        ON CONFLICT DO NOTHING`
      for (const scope of SCOPES) {
        await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
          VALUES (${id}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
      }
    }
    await cleanup()
    await seedThread(CHAT, "thread-post-untrusted-chat", "agent_chat", [REQUESTER])
    await seedThread(TEAM_THREAD, "thread-post-untrusted-team", "thread", [REQUESTER, COWORKER])
    // The chat turn has read outside text (a ticket body, a web page).
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${CHAT}`
    await ensureAppsForOrg(ORG)
  })

  afterAll(async () => {
    await setProtection("standard")
    toolRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await cleanup()
    await releaseTestLock()
  })

  for (const mode of ["standard", "hardened"] as const) {
    it(`threads_reply to a coworker thread posts at once in ${mode} mode`, async () => {
      await setProtection(mode)
      const content = `Fixed and deployed (${mode})`
      const result = (await run((tools) =>
        tools.kernel__threads_reply.execute({ threadId: TEAM_THREAD, content }, {}),
      )) as any

      expect(result.blocked).toBeUndefined()
      expect(result.gated).toBeUndefined()
      expect(result.message?.threadId).toBe(TEAM_THREAD)
      expect(await agentPostsIn(TEAM_THREAD, content)).toBe(1)
      expect(await taintEscalations()).toBe(0)
    })

    it(`threads_create with a coworker opens the thread at once in ${mode} mode`, async () => {
      await setProtection(mode)
      const initialMessage = `Can you check this (${mode})`
      const result = (await run((tools) =>
        tools.kernel__threads_create.execute({ participantIds: [COWORKER], initialMessage }, {}),
      )) as any

      expect(result.blocked).toBeUndefined()
      expect(result.gated).toBeUndefined()
      expect(result.thread?.id).toBeDefined()
      expect(await taintEscalations()).toBe(0)
    })
  }
})
