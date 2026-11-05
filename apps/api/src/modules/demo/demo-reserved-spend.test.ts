// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The reserved App Review org spends the deployment's own keys, so everything
// it can spend is either pinned to one cheap model under the token ceiling, or
// refused. Asserted through the functions the product actually calls.
//
// ── THE MUTATIONS THAT PROVE THESE BITE ────────────────────────────────────
//  * Delete the `reservedDemoModelId` override from `resolveModelForPreCheck`:
//    "runs every turn on the pinned model" fails with the agent's own model.
//  * Change RESERVED_TOKENS_PER_EUR, the price, the rate or the comment alone:
//    "the ceiling agrees with its own derivation" fails.
//  * Delete the reserved check from `resolveOrgEmbedder`: the embedder comes
//    back non null on the box's Google key.
//  * Delete the reserved check from `handleAnalyzeMedia`: the refusal is gone
//    and the pre check spy is called.
//  * Delete the step cap from `resolveModelForPreCheck`: "caps a reserved
//    step" fails on the model's own 1,048,576 window and no cap.
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test"
import crypto from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { shouldCompact } from "~/modules/agent/context/compaction"
import { preCheck, resolveModelForPreCheck } from "~/modules/agent/credits/credit-meter"
import {
  defaultMediaAnalysisToolDeps,
  handleAnalyzeMedia,
} from "~/modules/agent/media/media-analysis-tool"
import type { AppContext } from "~/modules/apps/context"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, reservedMarker } from "~/modules/demo/demo-org"
import { ensureReservedSecondAdmin } from "~/modules/demo/demo-seeder"
import { reservedDemoModelId } from "~/modules/demo/demo-spend"
import {
  ECB_USD_PER_EUR,
  RESERVED_MODEL_CONTEXT_WINDOW,
  RESERVED_MODEL_DEFAULT,
  RESERVED_STEP_OUTPUT_TOKENS,
  RESERVED_STEPS_IN_FLIGHT,
  RESERVED_TOKEN_CEILING_DEFAULT,
  RESERVED_TOKENS_PER_EUR,
  RESERVED_WORST_INPUT_USD_PER_M,
  RESERVED_WORST_OUTPUT_USD_PER_M,
  WEB_SEARCH_TOKEN_EQUIVALENT,
} from "~/modules/demo/demo-spend-ceiling"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { invalidateOrgEmbedder, resolveOrgEmbedder } from "~/modules/search/message-indexer"
import { getThread } from "~/modules/threads/thread"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const AGENT_MODEL = "reserved-test-agent-model"

describe("the reserved App Review org's spend", () => {
  let reservedOrgId: string
  let normalOrgId: string

  beforeAll(async () => {
    await acquireTestLock()
    reservedOrgId = (await ensureOrg({ slug: "reserved-spend", name: "Reserved Spend" })).orgId
    normalOrgId = (await ensureOrg({ slug: "reserved-spend-normal", name: "Normal" })).orgId
    await markOrgAsDemo(reservedOrgId, reservedMarker())
    // An agent preference on another vendor, and the pinned id, both in the
    // catalog exactly as the seed puts the pinned one there.
    await sql`
      INSERT INTO kernel.model_pricing
        (model_id, provider, display_name, input_cost_per_m, output_cost_per_m,
         context_window, tier_minimum, auto_eligible)
      VALUES (${AGENT_MODEL}, 'anthropic', 'Agent Pref', '3', '15', 200000, 'starter', false)
      ON CONFLICT DO NOTHING`
    await sql`
      INSERT INTO kernel.model_pricing
        (model_id, provider, display_name, input_cost_per_m, output_cost_per_m,
         context_window, tier_minimum, auto_eligible)
      VALUES (${RESERVED_MODEL_DEFAULT}, 'google', 'Gemini Flash-Lite', '0.09', '0.35',
              1048576, 'starter', true)
      ON CONFLICT DO NOTHING`
    // The deployment's Anthropic and Google keys are the test preload's
    // placeholders (src/tests/test-env-defaults.ts).
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  afterEach(async () => {
    invalidateDemoMarker()
    invalidateOrgEmbedder(reservedOrgId)
    invalidateOrgEmbedder(normalOrgId)
    await clearRedisPatterns(["demo:*"])
  })

  // ── ONE MODEL ────────────────────────────────────────────────────────────
  describe("one pinned model", () => {
    it("runs every turn on the pinned model, whatever the agent or thread asked for", async () => {
      DemoModeTestAccess.set(true)
      // The turn runner hands `preCheck` the thread's model, else the agent's
      // `modelPreference`, and then runs on `creditCheck.model`.
      const turn = await preCheck(reservedOrgId, AGENT_MODEL)
      expect(turn.allowed).toBe(true)
      if (!turn.allowed) return
      expect(turn.model.modelId).toBe(RESERVED_MODEL_DEFAULT)
      expect(turn.model.provider).toBe("google")
      // Auto mode is pinned too, and so is the compaction lookup.
      const auto = await preCheck(reservedOrgId, null)
      expect(auto.allowed && auto.model.modelId).toBe(RESERVED_MODEL_DEFAULT)
      const compaction = await resolveModelForPreCheck(reservedOrgId, AGENT_MODEL)
      expect("model" in compaction && compaction.model.modelId).toBe(RESERVED_MODEL_DEFAULT)
    })

    it("pins to the env's model when the operator names one", async () => {
      DemoModeTestAccess.set(true)
      const saved = env.LIAISON_DEMO_RESERVED_MODEL
      ;(env as { LIAISON_DEMO_RESERVED_MODEL: string }).LIAISON_DEMO_RESERVED_MODEL = AGENT_MODEL
      try {
        expect(await reservedDemoModelId(reservedOrgId)).toBe(AGENT_MODEL)
      } finally {
        ;(env as { LIAISON_DEMO_RESERVED_MODEL: string }).LIAISON_DEMO_RESERVED_MODEL = saved
      }
    })

    it("leaves a normal org, and a box that is not a demo, on the model it asked for", async () => {
      DemoModeTestAccess.set(true)
      const normal = await preCheck(normalOrgId, AGENT_MODEL)
      expect(normal.allowed && normal.model.modelId).toBe(AGENT_MODEL)
      DemoModeTestAccess.set(false)
      invalidateDemoMarker()
      const off = await preCheck(reservedOrgId, AGENT_MODEL)
      expect(off.allowed && off.model.modelId).toBe(AGENT_MODEL)
      expect(await reservedDemoModelId(reservedOrgId)).toBeNull()
    })

    // Walk 2026-10-12: the composer chip said "Default (Claude Haiku 4.5)" on
    // demo while every turn ran on the pinned Gemini Flash-Lite. The thread read
    // model's agentDefaultModelId is what the chip resolves "Default" against.
    it("tells the composer the pinned model is the agent's default", async () => {
      const [user] = await sql<{ id: string }[]>`
        INSERT INTO kernel.users (org_id, email, password_hash, name, status)
        VALUES (${reservedOrgId}, ${`chip-${crypto.randomUUID()}@t.co`}, 'x', 'Chip', 'active')
        RETURNING id`
      const [agent] = await sql<{ id: string }[]>`
        INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, system_prompt, model_preference)
        VALUES (${reservedOrgId}, 'role', ${`@chip-${crypto.randomUUID().slice(0, 8)}`}, 'Chip', '{}', '', ${AGENT_MODEL})
        RETURNING id`
      const [thread] = await sql<{ id: string }[]>`
        INSERT INTO kernel.threads (org_id, handle, created_by)
        VALUES (${reservedOrgId}, ${`chip-${crypto.randomUUID()}`}, ${user.id})
        RETURNING id`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, participant_type)
        VALUES (${thread.id}, ${user.id}, ${reservedOrgId}, 'user')`
      await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
        VALUES (${thread.id}, ${agent.id}, ${reservedOrgId}, 'agent')`
      const read = () =>
        withRlsContext(
          {
            actorType: "user",
            userId: user.id,
            orgId: reservedOrgId,
            scopes: ["*"],
            dimensionGrants: {},
          },
          (tx) => getThread(tx, { orgId: reservedOrgId, userId: user.id, threadId: thread.id }),
        )
      DemoModeTestAccess.set(true)
      expect((await read())?.agentDefaultModelId).toBe(RESERVED_MODEL_DEFAULT)
      DemoModeTestAccess.set(false)
      invalidateDemoMarker()
      expect((await read())?.agentDefaultModelId).toBe(AGENT_MODEL)
    })
  })

  // ── ONE EURO ─────────────────────────────────────────────────────────────
  describe("the ceiling", () => {
    it("agrees with its own derivation, and the comment's numbers agree with both", () => {
      const derived = Math.floor(ECB_USD_PER_EUR / (RESERVED_WORST_OUTPUT_USD_PER_M / 1_000_000))
      expect(RESERVED_TOKENS_PER_EUR).toBe(derived)
      expect(RESERVED_TOKEN_CEILING_DEFAULT).toBeLessThanOrEqual(derived)
      // The env default IS that constant (asserted on the schema's default,
      // not on whatever this process's environment happens to set).
      const envSource = readFileSync(path.resolve(import.meta.dir, "../../lib/env.ts"), "utf8")
      expect(envSource).toMatch(
        // The first `.default(` after the key, inside the empty-string preprocess
        // bfb12da7f wrapped it in (its arrow function has commas).
        /LIAISON_DEMO_RESERVED_TOKEN_CEILING:[\s\S]{0,300}?\.default\(RESERVED_TOKEN_CEILING_DEFAULT\)/,
      )

      const comment = readFileSync(path.resolve(import.meta.dir, "demo-spend-ceiling.ts"), "utf8")
      const num = (s: string) => Number(s.replace(/,/g, ""))
      const rate = comment.match(/1 EUR = ([\d.]+) USD/)
      expect(rate && Number(rate[1])).toBe(ECB_USD_PER_EUR)
      const price = comment.match(/gemini-3\.5-flash-lite\s+([\d.]+) USD\s+<- the most expensive/)
      expect(price && Number(price[1])).toBe(RESERVED_WORST_OUTPUT_USD_PER_M)
      const result = comment.match(/= ([\d,]+) tokens\n/)
      expect(result && num(result[1])).toBe(RESERVED_TOKENS_PER_EUR)
      const dflt = comment.match(/The default ceiling is ([\d,]+) tokens, well under ([\d,]+)\./)
      expect(dflt && num(dflt[1])).toBe(RESERVED_TOKEN_CEILING_DEFAULT)
      expect(dflt && num(dflt[2])).toBe(RESERVED_TOKENS_PER_EUR)
      // The overshoot: two steps in flight, each bounded by the model's context
      // window, each direction at its own worst price.
      expect(RESERVED_STEPS_IN_FLIGHT).toBe(2)
      const stepUsd =
        (RESERVED_MODEL_CONTEXT_WINDOW * RESERVED_WORST_INPUT_USD_PER_M +
          RESERVED_STEP_OUTPUT_TOKENS * RESERVED_WORST_OUTPUT_USD_PER_M) /
        1_000_000
      const ceilingUsd =
        (RESERVED_TOKEN_CEILING_DEFAULT * RESERVED_WORST_OUTPUT_USD_PER_M) / 1_000_000
      const worstUsd = ceilingUsd + RESERVED_STEPS_IN_FLIGHT * stepUsd
      const step = comment.match(
        /one step\s+([\d,]+) x ([\d.]+) \+ ([\d,]+) x ([\d.]+) = [\d.]+ \+ [\d.]+ = ([\d.]+) USD/,
      )
      expect(step && [num(step[1]), Number(step[2]), num(step[3]), Number(step[4])]).toEqual([
        RESERVED_MODEL_CONTEXT_WINDOW,
        RESERVED_WORST_INPUT_USD_PER_M,
        RESERVED_STEP_OUTPUT_TOKENS,
        RESERVED_WORST_OUTPUT_USD_PER_M,
      ])
      expect(step && Number(step[5])).toBeCloseTo(stepUsd, 6)
      const day = comment.match(/worst day [\d.]+ \+ 2 x [\d.]+ = ([\d.]+) USD = ([\d.]+) EUR/)
      expect(day && Number(day[1])).toBeCloseTo(worstUsd, 6)
      expect(day && Number(day[2])).toBeCloseTo(worstUsd / ECB_USD_PER_EUR, 4)
      // The step's output limit, as enforced.
      const stepOut = comment.match(/output at most ([\d,]+) tokens\./)
      expect(stepOut && num(stepOut[1])).toBe(RESERVED_STEP_OUTPUT_TOKENS)

      const search = comment.match(/= ([\d,]+) tokens, rounded up to ([\d,]+)\./)
      expect(search && num(search[2])).toBe(WEB_SEARCH_TOKEN_EQUIVALENT)
      expect(search && num(search[1])).toBeLessThanOrEqual(WEB_SEARCH_TOKEN_EQUIVALENT)
    })

    it("caps a reserved step's output only; its window is the model's; a normal org is untouched", async () => {
      DemoModeTestAccess.set(true)
      const [row] = await sql`
        SELECT context_window FROM kernel.model_pricing WHERE model_id = ${RESERVED_MODEL_DEFAULT}`
      const modelWindow = Number(row?.context_window)
      expect(modelWindow).toBe(RESERVED_MODEL_CONTEXT_WINDOW)
      // 110,000 tokens of context: far under 80 percent of the model's window.
      const context = 110_000

      const reserved = await preCheck(reservedOrgId, AGENT_MODEL)
      expect(reserved.allowed).toBe(true)
      if (!reserved.allowed) return
      expect(reserved.model.contextWindow).toBe(modelWindow)
      expect(reserved.model.stepTokenCap).toEqual({ maxOutputTokens: RESERVED_STEP_OUTPUT_TOKENS })
      expect(shouldCompact(context, reserved.model.contextWindow)).toBe(false)

      const normal = await preCheck(normalOrgId, RESERVED_MODEL_DEFAULT)
      expect(normal.allowed).toBe(true)
      if (!normal.allowed) return
      expect(normal.model.contextWindow).toBe(modelWindow)
      expect(normal.model.stepTokenCap).toBeUndefined()
      expect(shouldCompact(context, normal.model.contextWindow)).toBe(false)
    })

    it("is denominated over a rolling day", async () => {
      // The window lives in demo-spend.ts; a row 25 hours old no longer counts.
      DemoModeTestAccess.set(true)
      const { demoOrgTokensUsed } = await import("~/modules/demo/demo-spend")
      await sql`
        INSERT INTO kernel.credit_transactions
          (org_id, type, amount, balance_after, model, input_tokens, output_tokens, raw_cost, created_at)
        VALUES (${reservedOrgId}, 'byok_usage', '-1', '0', 'm', 1000, 0, '1',
                now() - make_interval(hours => 25)),
               (${reservedOrgId}, 'byok_usage', '-1', '0', 'm', 7, 0, '1',
                now() - make_interval(hours => 23))`
      try {
        expect(await demoOrgTokensUsed(reservedOrgId)).toBe(7)
      } finally {
        await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${reservedOrgId}`
      }
    })
  })

  // ── PAID WORK OUTSIDE A TURN ─────────────────────────────────────────────
  describe("paid work outside an agent turn", () => {
    it("refuses embeddings: no embedder on the box's Google key", async () => {
      DemoModeTestAccess.set(true)
      expect(await resolveOrgEmbedder(reservedOrgId)).toBeNull()
      // The same box still embeds for an org that is not the reserved one.
      expect(await resolveOrgEmbedder(normalOrgId)).not.toBeNull()
    })

    it("refuses analyze_media before a pre check or a byte is read", async () => {
      DemoModeTestAccess.set(true)
      const preCheckSpy = mock(defaultMediaAnalysisToolDeps.preCheck)
      const headSpy = mock(defaultMediaAnalysisToolDeps.headObject)
      const ctx = {
        orgId: reservedOrgId,
        userId: crypto.randomUUID(),
        db: {
          execute: async () => {
            throw new Error("analyze_media read a file for the reserved org")
          },
        },
      } as unknown as AppContext
      const result = await handleAnalyzeMedia({ fileId: crypto.randomUUID() }, ctx, {
        ...defaultMediaAnalysisToolDeps,
        preCheck: preCheckSpy,
        headObject: headSpy,
      })
      expect("error" in result && result.error.code).toBe("demo_reserved")
      expect(preCheckSpy).not.toHaveBeenCalled()
      expect(headSpy).not.toHaveBeenCalled()
    })

    it("counts nothing and takes no reservation off a demo box", async () => {
      DemoModeTestAccess.set(false)
      invalidateDemoMarker()
      await preCheck(reservedOrgId, AGENT_MODEL)
      expect(await redis.get(`demo:spend-reserve:${reservedOrgId}`)).toBeNull()
    })
  })

  // ── THE REVIEWER IS NOT THE LAST ADMIN ───────────────────────────────────
  describe("a second admin", () => {
    async function activeAdmins(orgId: string): Promise<string[]> {
      const rows = await sql`
        SELECT u.email FROM kernel.users u
        JOIN kernel.user_roles ur ON ur.user_id = u.id
        JOIN kernel.roles r ON r.id = ur.role_id
        WHERE u.org_id = ${orgId} AND r.name = 'admin' AND u.status = 'active'
        ORDER BY u.email`
      return rows.map((r) => String(r.email))
    }

    it("gives the reserved org an active admin besides App Review, once", async () => {
      const orgId = (await ensureOrg({ slug: `reserved-admins-${Date.now()}`, name: "Admins" }))
        .orgId
      // `ensureOrg` creates the default roles, `admin` among them.
      const [role] = await sql`
        SELECT id FROM kernel.roles WHERE org_id = ${orgId} AND name = 'admin'`
      const reviewer = crypto.randomUUID()
      const founder = crypto.randomUUID()
      const gone = crypto.randomUUID()
      await sql`
        INSERT INTO kernel.users (id, org_id, email, name, password_hash, status, created_at)
        VALUES (${reviewer}, ${orgId}, 'appreview@demo.liaison.sh', 'App Review', 'x', 'active', now() - interval '3 hours'),
               (${gone}, ${orgId}, 'gone@resonant.example', 'Gone', NULL, 'deactivated', now() - interval '2 hours'),
               (${founder}, ${orgId}, 'founder@resonant.example', 'Founder', NULL, 'active', now() - interval '1 hour')`
      await sql`
        INSERT INTO kernel.user_roles (user_id, role_id, org_id)
        VALUES (${reviewer}, ${role.id}, ${orgId}), (${gone}, ${role.id}, ${orgId})`
      expect(await activeAdmins(orgId)).toEqual(["appreview@demo.liaison.sh"])

      await ensureReservedSecondAdmin(orgId)
      expect(await activeAdmins(orgId)).toEqual([
        "appreview@demo.liaison.sh",
        "founder@resonant.example",
      ])
      // Idempotent: a second seed adds nobody.
      await ensureReservedSecondAdmin(orgId)
      expect((await activeAdmins(orgId)).length).toBe(2)
    })
  })
})
