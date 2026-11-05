// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SCOPE TAINT, RULE 6d: a write whose ONLY reader is the acting user (S28).
//
// kernel__notify_user posts an attention item, and a push, for the user whose
// turn it is and nobody else. On a tainted turn it is judged by that user's own
// grants: it runs when they hold every scope the turn read, and is refused
// otherwise. Without this a routine tick, whose taint always carries its whole
// effective scope, could never notify its owner (the Morning brief's push).
//
// Driven through the real chat seam (buildToolSet's execute closure, then
// executeToolCore), with the real kernel tool.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import type { ActorContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { initializedOrgRuntimes, toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000c6b01"
const HOLDER = "00000000-0000-4000-8000-0000000c6b02"
const LACKER = "00000000-0000-4000-8000-0000000c6b03"
const DM = "00000000-0000-4000-8000-0000000c6b04"
const MAIL_READ = "mail:conversations:read"

function turnFrame(injected: string[]): RunContext {
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected(injected)
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, turnScopeAccumulator }
}

async function notify(
  userId: string,
  scopes: string[],
  frame: RunContext,
  actorOverride?: ActorContext,
) {
  const actor: ActorContext = actorOverride ?? {
    actorType: "user",
    userId,
    orgId: ORG,
    scopes,
    dimensionGrants: {},
  }
  const tools = buildToolSet(ORG, actor, DM, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools.kernel__notify_user
  if (!t) throw new Error("kernel__notify_user is not in the catalog")
  return (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(
      { summary: "3 new emails, 1 draft to approve" },
      {},
    ),
  )) as Record<string, unknown>
}

function refused(r: Record<string, unknown>): boolean {
  return JSON.stringify(r).includes("E_SCOPE_TAINT_BLOCKED")
}

async function notificationCount(userId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.pending_events
     WHERE org_id = ${ORG} AND payload->>'entity' = 'agent_notification'
       AND payload->'data'->'targetUserIds' ? ${userId}`
  return n
}

describe("scope taint rule 6d: notify_user is judged by its only reader", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Self Reader Taint Org', 'self-reader-taint-org') ON CONFLICT DO NOTHING`
    for (const [id, email] of [
      [HOLDER, "self-reader-holder@test.com"],
      [LACKER, "self-reader-lacker@test.com"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${email}, ${email}, 'active', 'x') ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${HOLDER}, ${ORG}, ${MAIL_READ}), (${HOLDER}, ${ORG}, 'kernel:agent:memory'),
             (${LACKER}, ${ORG}, 'kernel:agent:memory') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${DM}, ${ORG}, 'self-reader-taint-dm', 'agent_chat', ${HOLDER}) ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(ORG)
  }, 120_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("a user holding what the turn read is notified", async () => {
    const r = await notify(HOLDER, [MAIL_READ, "kernel:agent:memory"], turnFrame([MAIL_READ]))
    expect(refused(r)).toBe(false)
    expect(await notificationCount(HOLDER)).toBe(1)
  })

  // The rule is the ACTING USER's: a non-user actor (a system job) has no one reader whose
  // grants could stand for the audience, so it keeps the refusal. Even one carrying the id of
  // a user who holds every scope (a context built from a routine owner) is not judged as that
  // user: only the actor's kind decides.
  it("a non-user actor is never judged by the acting-user rule", async () => {
    const before = await notificationCount(HOLDER)
    const systemActor = {
      actorType: "system",
      orgId: ORG,
      purpose: "job",
      scopes: [MAIL_READ, "kernel:agent:memory"],
      userId: HOLDER,
    } as unknown as ActorContext
    const r = await notify(HOLDER, [], turnFrame([MAIL_READ]), systemActor)
    expect(refused(r)).toBe(true)
    expect(await notificationCount(HOLDER)).toBe(before)
  })

  it("a user lacking a scope the turn read is refused, and nothing is queued", async () => {
    const r = await notify(LACKER, ["kernel:agent:memory"], turnFrame([MAIL_READ]))
    expect(refused(r)).toBe(true)
    expect(await notificationCount(LACKER)).toBe(0)
  })
})
