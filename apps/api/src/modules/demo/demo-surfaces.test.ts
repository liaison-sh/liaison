// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT A DEMO WORKSPACE ADVERTISES IT CAN DO.
//
// `resolveKey` refuses the box's own provider key for a visitor org. Three
// surfaces asked a DIFFERENT question first ("is there a key in the
// environment?") and therefore told the visitor things that were not true: the
// model picker listed every model the box holds a key for and each one 400ed at
// send, `web_search` was advertised to the agent and always refused, and the
// message indexer's embedder resolved as configured, threw at `resolveKey`, and
// cached the failure in a module level map nothing invalidated, killing
// semantic search for the whole life of the workspace even after the visitor
// pasted a key.
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Put the env-key fallback back into `isProviderConfigured` (or call it
//    instead of `isProviderUsable`): every "advertises nothing it cannot do"
//    case fails.
//  * Delete `invalidateOrgEmbedder(orgId)` from the BYOK save route: "a pasted
//    key brings the embedding leg back" fails, and it fails for the life of the
//    process, which is the bug.
//  * Make `demoWebSearchRefusal` refuse `keySource: "liaison"` for a reserved
//    org again: "the reserved org may search" fails, which is App Review
//    watching the agent refuse its own advertised tool.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import type { OrgKernelSettings } from "@liaison/shared"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import {
  isModelKeyAvailable,
  isProviderUsable,
  isWebSearchConfigured,
  listAvailableModels,
  selectSideCallModelForOrg,
} from "~/modules/agent/credits/credit-meter"
import { handleWebSearch } from "~/modules/agent/tools/web-tools"
import { cleanDictation } from "~/modules/assist/proofread-service"
import { demoWebSearchRefusal } from "~/modules/demo/demo-egress"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  invalidateDemoMarker,
  markOrgAsDemo,
  reservedMarker,
  visitorMarker,
} from "~/modules/demo/demo-org"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { MessageIndexerTestAccess, resolveOrgEmbedder } from "~/modules/search/message-indexer"
import { aiKeysRoutes } from "~/modules/settings/ai-keys-routes"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const MODEL = "demo-surface-model"

/** The BYOK save route, with the org bound the way the real middleware binds it. */
function keysApp(orgId: string) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", "00000000-0000-0000-0000-0000000b00ff")
    c.set("orgId", orgId)
    c.set("scopes", ["kernel:org:admin"] as never)
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/settings/ai/keys", aiKeysRoutes)
  return app
}

const realFetch = globalThis.fetch

describe("what a demo workspace advertises", () => {
  let visitorOrgId: string
  let reservedOrgId: string
  let normalOrgId: string

  beforeAll(async () => {
    await acquireTestLock()
    visitorOrgId = (await ensureOrg({ slug: "surface-visitor", name: "Surface Visitor" })).orgId
    reservedOrgId = (await ensureOrg({ slug: "surface-reserved", name: "Surface Reserved" })).orgId
    normalOrgId = (await ensureOrg({ slug: "surface-normal", name: "Surface Normal" })).orgId
    await markOrgAsDemo(visitorOrgId, visitorMarker(24))
    await markOrgAsDemo(reservedOrgId, reservedMarker())
    await sql`
      INSERT INTO kernel.model_pricing
        (model_id, provider, display_name, input_cost_per_m, output_cost_per_m,
         context_window, tier_minimum, auto_eligible)
      VALUES (${MODEL}, 'google', 'Surface Google', '1', '5', 200000, 'starter', true)`
    // Keys on the box, exactly as a real deployment has them: the Google and
    // Exa placeholders the test preload sets (src/tests/test-env-defaults.ts).
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    DemoModeTestAccess.set(null)
    MessageIndexerTestAccess.resetEmbedderCache()
    await releaseTestLock()
  })

  afterEach(async () => {
    globalThis.fetch = realFetch
    invalidateDemoMarker()
    MessageIndexerTestAccess.resetEmbedderCache()
    // A key one case pasted must not decide the next case's answer.
    await sql`UPDATE kernel.organizations SET settings = settings - 'providerKeys'
              WHERE id IN (${visitorOrgId}, ${reservedOrgId}, ${normalOrgId})`
    await clearRedisPatterns(["demo:*"])
  })

  describe("a visitor org advertises nothing it cannot do", () => {
    it("lists no model it would be refused at send", async () => {
      DemoModeTestAccess.set(true)
      expect(await listAvailableModels(visitorOrgId)).toHaveLength(0)
    })

    it("does not advertise web_search to the agent", async () => {
      DemoModeTestAccess.set(true)
      expect(await isWebSearchConfigured(visitorOrgId)).toBe(false)
    })

    it("does not resolve an embedder it cannot get a key for", async () => {
      DemoModeTestAccess.set(true)
      expect(await resolveOrgEmbedder(visitorOrgId)).toBeNull()
    })

    it("says the same thing through the one predicate all three ask", async () => {
      DemoModeTestAccess.set(true)
      expect(await isProviderUsable(visitorOrgId, "google", {})).toBe(false)
      expect(await isProviderUsable(visitorOrgId, "exa", {})).toBe(false)
    })
  })

  describe("the reserved org keeps the capabilities App Review will look at", () => {
    it("lists the models it can actually use", async () => {
      DemoModeTestAccess.set(true)
      // Only the model every call is pinned to (walk N4): another one would be
      // picked and then silently answered by the pin.
      const saved = env.LIAISON_DEMO_RESERVED_MODEL
      ;(env as { LIAISON_DEMO_RESERVED_MODEL: string }).LIAISON_DEMO_RESERVED_MODEL = MODEL
      try {
        const models = await listAvailableModels(reservedOrgId)
        expect(models.map((m) => m.modelId)).toEqual([MODEL])
        const other = `${MODEL}-other`
        await sql`INSERT INTO kernel.model_pricing (model_id, provider, display_name, input_cost_per_m, output_cost_per_m, context_window, tier_minimum, auto_eligible)
          VALUES (${other}, 'google', 'Other Google', '1', '5', 200000, 'starter', false) ON CONFLICT DO NOTHING`
        try {
          expect((await listAvailableModels(reservedOrgId)).map((m) => m.modelId)).toEqual([MODEL])
        } finally {
          await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${other}`
        }
      } finally {
        ;(env as { LIAISON_DEMO_RESERVED_MODEL: string }).LIAISON_DEMO_RESERVED_MODEL = saved
      }
    })

    it("may search the web on the deployment's key, inside its ceiling", async () => {
      DemoModeTestAccess.set(true)
      expect(await isWebSearchConfigured(reservedOrgId)).toBe(true)
      expect(await demoWebSearchRefusal(reservedOrgId, "liaison")).toBeNull()
    })

    it("stops searching once it has spent its rolling day of tokens", async () => {
      DemoModeTestAccess.set(true)
      await sql`
        INSERT INTO kernel.credit_transactions
          (org_id, type, amount, balance_after, model, input_tokens, output_tokens, raw_cost)
        VALUES (${reservedOrgId}, 'byok_usage', '-1', '0', ${MODEL},
                ${env.LIAISON_DEMO_RESERVED_TOKEN_CEILING}, 0, '1')`
      invalidateDemoMarker()
      const refusal = await demoWebSearchRefusal(reservedOrgId, "liaison")
      expect(refusal).toContain("usage limit")
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${reservedOrgId}`
    })
  })

  describe("the web search refusal tells the truth", () => {
    it("does not send a visitor to a settings screen with no field on it", async () => {
      DemoModeTestAccess.set(true)
      const refusal = await demoWebSearchRefusal(visitorOrgId, "liaison")
      expect(refusal).toBeTruthy()
      // Exa is not a provider this product accepts a key for: the four the
      // settings route takes are the model vendors. Advice it cannot act on is
      // worse than none.
      expect(refusal).not.toContain("Exa")
      expect(refusal).not.toContain("model keys")
    })
  })

  describe("a pasted key takes effect in this process", () => {
    it("brings the embedding leg back rather than leaving it dead for the org's life", async () => {
      DemoModeTestAccess.set(true)
      // First: no key of its own, and the box's key is out of reach. The null
      // is now memoised, which is exactly the trap.
      expect(await resolveOrgEmbedder(visitorOrgId)).toBeNull()

      // The visitor pastes a Google key. The provider validation call is the
      // only network in this route; everything after it is ours.
      globalThis.fetch = (async () =>
        new Response("{}", { status: 200 })) as unknown as typeof fetch
      const res = await keysApp(visitorOrgId).request("/api/settings/ai/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google", apiKey: "AIza-visitor-own-key" }),
      })
      expect(res.status).toBe(200)

      // No manual cache reset here, on purpose: the route is what must have
      // dropped the memo.
      const embedder = await resolveOrgEmbedder(visitorOrgId)
      expect(embedder).not.toBeNull()
      expect(await listAvailableModels(visitorOrgId)).not.toHaveLength(0)
    })
  })

  describe("a normal org, and a box that is not a demo", () => {
    it("advertises exactly what it always did on the demo box", async () => {
      DemoModeTestAccess.set(true)
      expect(await isProviderUsable(normalOrgId, "google", {})).toBe(true)
      expect((await listAvailableModels(normalOrgId)).map((m) => m.modelId)).toContain(MODEL)
      expect(await isWebSearchConfigured(normalOrgId)).toBe(true)
      expect(await demoWebSearchRefusal(normalOrgId, "liaison")).toBeNull()
    })

    it("changes nothing with demo mode off, not even for a marked org", async () => {
      DemoModeTestAccess.set(false)
      invalidateDemoMarker()
      expect(await isProviderUsable(visitorOrgId, "google", {})).toBe(true)
      expect((await listAvailableModels(visitorOrgId)).map((m) => m.modelId)).toContain(MODEL)
      expect(await isWebSearchConfigured(visitorOrgId)).toBe(true)
      expect(await demoWebSearchRefusal(visitorOrgId, "liaison")).toBeNull()
      expect(await resolveOrgEmbedder(visitorOrgId)).not.toBeNull()
    })
  })

  // SK9: the box also holds an OpenRouter key (web search's second backend,
  // dictation's transcription and added models all run on it). None of it may
  // be spent by a visitor org: every surface below must refuse before a single
  // byte leaves the process. A failure here is a demo-spend leak.
  describe("a visitor org with the box's OpenRouter key in the environment", () => {
    const ADDED_KEY = "openrouter/acme/cheap-chat"
    let savedOpenRouter: string | undefined
    let outbound = 0

    beforeAll(() => {
      savedOpenRouter = process.env.OPENROUTER_API_KEY
      process.env.OPENROUTER_API_KEY = "sk-or-operator-key-not-visitors"
      OutboundFetchTestAccess.setFetch((async () => {
        outbound++
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch)
    })
    afterAll(async () => {
      OutboundFetchTestAccess.setFetch(null)
      if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = savedOpenRouter
      await sql`UPDATE kernel.organizations SET settings = settings - 'ai' WHERE id = ${visitorOrgId}`
    })

    /** Count every request leaving the process, through either fetch. */
    function countFetches() {
      outbound = 0
      globalThis.fetch = (async () => {
        outbound++
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch
      return () => outbound
    }

    it("does not advertise web_search, and a search refuses with nothing sent", async () => {
      DemoModeTestAccess.set(true)
      expect(await isProviderUsable(visitorOrgId, "openrouter", {})).toBe(false)
      expect(await isWebSearchConfigured(visitorOrgId)).toBe(false)
      const sent = countFetches()
      const result = await handleWebSearch(
        { query: "anything" },
        { orgId: visitorOrgId, userId: "u" },
      )
      expect("error" in result).toBe(true)
      expect(sent()).toBe(0)
    })

    it("never picks an added OpenRouter model for a visitor's side call", async () => {
      DemoModeTestAccess.set(true)
      const added = {
        key: ADDED_KEY,
        provider: "openrouter" as const,
        upstreamId: "acme/cheap-chat",
        displayName: "Cheap chat",
        contextWindow: 32000,
        inputCostPerM: "0.01",
        outputCostPerM: "0.02",
        tools: true,
        reasoningEfforts: [],
        canDisableReasoning: false,
        enabled: true,
        addedAt: new Date().toISOString(),
      }
      await sql`UPDATE kernel.organizations
        SET settings = COALESCE(settings, '{}'::jsonb) ||
          jsonb_build_object('ai', jsonb_build_object('models',
            jsonb_build_object('autoModelKey', ${ADDED_KEY}::text, 'added', ${JSON.stringify([added])}::jsonb)))
        WHERE id = ${visitorOrgId}`
      const pick = await selectSideCallModelForOrg(visitorOrgId, "sk9-side-call")
      // A visitor's side call runs on the pin (from env, never its settings),
      // which the box key serves only through a reservation.
      expect(pick?.modelId).toBe(env.LIAISON_DEMO_VISITOR_MODEL)
      expect(pick?.modelId).not.toBe(ADDED_KEY)
      // The added model is refused for its key, not for being malformed: with
      // demo mode off the same org may run it.
      const settings = { ai: { models: { added: [added] } } } as OrgKernelSettings
      expect(await isModelKeyAvailable(visitorOrgId, ADDED_KEY, settings)).toBe(false)
      DemoModeTestAccess.set(false)
      invalidateDemoMarker()
      expect(await isModelKeyAvailable(visitorOrgId, ADDED_KEY, settings)).toBe(true)
    })

    it("cleans up no dictation on the box's key: cleanError, nothing sent", async () => {
      DemoModeTestAccess.set(true)
      const sent = countFetches()
      const out = await cleanDictation({ orgId: visitorOrgId, userId: "u", text: "um so hello" })
      expect(out).toEqual({ cleaned: "um so hello", cleanModel: null, cleanError: true })
      expect(sent()).toBe(0)
    })
  })
})
