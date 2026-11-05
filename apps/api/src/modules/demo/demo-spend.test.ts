// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Zero platform spend, asserted through `preCheck` -- the function the agent
// runtime actually calls before a turn -- not through the helpers in isolation.
//
// Two things have to be true at once and both are asserted here: a demo box
// cannot spend the operator's money, and a normal org's answer is unchanged.
// The second matters more. This branch of preCheck serves a real customer on
// BYOK, and a regression there is a customer being refused a turn they paid for.
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Delete the `await assertDemoPlatformKeyAllowed(orgId)` line from
//    `resolveKey`: every case in "a visitor org cannot spend ours" fails,
//    because the visitor's turn is admitted on the box's own key.
//  * Make `checkDemoSpendCeiling` treat `visitor` like `reserved`: the visitor
//    org is capped again, which is a budget nobody is spending.
//  * Make `demoOrgTokensUsed` drop its window predicate: the reserved org never
//    recovers, and App Review is locked out for good the first time a reviewer
//    spends the day's allowance.
//  * Put `>` back in `checkDemoSpendCeiling`: "draws the line in the same place"
//    fails, because the pre turn gate admits a turn the mid step gate kills.
//  * Drop the `isReservedDemoOrg` clause from preCheck step 3b: "runs on a
//    MANAGED edition too" fails with 402 "Out of agent usage".
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { checkMidStep, preCheck, resolveKey } from "~/modules/agent/credits/credit-meter"
import { registerDemoAlertMailer } from "~/modules/demo/demo-alerts"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  invalidateDemoMarker,
  markOrgAsDemo,
  reservedMarker,
  visitorMarker,
} from "~/modules/demo/demo-org"
import {
  checkDemoSpendCeiling,
  DemoKeyRequiredError,
  demoOrgTokensReserved,
  demoOrgTokensUsed,
  releaseDemoTurnReservation,
} from "~/modules/demo/demo-spend"
import { RESERVED_MODEL_DEFAULT } from "~/modules/demo/demo-spend-ceiling"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const MODEL = "demo-cheap-model"
const CEILING = () => env.LIAISON_DEMO_RESERVED_TOKEN_CEILING

async function spendTokens(orgId: string, tokens: number): Promise<void> {
  await sql`
    INSERT INTO kernel.credit_transactions
      (org_id, type, amount, balance_after, model, input_tokens, output_tokens, raw_cost)
    VALUES (${orgId}, 'byok_usage', '-1', '0', ${MODEL}, ${tokens}, 0, '1')`
}

/** The same spend, recorded `minutesAgo` in the past. What a WINDOW is about. */
async function spendTokensAgo(orgId: string, tokens: number, minutesAgo: number): Promise<void> {
  await sql`
    INSERT INTO kernel.credit_transactions
      (org_id, type, amount, balance_after, model, input_tokens, output_tokens, raw_cost, created_at)
    VALUES (${orgId}, 'byok_usage', '-1', '0', ${MODEL}, ${tokens}, 0, '1',
            now() - make_interval(mins => ${minutesAgo}))`
}

describe("demo spend", () => {
  let visitorOrgId: string
  let reservedOrgId: string
  let normalOrgId: string

  beforeAll(async () => {
    await acquireTestLock()
    visitorOrgId = (await ensureOrg({ slug: "spend-visitor", name: "Spend Visitor" })).orgId
    reservedOrgId = (await ensureOrg({ slug: "spend-reserved", name: "Spend Reserved" })).orgId
    normalOrgId = (await ensureOrg({ slug: "spend-normal", name: "Spend Normal" })).orgId
    await markOrgAsDemo(visitorOrgId, visitorMarker(24))
    await markOrgAsDemo(reservedOrgId, reservedMarker())
    await sql`
      INSERT INTO kernel.model_pricing
        (model_id, provider, display_name, input_cost_per_m, output_cost_per_m,
         context_window, tier_minimum, auto_eligible)
      VALUES (${MODEL}, 'anthropic', 'Demo Cheap', '1', '5', 200000, 'starter', true)`
    // The reserved org's turns are pinned to this id whatever they ask for
    // (demo-spend-ceiling.ts), and boot seeds it into the catalog; so does this.
    await sql`
      INSERT INTO kernel.model_pricing
        (model_id, provider, display_name, input_cost_per_m, output_cost_per_m,
         context_window, tier_minimum, auto_eligible)
      VALUES (${RESERVED_MODEL_DEFAULT}, 'google', 'Gemini Flash-Lite', '0.09', '0.35',
              1048576, 'starter', true)
      ON CONFLICT DO NOTHING`
    // Keys on the box, exactly as a real deployment has (the test preload's
    // placeholders): the whole point is that a visitor org cannot reach them.
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    _setEdition(null)
    await releaseTestLock()
  })

  afterEach(async () => {
    invalidateDemoMarker()
    _setEdition(null)
    await sql`DELETE FROM kernel.credit_transactions WHERE type = 'byok_usage'`
    await clearRedisPatterns(["demo:*"])
  })

  // ── A VISITOR ORG CANNOT SPEND OURS ──────────────────────────────────────
  //
  // The hole this closes: `resolveKey` fell back to `process.env[...]` for any
  // org without a BYOK key, so every stranger who filled in the signup form was
  // handed the operator's Anthropic key and spent it.
  describe("a visitor org cannot spend ours", () => {
    it("refuses the key on the box rather than handing it over", async () => {
      DemoModeTestAccess.set(true)
      await expect(resolveKey(visitorOrgId, "anthropic")).rejects.toBeInstanceOf(
        DemoKeyRequiredError,
      )
    })

    // Visitor spend on the box key is ON only with an owner alert address and
    // a demo mail channel (demo-alerts.ts); these turn it on.
    function spendOn(): () => void {
      const target = env as {
        LIAISON_DEMO_ALERT_EMAIL?: string
        LIAISON_DEMO_MAIL_CAPTURE: boolean
      }
      const saved = { ...target }
      target.LIAISON_DEMO_ALERT_EMAIL = "owner@example.com"
      target.LIAISON_DEMO_MAIL_CAPTURE = true
      registerDemoAlertMailer(async () => {})
      return () => {
        target.LIAISON_DEMO_ALERT_EMAIL = saved.LIAISON_DEMO_ALERT_EMAIL
        target.LIAISON_DEMO_MAIL_CAPTURE = saved.LIAISON_DEMO_MAIL_CAPTURE
        registerDemoAlertMailer(null)
      }
    }

    it("refuses the TURN until the visitor confirms an email, and says so in the thread", async () => {
      DemoModeTestAccess.set(true)
      const restore = spendOn()
      try {
        const result = await preCheck(visitorOrgId, MODEL)
        expect(result.allowed).toBe(false)
        if (result.allowed) return
        expect(result.code).toBe("demo_verification_required")
        expect(result.status).toBe(403)
        expect(result.persistSystemMessage).toBe(true)
      } finally {
        restore()
      }
    })

    it("refuses on a MANAGED edition too, which is where the tokens cost money", async () => {
      DemoModeTestAccess.set(true)
      _setEdition("managed")
      const restore = spendOn()
      try {
        const result = await preCheck(visitorOrgId, MODEL)
        expect(result.allowed).toBe(false)
        if (result.allowed) return
        expect(result.code).toBe("demo_verification_required")
      } finally {
        restore()
      }
    })

    it("refuses with demo_unavailable while no owner alert can be sent", async () => {
      DemoModeTestAccess.set(true)
      const result = await preCheck(visitorOrgId, MODEL)
      expect(result.allowed).toBe(false)
      if (result.allowed) return
      expect(result.code).toBe("demo_unavailable")
    })

    it("has no ceiling of its own: there is nothing of ours left to ration", async () => {
      DemoModeTestAccess.set(true)
      await spendTokens(visitorOrgId, CEILING() * 100)
      invalidateDemoMarker()
      expect(await checkDemoSpendCeiling(visitorOrgId)).toBeNull()
      expect(await demoOrgTokensReserved(visitorOrgId)).toBe(0)
      expect((await checkMidStep(visitorOrgId, "byok")).exhausted).toBe(false)
    })
  })

  // ── THE RESERVED ORG IS THE ONE EXCEPTION, AND IT IS CAPPED ──────────────
  describe("the reserved App Review org", () => {
    it("reaches the key on the box, because a reviewer cannot paste one", async () => {
      DemoModeTestAccess.set(true)
      const resolved = await resolveKey(reservedOrgId, "anthropic")
      expect(resolved.source).toBe("liaison")
    })

    it("runs a turn while it is under the ceiling", async () => {
      DemoModeTestAccess.set(true)
      expect((await preCheck(reservedOrgId, MODEL)).allowed).toBe(true)
    })

    it("refuses the turn once the day's allowance is spent", async () => {
      DemoModeTestAccess.set(true)
      await spendTokens(reservedOrgId, CEILING())
      invalidateDemoMarker()
      const result = await preCheck(reservedOrgId, MODEL)
      expect(result.allowed).toBe(false)
      if (result.allowed) return
      expect(result.status).toBe(402)
      expect(result.persistSystemMessage).toBe(true)
      expect(result.reason).toContain("usage limit")
    })

    // THE HEADLINE. A lifetime total here locks App Review out permanently the
    // first time a reviewer spends it, which is a rejected build.
    it("recovers on the clock, so a later review session still works", async () => {
      DemoModeTestAccess.set(true)
      await spendTokensAgo(reservedOrgId, CEILING() * 50, 25 * 60)
      invalidateDemoMarker()
      expect((await preCheck(reservedOrgId, MODEL)).allowed).toBe(true)
      await releaseDemoTurnReservation(reservedOrgId)
      expect((await checkMidStep(reservedOrgId, "byok")).exhausted).toBe(false)
    })

    it("counts only what was spent inside the window", async () => {
      await spendTokensAgo(reservedOrgId, CEILING() * 50, 25 * 60)
      await spendTokens(reservedOrgId, 1_000)
      expect(await demoOrgTokensUsed(reservedOrgId)).toBe(1_000)
    })

    // Concurrency: `checkDemoSpendCeiling` used to be a pre-turn read of already
    // recorded transactions, so N concurrent turns all read `used = 0` and all
    // proceeded. The reservation is what makes them see each other.
    it("refuses concurrent turns that would collectively pass the ceiling", async () => {
      DemoModeTestAccess.set(true)
      // One token under the point where the FIRST reservation alone reaches the
      // ceiling, so exactly one of the four is admitted.
      await spendTokens(reservedOrgId, CEILING() - 25_001)
      invalidateDemoMarker()
      const results = await Promise.all([
        checkDemoSpendCeiling(reservedOrgId),
        checkDemoSpendCeiling(reservedOrgId),
        checkDemoSpendCeiling(reservedOrgId),
        checkDemoSpendCeiling(reservedOrgId),
      ])
      expect(results.filter((r) => r === null).length).toBe(1)
      expect(results.filter((r) => r?.status === 402).length).toBe(3)
    })

    it("gives the reservation back when the turn finishes", async () => {
      DemoModeTestAccess.set(true)
      expect(await checkDemoSpendCeiling(reservedOrgId)).toBeNull()
      expect(await demoOrgTokensReserved(reservedOrgId)).toBe(25_000)
      await releaseDemoTurnReservation(reservedOrgId)
      expect(await demoOrgTokensReserved(reservedOrgId)).toBe(0)
    })

    // The pre turn gate and the mid step gate must draw the line in the SAME
    // place. `checkDemoSpendCeiling` compared `used + reserved > ceiling` while
    // `demoSpendExhausted` compares `>=`, so a turn taken at exactly the ceiling
    // was admitted by the first gate and killed by the second on its very first
    // step: one wasted turn per review session, and a refusal that arrives after
    // the reviewer has watched the agent start. Here the org is one reservation
    // short of the ceiling, so the admitted turn's own reservation lands exactly
    // on it. Mutate the `>=` in `checkDemoSpendCeiling` back to `>` and this
    // fails: the turn is admitted, and the mid step assertion below shows what
    // would have happened to it.
    it("refuses at exactly the ceiling, where the mid step gate would kill the turn", async () => {
      DemoModeTestAccess.set(true)
      await spendTokens(reservedOrgId, CEILING() - 25_000)
      invalidateDemoMarker()
      const block = await checkDemoSpendCeiling(reservedOrgId)
      expect(block?.status).toBe(402)
      // And the refusal handed the reservation back rather than leaking it.
      expect(await demoOrgTokensReserved(reservedOrgId)).toBe(0)
    })

    it("agrees with the mid step gate about what a turn in flight costs", async () => {
      DemoModeTestAccess.set(true)
      await spendTokens(reservedOrgId, CEILING() - 25_000)
      invalidateDemoMarker()
      // Model a turn that IS in flight at this level: its reservation is held,
      // so `used + reserved` is exactly the ceiling. That is the state the pre
      // turn gate just refused to create, and the mid step gate calls it
      // exhausted. The two now agree.
      await redis.incrby(`demo:spend-reserve:${reservedOrgId}`, 25_000)
      expect((await checkMidStep(reservedOrgId, "byok")).exhausted).toBe(true)
    })

    // A managed edition is a deploy convention, and the reserved org's
    // usability may not rest on one. Its budget is the TOKEN CEILING; its
    // credit balance is forced to zero on purpose by `zeroDemoOrgCredits`, so
    // without the bypass every reviewer turn came back 402 "Out of agent usage"
    // with the ceiling untouched. Delete the `isReservedDemoOrg` clause from
    // preCheck step 3b and this fails.
    it("runs on a MANAGED edition too, where its balance is zero by design", async () => {
      DemoModeTestAccess.set(true)
      _setEdition("managed")
      const result = await preCheck(reservedOrgId, MODEL)
      expect(result.allowed).toBe(true)
      if (!result.allowed) return
      expect(result.keySource).toBe("liaison")
      expect((await checkMidStep(reservedOrgId, "liaison")).exhausted).toBe(false)
    })

    it("still stops on a MANAGED edition once the ceiling is spent", async () => {
      DemoModeTestAccess.set(true)
      _setEdition("managed")
      await spendTokens(reservedOrgId, CEILING())
      invalidateDemoMarker()
      const result = await preCheck(reservedOrgId, MODEL)
      expect(result.allowed).toBe(false)
      if (result.allowed) return
      expect(result.status).toBe(402)
      expect(result.reason).toContain("usage limit")
    })

    it("aborts a running turn once it goes over the ceiling mid flight", async () => {
      DemoModeTestAccess.set(true)
      expect((await checkMidStep(reservedOrgId, "byok")).exhausted).toBe(false)
      await spendTokens(reservedOrgId, CEILING())
      invalidateDemoMarker()
      expect((await checkMidStep(reservedOrgId, "byok")).exhausted).toBe(true)
    })
  })

  // ── THE REGRESSION GUARD. Everything above must leave this untouched. ─────
  describe("a normal org, and a box that is not a demo", () => {
    it("never caps a normal org on the demo box, whatever it has spent", async () => {
      DemoModeTestAccess.set(true)
      await spendTokens(normalOrgId, CEILING() * 10)
      expect((await preCheck(normalOrgId, MODEL)).allowed).toBe(true)
      expect(await checkDemoSpendCeiling(normalOrgId)).toBeNull()
      expect(await demoOrgTokensReserved(normalOrgId)).toBe(0)
      expect((await checkMidStep(normalOrgId, "byok")).exhausted).toBe(false)
    })

    it("still resolves a normal org's key off the environment on the demo box", async () => {
      DemoModeTestAccess.set(true)
      expect((await resolveKey(normalOrgId, "anthropic")).source).toBe("liaison")
    })

    it("leaves a managed normal org's turn on the billing path it was always on", async () => {
      DemoModeTestAccess.set(true)
      _setEdition("managed")
      // No credits on this org, so a managed turn is refused by the BALANCE
      // gate, never by anything demo-shaped.
      const result = await preCheck(normalOrgId, MODEL)
      expect(result.allowed).toBe(false)
      if (result.allowed) return
      expect(result.reason).not.toContain("demo")
      expect(result.reason).not.toContain("model API key")
    })

    it("changes nothing at all with demo mode off, not even for a marked org", async () => {
      DemoModeTestAccess.set(false)
      await spendTokens(visitorOrgId, CEILING() * 10)
      await spendTokens(reservedOrgId, CEILING() * 10)
      invalidateDemoMarker()
      expect((await resolveKey(visitorOrgId, "anthropic")).source).toBe("liaison")
      expect((await preCheck(visitorOrgId, MODEL)).allowed).toBe(true)
      expect((await preCheck(reservedOrgId, MODEL)).allowed).toBe(true)
      expect(await checkDemoSpendCeiling(reservedOrgId)).toBeNull()
      expect((await checkMidStep(visitorOrgId, "byok")).exhausted).toBe(false)
    })
  })
})
