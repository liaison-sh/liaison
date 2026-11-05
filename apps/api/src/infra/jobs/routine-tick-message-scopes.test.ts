// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine tick posts its prompt (with the trigger event's data) and, when a
// completeness guard fires, a steer into the routine's output thread. A shared
// routine enrolls every org member, so both posts carry the routine agent's
// effective scope for that tick: a member lacking it sees neither, the owner does.
//
// Drives the real `routine-tick` job handler registered by registerKernelJobs,
// with only the agent turn itself stubbed.

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { creditBalances, modelPricing, routines } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import * as jobsModule from "~/infra/jobs/jobs"
import { registerKernelJobs } from "~/infra/jobs/kernel-jobs"
import * as agentService from "~/modules/agent/runtime/agent-service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// registerKernelJobs and a full tick take longer than the 5 s default.
setDefaultTimeout(60_000)

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const SECRET = "rtk:deals:read"
const OTHER = "rtk:other:read"
// WHAT THE ROUTINE ASKS FOR, which is what its messages are tagged with. It is
// deliberately NOT the whole of what the owner holds: the point of this file is
// that the tag is bounded by the routine's own scopes, so OTHER sits in the
// owner agent's ceiling and never reaches a message.
const ROUTINE_SCOPES = [SECRET]
// What the OWNER holds. The two kernel:threads grants are what lets the owner
// read the routine thread back; they are not the routine's, and P8-FX2's SK-2
// ceiling gate would pause a tick whose owner agent could not reach them, which
// is why they are not in ROUTINE_SCOPES.
const OWNER_SCOPES = ["kernel:threads:read", "kernel:threads:write", ...ROUTINE_SCOPES]

let orgId: string
let owner: string
let lacker: string
let routineId: string
let agentId: string
let tick: (payload: unknown) => Promise<void>

async function visibleIds(userId: string, scopes: string[], threadId: string): Promise<string[]> {
  return withRlsContext(
    { actorType: "user", userId, orgId, scopes, dimensionGrants: {} },
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`SELECT id FROM kernel.messages WHERE thread_id = ${threadId}`),
      ).map((r) => r.id),
  )
}

describe("routine tick messages carry the routine agent's effective scope", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-rtk-stub"
    orgId = (await createTestOrg()).id
    owner = (await minimal.person(orgId)).id
    lacker = (await minimal.person(orgId)).id
    for (const scope of OWNER_SCOPES) await minimal.grantScope(owner, scope)
    await withSystemDb("rtk-seed", async (db) => {
      await db
        .insert(modelPricing)
        .values({
          provider: "anthropic",
          modelId: "claude-haiku-4-5-rtk",
          displayName: "Routine tick Haiku",
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
    agentId = await withPrivilegedDb(orgId, "rtk-agent", async (tx) => {
      const [a] = await tx
        .insert(agents)
        .values({
          orgId,
          kind: "role",
          handle: `@rtk-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Deals watcher",
          scopeCeiling: [SECRET, OTHER],
        })
        .returning({ id: agents.id })
      return a.id
    })
    routineId = await withPrivilegedDb(orgId, "rtk-routine", async (tx) => {
      const [r] = await tx
        .insert(routines)
        .values({
          orgId,
          ownerUserId: owner,
          ownerAgentId: agentId,
          name: `rtk-${crypto.randomUUID().slice(0, 6)}`,
          description: "deal watch",
          kind: "recurring",
          cron: "0 9 * * *",
          timezone: "UTC",
          prompt: "Use web_watch on the deals feed and summarise what changed.",
          scopes: ROUTINE_SCOPES,
          visibility: "shared",
          enabled: true,
          status: "active",
          createdByUserId: owner,
          createdByActorType: "user",
        })
        .returning({ id: routines.id })
      return r.id
    })

    // Capture the real routine-tick handler without starting BullMQ workers or schedulers.
    const handlers = new Map<string, (payload: unknown) => Promise<void>>()
    const spies = [
      spyOn(jobsModule, "registerJobWorker").mockImplementation(((
        app: string,
        name: string,
        handler: (payload: unknown) => Promise<void>,
      ) => {
        handlers.set(`${app}:${name}`, handler)
      }) as never),
      spyOn(jobsModule, "registerScheduledJob").mockResolvedValue(undefined as never),
      spyOn(jobsModule, "upsertJobScheduler").mockResolvedValue(undefined as never),
      spyOn(jobsModule, "enqueueAppJob").mockResolvedValue("stub" as never),
    ]
    try {
      await registerKernelJobs()
    } finally {
      for (const s of spies) s.mockRestore()
    }
    const handler = handlers.get("kernel:routine-tick")
    if (!handler) throw new Error("routine-tick handler not registered")
    tick = handler
  })

  afterAll(async () => {
    await withPrivilegedDb(orgId, "rtk-cleanup", (tx) =>
      tx.delete(routines).where(drizzleSql`${routines.orgId} = ${orgId}`),
    ).catch(() => {})
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  it("the tick prompt with trigger data and the steer are hidden from a member lacking the scope", async () => {
    const invoke = spyOn(agentService, "invokeAgentForThread").mockResolvedValue({
      finishReason: "stop",
      turnsAdded: 1,
    } as never)
    try {
      await tick({
        routineId,
        orgId,
        scheduledAt: new Date().toISOString(),
        triggerEvent: {
          app: "rtk",
          entity: "deal",
          action: "created",
          entityId: "deal-42",
          data: { note: "Deal 42 closes Friday at 1.2M" },
        },
      })
    } finally {
      invoke.mockRestore()
    }

    const [routine] = await sql<{ output_thread_id: string }[]>`
      SELECT output_thread_id FROM kernel.routines WHERE id = ${routineId}`
    const threadId = routine?.output_thread_id ?? ""
    const posts = await sql<{ id: string; content: string; required_scopes: string[] }[]>`
      SELECT id, content, required_scopes FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_id = ${owner} AND author_type = 'user'
      ORDER BY created_at`
    // The tick prompt (quoting the event) and the web_watch execution-skip steer.
    expect(posts.length).toBe(2)
    expect(posts[0]?.content).toContain("Deal 42")
    // ceiling [SECRET, OTHER] on a routine thread, bounded by the routine's scopes.
    for (const p of posts) expect(p.required_scopes).toEqual([SECRET])

    const lackerSees = await visibleIds(lacker, ["kernel:threads:read"], threadId)
    const ownerSees = await visibleIds(owner, OWNER_SCOPES, threadId)
    for (const p of posts) {
      expect(lackerSees).not.toContain(p.id)
      expect(ownerSees).toContain(p.id)
    }
  }, 60_000)

  it("the tick prompt and the steer name the tick acting agent on their create events", async () => {
    const invoke = spyOn(agentService, "invokeAgentForThread").mockResolvedValue({
      finishReason: "stop",
      turnsAdded: 1,
    } as never)
    const since = new Date().toISOString()
    try {
      await tick({
        routineId,
        orgId,
        scheduledAt: new Date().toISOString(),
        triggerEvent: {
          app: "rtk",
          entity: "deal",
          action: "created",
          entityId: "deal-43",
          data: { note: "Deal 43 closes Monday at 900k" },
        },
      })
    } finally {
      invoke.mockRestore()
    }

    const [routine] = await sql<{ output_thread_id: string }[]>`
      SELECT output_thread_id FROM kernel.routines WHERE id = ${routineId}`
    const threadId = routine?.output_thread_id ?? ""
    const posts = await sql<{ id: string }[]>`
      SELECT id FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_id = ${owner} AND author_type = 'user'
        AND created_at >= ${since}::timestamptz
      ORDER BY created_at`
    // This tick's own prompt and its execution-skip steer.
    expect(posts.length).toBe(2)

    const ids = posts.map((p) => p.id)
    const events = await sql<{ entity_id: string; agent_id: string | null }[]>`
      SELECT payload->>'entityId' AS entity_id, payload->>'agentId' AS agent_id
        FROM kernel.pending_events
       WHERE org_id = ${orgId}
         AND payload->>'entity' = 'message'
         AND payload->>'action' = 'create'
         AND payload->>'entityId' = ANY(${ids}::text[])`
    expect(events.length).toBe(2)
    // Nobody is at the keyboard on a routine tick, so the acting agent is the
    // only attribution these rows can carry (A11): the audit consumers persist
    // exactly what the create event names.
    for (const e of events) expect(e.agent_id).toBe(agentId)
  }, 60_000)
})
