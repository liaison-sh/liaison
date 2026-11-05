// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN AGENT'S DEFAULT MODEL MUST BE ONE THE ORG CAN RUN.
//
// The demo seeds its agents on Claude Sonnet. A visitor who pasted only a
// Google key got conversations that asked for Sonnet on every turn, and every
// turn failed on the missing Anthropic key until they found the model picker.
// A default whose provider the org has no usable key for now falls back to
// auto, which picks among the providers the org can use; a usable default is
// left exactly where it was.
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Make `usableDefaultModel` return its input unconditionally: "drops a
//    default the visitor has no key for" and the composer case fail.
//  * Drop the `usableDefaultModel` call from `getThread`: "tells the composer
//    the default is Auto" fails.
//  * Return null for every default: "keeps a default the org can run" fails,
//    which is the "nothing moves for an org whose default works" promise.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { preCheck, usableDefaultModel } from "~/modules/agent/credits/credit-meter"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { aiKeysRoutes } from "~/modules/settings/ai-keys-routes"
import { getThread } from "~/modules/threads/thread"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const ANTHROPIC_MODEL = "usable-default-anthropic"
const GOOGLE_MODEL = "usable-default-google"

/** The BYOK save route, with the org bound the way the real middleware binds it. */
function keysApp(orgId: string) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", "00000000-0000-0000-0000-0000000b00fe")
    c.set("orgId", orgId)
    c.set("scopes", ["kernel:org:admin"] as never)
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/settings/ai/keys", aiKeysRoutes)
  return app
}

async function pasteGoogleKey(orgId: string): Promise<void> {
  // The provider validation call is the only network in this route.
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
  try {
    const res = await keysApp(orgId).request("/api/settings/ai/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "google", apiKey: "AIza-visitor-own-key" }),
    })
    expect(res.status).toBe(200)
  } finally {
    fetchSpy.mockRestore()
  }
}

describe("an agent's default model", () => {
  let visitorOrgId: string
  let normalOrgId: string

  beforeAll(async () => {
    await acquireTestLock()
    visitorOrgId = (await ensureOrg({ slug: "usable-default-visitor", name: "Visitor" })).orgId
    normalOrgId = (await ensureOrg({ slug: "usable-default-normal", name: "Normal" })).orgId
    await markOrgAsDemo(visitorOrgId, visitorMarker(24))
    // Both auto-eligible and the cheapest in the catalog, so auto mode's pick
    // is one of these two and the assertion says which provider it chose.
    await sql`
      INSERT INTO kernel.model_pricing
        (model_id, provider, display_name, input_cost_per_m, output_cost_per_m,
         context_window, tier_minimum, auto_eligible)
      VALUES
        (${ANTHROPIC_MODEL}, 'anthropic', 'Usable Default Anthropic', '0.0000001', '0.0000001', 200000, 'starter', true),
        (${GOOGLE_MODEL}, 'google', 'Usable Default Google', '0.0000002', '0.0000002', 200000, 'starter', true)`
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    await sql`DELETE FROM kernel.model_pricing WHERE model_id IN (${ANTHROPIC_MODEL}, ${GOOGLE_MODEL})`
    await releaseTestLock()
  })

  afterEach(async () => {
    invalidateDemoMarker()
    await sql`UPDATE kernel.organizations SET settings = settings - 'providerKeys'
              WHERE id IN (${visitorOrgId}, ${normalOrgId})`
    await clearRedisPatterns(["demo:*"])
  })

  it("drops a default the visitor has no key for, and auto then runs on their key", async () => {
    DemoModeTestAccess.set(true)
    await pasteGoogleKey(visitorOrgId)
    // The box holds an Anthropic key, but a visitor org may not reach it.
    expect(await usableDefaultModel(visitorOrgId, ANTHROPIC_MODEL)).toBeNull()
    expect(await usableDefaultModel(visitorOrgId, GOOGLE_MODEL)).toBe(GOOGLE_MODEL)
    // Null is auto mode, and auto picks among the providers the visitor can use.
    const turn = await preCheck(
      visitorOrgId,
      await usableDefaultModel(visitorOrgId, ANTHROPIC_MODEL),
    )
    expect(turn.allowed).toBe(true)
    if (!turn.allowed) return
    expect(turn.model.provider).toBe("google")
  })

  it("keeps a default the org can run, and leaves unknown and empty defaults alone", async () => {
    DemoModeTestAccess.set(true)
    // A normal org on the demo box reaches the box's keys: nothing moves.
    expect(await usableDefaultModel(normalOrgId, ANTHROPIC_MODEL)).toBe(ANTHROPIC_MODEL)
    expect(await usableDefaultModel(normalOrgId, GOOGLE_MODEL)).toBe(GOOGLE_MODEL)
    // The pre-check answers an unknown model ("Model not available"), not this.
    expect(await usableDefaultModel(normalOrgId, "not-in-the-catalog")).toBe("not-in-the-catalog")
    expect(await usableDefaultModel(normalOrgId, null)).toBeNull()
    DemoModeTestAccess.set(false)
    invalidateDemoMarker()
    // With demo mode off a marked org is a normal org too.
    expect(await usableDefaultModel(visitorOrgId, ANTHROPIC_MODEL)).toBe(ANTHROPIC_MODEL)
  })

  it("drops a default on any org whose provider has no key at all", async () => {
    DemoModeTestAccess.set(false)
    const saved = process.env.LIAISON_ANTHROPIC_API_KEY
    process.env.LIAISON_ANTHROPIC_API_KEY = ""
    try {
      expect(await usableDefaultModel(normalOrgId, ANTHROPIC_MODEL)).toBeNull()
      expect(await usableDefaultModel(normalOrgId, GOOGLE_MODEL)).toBe(GOOGLE_MODEL)
    } finally {
      process.env.LIAISON_ANTHROPIC_API_KEY = saved
    }
  })

  it("tells the composer the default is Auto when the agent's model cannot run", async () => {
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO kernel.users (org_id, email, password_hash, name, status)
      VALUES (${visitorOrgId}, ${`chip-${crypto.randomUUID()}@t.co`}, 'x', 'Chip', 'active')
      RETURNING id`
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, system_prompt, model_preference)
      VALUES (${visitorOrgId}, 'role', ${`@chip-${crypto.randomUUID().slice(0, 8)}`}, 'Chip', '{}', '', ${ANTHROPIC_MODEL})
      RETURNING id`
    const [thread] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, created_by)
      VALUES (${visitorOrgId}, ${`chip-${crypto.randomUUID()}`}, ${user.id})
      RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, participant_type)
      VALUES (${thread.id}, ${user.id}, ${visitorOrgId}, 'user')`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${thread.id}, ${agent.id}, ${visitorOrgId}, 'agent')`
    const read = () =>
      withRlsContext(
        {
          actorType: "user",
          userId: user.id,
          orgId: visitorOrgId,
          scopes: ["*"],
          dimensionGrants: {},
        },
        (tx) => getThread(tx, { orgId: visitorOrgId, userId: user.id, threadId: thread.id }),
      )
    DemoModeTestAccess.set(true)
    await pasteGoogleKey(visitorOrgId)
    expect((await read())?.agentDefaultModelId).toBeNull()
    DemoModeTestAccess.set(false)
    invalidateDemoMarker()
    expect((await read())?.agentDefaultModelId).toBe(ANTHROPIC_MODEL)
  })
})
