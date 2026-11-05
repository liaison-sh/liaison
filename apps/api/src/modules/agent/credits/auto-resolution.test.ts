// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AUTO'S RESOLUTION MATRIX: which model a turn on Auto runs on, per set of
// keys the org holds. Auto never picks a provider the org has no usable key
// for; an OpenRouter key alone runs on OpenRouter's default model; no key at
// all is an error that says what to do.
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Restore the global pick in turnRuleModelForOrg (no usable provider →
//    cheapest auto model of any provider): "no keys" resolves Google's model
//    and "OpenRouter only" never reaches its default.
//  * Drop the self-heal in resolveModelForPreCheck: "OpenRouter only" fails
//    with the no-model error instead of running on OpenRouter.
//  * Let ensureOpenRouterAutoModel run when Auto already has a model: "Google
//    only" and "OpenRouter + Google" gain an Auto setting they never chose.
//  * Make the default model Auto over an admin's switch-off: "a default an
//    admin switched off stays off" fails.
//  * Ignore the provisioning marker: "a default an admin removed is never
//    added back" fails (the next turn re-adds it).
//  * Drop the re-check under the row lock: "an admin's Auto choice made
//    during the catalogue fetch wins" fails (Auto is overwritten).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { _setEdition } from "~/lib/edition"
import { byokEncryptionKey } from "~/lib/env"
import { redis } from "~/lib/redis"
import { mutateAiModels } from "~/modules/agent/credits/ai-models-store"
import {
  NO_AUTO_MODEL_FOR_KEYS,
  NO_USABLE_MODEL_KEY,
  preCheck,
  selectAutoModelForOrg,
  selectSideCallModelForOrg,
} from "~/modules/agent/credits/credit-meter"
import {
  mapOpenRouterModel,
  OPENROUTER_CATALOGUE_CACHE_KEY,
} from "~/modules/agent/credits/openrouter-catalogue"
import {
  ensureOpenRouterAutoModel,
  OPENROUTER_AUTO_DEFAULT_KEY,
} from "~/modules/agent/credits/openrouter-default"
import { STUB_OPENROUTER_CATALOGUE } from "~/tests/openai-compatible-stub"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const OR_ONLY = "00000000-0000-0000-0000-0000000e1001"
const GOOGLE_ONLY = "00000000-0000-0000-0000-0000000e1002"
const BOTH = "00000000-0000-0000-0000-0000000e1003"
const NONE = "00000000-0000-0000-0000-0000000e1004"
const ORGS = [OR_ONLY, GOOGLE_ONLY, BOTH, NONE]

// The cheapest auto-eligible native model of the fixture, Google's.
const FLASH_LITE = "arm-gemini-flash-lite"

const PROVIDER_ENV = [
  "LIAISON_ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
]

function enc(plain: string): string {
  return encryptSecret(plain, byokEncryptionKey, CryptoContext.byokApiKey)
}

async function setOrg(id: string, providers: string[], models?: Record<string, unknown>) {
  const providerKeys = Object.fromEntries(
    providers.map((p) => [p, { encrypted: enc(`key-${p}-${id.slice(-4)}`), maskedHint: "hint" }]),
  )
  const settings = JSON.stringify({ providerKeys, ...(models ? { ai: { models } } : {}) })
  await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
    VALUES (${id}, ${`Auto ${id.slice(-4)}`}, ${`auto-matrix-${id.slice(-4)}`}, ${settings}::jsonb)
    ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings`
}

const cheap = {
  key: "openrouter/acme/always-thinks",
  provider: "openrouter",
  upstreamId: "acme/always-thinks",
  displayName: "Acme",
  contextWindow: 200000,
  inputCostPerM: "0.9",
  outputCostPerM: "1.8",
  tools: true,
  reasoningEfforts: ["low", "medium", "high"],
  canDisableReasoning: false,
  enabled: true,
  addedAt: "2026-10-24T00:00:00.000Z",
}

/** OpenRouter's catalogue, as the hour cache holds it: no network in a test. */
async function seedCatalogue() {
  const catalogue = STUB_OPENROUTER_CATALOGUE.map((raw) => mapOpenRouterModel(raw, 1.1)).filter(
    Boolean,
  )
  await redis.set(OPENROUTER_CATALOGUE_CACHE_KEY, JSON.stringify(catalogue), "EX", 600)
}

async function aiModelsOf(id: string): Promise<{ autoModelKey?: string; added?: unknown[] }> {
  const [row] =
    await sql`SELECT settings->'ai'->'models' AS m FROM kernel.organizations WHERE id = ${id}`
  return (row?.m ?? {}) as { autoModelKey?: string; added?: unknown[] }
}

describe("Auto's resolution matrix", () => {
  let saved: Record<string, string | undefined>

  beforeAll(async () => {
    await acquireTestLock()
    _setEdition("self_hosted")
    // Which providers are usable is decided by each org's own keys only.
    saved = Object.fromEntries(PROVIDER_ENV.map((k) => [k, process.env[k]]))
    for (const k of PROVIDER_ENV) delete process.env[k]
    await sql`
      INSERT INTO kernel.model_pricing
        (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('google', ${FLASH_LITE}, 'Flash Lite (matrix)', '0.00000001', '0.00000001', 1048576, true, 'starter')
      ON CONFLICT DO NOTHING`
    // OpenRouter's catalogue, as the hour cache holds it: no network in a test.
    await seedCatalogue()
  })

  beforeEach(async () => {
    await setOrg(OR_ONLY, ["openrouter"])
    await setOrg(GOOGLE_ONLY, ["google"])
    await setOrg(BOTH, ["openrouter", "google"])
    await setOrg(NONE, [])
  })

  afterAll(async () => {
    await redis.del(OPENROUTER_CATALOGUE_CACHE_KEY)
    for (const id of ORGS) {
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${id}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${id}`
    }
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${FLASH_LITE}`
    for (const k of PROVIDER_ENV) {
      if (saved[k] !== undefined) process.env[k] = saved[k]
      else delete process.env[k]
    }
    _setEdition(null)
    await releaseTestLock()
  })

  describe("OpenRouter only", () => {
    it("never resolves a provider it has no key for", async () => {
      expect(await selectAutoModelForOrg(OR_ONLY, "t")).toBeNull()
      expect(await selectSideCallModelForOrg(OR_ONLY, "t")).toBeNull()
    })

    it("a turn on Auto runs on OpenRouter's default model, on the org's own key", async () => {
      expect(OPENROUTER_AUTO_DEFAULT_KEY).toBe("openrouter/deepseek/deepseek-v4.1-flash")
      const res = await preCheck(OR_ONLY, null, { turn: true })
      if (!res.allowed) throw new Error(res.reason)
      expect(res.model.provider).toBe("openrouter")
      expect(res.model.modelId).toBe(OPENROUTER_AUTO_DEFAULT_KEY)
      expect(res.model.upstreamId).toBe("deepseek/deepseek-v4.1-flash")
      expect(res.keySource).toBe("byok")
      expect(res.providerKey).toBe(`key-openrouter-${OR_ONLY.slice(-4)}`)
      // The default is now an added model the admin sees, and it is Auto.
      const models = await aiModelsOf(OR_ONLY)
      expect(models.autoModelKey).toBe(OPENROUTER_AUTO_DEFAULT_KEY)
      expect(models.added).toHaveLength(1)
      // Side calls follow it too.
      expect((await selectSideCallModelForOrg(OR_ONLY, "t"))?.modelId).toBe(
        OPENROUTER_AUTO_DEFAULT_KEY,
      )
    })

    it("ensureOpenRouterAutoModel is idempotent", async () => {
      expect(await ensureOpenRouterAutoModel(OR_ONLY)).toEqual({
        status: "set",
        key: OPENROUTER_AUTO_DEFAULT_KEY,
      })
      expect(await ensureOpenRouterAutoModel(OR_ONLY)).toEqual({ status: "already_provisioned" })
      expect((await aiModelsOf(OR_ONLY)).added).toHaveLength(1)
    })

    it("an added model the admin already has is Auto's rule, untouched", async () => {
      await setOrg(OR_ONLY, ["openrouter"], { added: [cheap] })
      expect((await selectAutoModelForOrg(OR_ONLY, "t"))?.modelId).toBe(cheap.key)
      expect(await ensureOpenRouterAutoModel(OR_ONLY)).toEqual({ status: "not_needed" })
    })

    it("a default an admin switched off stays off, and the error names no foreign provider", async () => {
      await ensureOpenRouterAutoModel(OR_ONLY)
      const models = await aiModelsOf(OR_ONLY)
      const added = (models.added ?? []).map((m) => ({ ...(m as object), enabled: false }))
      await setOrg(OR_ONLY, ["openrouter"], { added })
      const res = await preCheck(OR_ONLY, null, { turn: true })
      expect(res.allowed).toBe(false)
      if (res.allowed) return
      expect(res.status).toBe(400)
      expect(res.reason).toBe(NO_AUTO_MODEL_FOR_KEYS)
      expect(res.reason.toLowerCase()).not.toContain("google")
      expect(res.reason.toLowerCase()).not.toContain("gemini")
      expect((await aiModelsOf(OR_ONLY)).autoModelKey).toBeUndefined()
    })

    it("a default an admin removed is never added back", async () => {
      expect((await ensureOpenRouterAutoModel(OR_ONLY)).status).toBe("set")
      // What the remove route does (ai-models-routes.ts): the entry goes and
      // Auto, which named it, is cleared.
      await mutateAiModels(OR_ONLY, "t", async (cur) => ({
        next: {
          ...cur,
          added: (cur.added ?? []).filter((m) => m.key !== OPENROUTER_AUTO_DEFAULT_KEY),
          autoModelKey: null,
        },
        result: null,
      }))
      const res = await preCheck(OR_ONLY, null, { turn: true })
      expect(res.allowed).toBe(false)
      if (res.allowed) return
      expect(res.reason).toBe(NO_AUTO_MODEL_FOR_KEYS)
      const models = await aiModelsOf(OR_ONLY)
      expect(models.added ?? []).toHaveLength(0)
      expect(models.autoModelKey ?? null).toBeNull()
      expect(await ensureOpenRouterAutoModel(OR_ONLY)).toEqual({ status: "already_provisioned" })
    })

    it("an admin's Auto choice made during the catalogue fetch wins", async () => {
      // OpenRouter answers the catalogue only after the admin has chosen an
      // Auto model, so the choice lands between the first check and the write.
      const race = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch() {
          await setOrg(OR_ONLY, ["openrouter"], { added: [cheap], autoModelKey: cheap.key })
          return Response.json({ data: STUB_OPENROUTER_CATALOGUE })
        },
      })
      const savedBase = process.env.OPENROUTER_BASE_URL
      process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${race.port}/api/v1`
      await redis.del(OPENROUTER_CATALOGUE_CACHE_KEY)
      try {
        expect(await ensureOpenRouterAutoModel(OR_ONLY)).toEqual({ status: "not_needed" })
        const models = await aiModelsOf(OR_ONLY)
        expect(models.autoModelKey).toBe(cheap.key)
        expect(models.added).toHaveLength(1)
        expect(
          (models as { openRouterDefaultProvisionedAt?: string }).openRouterDefaultProvisionedAt,
        ).toBeUndefined()
      } finally {
        race.stop(true)
        if (savedBase === undefined) delete process.env.OPENROUTER_BASE_URL
        else process.env.OPENROUTER_BASE_URL = savedBase
        await seedCatalogue()
      }
    })
  })

  describe("Google only (unchanged)", () => {
    it("runs on the cheapest auto-eligible Google model and gets no Auto setting", async () => {
      expect(await selectAutoModelForOrg(GOOGLE_ONLY, "t")).toEqual({
        provider: "google",
        modelId: FLASH_LITE,
      })
      const res = await preCheck(GOOGLE_ONLY, null, { turn: true })
      if (!res.allowed) throw new Error(res.reason)
      expect(res.model.modelId).toBe(FLASH_LITE)
      expect(await ensureOpenRouterAutoModel(GOOGLE_ONLY)).toEqual({ status: "not_needed" })
      expect((await aiModelsOf(GOOGLE_ONLY)).autoModelKey).toBeUndefined()
    })
  })

  describe("OpenRouter + Google (existing precedence)", () => {
    it("the native rule wins until an admin makes an OpenRouter model Auto", async () => {
      const res = await preCheck(BOTH, null, { turn: true })
      if (!res.allowed) throw new Error(res.reason)
      expect(res.model.modelId).toBe(FLASH_LITE)
      expect(await ensureOpenRouterAutoModel(BOTH)).toEqual({ status: "not_needed" })
      expect((await aiModelsOf(BOTH)).added).toBeUndefined()
    })
  })

  describe("no keys", () => {
    it("resolves nothing, and the error says to add a model key", async () => {
      expect(await selectAutoModelForOrg(NONE, "t")).toBeNull()
      expect(await selectSideCallModelForOrg(NONE, "t")).toBeNull()
      expect(await ensureOpenRouterAutoModel(NONE)).toEqual({ status: "no_key" })

      const turn = await preCheck(NONE, null, { turn: true })
      expect(turn.allowed).toBe(false)
      if (turn.allowed) return
      expect(turn.status).toBe(400)
      expect(turn.persistSystemMessage).toBe(true)
      expect(turn.reason).toBe(NO_USABLE_MODEL_KEY)
      expect(turn.reason).toContain("Add a model key in Settings > AI models")
      expect(turn.reason.toLowerCase()).not.toContain("google")

      const side = await preCheck(NONE, null)
      expect(side.allowed).toBe(false)
      if (side.allowed) return
      expect(side.reason).toBe(NO_USABLE_MODEL_KEY)
    })
  })
})
