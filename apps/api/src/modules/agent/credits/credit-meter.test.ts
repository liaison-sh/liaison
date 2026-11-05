// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { _setEdition } from "~/lib/edition"
import { byokEncryptionKey } from "~/lib/env"
import { redis } from "~/lib/redis"
import {
  checkMidStep,
  finalizeUsage,
  listAvailableModels,
  NO_AUTO_MODEL_FOR_KEYS,
  preCheck,
  resolveKey,
  selectAutoModelForOrg,
} from "~/modules/agent/credits/credit-meter"
import * as creditService from "~/modules/agent/credits/credit-service"
import { sideCallUsage } from "~/modules/agent/providers/side-call-model"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-000000cc0001"
const USER_ID = "00000000-0000-0000-0000-000000cc0002"
const BYOK_ORG_ID = "00000000-0000-0000-0000-000000cc0003"

// Encrypt fixtures with the live `byokEncryptionKey` so the test stays correct
// regardless of which .env file the test runner happened to load. The shape we
// want to assert is "encrypted blob round-trips through resolveKey" — pinning
// the key value would make this a tautology about env loading, not behaviour.
const TEST_BYOK_ENCRYPTION_KEY = byokEncryptionKey

describe("credit-meter", () => {
  beforeAll(async () => {
    await acquireTestLock()
    // This suite asserts the metered/billed behaviour — exercise it as a
    // managed instance. The self-hosted (no-credits) path has its own block.
    _setEdition("managed")

    // Encrypt BYOK key the same way ai-keys-routes does in production
    const encryptedByok = encryptSecret(
      "sk-byok-test",
      TEST_BYOK_ENCRYPTION_KEY,
      CryptoContext.byokApiKey,
    )
    const byokSettings = JSON.stringify({
      fileSizeLimitMb: 50,
      storageQuotaGb: 10,
      auditRetentionDays: 90,
      rateLimitPerMinute: 100,
      providerKeys: {
        anthropic: {
          encrypted: encryptedByok,
          maskedHint: "k-test",
          validatedAt: "2026-04-08T00:00:00.000Z",
        },
      },
    })

    // Seed org, user, credit balance, and model pricing
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'MeterOrg', 'meter-org')`
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${BYOK_ORG_ID}, 'ByokOrg', 'byok-org', ${byokSettings}::jsonb)`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'meter@test.com', 'Meter User')`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '5.00000000', '3.00000000', 'EUR')`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${BYOK_ORG_ID}, '0.00000000', '0.00000000', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum) VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00000000', '5.00000000', 200000, true, 'starter')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum) VALUES ('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', '3.00000000', '15.00000000', 200000, false, 'starter')`
    // team-tier model used to test tier gating
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum) VALUES ('anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', '4.35000000', '21.74000000', 1000000, false, 'team')`
  })

  afterAll(async () => {
    _setEdition(null)
    await releaseTestLock()
  })

  describe("resolveKey", () => {
    it("returns BYOK key when org has provider key in settings (encrypted format)", async () => {
      const result = await resolveKey(BYOK_ORG_ID, "anthropic")
      expect(result.source).toBe("byok")
      // Key is decrypted from the encrypted fixture — original plaintext "sk-byok-test"
      expect(result.key).toBe("sk-byok-test")
    })

    it("returns Liaison env key when no BYOK key", async () => {
      const origKey = process.env.LIAISON_ANTHROPIC_API_KEY
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-liaison-test"
      try {
        const result = await resolveKey(ORG_ID, "anthropic")
        expect(result.source).toBe("liaison")
        expect(result.key).toBe("sk-liaison-test")
      } finally {
        if (origKey !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = origKey
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })

    it("throws when no key available for provider", async () => {
      const origKey = process.env.MISTRAL_API_KEY
      delete process.env.MISTRAL_API_KEY
      try {
        await expect(resolveKey(ORG_ID, "mistral")).rejects.toThrow()
      } finally {
        if (origKey !== undefined) process.env.MISTRAL_API_KEY = origKey
      }
    })
  })

  describe("listAvailableModels", () => {
    // Control every provider env key so availability is decided only by the
    // explicit fixtures (BYOK on BYOK_ORG, env toggled per assertion).
    const PROVIDER_ENV = [
      "LIAISON_ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "MISTRAL_API_KEY",
      // An instance OpenRouter key would make Auto provision OpenRouter's
      // default for a key-less org (openrouter-default.ts): not a fixture here.
      "OPENROUTER_API_KEY",
    ]
    let saved: Record<string, string | undefined>
    beforeAll(() => {
      saved = Object.fromEntries(PROVIDER_ENV.map((k) => [k, process.env[k]]))
      for (const k of PROVIDER_ENV) delete process.env[k]
    })
    afterAll(() => {
      for (const k of PROVIDER_ENV) {
        if (saved[k] !== undefined) process.env[k] = saved[k]
        else delete process.env[k]
      }
    })

    it("returns the catalog models for a BYOK-configured provider", async () => {
      const models = await listAvailableModels(BYOK_ORG_ID)
      // BYOK_ORG has an anthropic key; the only seeded models are anthropic.
      expect(models.length).toBeGreaterThanOrEqual(3)
      expect(models.every((m) => m.provider === "anthropic")).toBe(true)
      expect(models.map((m) => m.modelId)).toContain("claude-haiku-4-5")
    })

    it("returns nothing for an org with no key for any catalogued provider", async () => {
      const models = await listAvailableModels(ORG_ID)
      expect(models).toHaveLength(0)
    })

    it("auto mode never picks a model that is not auto-eligible, even for the org's only provider", async () => {
      await sql`UPDATE kernel.model_pricing SET auto_eligible = false WHERE model_id = 'claude-haiku-4-5'`
      await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum) VALUES ('google', 'auto-usable-test-google', 'Cheapest Google', '0.00000001', '0.00000001', 100000, true, 'starter')`
      try {
        // The org's key is Anthropic and no Anthropic model is auto-eligible:
        // Auto picks nothing, neither the non-eligible Haiku nor the cheaper
        // Google model it has no key for, and the turn says why.
        expect(await selectAutoModelForOrg(BYOK_ORG_ID, "t")).toBeNull()
        const turn = await preCheck(BYOK_ORG_ID, null, { turn: true })
        expect(turn.allowed).toBe(false)
        if (turn.allowed) return
        expect(turn.reason).toBe(NO_AUTO_MODEL_FOR_KEYS)
      } finally {
        await sql`UPDATE kernel.model_pricing SET auto_eligible = true WHERE model_id = 'claude-haiku-4-5'`
        await sql`DELETE FROM kernel.model_pricing WHERE model_id = 'auto-usable-test-google'`
      }
    })

    it("auto mode skips a cheaper model whose provider the org has no key for", async () => {
      // The org brought only an Anthropic key; a cheaper auto-eligible Google
      // model must not be picked, or every auto turn fails for want of a key.
      await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum) VALUES ('google', 'auto-usable-test-google', 'Cheapest Google', '0.00000001', '0.00000001', 100000, true, 'starter')`
      try {
        expect(await selectAutoModelForOrg(BYOK_ORG_ID, "t")).toEqual({
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
        })
        const result = await preCheck(BYOK_ORG_ID)
        expect(result.allowed).toBe(true)
        if (!result.allowed) throw new Error("expected allowed result")
        expect(result.model.provider).toBe("anthropic")
      } finally {
        await sql`DELETE FROM kernel.model_pricing WHERE model_id = 'auto-usable-test-google'`
      }
    })

    it("includes a provider once its managed env key is set", async () => {
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-liaison-test"
      try {
        const models = await listAvailableModels(ORG_ID)
        expect(models.map((m) => m.modelId)).toContain("claude-sonnet-4-6")
      } finally {
        delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })
  })

  describe("preCheck", () => {
    it("returns allowed with auto model when modelId omitted", async () => {
      const origKey = process.env.LIAISON_ANTHROPIC_API_KEY
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-liaison-test"
      try {
        const result = await preCheck(ORG_ID)
        expect(result.allowed).toBe(true)
        if (!result.allowed) throw new Error("expected allowed result")
        expect(result.model.modelId).toBe("claude-haiku-4-5")
        expect(result.keySource).toBe("liaison")
      } finally {
        if (origKey !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = origKey
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })

    it("accepts null modelId as Auto mode", async () => {
      const origKey = process.env.LIAISON_ANTHROPIC_API_KEY
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-liaison-test"
      try {
        const result = await preCheck(ORG_ID, null)
        expect(result.allowed).toBe(true)
        if (!result.allowed) throw new Error("expected allowed result")
        expect(result.model.modelId).toBe("claude-haiku-4-5")
      } finally {
        if (origKey !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = origKey
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })

    it("returns allowed with explicit model", async () => {
      const origKey = process.env.LIAISON_ANTHROPIC_API_KEY
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-liaison-test"
      try {
        const result = await preCheck(ORG_ID, "claude-sonnet-4-6")
        expect(result.allowed).toBe(true)
        if (!result.allowed) throw new Error("expected allowed result")
        expect(result.model.modelId).toBe("claude-sonnet-4-6")
      } finally {
        if (origKey !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = origKey
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })

    it("returns status:400 for unknown model (not 402)", async () => {
      const result = await preCheck(ORG_ID, "nonexistent-model")
      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.status).toBe(400)
        expect(result.persistSystemMessage).toBe(false)
        expect(result.reason).toContain("not available")
      }
    })

    it("returns status:402 with persistSystemMessage for zero balance", async () => {
      const zeroOrg = "00000000-0000-0000-0000-000000cc0005"
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${zeroOrg}, 'ZeroOrg', 'zero-org') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${zeroOrg}, '0.00000000', '0.00000000', 'EUR') ON CONFLICT DO NOTHING`
      const origKey = process.env.LIAISON_ANTHROPIC_API_KEY
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-liaison-test"
      try {
        const result = await preCheck(zeroOrg)
        expect(result.allowed).toBe(false)
        if (!result.allowed) {
          expect(result.status).toBe(402)
          expect(result.persistSystemMessage).toBe(true)
          expect(result.reason).toContain("Out of agent usage")
        }
      } finally {
        if (origKey !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = origKey
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })

    it("returns allowed with BYOK even when balance is zero", async () => {
      // BYOK orgs bypass all balance checks regardless of key source
      const result = await preCheck(BYOK_ORG_ID)
      expect(result.allowed).toBe(true)
      if (!result.allowed) throw new Error("expected allowed result")
      expect(result.keySource).toBe("byok")
    })

    it("returns status:400 when model tier_minimum exceeds org tier and no purchased balance", async () => {
      // claude-opus-4-6 has tier_minimum: 'team'; starter org with no purchased balance is blocked
      const incOnlyOrg = "00000000-0000-0000-0000-000000cc0004"
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${incOnlyOrg}, 'IncOnlyOrg', 'inc-only-org') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${incOnlyOrg}, '5.00000000', '0.00000000', 'EUR') ON CONFLICT DO NOTHING`
      const origKey = process.env.LIAISON_ANTHROPIC_API_KEY
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-liaison-test"
      try {
        const result = await preCheck(incOnlyOrg, "claude-opus-4-6")
        expect(result.allowed).toBe(false)
        if (!result.allowed) {
          expect(result.status).toBe(400)
          expect(result.persistSystemMessage).toBe(false)
          // Reason explains the tier gate and how to unlock
          expect(result.reason).toContain("purchased usage")
        }
      } finally {
        if (origKey !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = origKey
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })

    it("blocks when total balance is zero and not BYOK", async () => {
      const zeroOrg = "00000000-0000-0000-0000-000000cc0005"
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${zeroOrg}, 'ZeroOrg', 'zero-org') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${zeroOrg}, '0.00000000', '0.00000000', 'EUR') ON CONFLICT DO NOTHING`
      const origKey = process.env.LIAISON_ANTHROPIC_API_KEY
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-liaison-test"
      try {
        const result = await preCheck(zeroOrg)
        expect(result.allowed).toBe(false)
        if (!result.allowed) {
          expect(result.reason).toContain("Out of agent usage")
        }
      } finally {
        if (origKey !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = origKey
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })
  })

  describe("checkMidStep", () => {
    it("returns not exhausted for BYOK", async () => {
      const result = await checkMidStep(BYOK_ORG_ID, "byok")
      expect(result.exhausted).toBe(false)
    })

    it("returns not exhausted when balance is positive", async () => {
      const result = await checkMidStep(ORG_ID, "liaison")
      expect(result.exhausted).toBe(false)
    })

    it("returns exhausted when balance is zero", async () => {
      const zeroOrg = "00000000-0000-0000-0000-000000cc0005"
      const result = await checkMidStep(zeroOrg, "liaison")
      expect(result.exhausted).toBe(true)
    })
  })

  describe("finalizeUsage", () => {
    it("computes cost as rawCost * 1.20 and deducts credits", async () => {
      const result = await finalizeUsage(ORG_ID, {
        model: {
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
          inputCostPerM: "1.00000000",
          outputCostPerM: "5.00000000",
        },
        inputTokens: 1000,
        outputTokens: 500,
        keySource: "liaison",
        userId: USER_ID,
      })
      // rawCost = (1000 * 1 / 1_000_000) + (500 * 5 / 1_000_000) = 0.001 + 0.0025 = 0.0035
      // creditCost = 0.0035 * 1.20 = 0.0042
      const cost = Number.parseFloat(result.creditCost)
      expect(cost).toBeCloseTo(0.0042, 4)
    })

    it("returns creditCost '0' for BYOK without deducting balance", async () => {
      const result = await finalizeUsage(BYOK_ORG_ID, {
        model: {
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
          inputCostPerM: "1.00000000",
          outputCostPerM: "5.00000000",
        },
        inputTokens: 1000,
        outputTokens: 500,
        keySource: "byok",
        userId: USER_ID,
      })
      expect(result.creditCost).toBe("0")
    })

    it("durably persists BYOK audit event via transactional outbox", async () => {
      const byokUserId = "00000000-0000-0000-0000-000000cc0008"
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${byokUserId}, ${BYOK_ORG_ID}, 'byok-user@test.com', 'BYOK User') ON CONFLICT DO NOTHING`

      // Count pending_events before
      const before =
        await sql`SELECT COUNT(*) AS n FROM kernel.pending_events WHERE payload->>'orgId' = ${BYOK_ORG_ID}`
      const beforeCount = Number(before[0].n)

      await finalizeUsage(BYOK_ORG_ID, {
        model: {
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
          inputCostPerM: "1.00000000",
          outputCostPerM: "5.00000000",
        },
        inputTokens: 500,
        outputTokens: 200,
        keySource: "byok",
        userId: byokUserId,
      })

      // An outbox event must have been inserted (durable audit, not ephemeral)
      const after =
        await sql`SELECT COUNT(*) AS n FROM kernel.pending_events WHERE payload->>'orgId' = ${BYOK_ORG_ID}`
      const afterCount = Number(after[0].n)
      expect(afterCount).toBeGreaterThan(beforeCount)

      // Verify the event content
      const evt =
        await sql`SELECT payload FROM kernel.pending_events WHERE payload->>'orgId' = ${BYOK_ORG_ID} ORDER BY created_at DESC LIMIT 1`
      const payload = evt[0].payload as any
      expect(payload.entity).toBe("credit")
      expect(payload.action).toBe("usage")
      expect(payload.data.byok).toBe(true)
    })

    it("writes credit_transactions row with correct fields for Liaison usage", async () => {
      await finalizeUsage(ORG_ID, {
        model: {
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
          inputCostPerM: "1.00000000",
          outputCostPerM: "5.00000000",
        },
        inputTokens: 2000,
        outputTokens: 1000,
        keySource: "liaison",
        userId: USER_ID,
      })

      const txns =
        await sql`SELECT * FROM kernel.credit_transactions WHERE org_id = ${ORG_ID} ORDER BY created_at DESC LIMIT 1`
      expect(txns.length).toBe(1)
      expect(txns[0].model).toBe("claude-haiku-4-5")
      expect(txns[0].input_tokens).toBe(2000)
      expect(txns[0].output_tokens).toBe(1000)
      expect(txns[0].type).toBe("usage")
    })

    it("writes a non-deducting byok_usage credit_transactions row for BYOK usage", async () => {
      const byokTxnUserId = "00000000-0000-0000-0000-000000cc0009"
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${byokTxnUserId}, ${BYOK_ORG_ID}, 'byok-txn@test.com', 'BYOK Txn User') ON CONFLICT DO NOTHING`

      const before =
        await sql`SELECT COUNT(*) AS n FROM kernel.credit_transactions WHERE org_id = ${BYOK_ORG_ID}`
      const beforeCount = Number(before[0].n)

      const result = await finalizeUsage(BYOK_ORG_ID, {
        model: {
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
          inputCostPerM: "1.00000000",
          outputCostPerM: "5.00000000",
        },
        inputTokens: 1000,
        outputTokens: 500,
        keySource: "byok",
        userId: byokTxnUserId,
      })

      // BYOK still reports zero credit cost (no balance deduction)
      expect(result.creditCost).toBe("0")

      const txns =
        await sql`SELECT * FROM kernel.credit_transactions WHERE org_id = ${BYOK_ORG_ID} ORDER BY created_at DESC LIMIT 1`
      const after =
        await sql`SELECT COUNT(*) AS n FROM kernel.credit_transactions WHERE org_id = ${BYOK_ORG_ID}`
      expect(Number(after[0].n)).toBe(beforeCount + 1)

      const row = txns[0]
      expect(row.type).toBe("byok_usage")
      expect(row.model).toBe("claude-haiku-4-5")
      expect(row.input_tokens).toBe(1000)
      expect(row.output_tokens).toBe(500)
      // rawCost = 1000/1e6*1 + 500/1e6*5 = 0.001 + 0.0025 = 0.0035 — no Liaison margin
      expect(Number(row.raw_cost)).toBeCloseTo(0.0035, 8)
      // amount is the cost, stored negative for consistency with `usage` rows
      expect(Number(row.amount)).toBeCloseTo(-0.0035, 8)
      expect(row.user_id).toBe(byokTxnUserId)
    })

    it("records a system actor (user_id null) for non-uuid usage instead of throwing on the uuid cast", async () => {
      // Regression: the ticket summarizer (and scheduled jobs) attribute usage
      // to the sentinel "system". Inserting that string into the uuid user_id
      // column threw "invalid input syntax for type uuid", which on a
      // self-hosted / BYOK org aborted the whole job — ticket summaries were
      // left stuck on 'generating' because the post-usage status update never
      // ran. The actor must coerce to null (a system actor) and the row insert.
      const before =
        await sql`SELECT COUNT(*) AS n FROM kernel.credit_transactions WHERE org_id = ${BYOK_ORG_ID}`
      const beforeCount = Number(before[0].n)

      const result = await finalizeUsage(BYOK_ORG_ID, {
        model: {
          provider: "google",
          modelId: "gemini-flash-lite-latest",
          inputCostPerM: "0.10000000",
          outputCostPerM: "0.40000000",
        },
        inputTokens: 293,
        outputTokens: 22,
        keySource: "byok",
        userId: "system",
      })

      expect(result.creditCost).toBe("0")
      const after =
        await sql`SELECT COUNT(*) AS n FROM kernel.credit_transactions WHERE org_id = ${BYOK_ORG_ID}`
      expect(Number(after[0].n)).toBe(beforeCount + 1)
      const txns =
        await sql`SELECT * FROM kernel.credit_transactions WHERE org_id = ${BYOK_ORG_ID} ORDER BY created_at DESC LIMIT 1`
      expect(txns[0].type).toBe("byok_usage")
      expect(txns[0].user_id).toBeNull()
    })

    it("does not change the credit balance for BYOK usage", async () => {
      const balBefore =
        await sql`SELECT included_balance, purchased_balance FROM kernel.credit_balances WHERE org_id = ${BYOK_ORG_ID}`
      await finalizeUsage(BYOK_ORG_ID, {
        model: {
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
          inputCostPerM: "1.00000000",
          outputCostPerM: "5.00000000",
        },
        inputTokens: 400,
        outputTokens: 100,
        keySource: "byok",
        userId: USER_ID,
      })
      const balAfter =
        await sql`SELECT included_balance, purchased_balance FROM kernel.credit_balances WHERE org_id = ${BYOK_ORG_ID}`
      // If BYOK_ORG_ID has no balance row, both are empty — assertion still holds.
      expect(balAfter[0]?.included_balance).toBe(balBefore[0]?.included_balance)
      expect(balAfter[0]?.purchased_balance).toBe(balBefore[0]?.purchased_balance)
    })

    it("emits low-balance event at 20% threshold via outbox", async () => {
      const lowOrg = "00000000-0000-0000-0000-000000cc0006"
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${lowOrg}, 'LowOrg', 'low-org') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${lowOrg}, '1.00000000', '0.00000000', 'EUR') ON CONFLICT DO NOTHING`

      const lowUserId = "00000000-0000-0000-0000-000000cc0007"
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${lowUserId}, ${lowOrg}, 'low@test.com', 'Low User') ON CONFLICT DO NOTHING`

      // 700_000 input * 1.00/M / 1_000_000 = 0.70; * 1.20 = 0.84 creditCost → remaining ≈ 0.16 (16%)
      const result = await finalizeUsage(lowOrg, {
        model: {
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
          inputCostPerM: "1.00000000",
          outputCostPerM: "5.00000000",
        },
        inputTokens: 700_000,
        outputTokens: 0,
        keySource: "liaison",
        userId: lowUserId,
      })
      // Cost = 0.70 * 1.20 = 0.84; balance after ≈ 0.16 which is 16% of original 1.00
      const cost = Number.parseFloat(result.creditCost)
      expect(cost).toBeCloseTo(0.84, 4)

      // Low-balance event should have been queued in the outbox
      const events =
        await sql`SELECT payload FROM kernel.pending_events WHERE payload->>'orgId' = ${lowOrg} ORDER BY created_at DESC LIMIT 1`
      expect(events.length).toBeGreaterThanOrEqual(1)
      const payload = events[0].payload as any
      expect(payload.entity).toBe("credit")
      expect(payload.action).toBe("low_balance")
    })
  })

  describe("persistent-deduction-failure circuit breaker", () => {
    // Dedicated org so the failure counter never collides with other suites.
    const CB_ORG_ID = "00000000-0000-0000-0000-000000cc0020"
    const CB_USER_ID = "00000000-0000-0000-0000-000000cc0021"
    const failKey = `agent:credit-deduct-fail:${CB_ORG_ID}`

    const params = {
      model: {
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        inputCostPerM: "1.00000000",
        outputCostPerM: "5.00000000",
      },
      inputTokens: 1000,
      outputTokens: 500,
      keySource: "liaison" as const,
      userId: CB_USER_ID,
    }

    beforeAll(async () => {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${CB_ORG_ID}, 'BreakerOrg', 'breaker-org') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${CB_USER_ID}, ${CB_ORG_ID}, 'breaker@test.com', 'Breaker User') ON CONFLICT DO NOTHING`
      // Positive balance so balance/tier gates pass — the breaker is the only thing that can block.
      await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${CB_ORG_ID}, '10.00000000', '0.00000000', 'EUR') ON CONFLICT DO NOTHING`
    })

    afterEach(async () => {
      // Each test owns the counter state; clear between tests.
      await redis.del(failKey)
    })

    it("a deduction failure increments the counter and is logged, not swallowed", async () => {
      const spy = spyOn(creditService, "deductCredits").mockImplementation(async () => {
        throw new Error("simulated deduction failure")
      })
      try {
        // The turn does not throw — the per-turn loss is swallowed — but the
        // failure is recorded so persistence can be detected.
        const result = await finalizeUsage(CB_ORG_ID, params)
        expect(result.creditCost).toBe("0")
        const count = await redis.get(failKey)
        expect(Number(count)).toBe(1)
      } finally {
        spy.mockRestore()
      }
    })

    it("blocks the next turn after N consecutive deduction failures", async () => {
      const origKey = process.env.LIAISON_ANTHROPIC_API_KEY
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-liaison-test"
      const spy = spyOn(creditService, "deductCredits").mockImplementation(async () => {
        throw new Error("simulated deduction failure")
      })
      try {
        // Drive three consecutive failures (the threshold).
        for (let i = 0; i < 3; i++) {
          await finalizeUsage(CB_ORG_ID, params)
        }
        expect(Number(await redis.get(failKey))).toBe(3)

        // The pre-turn gate now hard-blocks instead of serving a free turn.
        const gate = await preCheck(CB_ORG_ID, "claude-haiku-4-5")
        expect(gate.allowed).toBe(false)
        if (!gate.allowed) {
          expect(gate.status).toBe(402)
          expect(gate.persistSystemMessage).toBe(true)
          expect(gate.reason).toContain("billing system")
        }
      } finally {
        spy.mockRestore()
        if (origKey !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = origKey
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })

    it("does not block before the threshold is reached", async () => {
      const origKey = process.env.LIAISON_ANTHROPIC_API_KEY
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-liaison-test"
      const spy = spyOn(creditService, "deductCredits").mockImplementation(async () => {
        throw new Error("simulated deduction failure")
      })
      try {
        // Two failures — one short of the threshold.
        await finalizeUsage(CB_ORG_ID, params)
        await finalizeUsage(CB_ORG_ID, params)
        expect(Number(await redis.get(failKey))).toBe(2)

        const gate = await preCheck(CB_ORG_ID, "claude-haiku-4-5")
        expect(gate.allowed).toBe(true)
      } finally {
        spy.mockRestore()
        if (origKey !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = origKey
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })

    it("a successful deduction resets the counter and reopens the gate", async () => {
      const origKey = process.env.LIAISON_ANTHROPIC_API_KEY
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-liaison-test"

      // Trip the breaker with three failures.
      const failSpy = spyOn(creditService, "deductCredits").mockImplementation(async () => {
        throw new Error("simulated deduction failure")
      })
      try {
        for (let i = 0; i < 3; i++) await finalizeUsage(CB_ORG_ID, params)
      } finally {
        failSpy.mockRestore()
      }
      expect(Number(await redis.get(failKey))).toBe(3)

      try {
        // A real, successful deduction now resets the counter.
        const result = await finalizeUsage(CB_ORG_ID, params)
        expect(result.creditCost).not.toBe("0")
        expect(await redis.get(failKey)).toBeNull()

        // Gate is open again.
        const gate = await preCheck(CB_ORG_ID, "claude-haiku-4-5")
        expect(gate.allowed).toBe(true)
      } finally {
        if (origKey !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = origKey
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })
  })

  describe("self-hosted edition (no control plane → no credits)", () => {
    const SH_ORG_ID = "00000000-0000-0000-0000-000000cc0010"
    const SH_USER_ID = "00000000-0000-0000-0000-000000cc0011"
    // A self-hosted box serves a turn on the deployment's own key: the
    // placeholder LIAISON_ANTHROPIC_API_KEY the test preload sets.

    beforeAll(async () => {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${SH_ORG_ID}, 'SelfHostOrg', 'self-host-org') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${SH_USER_ID}, ${SH_ORG_ID}, 'sh@test.com', 'SH User') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${SH_ORG_ID}, '0.00000000', '0.00000000', 'EUR') ON CONFLICT DO NOTHING`
      _setEdition("self_hosted")
    })

    afterAll(() => {
      // Restore the suite-wide managed edition.
      _setEdition("managed")
    })

    it("preCheck allows a Liaison-key request even at zero balance", async () => {
      const result = await preCheck(SH_ORG_ID, "claude-haiku-4-5")
      expect(result.allowed).toBe(true)
      if (result.allowed) expect(result.keySource).toBe("liaison")
    })

    it("preCheck applies no tier gating — a team-tier model is allowed", async () => {
      const result = await preCheck(SH_ORG_ID, "claude-opus-4-6")
      expect(result.allowed).toBe(true)
    })

    it("checkMidStep never reports exhausted for a Liaison key", async () => {
      const result = await checkMidStep(SH_ORG_ID, "liaison")
      expect(result.exhausted).toBe(false)
    })

    it("finalizeUsage records byok_usage and never deducts a balance", async () => {
      const balBefore =
        await sql`SELECT included_balance, purchased_balance FROM kernel.credit_balances WHERE org_id = ${SH_ORG_ID}`

      const result = await finalizeUsage(SH_ORG_ID, {
        model: {
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
          inputCostPerM: "1.00000000",
          outputCostPerM: "5.00000000",
        },
        inputTokens: 1000,
        outputTokens: 500,
        keySource: "liaison",
        userId: SH_USER_ID,
      })
      // No credits outside a control plane — zero cost reported, nothing deducted.
      expect(result.creditCost).toBe("0")

      const [row] =
        await sql`SELECT * FROM kernel.credit_transactions WHERE org_id = ${SH_ORG_ID} ORDER BY created_at DESC LIMIT 1`
      expect(row.type).toBe("byok_usage")
      expect(Number(row.raw_cost)).toBeCloseTo(0.0035, 8)

      const balAfter =
        await sql`SELECT included_balance, purchased_balance FROM kernel.credit_balances WHERE org_id = ${SH_ORG_ID}`
      expect(balAfter[0].included_balance).toBe(balBefore[0].included_balance)
      expect(balAfter[0].purchased_balance).toBe(balBefore[0].purchased_balance)
    })
  })

  describe("OpenRouter: the cost OpenRouter reports", () => {
    // OpenRouter bills cached reads far below the input price, and its own usage accounting
    // (providerMetadata.openrouter.usage.cost, USD) is what it charges. Pricing its tokens at
    // the full input rate recorded about four times what OpenRouter billed.
    const RATE = 1.17
    let savedRate: unknown = null
    const OR_MODEL = {
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4.1-flash",
      inputCostPerM: "1.00000000",
      outputCostPerM: "5.00000000",
    }
    const orUserId = "00000000-0000-0000-0000-000000cc0009"

    beforeAll(async () => {
      const [row] = await sql`SELECT value FROM kernel.system_config WHERE key = 'usd_eur_rate'`
      savedRate = row?.value ?? null
      const value = JSON.stringify({ rate: RATE, fetchedAt: new Date().toISOString() })
      await sql`INSERT INTO kernel.system_config (key, value, updated_at) VALUES ('usd_eur_rate', ${value}::jsonb, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${orUserId}, ${BYOK_ORG_ID}, 'or-user@test.com', 'OR User') ON CONFLICT DO NOTHING`
    })

    afterAll(async () => {
      if (savedRate === null) await sql`DELETE FROM kernel.system_config WHERE key = 'usd_eur_rate'`
      else
        await sql`UPDATE kernel.system_config SET value = ${JSON.stringify(savedRate)}::jsonb WHERE key = 'usd_eur_rate'`
    })

    async function lastRow() {
      const [row] =
        await sql`SELECT raw_cost, amount FROM kernel.credit_transactions WHERE org_id = ${BYOK_ORG_ID} ORDER BY created_at DESC LIMIT 1`
      return row
    }

    it("records the reported USD cost converted to EUR, not the token-price estimate", async () => {
      // A step as the AI SDK hands it over: its usage, and OpenRouter's accounting beside it.
      const step = {
        usage: {
          inputTokens: 100_000,
          outputTokens: 1_000,
          inputTokenDetails: { cacheReadTokens: 90_000 },
        },
        providerMetadata: { openrouter: { usage: { promptTokens: 100_000, cost: 0.0123 } } },
      }
      await finalizeUsage(BYOK_ORG_ID, {
        model: OR_MODEL,
        ...sideCallUsage(step.usage, step.providerMetadata),
        keySource: "byok",
        userId: orUserId,
      })
      const row = await lastRow()
      expect(Number(row.raw_cost)).toBeCloseTo(0.0123 / RATE, 8)
      expect(Number(row.amount)).toBeCloseTo(-0.0123 / RATE, 8)
    })

    it("falls back to the token-price estimate when OpenRouter reports no cost", async () => {
      await finalizeUsage(BYOK_ORG_ID, {
        model: OR_MODEL,
        inputTokens: 100_000,
        outputTokens: 1_000,
        cachedInputTokens: 90_000,
        keySource: "byok",
        userId: orUserId,
      })
      const row = await lastRow()
      // 100k input at 1 EUR/M plus 1k output at 5 EUR/M.
      expect(Number(row.raw_cost)).toBeCloseTo(0.1 + 0.005, 8)
    })

    it("ignores a reported cost from any other provider", async () => {
      await finalizeUsage(BYOK_ORG_ID, {
        model: { ...OR_MODEL, provider: "anthropic", modelId: "claude-haiku-4-5" },
        inputTokens: 1000,
        outputTokens: 500,
        providerCostUsd: 0.0123,
        keySource: "byok",
        userId: orUserId,
      })
      const row = await lastRow()
      expect(Number(row.raw_cost)).toBeCloseTo(0.0035, 8)
    })
  })
})
