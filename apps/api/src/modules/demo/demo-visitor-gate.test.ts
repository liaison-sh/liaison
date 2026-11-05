// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE BOX KEY IS A CAPABILITY. A demo visitor org gets this box's model key
// only against a live reservation, only for OpenRouter, only for the pinned
// model (or the web-search / transcription model), and nothing the visitor
// administers can change which model that is. Asserted through the functions
// the product calls (preCheck, resolveKey, the request guard, the step cap).
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Delete the visitor branch from `resolveKey`: "never hands the box key
//    without a live reservation" gets the key back.
//  * Drop `isLive` from `assertVisitorBoxKey`: the settled and expired handle
//    cases get the key.
//  * Drop the provider check: the Anthropic / Google / Exa cases get a key.
//  * Build the pin from `lookupModelInfo(settings)`: the settings cases run the
//    visitor's own model on the box key.
//  * Drop `assertBoxKeyRequest` from the provider's fetch: another body.model
//    reaches the stub server.
//  * Drop the `onLanguageModelCallEnd` forwarding from `runAgentStream` (or
//    the meter's `onCallEnd`): an asking turn holds its step's max while it
//    waits, and the asked agent's step is refused inside the same headroom.
//  * Drop the `notBilled` release from `searchOnOpenRouter`: a search
//    OpenRouter never answered is billed at its worst case. Mark every
//    failure `notBilled`: the timeout and the 5xx cases are released.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { resolveTurnReasoningLevel } from "@liaison/shared"
import { generateText, simulateReadableStream, stepCountIs, tool } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { byokEncryptionKey, env } from "~/lib/env"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import {
  DemoStepMeter,
  demoVisitorModelInfo,
  isProviderUsable,
  listAvailableModels,
  preCheck,
  resolveAutoReasoningLevel,
  resolveKey,
  selectAutoModelForOrg,
  selectSideCallModelForOrg,
  visitorCostMicroEur,
  visitorStepBase,
  visitorStepsPerTurn,
} from "~/modules/agent/credits/credit-meter"
import {
  assertBoxKeyRequest,
  BoxKeyRequestRefusedError,
  createOpenRouterModel,
} from "~/modules/agent/providers/openrouter"
import {
  DemoMediaRefusedError,
  estimateVisitorRequestInputTokens,
} from "~/modules/agent/providers/step-token-cap"
import { runAgentChat, runAgentStream } from "~/modules/agent/runtime/agent-service"
import { OPENROUTER_WEB_SEARCH_MODEL } from "~/modules/agent/tools/web-search-openrouter"
import { registerDemoAlertMailer } from "~/modules/demo/demo-alerts"
import {
  DemoBudgetTestAccess,
  type DemoSpendIdentity,
  reserveStep,
  reserveVisitorStep,
  settleStep,
  snapshot,
} from "~/modules/demo/demo-budget"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { DemoReservationRequiredError } from "~/modules/demo/demo-spend"
import {
  microEurOfUsd,
  VISITOR_MODEL_UPSTREAM_DEFAULT,
  visitorRequestInputMicroEur,
  visitorStepOutputMicroEur,
} from "~/modules/demo/demo-spend-ceiling"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { invalidateOrgEmbedder, resolveOrgEmbedder } from "~/modules/search/message-indexer"
import { aiModelsRoutes } from "~/modules/settings/ai-models-routes"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

/**
 * This run's demo budget keys matching `pattern` (after `demo:b:`). KEYS takes
 * no client keyPrefix, so the pattern names this run's REDIS_PREFIX itself: a
 * leading wildcard would also match other test runs' keys in the shared Redis.
 */
function demoKeys(pattern: string): Promise<string[]> {
  return redis.keys(`${REDIS_PREFIX}demo:b:${pattern}`)
}

type EnvKey = keyof typeof env
function setEnv<K extends EnvKey>(key: K, value: (typeof env)[K]): () => void {
  const target = env as Record<K, (typeof env)[K]>
  const saved = target[key]
  target[key] = value
  return () => {
    target[key] = saved
  }
}

const BOX_KEY = "sk-or-box-key-of-demo-tests"
const PIN_KEY = `openrouter/${VISITOR_MODEL_UPSTREAM_DEFAULT}`
const ANTHROPIC_MODEL = "visitor-gate-anthropic-model"

async function setByok(orgId: string, provider: string, plaintext: string): Promise<void> {
  const encrypted = encryptSecret(plaintext, byokEncryptionKey, CryptoContext.byokApiKey)
  await withPrivilegedDb(orgId, "test-set-byok", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE kernel.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) ||
        jsonb_build_object('providerKeys',
          COALESCE(settings->'providerKeys', '{}'::jsonb) ||
          jsonb_build_object(${provider}::text, jsonb_build_object('encrypted', ${encrypted}::text)))
      WHERE id = ${orgId}::uuid`)
  })
}

async function clearByok(orgId: string): Promise<void> {
  await sql`UPDATE kernel.organizations SET settings = settings - 'providerKeys' WHERE id = ${orgId}::uuid`
}

describe("the box key is a capability for demo visitor orgs", () => {
  let visitorOrg: string
  let unverifiedOrg: string
  let normalOrg: string
  const identities = new Map<string, DemoSpendIdentity>()
  const restores: Array<() => void> = []
  const savedEnv: Record<string, string | undefined> = {}
  const mails: Array<{ to: string; subject: string }> = []

  beforeAll(async () => {
    await acquireTestLock()
    for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"]) savedEnv[k] = process.env[k]
    process.env.OPENROUTER_API_KEY = BOX_KEY
    visitorOrg = (await ensureOrg({ slug: "visitor-gate-v", name: "Visitor" })).orgId
    unverifiedOrg = (await ensureOrg({ slug: "visitor-gate-u", name: "Unverified" })).orgId
    normalOrg = (await ensureOrg({ slug: "visitor-gate-n", name: "Normal" })).orgId
    await markOrgAsDemo(visitorOrg, visitorMarker(24))
    await markOrgAsDemo(unverifiedOrg, visitorMarker(24))
    await sql`
      INSERT INTO kernel.model_pricing
        (model_id, provider, display_name, input_cost_per_m, output_cost_per_m,
         context_window, tier_minimum, auto_eligible)
      VALUES (${ANTHROPIC_MODEL}, 'anthropic', 'Visitor Gate Anthropic', '0.5', '1', 200000,
              'starter', true)
      ON CONFLICT DO NOTHING`
    DemoBudgetTestAccess.setVerifiedIdentity(async (orgId) => identities.get(orgId) ?? null)
    registerDemoAlertMailer(async (m) => {
      mails.push({ to: m.to, subject: m.subject })
    })
    // Three orgs, each installing every app: past the 5 s hook default on a loaded machine.
  }, 60_000)

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    DemoBudgetTestAccess.setVerifiedIdentity(null)
    registerDemoAlertMailer(null)
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${ANTHROPIC_MODEL}`
    await releaseTestLock()
  })

  let seq = 0
  function verify(orgId: string): DemoSpendIdentity {
    seq += 1
    const id = {
      emailNormalized: `gate${seq}-${Date.now()}@example.com`,
      network: `192.0.2.0/24-${seq}`,
    }
    identities.set(orgId, id)
    return id
  }

  function spendOn(): void {
    DemoModeTestAccess.set(true)
    restores.push(setEnv("LIAISON_DEMO_ALERT_EMAIL", "owner@example.com"))
    restores.push(setEnv("LIAISON_DEMO_MAIL_CAPTURE", true))
  }

  afterEach(async () => {
    while (restores.length > 0) restores.pop()?.()
    identities.clear()
    DemoBudgetTestAccess.setNow(null)
    invalidateDemoMarker()
    await clearByok(visitorOrg)
    await sql`DELETE FROM kernel.demo_spend`
    await clearRedisPatterns(["demo:*"])
    mails.length = 0
  })

  // ── WHO GETS THE KEY ───────────────────────────────────────────────────
  it("refuses an unverified visitor's turn with the verification code, and no key", async () => {
    spendOn()
    const turn = await preCheck(unverifiedOrg, null, { turn: true })
    expect(turn.allowed).toBe(false)
    if (turn.allowed) return
    expect(turn.code).toBe("demo_verification_required")
    expect(turn.persistSystemMessage).toBe(true)
    let refused: unknown = null
    try {
      await resolveKey(unverifiedOrg, "openrouter")
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(DemoReservationRequiredError)
    expect((refused as DemoReservationRequiredError).code).toBe("demo_verification_required")
    // Nothing was reserved or spent.
    expect(await demoKeys("r:*")).toEqual([])
  })

  // Walk D40: when the box could not send the code, the refusal line still
  // said "The code is in your inbox" while the band said it was not sent.
  it("says the code is in the inbox only when one was sent", async () => {
    spendOn()
    const unsent = await preCheck(unverifiedOrg, null, { turn: true })
    if (unsent.allowed) throw new Error("admitted")
    expect(unsent.code).toBe("demo_verification_required")
    expect(unsent.reason).not.toContain("inbox")
    expect(unsent.reason).toContain("cannot send the code")
    await redis.hset(`demo:code:${unverifiedOrg}`, { mac: "x", codeId: "y" })
    const sent = await preCheck(unverifiedOrg, null, { turn: true })
    if (sent.allowed) throw new Error("admitted")
    expect(sent.code).toBe("demo_verification_required")
    expect(sent.reason).toContain("The code is in your inbox")
  })

  it("admits a verified visitor's turn on the pin, through a live reservation, and settles it", async () => {
    spendOn()
    const id = verify(visitorOrg)
    const turn = await preCheck(visitorOrg, null, { turn: true })
    if (!turn.allowed) throw new Error(`refused: ${turn.reason}`)
    expect(turn.model.modelId).toBe(PIN_KEY)
    expect(turn.model.upstreamId).toBe(VISITOR_MODEL_UPSTREAM_DEFAULT)
    expect(turn.providerKey).toBe(BOX_KEY)
    expect(turn.keySource).toBe("liaison")
    expect(turn.demo).toBeInstanceOf(DemoStepMeter)
    expect(turn.demo?.reservation).not.toBeNull()
    await turn.demo?.finish(1234)
    expect((await snapshot(id)).usedMicroEur).toBe(1234)
  })

  it("never hands the box key to a visitor without a live reservation", async () => {
    spendOn()
    const id = verify(visitorOrg)
    const refusedCode = async (p: Promise<unknown>) => {
      try {
        await p
        return "key"
      } catch (err) {
        return err instanceof DemoReservationRequiredError ? err.code : String(err)
      }
    }
    // No handle at all, verified: refused.
    expect(await refusedCode(resolveKey(visitorOrg, "openrouter"))).toBe("demo_unavailable")
    // A settled handle: refused.
    const settled = await reserveStep(id, VISITOR_MODEL_UPSTREAM_DEFAULT, 100, visitorOrg)
    await settleStep(settled, 10)
    expect(await refusedCode(resolveKey(visitorOrg, "openrouter", { reservation: settled }))).toBe(
      "demo_unavailable",
    )
    // An expired handle: refused.
    let now = Date.now()
    DemoBudgetTestAccess.setNow(() => now)
    const expiring = await reserveStep(id, VISITOR_MODEL_UPSTREAM_DEFAULT, 100, visitorOrg)
    now += 16 * 60 * 1000
    expect(await refusedCode(resolveKey(visitorOrg, "openrouter", { reservation: expiring }))).toBe(
      "demo_unavailable",
    )
    DemoBudgetTestAccess.setNow(null)
    // A live handle, another provider: refused for every one of them.
    const live = await reserveStep(id, VISITOR_MODEL_UPSTREAM_DEFAULT, 100, visitorOrg)
    for (const provider of ["anthropic", "google", "exa", "openai", "mistral"]) {
      expect(await refusedCode(resolveKey(visitorOrg, provider, { reservation: live }))).toBe(
        "demo_unavailable",
      )
    }
    // A live handle for another org: refused.
    expect(await refusedCode(resolveKey(unverifiedOrg, "openrouter", { reservation: live }))).toBe(
      "demo_verification_required",
    )
    // A live handle, another model named by the target: refused.
    expect(
      await refusedCode(
        resolveKey(
          visitorOrg,
          { provider: "openrouter", upstreamId: "anthropic/claude-opus-4" },
          { reservation: live },
        ),
      ),
    ).toBe("demo_unavailable")
    // A reservation held for a model the box key does not price: refused.
    const offModel = await reserveStep(id, "anthropic/claude-opus-4", 100, visitorOrg)
    expect(await refusedCode(resolveKey(visitorOrg, "openrouter", { reservation: offModel }))).toBe(
      "demo_unavailable",
    )
    // The live handle for the pin: the key.
    expect(
      (
        await resolveKey(
          visitorOrg,
          { provider: "openrouter", upstreamId: VISITOR_MODEL_UPSTREAM_DEFAULT },
          { reservation: live },
        )
      ).key,
    ).toBe(BOX_KEY)
  })

  // ── THE PIN COMES FROM CODE AND ENV ──────────────────────────────────────
  it("ignores the visitor's own model settings: the pin is what runs on the box key", async () => {
    spendOn()
    verify(visitorOrg)
    await withPrivilegedDb(visitorOrg, "test-ai-models", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE kernel.organizations SET settings = COALESCE(settings, '{}'::jsonb) ||
          jsonb_build_object('ai', jsonb_build_object('models', jsonb_build_object(
            'autoModelKey', 'openrouter/anthropic/claude-opus-4',
            'added', jsonb_build_array(jsonb_build_object(
              'key', 'openrouter/anthropic/claude-opus-4', 'provider', 'openrouter',
              'upstreamId', 'anthropic/claude-opus-4', 'displayName', 'Opus',
              'enabled', true, 'contextWindow', 200000, 'tools', true,
              'inputCostPerM', '0.0001', 'outputCostPerM', '0.0001',
              'reasoningEfforts', jsonb_build_array(), 'canDisableReasoning', false,
              'addedAt', '2026-10-23T00:00:00.000Z')))))
        WHERE id = ${visitorOrg}::uuid`)
    })
    try {
      for (const asked of [null, "openrouter/anthropic/claude-opus-4", ANTHROPIC_MODEL]) {
        const turn = await preCheck(visitorOrg, asked, { turn: true })
        if (!turn.allowed) throw new Error(`refused: ${turn.reason}`)
        expect(turn.model.upstreamId).toBe(VISITOR_MODEL_UPSTREAM_DEFAULT)
        expect(Number(turn.model.inputCostPerM)).toBeGreaterThan(0.2)
        await turn.demo?.finish(0)
      }
      expect((await selectAutoModelForOrg(visitorOrg, "t"))?.modelId).toBe(PIN_KEY)
      expect((await selectSideCallModelForOrg(visitorOrg, "t"))?.modelId).toBe(PIN_KEY)
      const listed = (await listAvailableModels(visitorOrg)).map((m) => m.key)
      expect(listed).toContain(PIN_KEY)
      expect(listed).not.toContain("openrouter/anthropic/claude-opus-4")
    } finally {
      await sql`UPDATE kernel.organizations SET settings = settings - 'ai' WHERE id = ${visitorOrg}::uuid`
    }
  })

  it("shows and runs Auto at low on the box key, from the pin's one level", async () => {
    spendOn()
    verify(visitorOrg)
    const turn = await preCheck(visitorOrg, null, { turn: true })
    if (!turn.allowed) throw new Error(`refused: ${turn.reason}`)
    expect(turn.model.autoReasoningLevel).toBe("low")
    await turn.demo?.finish(0)
    // The model menu reads the same level (GET /credits/models).
    expect(await resolveAutoReasoningLevel(visitorOrg)).toBe("low")
    const pin = (await listAvailableModels(visitorOrg)).find((m) => m.key === PIN_KEY)
    expect(pin?.reasoning).toEqual({ allowedLevels: ["low"], defaultLevel: "low" })
  })

  it("lets a visitor with its own key run that provider unpinned, with no box spend", async () => {
    spendOn()
    const id = verify(visitorOrg)
    // Exhaust the visitor's budget first: its own key still runs.
    await settleStep(
      await reserveStep(id, VISITOR_MODEL_UPSTREAM_DEFAULT, 200_000, visitorOrg),
      200_000,
    )
    const exhausted = await preCheck(visitorOrg, null, { turn: true })
    expect(!exhausted.allowed && exhausted.code).toBe("demo_budget_exhausted")
    await setByok(visitorOrg, "anthropic", "sk-ant-visitor-own")
    const turn = await preCheck(visitorOrg, null, { turn: true })
    if (!turn.allowed) throw new Error(`refused: ${turn.reason}`)
    expect(turn.model.provider).toBe("anthropic")
    expect(turn.keySource).toBe("byok")
    expect(turn.providerKey).toBe("sk-ant-visitor-own")
    expect(turn.demo).toBeUndefined()
    expect((await snapshot(id)).usedMicroEur).toBe(200_000)
    // The box's Google and Exa keys stay out of reach even so.
    expect(await isProviderUsable(visitorOrg, "google", {})).toBe(false)
    expect(await isProviderUsable(visitorOrg, "exa", {})).toBe(false)
  })

  // ── SPEND OFF FAILS CLOSED ───────────────────────────────────────────────
  it("refuses a verified visitor with demo_unavailable when no alert address or mail is set", async () => {
    DemoModeTestAccess.set(true)
    verify(visitorOrg)
    const noAlert = await preCheck(visitorOrg, null, { turn: true })
    expect(!noAlert.allowed && noAlert.code).toBe("demo_unavailable")
    restores.push(setEnv("LIAISON_DEMO_ALERT_EMAIL", "owner@example.com"))
    registerDemoAlertMailer(null)
    try {
      const noMail = await preCheck(visitorOrg, null, { turn: true })
      expect(!noMail.allowed && noMail.code).toBe("demo_unavailable")
    } finally {
      registerDemoAlertMailer(async (m) => {
        mails.push({ to: m.to, subject: m.subject })
      })
    }
    expect(await demoKeys("r:*")).toEqual([])
  })

  // ── LOAD ─────────────────────────────────────────────────────────────────
  it("refuses a 3rd concurrent turn of one email, a sub-run counted as a turn", async () => {
    spendOn()
    verify(visitorOrg)
    const a = await preCheck(visitorOrg, null, { turn: true })
    const subrun = await preCheck(visitorOrg, null, { turn: true })
    expect(a.allowed && subrun.allowed).toBe(true)
    const third = await preCheck(visitorOrg, null, { turn: true })
    expect(!third.allowed && third.code).toBe("demo_busy")
    if (a.allowed) await a.demo?.finish(0)
    const again = await preCheck(visitorOrg, null, { turn: true })
    expect(again.allowed).toBe(true)
  })

  it("admits turns of one email one after another, with no per-minute cap", async () => {
    spendOn()
    verify(visitorOrg)
    for (let i = 0; i < 12; i++) {
      const t = await preCheck(visitorOrg, null, { turn: true })
      if (!t.allowed) throw new Error(`turn ${i + 1} refused: ${t.reason}`)
      await t.demo?.finish(0)
    }
  })

  // ── STEPS ────────────────────────────────────────────────────────────────
  it("admits a chat turn's steps up to its limit and refuses the next", async () => {
    spendOn()
    verify(visitorOrg)
    restores.push(setEnv("LIAISON_DEMO_BUDGET_PER_EMAIL_EUR", 10))
    restores.push(setEnv("LIAISON_DEMO_BUDGET_PER_NETWORK_EUR", 10))
    const limit = env.LIAISON_DEMO_STEPS_PER_TURN
    // Six steps left the live scenarios' agent work unfinished (the sales reply draft).
    expect(limit).toBeGreaterThan(6)
    const turn = await preCheck(visitorOrg, null, { turn: true })
    if (!turn.allowed || !turn.demo) throw new Error("refused")
    const usage = { inputTokens: 100, outputTokens: 10 }
    for (let step = 1; step < limit; step++) {
      expect((await turn.demo.stepFinished(usage)).exhausted).toBe(false)
    }
    expect(turn.demo.stepCount).toBe(limit)
    expect((await turn.demo.stepFinished(usage)).exhausted).toBe(true)
    // The step limit has its own code, not "busy".
    expect(turn.demo.refusal).toBe("demo_step_limit")
    await turn.demo.finish(0)
  })

  it("gives a routine run its own, larger step limit", async () => {
    spendOn()
    verify(visitorOrg)
    restores.push(setEnv("LIAISON_DEMO_BUDGET_PER_EMAIL_EUR", 10))
    restores.push(setEnv("LIAISON_DEMO_BUDGET_PER_NETWORK_EUR", 10))
    const limit = visitorStepsPerTurn({ routine: true })
    expect(limit).toBe(env.LIAISON_DEMO_ROUTINE_STEPS_PER_TURN)
    expect(limit).toBeGreaterThan(visitorStepsPerTurn())
    const turn = await preCheck(visitorOrg, null, { turn: true })
    if (!turn.allowed || !turn.demo) throw new Error("refused")
    turn.demo.maxSteps = limit
    const usage = { inputTokens: 100, outputTokens: 10 }
    for (let step = 1; step < limit; step++) {
      expect((await turn.demo.stepFinished(usage)).exhausted).toBe(false)
    }
    expect((await turn.demo.stepFinished(usage)).exhausted).toBe(true)
    expect(turn.demo.refusal).toBe("demo_step_limit")
    await turn.demo.finish(0)
  })

  it("settles a step at the cost OpenRouter reported for it, not its tokens' estimate", async () => {
    spendOn()
    const id = verify(visitorOrg)
    const turn = await preCheck(visitorOrg, null, { turn: true })
    if (!turn.allowed || !turn.demo) throw new Error("refused")
    turn.demo.markSent()
    const usage = { inputTokens: 50_000, outputTokens: 1_000 }
    await turn.demo.stepFinished(
      usage,
      { openrouter: { usage: { cost: 0.0021 } } },
      {
        reserveNext: false,
      },
    )
    await turn.demo.finish()
    expect((await snapshot(id)).usedMicroEur).toBe(microEurOfUsd(0.0021))
    expect(microEurOfUsd(0.0021)).not.toBe(visitorCostMicroEur(usage))
  })

  it("ends the turn when the next step's reservation does not fit the budget", async () => {
    spendOn()
    const id = verify(visitorOrg)
    // What a step holds before it runs: its 16,000 output tokens at worst.
    const stepMax = visitorStepOutputMicroEur(16_000)
    const turn = await preCheck(visitorOrg, null, { turn: true })
    if (!turn.allowed || !turn.demo) throw new Error("refused")
    // Another tab spends the rest meanwhile.
    await settleStep(
      await reserveStep(id, VISITOR_MODEL_UPSTREAM_DEFAULT, 200_000 - 2 * stepMax + 1, visitorOrg),
      200_000 - 2 * stepMax + 1,
    )
    const next = await turn.demo.stepFinished({ inputTokens: 90_000, outputTokens: 16_000 })
    expect(next.exhausted).toBe(true)
    expect(turn.demo.refusal).toBe("demo_budget_exhausted")
    await turn.demo.finish(0)
    expect((await snapshot(id)).usedMicroEur).toBeLessThanOrEqual(200_000 + stepMax)
  })

  // ── A SENT REQUEST IS BILLED ─────────────────────────────────────────────
  // A step whose request left and whose usage never came back (the visitor
  // dropped the connection, the stream errored) is settled at its reserved
  // max; only a step that was never sent is released.

  /**
   * One visitor step whose stream starts answering, then is aborted mid-way.
   * `held` is what the step held: its output, and its input as it left.
   */
  async function abortedStep(cap: Parameters<typeof runAgentStream>[0]["stepTokenCap"]) {
    const abort = new AbortController()
    let calls = 0
    let estimated = 0
    const seen = cap
      ? {
          ...cap,
          onRequest: async (e: number) => {
            estimated = e
            await cap.onRequest?.(e)
          },
        }
      : null
    const model = new MockLanguageModelV4({
      doStream: async (opts) => {
        calls++
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: "stream-start", warnings: [] })
              c.enqueue({ type: "text-start", id: "t1" })
              c.enqueue({ type: "text-delta", id: "t1", delta: "Part" })
              const stop = () => c.error(new DOMException("aborted", "AbortError"))
              if (opts.abortSignal?.aborted) stop()
              else opts.abortSignal?.addEventListener("abort", stop, { once: true })
            },
          }),
        }
      },
    })
    const result = runAgentStream({
      model,
      stepTokenCap: seen,
      system: "sys",
      messages: [{ role: "user", content: "a long question" }],
      tools: {},
      stopWhen: stepCountIs(1),
      abortSignal: abort.signal,
    })
    try {
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") abort.abort("client went away")
      }
    } catch {
      // the abort
    }
    return { calls, held: visitorStepBase() + visitorRequestInputMicroEur(estimated) }
  }

  it("bills a turn's step at its reserved max when the stream is aborted after it was sent", async () => {
    spendOn()
    const id = verify(visitorOrg)
    const turn = await preCheck(visitorOrg, null, { turn: true })
    if (!turn.allowed || !turn.demo) throw new Error("refused")
    const ran = await abortedStep(turn.model.stepTokenCap ?? null)
    expect(ran.calls).toBe(1)
    // The route finalizes with the usage it saw: none for the aborted step.
    await turn.demo.finish(0)
    expect((await snapshot(id)).usedMicroEur).toBe(ran.held)
    expect(ran.held).toBeGreaterThan(visitorStepBase())
    expect(await demoKeys("r:*")).toEqual([])
  })

  it("bills the in-flight step at its max after earlier steps settled at their cost", async () => {
    spendOn()
    const id = verify(visitorOrg)
    const turn = await preCheck(visitorOrg, null, { turn: true })
    if (!turn.allowed || !turn.demo) throw new Error("refused")
    const first = { inputTokens: 100, outputTokens: 10 }
    const firstCost = visitorCostMicroEur(first)
    expect((await turn.demo.stepFinished(first)).exhausted).toBe(false)
    const ran = await abortedStep(turn.model.stepTokenCap ?? null)
    // The turn's total covers only the finished step.
    await turn.demo.finish(firstCost)
    expect((await snapshot(id)).usedMicroEur).toBe(firstCost + ran.held)
  })

  // ── A WAITING ASKER HOLDS NOTHING ──────────────────────────────────────
  // Live demo, 2026-10-27: an agent waiting in agents_ask (up to 45 s) held its step's worst
  // cost while the asked agent reserved its own, so one ask needed two step maxes of headroom
  // and the asked agent was refused. Only one of the two runs at a time.
  it("settles an asking step before its tool waits, so the asked agent fits in what is left", async () => {
    spendOn()
    const id = verify(visitorOrg)
    // A step's hold: its output, and the input of a short request.
    const max = visitorStepBase() + visitorRequestInputMicroEur(2_000)
    // Room for one step's max and a half: the asker's hold and the asked agent's cannot both fit.
    restores.push(setEnv("LIAISON_DEMO_BUDGET_PER_EMAIL_EUR", (1.5 * max) / 1_000_000))
    const turn = await preCheck(visitorOrg, null, { turn: true })
    if (!turn.allowed || !turn.demo) throw new Error("refused")
    const meter = turn.demo
    const askerUsd = 0.0001
    const askedUsd = 0.0002
    const seen: { holdsWhileWaiting?: number; askedRefused?: unknown; holdsOnResume?: number } = {}
    const finish = (unified: "tool-calls" | "stop", usd: number) => ({
      type: "finish" as const,
      finishReason: { unified, raw: unified },
      usage: {
        inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 20, text: 20, reasoning: 0 },
      },
      providerMetadata: { openrouter: { usage: { cost: usd } } },
    })
    let calls = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++
        if (calls === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start" as const, warnings: [] },
                {
                  type: "tool-call" as const,
                  toolCallId: "ask-1",
                  toolName: "ask",
                  input: JSON.stringify({ question: "the margin?" }),
                },
                finish("tool-calls", askerUsd),
              ],
            }),
          }
        }
        seen.holdsOnResume = (await demoKeys("r:*")).length
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "t1" },
              { type: "text-delta" as const, id: "t1", delta: "41%" },
              { type: "text-end" as const, id: "t1" },
              finish("stop", askerUsd),
            ],
          }),
        }
      },
    })
    const ask = tool({
      inputSchema: z.object({ question: z.string() }),
      execute: async () => {
        // The asker waits here; the asked agent's turn runs meanwhile.
        seen.holdsWhileWaiting = (await demoKeys("r:*")).length
        try {
          const asked = await reserveVisitorStep(visitorOrg, turn.model.upstreamId, max, id)
          await settleStep(asked, microEurOfUsd(askedUsd))
        } catch (err) {
          seen.askedRefused = err
        }
        return { answer: "41%" }
      },
    })
    const result = runAgentStream({
      model,
      stepTokenCap: turn.model.stepTokenCap ?? null,
      system: "sys",
      messages: [{ role: "user", content: "ask finance" }],
      tools: { ask },
      stopWhen: stepCountIs(2),
      onStepFinish: async (step) => {
        const s = step as { usage?: unknown; providerMetadata?: unknown }
        await meter.stepFinished(s.usage, s.providerMetadata)
      },
    })
    for await (const _ of result.fullStream) {
      // drain
    }
    await meter.finish(2 * microEurOfUsd(askerUsd))
    expect(calls).toBe(2)
    // While the asker waited it held nothing, and the asked agent's step fitted.
    expect(seen.holdsWhileWaiting).toBe(0)
    expect(seen.askedRefused).toBeUndefined()
    // The asker reserved its next step again before that step was sent: its
    // output, and its input as the request left.
    expect(seen.holdsOnResume).toBe(2)
    // Each step is counted once, at what it was billed.
    expect((await snapshot(id)).usedMicroEur).toBe(
      2 * microEurOfUsd(askerUsd) + microEurOfUsd(askedUsd),
    )
    expect(await demoKeys("r:*")).toEqual([])
  })

  it("releases the next step's hold when the turn ends without sending it", async () => {
    spendOn()
    const id = verify(visitorOrg)
    const turn = await preCheck(visitorOrg, null, { turn: true })
    if (!turn.allowed || !turn.demo) throw new Error("refused")
    const first = { inputTokens: 100, outputTokens: 10 }
    turn.demo.markSent()
    expect((await turn.demo.stepFinished(first)).exhausted).toBe(false)
    await turn.demo.finish(visitorCostMicroEur(first))
    expect((await snapshot(id)).usedMicroEur).toBe(visitorCostMicroEur(first))
  })

  it("releases a step whose input the budget cannot hold, before sending it", async () => {
    spendOn()
    const id = verify(visitorOrg)
    const turn = await preCheck(visitorOrg, null, { turn: true })
    if (!turn.allowed || !turn.demo) throw new Error("refused")
    let calls = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++
        return answer()
      },
    })
    // 700,000 CJK characters: about 187,000 µEUR of input, past what the
    // 0.20 EUR budget has left beside the step's output hold.
    const result = runAgentStream({
      model,
      stepTokenCap: turn.model.stepTokenCap ?? null,
      system: "sys",
      messages: [{ role: "user", content: "漢".repeat(700_000) }],
      tools: {},
      stopWhen: stepCountIs(1),
    })
    let error: unknown = null
    for await (const part of result.fullStream) {
      if (part.type === "error") error = part.error
    }
    expect(calls).toBe(0)
    expect(turn.demo.refusal).toBe("demo_budget_exhausted")
    expect((error as Error | null)?.message).toBeTruthy()
    await turn.demo.finish(0)
    expect((await snapshot(id)).usedMicroEur).toBe(0)
    expect(await demoKeys("r:*")).toEqual([])
  })

  it("sends a step past the old 90,000-token input limit when the budget holds it", async () => {
    spendOn()
    const id = verify(visitorOrg)
    const turn = await preCheck(visitorOrg, null, { turn: true })
    if (!turn.allowed || !turn.demo) throw new Error("refused")
    let calls = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++
        return answer()
      },
    })
    const result = runAgentStream({
      model,
      stepTokenCap: turn.model.stepTokenCap ?? null,
      system: "sys",
      messages: [{ role: "user", content: "x".repeat(3 * 110_000) }],
      tools: {},
      stopWhen: stepCountIs(1),
      onStepFinish: async (step) => {
        const s = step as { usage?: unknown; providerMetadata?: unknown }
        await turn.demo?.stepFinished(s.usage, s.providerMetadata, { reserveNext: false })
      },
    })
    let error: unknown = null
    for await (const part of result.fullStream) {
      if (part.type === "error") error = part.error
    }
    expect(error).toBeNull()
    expect(calls).toBe(1)
    await turn.demo.finish()
    // Settled at what the step reported, every hold closed.
    expect((await snapshot(id)).usedMicroEur).toBeLessThan(visitorStepBase())
    expect(await demoKeys("r:*")).toEqual([])
  })

  it("exhausts the email budget by aborted steps: every one is counted", async () => {
    spendOn()
    const id = verify(visitorOrg)
    let held = 0
    let steps = 0
    for (;;) {
      const turn = await preCheck(visitorOrg, null, { turn: true })
      if (!turn.allowed || !turn.demo) throw new Error(`turn ${steps + 1} refused`)
      const ran = await abortedStep(turn.model.stepTokenCap ?? null)
      await turn.demo.finish(0)
      held += ran.held
      steps += 1
      if (200_000 - held < ran.held) break
    }
    expect(steps).toBeGreaterThan(1)
    expect((await snapshot(id)).usedMicroEur).toBe(held)
    const refused = await preCheck(visitorOrg, null, { turn: true })
    expect(!refused.allowed && refused.code).toBe("demo_budget_exhausted")
  })

  it("gives the turn slot and the hold back when a turn fails before it streams", async () => {
    spendOn()
    const id = verify(visitorOrg)
    const userId = crypto.randomUUID()
    const threadId = crypto.randomUUID()
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
      VALUES (${userId}, ${visitorOrg}, ${`gate-${userId}@example.com`}, 'Visitor')`
    // A thread the visitor is NOT a participant of: the turn is refused (403)
    // after its pre-check already took a slot and a reservation.
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${threadId}, ${visitorOrg}, ${`gate-${threadId}`}, 'thread', ${userId})`
    let refused: unknown = null
    try {
      await runAgentChat({
        threadId,
        content: "hello",
        actor: { actorType: "user", userId, orgId: visitorOrg, scopes: ["*"], dimensionGrants: {} },
        orgId: visitorOrg,
      })
    } catch (err) {
      refused = err
    }
    expect(String(refused)).toContain("Not a participant")
    expect(await redis.zcard("demo:b:t:box")).toBe(0)
    expect(await demoKeys("r:*")).toEqual([])
    expect((await snapshot(id)).usedMicroEur).toBe(0)
  })

  // ── THE STEP CAP ─────────────────────────────────────────────────────────
  function answer() {
    return {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "t1" },
          { type: "text-delta" as const, id: "t1", delta: "ok" },
          { type: "text-end" as const, id: "t1" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: "STOP" },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ],
      }),
    }
  }

  async function runStep(
    messages: Parameters<typeof runAgentStream>[0]["messages"],
  ): Promise<{ error: unknown; maxOutputTokens: number | undefined; calls: number }> {
    let calls = 0
    let maxOutputTokens: number | undefined
    const model = new MockLanguageModelV4({
      doStream: async (opts) => {
        calls++
        maxOutputTokens = opts.maxOutputTokens
        return answer()
      },
    })
    const result = runAgentStream({
      model,
      stepTokenCap: demoVisitorModelInfo().stepTokenCap ?? null,
      system: "sys",
      messages,
      tools: {},
      stopWhen: stepCountIs(1),
    })
    let error: unknown = null
    try {
      for await (const part of result.fullStream) {
        if (part.type === "error") error = part.error
      }
    } catch (err) {
      error = err
    }
    return { error, maxOutputTokens, calls }
  }

  it("estimates a CJK paste at one token per character or more", () => {
    const cjk = "漢".repeat(90_000)
    expect(
      estimateVisitorRequestInputTokens({
        prompt: [{ role: "user", content: [{ type: "text", text: cjk }] }],
      }),
    ).toBeGreaterThanOrEqual(90_000)
  })

  it("refuses an image part in a visitor step before anything is sent", async () => {
    const ran = await runStep([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", image: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        ],
      },
    ])
    expect(ran.error).toBeInstanceOf(DemoMediaRefusedError)
    expect(ran.calls).toBe(0)
  })

  it("caps a step asking for more than 16,000 output tokens at 16,000", async () => {
    const ran = await runStep([{ role: "user", content: "hello" }])
    expect(ran.error).toBeNull()
    expect(ran.maxOutputTokens).toBe(16_000)
  })

  it("the pin is Auto, runs at low on the box key and cannot be switched off", () => {
    const pin = demoVisitorModelInfo()
    expect(pin.autoPicked).toBe(true)
    expect(pin.reasoningCaps).toEqual({
      reasoningEfforts: ["low", "high"],
      canDisableReasoning: false,
    })
    expect(pin.autoReasoningLevel).toBe("low")
    expect(
      resolveTurnReasoningLevel({
        capability: { allowedLevels: ["low", "high"], defaultLevel: "low" },
        requested: "high",
        autoPicked: pin.autoPicked === true,
        autoLevel: pin.autoReasoningLevel,
      }),
    ).toBe("low")
    // On the visitor's own key, Auto stays at its usual level.
    expect(demoVisitorModelInfo(false).autoReasoningLevel).toBeUndefined()
    // A step holds its 16,000 output tokens before it runs (demo-spend-ceiling.ts, ONE STEP),
    // and no input limit: the model's context window bounds a step's input.
    expect(pin.stepTokenCap).toEqual({ maxOutputTokens: 16_000, visitor: true })
    expect(pin.contextWindow).toBe(1_048_576)
    expect(visitorStepOutputMicroEur(16_000)).toBe(17_136)
    expect(visitorRequestInputMicroEur(97_000)).toBe(25_971)
  })

  // ── THE REQUEST GUARD ────────────────────────────────────────────────────
  it("refuses a box key request for any other model and prices every chat request", () => {
    DemoModeTestAccess.set(true)
    expect(() => assertBoxKeyRequest({ model: "anthropic/claude-opus-4" })).toThrow(
      BoxKeyRequestRefusedError,
    )
    const pin = assertBoxKeyRequest({
      model: VISITOR_MODEL_UPSTREAM_DEFAULT,
      max_tokens: 50_000,
      provider: { data_collection: "deny" },
    })
    expect(pin.provider).toEqual({
      data_collection: "deny",
      max_price: { prompt: 0.3, completion: 1.2 },
    })
    expect(pin.reasoning).toEqual({ effort: "low" })
    expect(pin.max_tokens).toBe(16_000)
    // Whatever reasoning the caller asked for, the guard sends effort low.
    const off = assertBoxKeyRequest({
      model: VISITOR_MODEL_UPSTREAM_DEFAULT,
      reasoning: { enabled: false },
    })
    expect(off.reasoning).toEqual({ effort: "low" })
    expect(off.max_tokens).toBe(16_000)
    const search = assertBoxKeyRequest({ model: OPENROUTER_WEB_SEARCH_MODEL })
    expect((search.provider as { max_price?: unknown }).max_price).toEqual({
      prompt: 0.25,
      completion: 1.5,
    })
  })

  it("runs every request the provider makes on the box key through the guard", async () => {
    DemoModeTestAccess.set(true)
    const bodies: unknown[] = []
    const stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        bodies.push(await req.json())
        return new Response("upstream should not be reached for the refused model", {
          status: 500,
        })
      },
    })
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${stub.port}/api/v1`
    try {
      const refused = createOpenRouterModel(BOX_KEY, "anthropic/claude-opus-4")
      let error: unknown = null
      try {
        await generateText({ model: refused, prompt: "hi", maxRetries: 0 })
      } catch (err) {
        error = err
      }
      expect(String(error)).toContain("may not be used for that model")
      expect(bodies).toEqual([])
      // The pin passes, priced; a visitor's OWN key is untouched.
      const pinned = createOpenRouterModel(BOX_KEY, VISITOR_MODEL_UPSTREAM_DEFAULT)
      await generateText({ model: pinned, prompt: "hi", maxRetries: 0 }).catch(() => undefined)
      const own = createOpenRouterModel("sk-or-visitor-own", "anthropic/claude-opus-4")
      await generateText({ model: own, prompt: "hi", maxRetries: 0 }).catch(() => undefined)
      const sent = bodies as Array<{ model: string; provider?: { max_price?: unknown } }>
      expect(sent.map((b) => b.model)).toEqual([
        VISITOR_MODEL_UPSTREAM_DEFAULT,
        "anthropic/claude-opus-4",
      ])
      expect(sent[0]?.provider?.max_price).toEqual({ prompt: 0.3, completion: 1.2 })
      expect(sent[1]?.provider?.max_price).toBeUndefined()
    } finally {
      stub.stop(true)
      process.env.OPENROUTER_BASE_URL = savedEnv.OPENROUTER_BASE_URL
      if (savedEnv.OPENROUTER_BASE_URL === undefined) delete process.env.OPENROUTER_BASE_URL
    }
  })

  // ── CALL SITES THAT ARE OFF ──────────────────────────────────────────────
  it("keeps embeddings off on the box's Google key, and on a visitor's own key it embeds", async () => {
    spendOn()
    verify(visitorOrg)
    invalidateOrgEmbedder(visitorOrg)
    expect(await resolveOrgEmbedder(visitorOrg)).toBeNull()
    await setByok(visitorOrg, "google", "visitor-google-key")
    invalidateOrgEmbedder(visitorOrg)
    expect(await resolveOrgEmbedder(visitorOrg)).not.toBeNull()
    invalidateOrgEmbedder(visitorOrg)
  })

  it("refuses visitor writes to the model settings, the OpenRouter add-model included", async () => {
    DemoModeTestAccess.set(true)
    const appFor = (orgId: string) =>
      new Hono<AppEnv>()
        .use("*", async (c, next) => {
          c.set("orgId", orgId)
          await next()
        })
        .route("/", aiModelsRoutes)
    for (const [method, path] of [
      ["POST", "/models/openrouter"],
      ["PATCH", "/models"],
      ["DELETE", "/models/openrouter/x"],
    ] as const) {
      const res = await appFor(visitorOrg).request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "DELETE" ? undefined : "{}",
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe("demo_models_locked")
    }
    // A normal org is not refused by the lock (it reaches the route's own validation).
    const normal = await appFor(normalOrg).request("/models", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bogus: true }),
    })
    expect(normal.status).not.toBe(403)
  })

  // ── WEB SEARCH ON THE BOX KEY ─────────────────────────────────────────────
  describe("web_search for a verified visitor", () => {
    let stub: ReturnType<typeof Bun.serve>
    const bodies: Array<Record<string, unknown>> = []
    const auths: string[] = []
    let savedExa: string | undefined
    beforeAll(async () => {
      const recorded = (
        await import("~/modules/agent/tools/__fixtures__/openrouter-web-search.json")
      ).default
      stub = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          bodies.push((await req.json()) as Record<string, unknown>)
          auths.push(req.headers.get("authorization") ?? "")
          return Response.json(recorded)
        },
      })
      savedExa = process.env.EXA_API_KEY
    })
    afterAll(() => {
      stub.stop(true)
      if (savedExa === undefined) delete process.env.EXA_API_KEY
      else process.env.EXA_API_KEY = savedExa
    })
    afterEach(() => {
      bodies.length = 0
      auths.length = 0
    })

    const search = async (query: string, numResults?: number) => {
      const { handleWebSearch } = await import("~/modules/agent/tools/web-tools")
      const { runContextStore } = await import("~/modules/agent/runtime/run-context")
      return runContextStore.run(
        { runId: "turn-a", parentRunId: null, rootRunId: "turn-a", nestingDepth: 0 },
        () =>
          handleWebSearch(
            { query, ...(numResults !== undefined ? { numResults } : {}) },
            { userId: "u", orgId: visitorOrg },
          ),
      )
    }

    it("searches on the box's OpenRouter key through a reservation, clamped, never on Exa", async () => {
      spendOn()
      const id = verify(visitorOrg)
      process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${stub.port}/api/v1`
      process.env.EXA_API_KEY = "box-exa-key-never-for-visitors"
      const result = await search("x".repeat(2_000), 20)
      if ("error" in result) throw new Error(result.error)
      expect(result.backend).toBe("openrouter")
      expect(auths).toEqual([`Bearer ${BOX_KEY}`])
      const body = bodies[0] as {
        model?: string
        plugins?: Array<Record<string, unknown>>
        messages?: Array<{ content: string }>
        provider?: { max_price?: unknown }
      }
      expect(body.model).toBe(OPENROUTER_WEB_SEARCH_MODEL)
      expect(body.plugins).toEqual([{ id: "web", engine: "exa", max_results: 3 }])
      // Each result is a snippet, never the whole cited page.
      for (const r of result.results) expect(r.snippet.length).toBeLessThan(1_000)
      expect(body.messages?.[0]?.content.length).toBe(500)
      expect(body.provider?.max_price).toEqual({ prompt: 0.25, completion: 1.5 })
      // Settled: the email's budget shows the search.
      expect((await snapshot(id)).usedMicroEur).toBeGreaterThan(0)
      expect(await demoKeys("r:*")).toEqual([])
    })

    /** An OpenRouter on its own port: closes without answering, answers 500, or never answers. */
    async function failingSearchUpstream(mode: "close" | "error" | "hang"): Promise<() => void> {
      const { createServer } = await import("node:net")
      const server = createServer((socket) => {
        socket.once("data", () => {
          if (mode === "close") setTimeout(() => socket.destroy(), 20)
          else if (mode === "error")
            socket.end(
              "HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
            )
        })
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`
      return () => {
        server.close()
      }
    }

    // The dictation rule: a search OpenRouter never answered cost nothing and is released; one
    // that may have run (a 5xx, our own timeout cutting it) settles at its worst case.
    it("releases a search whose connection closed before OpenRouter answered", async () => {
      spendOn()
      const id = verify(visitorOrg)
      const stop = await failingSearchUpstream("close")
      try {
        const result = await search("battery passport")
        expect("error" in result).toBe(true)
        expect((await snapshot(id)).usedMicroEur).toBe(0)
        expect(await demoKeys("r:*")).toEqual([])
      } finally {
        stop()
      }
    })

    it("bills a search our own timeout cut off, and one OpenRouter failed with a 5xx, at the worst case", async () => {
      spendOn()
      const id = verify(visitorOrg)
      const { OpenRouterWebSearchTestAccess } = await import(
        "~/modules/agent/tools/web-search-openrouter"
      )
      const { VISITOR_WEB_SEARCH_MICRO_EUR } = await import("~/modules/demo/demo-spend-ceiling")
      let stop = await failingSearchUpstream("hang")
      OpenRouterWebSearchTestAccess.timeoutMs = 300
      try {
        expect("error" in (await search("cut off"))).toBe(true)
        expect((await snapshot(id)).usedMicroEur).toBe(VISITOR_WEB_SEARCH_MICRO_EUR)
      } finally {
        OpenRouterWebSearchTestAccess.timeoutMs = null
        stop()
      }
      stop = await failingSearchUpstream("error")
      try {
        expect("error" in (await search("upstream down"))).toBe(true)
        expect((await snapshot(id)).usedMicroEur).toBe(2 * VISITOR_WEB_SEARCH_MICRO_EUR)
        expect(await demoKeys("r:*")).toEqual([])
      } finally {
        stop()
      }
    })

    it("allows 2 searches per turn and refuses the 3rd with nothing sent", async () => {
      spendOn()
      verify(visitorOrg)
      process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${stub.port}/api/v1`
      for (let i = 0; i < 2; i++) {
        const r = await search(`q${i}`)
        expect("results" in r).toBe(true)
      }
      const third = await search("q3")
      expect("error" in third).toBe(true)
      expect(bodies).toHaveLength(2)
    })

    it("sends nothing for an unverified visitor", async () => {
      spendOn()
      process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${stub.port}/api/v1`
      const { handleWebSearch } = await import("~/modules/agent/tools/web-tools")
      const r = await handleWebSearch({ query: "q" }, { userId: "u", orgId: unverifiedOrg })
      expect("error" in r).toBe(true)
      expect(bodies).toHaveLength(0)
    })
  })

  // ── A NORMAL ORG IS UNTOUCHED ────────────────────────────────────────────
  it("leaves a normal org's pre check without any demo budget state", async () => {
    spendOn()
    const turn = await preCheck(normalOrg, ANTHROPIC_MODEL, { turn: true })
    expect(turn.allowed && turn.model.modelId).toBe(ANTHROPIC_MODEL)
    expect(turn.allowed && turn.demo).toBeFalsy()
    expect(await demoKeys("*")).toEqual([])
  })
})
