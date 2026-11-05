// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A DEMO REFUSAL IS NOT RUNNING OUT OF CREDITS. A demo visitor's workspace
// refuses its agents until the visitor confirms their email. Its support
// routine's first tick met that refusal and paused itself `paused_no_credits`,
// the pause no one ever lifted: the visitor confirmed, the live ticket of the
// scenario arrived, and its tick returned at the status check with no run and
// no log, so the scenario waited forever on the routine's note. These cases run
// the real tick against the real credit gate of an unverified visitor org.
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Make `routineTickCreditGate` (kernel-jobs.ts) return `pause: true` for a
//    demo code: the refused tick pauses the routine.
//  * Drop the `paused_no_credits` re-check from `runRoutineTick`: the tick
//    after the visitor confirmed returns `no_run` and the routine stays paused.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { routineRuns, routines as routinesTbl } from "~/db/schema/kernel"
import { routineTickCreditGate } from "~/infra/jobs/kernel-jobs"
import { env } from "~/lib/env"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { registerDemoAlertMailer } from "~/modules/demo/demo-alerts"
import { DemoBudgetTestAccess, type DemoSpendIdentity } from "~/modules/demo/demo-budget"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

type EnvKey = keyof typeof env
function setEnv<K extends EnvKey>(key: K, value: (typeof env)[K]): () => void {
  const target = env as Record<K, (typeof env)[K]>
  const saved = target[key]
  target[key] = value
  return () => {
    target[key] = saved
  }
}

describe("a demo visitor's routine and the verification refusal", () => {
  let orgId: string
  let userId: string
  const identities = new Map<string, DemoSpendIdentity>()
  const restores: Array<() => void> = []
  let savedBoxKey: string | undefined

  beforeAll(async () => {
    await acquireTestLock()
    savedBoxKey = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = "sk-or-box-key-of-demo-tests"
    orgId = (await minimal.secondOrg({ name: "Demo Routine Pause" })).orgId
    userId = (await minimal.person(orgId)).id
    await markOrgAsDemo(orgId, visitorMarker(24))
    DemoBudgetTestAccess.setVerifiedIdentity(async (id) => identities.get(id) ?? null)
    registerDemoAlertMailer(async () => {})
  }, 60_000)

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    DemoBudgetTestAccess.setVerifiedIdentity(null)
    registerDemoAlertMailer(null)
    if (savedBoxKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = savedBoxKey
    await releaseTestLock()
  })

  afterEach(async () => {
    while (restores.length > 0) restores.pop()?.()
    identities.clear()
    invalidateDemoMarker()
    await withPrivilegedDb(orgId, "drp-cleanup", async (tx) => {
      await tx.delete(routineRuns).where(eq(routineRuns.orgId, orgId))
      await tx.delete(routinesTbl).where(eq(routinesTbl.orgId, orgId))
    })
    await sql`DELETE FROM kernel.demo_spend`
    await clearRedisPatterns(["demo:*", "routine-lock:*"])
  })

  function demoOn(): void {
    DemoModeTestAccess.set(true)
    restores.push(setEnv("LIAISON_DEMO_ALERT_EMAIL", "owner@example.com"))
    restores.push(setEnv("LIAISON_DEMO_MAIL_CAPTURE", true))
  }

  async function makeRoutine(status: "active" | "paused_no_credits") {
    const [row] = await withPrivilegedDb(orgId, "drp-routine", (tx) =>
      tx
        .insert(routinesTbl)
        .values({
          orgId,
          ownerUserId: userId,
          name: `Draft a reply ${crypto.randomUUID().slice(0, 6)}`,
          description: "draft a reply to new tickets",
          kind: "event",
          event: "tickets:ticket:create",
          prompt: "draft a reply",
          scopes: [],
          enabled: true,
          status,
          visibility: "shared",
          createdByUserId: userId,
          createdByActorType: "user",
        })
        .returning(),
    )
    return row!
  }

  async function statusOf(routineId: string) {
    const [row] = await withPrivilegedDb(orgId, "drp-status", (tx) =>
      tx.select().from(routinesTbl).where(eq(routinesTbl.id, routineId)),
    )
    return row?.status
  }

  async function tick(routineId: string, invoked: { n: number }) {
    return runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      triggerEvent: {
        app: "tickets",
        entity: "ticket",
        action: "create",
        entityId: crypto.randomUUID(),
        data: {},
      },
      loadOwnerScopes: async () => ["*"],
      checkCredits: (o) => routineTickCreditGate(o),
      agentInvoker: async () => {
        invoked.n++
        return { turnsAdded: 1 }
      },
    })
  }

  it("the gate reads the verification refusal as one that does not pause", async () => {
    demoOn()
    const refusal = await routineTickCreditGate(orgId)
    expect(refusal?.pause).toBe(false)
    expect(refusal?.reason).toBeTruthy()
  })

  it("an unverified visitor's tick is skipped and recorded; the routine stays active", async () => {
    demoOn()
    const r = await makeRoutine("active")
    const invoked = { n: 0 }
    const result = await tick(r.id, invoked)
    expect(result.status).toBe("skipped_no_credits")
    expect(invoked.n).toBe(0)
    expect(await statusOf(r.id)).toBe("active")
  })

  it("once the visitor confirmed their email, a routine paused for credits resumes and runs", async () => {
    demoOn()
    const r = await makeRoutine("paused_no_credits")
    identities.set(orgId, {
      emailNormalized: `drp-${Date.now()}@example.com`,
      network: "192.0.2.0/24-drp",
    })
    const invoked = { n: 0 }
    const result = await tick(r.id, invoked)
    expect(result.status).toBe("succeeded")
    expect(invoked.n).toBe(1)
    expect(await statusOf(r.id)).toBe("active")
  })
})
