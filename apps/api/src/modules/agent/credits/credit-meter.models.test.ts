// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ORG'S MODEL CATALOGUE (S4, S5, S8 metering, A1, A5, A6, A17).
//
// An org runs the native catalogue minus what its admin switched off, plus the
// models it added (OpenRouter, its own servers), each only while its provider
// is reachable. Auto is the admin's choice when it is available, else today's
// rule. A turn whose stored model went away runs on Auto; a side call keeps the
// model it asked for.
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Ignore `disabled` in listAvailableModels: "leaves out a switched-off
//    native model" fails.
//  * Drop the turn fallback in resolveModelForPreCheck: "a turn on a
//    switched-off model runs on Auto" fails (it resolves the disabled model).
//  * Apply the fallback to every pre-check: "a side call keeps its model" fails.
//  * Ignore autoModelKey in selectAutoModelForOrg: "turns with no model run on
//    the Auto setting" fails.
//  * Let the side-call rule read autoModelKey: "side calls keep the cheap
//    model" fails.
//  * Drop the side-call fallback past the native rule: "an OpenRouter-only
//    org's side call runs on its Auto model" fails (it resolves Google's).
//  * Look prefixed keys up in model_pricing: "never lists a catalogue row in an
//    added namespace" fails.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { _setEdition } from "~/lib/edition"
import { byokEncryptionKey } from "~/lib/env"
import {
  finalizeUsage,
  listAvailableModels,
  preCheck,
  resolveAutoModelKey,
  resolveKey,
  selectSideCallModelForOrg,
  usableDefaultModel,
} from "~/modules/agent/credits/credit-meter"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const DAY_ONE_ORG = "00000000-0000-0000-0000-0000000e0001"
const MODELS_ORG = "00000000-0000-0000-0000-0000000e0002"
const OR_ONLY_ORG = "00000000-0000-0000-0000-0000000e0003"
const NO_KEYS_ORG = "00000000-0000-0000-0000-0000000e0004"

const FLASH_LITE = "orm-gemini-flash-lite"
const GEMINI_PRO = "orm-gemini-pro"
const OR_KEY = "openrouter/deepseek/deepseek-v4.1-flash"
const OR_OFF_KEY = "openrouter/qwen/qwen-off"
const SERVER_ID = "ab12cd34"
const CUSTOM_KEY = `custom/${SERVER_ID}/llama-3.3`
const ORPHAN_CUSTOM_KEY = "custom/ffffffff/gone"

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

function addedOpenRouter(key: string, enabled: boolean) {
  return {
    key,
    provider: "openrouter",
    upstreamId: key.slice("openrouter/".length),
    displayName: `Model ${key}`,
    contextWindow: 1048576,
    inputCostPerM: "0.26000000",
    outputCostPerM: "1.04000000",
    tools: true,
    reasoningEfforts: ["low", "high"],
    canDisableReasoning: true,
    enabled,
    addedAt: "2026-10-22T00:00:00.000Z",
  }
}

function settingsWith(models: Record<string, unknown>) {
  return JSON.stringify({
    providerKeys: {
      google: { encrypted: enc("AIza-org"), maskedHint: "a-org" },
      openrouter: { encrypted: enc("sk-or-org"), maskedHint: "r-org" },
      [`custom:${SERVER_ID}`]: { encrypted: enc("sk-server"), maskedHint: "server" },
    },
    ai: { models },
  })
}

async function setModels(models: Record<string, unknown>) {
  await sql`UPDATE kernel.organizations SET settings = ${settingsWith(models)}::jsonb WHERE id = ${MODELS_ORG}`
}

const BASE_MODELS = {
  disabled: [GEMINI_PRO],
  added: [
    addedOpenRouter(OR_KEY, true),
    addedOpenRouter(OR_OFF_KEY, false),
    {
      key: CUSTOM_KEY,
      provider: "custom",
      upstreamId: "llama-3.3",
      serverId: SERVER_ID,
      displayName: "Llama 3.3",
      contextWindow: 32768,
      inputCostPerM: null,
      outputCostPerM: null,
      tools: false,
      reasoningEfforts: [],
      canDisableReasoning: false,
      enabled: true,
      addedAt: "2026-10-22T00:00:00.000Z",
    },
    {
      key: ORPHAN_CUSTOM_KEY,
      provider: "custom",
      upstreamId: "gone",
      serverId: "ffffffff",
      displayName: "Gone",
      contextWindow: 32768,
      inputCostPerM: null,
      outputCostPerM: null,
      tools: false,
      reasoningEfforts: [],
      canDisableReasoning: false,
      enabled: true,
      addedAt: "2026-10-22T00:00:00.000Z",
    },
  ],
  servers: [
    {
      id: SERVER_ID,
      name: "Lab GPU box",
      baseURL: "https://models.example.com/v1",
      addedAt: "2026-10-22T00:00:00.000Z",
    },
  ],
}

describe("the org's model catalogue", () => {
  let saved: Record<string, string | undefined>

  beforeAll(async () => {
    await acquireTestLock()
    _setEdition("self_hosted")
    // Availability is decided by the fixtures' own keys only.
    saved = Object.fromEntries(PROVIDER_ENV.map((k) => [k, process.env[k]]))
    for (const k of PROVIDER_ENV) delete process.env[k]

    const dayOne = JSON.stringify({
      providerKeys: { google: { encrypted: enc("AIza-day-one"), maskedHint: "ay-one" } },
    })
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${DAY_ONE_ORG}, 'DayOne', 'orm-day-one', ${dayOne}::jsonb) ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings`
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${MODELS_ORG}, 'Models', 'orm-models', ${settingsWith(BASE_MODELS)}::jsonb) ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings`
    await sql`
      INSERT INTO kernel.model_pricing
        (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES
        ('google', ${FLASH_LITE}, 'Flash Lite (test)', '0.00000001', '0.00000001', 1048576, true, 'starter'),
        ('google', ${GEMINI_PRO}, 'Gemini Pro (test)', '1.00000000', '8.00000000', 1048576, false, 'starter'),
        ('google', 'openrouter/evil/native-row', 'Prefixed row', '0', '0', 1000, false, 'starter')
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id IN (${DAY_ONE_ORG}, ${MODELS_ORG})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${OR_ONLY_ORG}, ${NO_KEYS_ORG})`
    await sql`DELETE FROM kernel.model_pricing WHERE model_id IN (${FLASH_LITE}, ${GEMINI_PRO}, 'openrouter/evil/native-row')`
    for (const k of PROVIDER_ENV) {
      if (saved[k] !== undefined) process.env[k] = saved[k]
      else delete process.env[k]
    }
    _setEdition(null)
    await releaseTestLock()
  })

  describe("listAvailableModels (S4)", () => {
    it("day one (no ai.models): exactly the native rows of the keyed providers, as before", async () => {
      const expected = (
        await sql`SELECT model_id, provider, display_name, tier_minimum, auto_eligible FROM kernel.model_pricing`
      )
        .filter((r) => r.provider === "google" && !String(r.model_id).startsWith("openrouter/"))
        .map((r) => ({
          modelId: r.model_id,
          provider: r.provider,
          displayName: r.display_name,
          tierMinimum: r.tier_minimum,
          autoEligible: r.auto_eligible,
        }))
      const models = await listAvailableModels(DAY_ONE_ORG)
      expect(
        models.map(({ modelId, provider, displayName, tierMinimum, autoEligible }) => ({
          modelId,
          provider,
          displayName,
          tierMinimum,
          autoEligible,
        })),
      ).toEqual(expected)
      expect(models.every((m) => m.key === m.modelId && m.providerLabel === "Google")).toBe(true)
    })

    it("leaves out a switched-off native model and lists the enabled added models", async () => {
      const models = await listAvailableModels(MODELS_ORG)
      const keys = models.map((m) => m.key)
      expect(keys).toContain(FLASH_LITE)
      expect(keys).not.toContain(GEMINI_PRO)
      expect(keys).toContain(OR_KEY)
      expect(keys).not.toContain(OR_OFF_KEY)
      expect(keys).toContain(CUSTOM_KEY)
      expect(keys).not.toContain(ORPHAN_CUSTOM_KEY)

      const or = models.find((m) => m.key === OR_KEY)!
      expect(or).toMatchObject({
        modelId: OR_KEY,
        provider: "openrouter",
        providerLabel: "OpenRouter",
        tierMinimum: "starter",
        autoEligible: false,
        contextWindow: 1048576,
        inputCostPerM: "0.26000000",
        tools: true,
        reasoning: { allowedLevels: ["off", "low", "medium", "high"], defaultLevel: "off" },
      })
      const custom = models.find((m) => m.key === CUSTOM_KEY)!
      expect(custom.providerLabel).toBe("Lab GPU box")
      expect(custom.reasoning.allowedLevels).toEqual(["off"])
      expect(custom.tools).toBe(false)
    })

    it("never lists a catalogue row in an added namespace (A17)", async () => {
      const keys = (await listAvailableModels(DAY_ONE_ORG)).map((m) => m.key)
      expect(keys).not.toContain("openrouter/evil/native-row")
    })

    it("never picks a catalogue row in an added namespace as Auto (A17)", async () => {
      await sql`UPDATE kernel.model_pricing SET auto_eligible = true, input_cost_per_m = '0', output_cost_per_m = '0' WHERE model_id = 'openrouter/evil/native-row'`
      try {
        expect((await selectSideCallModelForOrg(DAY_ONE_ORG, "t"))?.modelId).toBe(FLASH_LITE)
      } finally {
        await sql`UPDATE kernel.model_pricing SET auto_eligible = false WHERE model_id = 'openrouter/evil/native-row'`
      }
    })

    it("drops OpenRouter models when the OpenRouter key is removed", async () => {
      const settings = JSON.parse(settingsWith(BASE_MODELS))
      delete settings.providerKeys.openrouter
      await sql`UPDATE kernel.organizations SET settings = ${JSON.stringify(settings)}::jsonb WHERE id = ${MODELS_ORG}`
      try {
        const keys = (await listAvailableModels(MODELS_ORG)).map((m) => m.key)
        expect(keys).not.toContain(OR_KEY)
        expect(keys).toContain(CUSTOM_KEY)
      } finally {
        await setModels(BASE_MODELS)
      }
    })
  })

  describe("the turn fallback (S4, A6)", () => {
    it("a turn on a switched-off model runs on Auto", async () => {
      const auto = await selectSideCallModelForOrg(MODELS_ORG, "t")
      const res = await preCheck(MODELS_ORG, GEMINI_PRO, { turn: true })
      expect(res.allowed).toBe(true)
      if (!res.allowed) return
      expect(res.model.modelId).toBe(auto!.modelId)
      expect(res.model.modelId).not.toBe(GEMINI_PRO)
    })

    it("a side call keeps the model it asked for, switched off or not", async () => {
      const res = await preCheck(MODELS_ORG, GEMINI_PRO)
      expect(res.allowed).toBe(true)
      if (res.allowed) expect(res.model.modelId).toBe(GEMINI_PRO)
    })

    it("a turn on a switched-off added model runs on Auto", async () => {
      const res = await preCheck(MODELS_ORG, OR_OFF_KEY, { turn: true })
      expect(res.allowed).toBe(true)
      if (res.allowed) expect(res.model.modelId).toBe(FLASH_LITE)
    })

    it("a turn on an available added model runs on it, with its upstream id and prices (A1, S8)", async () => {
      const res = await preCheck(MODELS_ORG, OR_KEY, { turn: true })
      expect(res.allowed).toBe(true)
      if (!res.allowed) return
      expect(res.model).toMatchObject({
        provider: "openrouter",
        modelId: OR_KEY,
        upstreamId: "deepseek/deepseek-v4.1-flash",
        inputCostPerM: "0.26000000",
        outputCostPerM: "1.04000000",
        reasoningCaps: { reasoningEfforts: ["low", "high"], canDisableReasoning: true },
      })
      expect(res.providerKey).toBe("sk-or-org")
    })

    it("a custom model resolves its server's address and key (A5)", async () => {
      const res = await preCheck(MODELS_ORG, CUSTOM_KEY, { turn: true })
      expect(res.allowed).toBe(true)
      if (!res.allowed) return
      expect(res.model).toMatchObject({
        provider: "custom",
        modelId: CUSTOM_KEY,
        upstreamId: "llama-3.3",
        baseURL: "https://models.example.com/v1",
        serverId: SERVER_ID,
        inputCostPerM: "0",
        outputCostPerM: "0",
      })
      expect(res.providerKey).toBe("sk-server")
      expect(await resolveKey(MODELS_ORG, { provider: "custom", serverId: "00000000" })).toEqual({
        key: "",
        source: "byok",
      })
    })

    it("an agent default that is switched off reads as Auto", async () => {
      expect(await usableDefaultModel(MODELS_ORG, GEMINI_PRO)).toBeNull()
      expect(await usableDefaultModel(MODELS_ORG, OR_OFF_KEY)).toBeNull()
      expect(await usableDefaultModel(MODELS_ORG, OR_KEY)).toBe(OR_KEY)
      expect(await usableDefaultModel(MODELS_ORG, FLASH_LITE)).toBe(FLASH_LITE)
    })
  })

  describe("the Auto setting (S5, A5)", () => {
    it("unset: turns run on today's rule", async () => {
      const res = await preCheck(MODELS_ORG, null, { turn: true })
      expect(res.allowed && res.model.modelId).toBe(FLASH_LITE)
      expect(await resolveAutoModelKey(MODELS_ORG)).toBe(FLASH_LITE)
    })

    it("turns with no model run on the Auto setting; side calls keep the cheap model", async () => {
      await setModels({ ...BASE_MODELS, autoModelKey: OR_KEY })
      try {
        const turn = await preCheck(MODELS_ORG, null, { turn: true })
        expect(turn.allowed && turn.model.modelId).toBe(OR_KEY)
        expect(await resolveAutoModelKey(MODELS_ORG)).toBe(OR_KEY)
        const side = await preCheck(MODELS_ORG, null)
        expect(side.allowed && side.model.modelId).toBe(FLASH_LITE)
        expect((await selectSideCallModelForOrg(MODELS_ORG, "t"))?.modelId).toBe(FLASH_LITE)
        // A turn whose stored model is gone runs on the Auto SETTING too.
        const fallback = await preCheck(MODELS_ORG, GEMINI_PRO, { turn: true })
        expect(fallback.allowed && fallback.model.modelId).toBe(OR_KEY)
      } finally {
        await setModels(BASE_MODELS)
      }
    })

    it("an Auto setting naming a model that is no longer available falls back to today's rule", async () => {
      await setModels({ ...BASE_MODELS, autoModelKey: OR_OFF_KEY })
      try {
        const turn = await preCheck(MODELS_ORG, null, { turn: true })
        expect(turn.allowed && turn.model.modelId).toBe(FLASH_LITE)
      } finally {
        await setModels(BASE_MODELS)
      }
    })
  })

  describe("Auto never runs a switched-off model (turn path)", () => {
    it("the automatic rule skips a switched-off model", async () => {
      await sql`
        INSERT INTO kernel.model_pricing
          (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
        VALUES ('google', 'orm-gemini-flash', 'Flash (test)', '0.00000002', '0.00000002', 1048576, true, 'starter')
        ON CONFLICT DO NOTHING`
      await setModels({ ...BASE_MODELS, disabled: [GEMINI_PRO, FLASH_LITE] })
      try {
        const turn = await preCheck(MODELS_ORG, null, { turn: true })
        expect(turn.allowed).toBe(true)
        if (!turn.allowed) return
        expect(turn.model.modelId).toBe("orm-gemini-flash")
        expect(await resolveAutoModelKey(MODELS_ORG)).toBe("orm-gemini-flash")
        // Side calls keep today's rule (A5).
        expect((await selectSideCallModelForOrg(MODELS_ORG, "t"))?.modelId).toBe(FLASH_LITE)
      } finally {
        await sql`DELETE FROM kernel.model_pricing WHERE model_id = 'orm-gemini-flash'`
        await setModels(BASE_MODELS)
      }
    })

    it("every Auto candidate switched off: the turn fails naming what to switch on", async () => {
      const eligible = (
        await sql`SELECT model_id FROM kernel.model_pricing WHERE provider = 'google' AND auto_eligible = true AND model_id NOT LIKE 'openrouter/%' AND model_id NOT LIKE 'custom/%'`
      ).map((r) => String(r.model_id))
      await setModels({ ...BASE_MODELS, disabled: [GEMINI_PRO, ...eligible] })
      try {
        const turn = await preCheck(MODELS_ORG, null, { turn: true })
        expect(turn.allowed).toBe(false)
        if (turn.allowed) return
        expect(turn.status).toBe(400)
        expect(turn.persistSystemMessage).toBe(true)
        expect(turn.reason).toContain("Flash Lite (test)")
        expect(turn.reason).toContain("switch")
        expect(await resolveAutoModelKey(MODELS_ORG)).toBeNull()
      } finally {
        await setModels(BASE_MODELS)
      }
    })
  })

  describe("non-chat catalogue rows (web search) are never models", () => {
    it("never lists or picks a non-chat row, even with a key for its provider", async () => {
      await sql`
        INSERT INTO kernel.model_pricing
          (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
        VALUES ('system', 'orm-system-tool', 'System tool (test)', '0', '0', 0, true, 'starter')
        ON CONFLICT DO NOTHING`
      const settings = JSON.parse(settingsWith(BASE_MODELS))
      settings.providerKeys.system = { encrypted: enc("not-a-model-key"), maskedHint: "x" }
      await sql`UPDATE kernel.organizations SET settings = ${JSON.stringify(settings)}::jsonb WHERE id = ${MODELS_ORG}`
      try {
        const keys = (await listAvailableModels(MODELS_ORG)).map((m) => m.key)
        expect(keys).not.toContain("orm-system-tool")
        expect((await selectSideCallModelForOrg(MODELS_ORG, "t"))?.modelId).toBe(FLASH_LITE)
        expect(await resolveAutoModelKey(MODELS_ORG)).toBe(FLASH_LITE)
        expect(await usableDefaultModel(MODELS_ORG, "orm-system-tool")).toBeNull()
      } finally {
        await sql`DELETE FROM kernel.model_pricing WHERE model_id = 'orm-system-tool'`
        await setModels(BASE_MODELS)
      }
    })
  })

  describe("an added model with no fixed price", () => {
    const UNPRICED = "openrouter/acme/router"
    const unpriced = {
      ...addedOpenRouter(UNPRICED, true),
      inputCostPerM: null,
      outputCostPerM: null,
    }

    it("refuses the turn on the platform key, runs on the org's own key", async () => {
      const settings = JSON.parse(settingsWith({ ...BASE_MODELS, added: [unpriced] }))
      delete settings.providerKeys.openrouter
      await sql`UPDATE kernel.organizations SET settings = ${JSON.stringify(settings)}::jsonb WHERE id = ${MODELS_ORG}`
      process.env.OPENROUTER_API_KEY = "sk-or-platform"
      try {
        const refused = await preCheck(MODELS_ORG, UNPRICED)
        expect(refused.allowed).toBe(false)
        if (!refused.allowed) expect(refused.reason).toContain("This model has no fixed price")

        await setModels({ ...BASE_MODELS, added: [unpriced] })
        const byok = await preCheck(MODELS_ORG, UNPRICED, { turn: true })
        expect(byok.allowed).toBe(true)
        if (byok.allowed) expect(byok.keySource).toBe("byok")
      } finally {
        delete process.env.OPENROUTER_API_KEY
        await setModels(BASE_MODELS)
      }
    })
  })

  describe("metering an added model (S3, S8)", () => {
    it("records a custom server's usage with its token counts at cost 0", async () => {
      const res = await preCheck(MODELS_ORG, CUSTOM_KEY, { turn: true })
      if (!res.allowed) throw new Error(res.reason)
      await finalizeUsage(MODELS_ORG, {
        model: res.model,
        inputTokens: 120,
        outputTokens: 30,
        keySource: res.keySource,
        userId: "system",
      })
      const [row] =
        await sql`SELECT model, input_tokens, output_tokens, raw_cost FROM kernel.credit_transactions WHERE org_id = ${MODELS_ORG} AND model = ${CUSTOM_KEY} ORDER BY created_at DESC LIMIT 1`
      expect(row).toMatchObject({ model: CUSTOM_KEY, input_tokens: 120, output_tokens: 30 })
      expect(Number(row!.raw_cost)).toBe(0)
    })

    it("prices an OpenRouter model at its entry's prices", async () => {
      const res = await preCheck(MODELS_ORG, OR_KEY, { turn: true })
      if (!res.allowed) throw new Error(res.reason)
      await finalizeUsage(MODELS_ORG, {
        model: res.model,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        keySource: res.keySource,
        userId: "system",
      })
      const [row] =
        await sql`SELECT raw_cost FROM kernel.credit_transactions WHERE org_id = ${MODELS_ORG} AND model = ${OR_KEY} ORDER BY created_at DESC LIMIT 1`
      expect(Number(row!.raw_cost)).toBeCloseTo(1.3, 6)
    })
  })

  describe("side calls of an org with no usable native provider (OpenRouter only)", () => {
    const OR_CHEAP = "openrouter/acme/tiny"
    const OR_CHEAP_OFF = "openrouter/acme/tinier-off"
    const cheap = {
      ...addedOpenRouter(OR_CHEAP, true),
      inputCostPerM: "0.01000000",
      outputCostPerM: "0.02000000",
    }
    const cheapOff = {
      ...addedOpenRouter(OR_CHEAP_OFF, false),
      inputCostPerM: "0.00100000",
      outputCostPerM: "0.00100000",
    }

    async function setOrOnly(models: Record<string, unknown>) {
      const settings = JSON.stringify({
        providerKeys: { openrouter: { encrypted: enc("sk-or-only"), maskedHint: "-only" } },
        ai: { models },
      })
      await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${OR_ONLY_ORG}, 'OrOnly', 'orm-or-only', ${settings}::jsonb) ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings`
    }

    it("an OpenRouter-only org's side call runs on its Auto model", async () => {
      await setOrOnly({ autoModelKey: OR_KEY, added: [addedOpenRouter(OR_KEY, true), cheap] })
      expect(await selectSideCallModelForOrg(OR_ONLY_ORG, "t")).toEqual({
        provider: "openrouter",
        modelId: OR_KEY,
      })
      const side = await preCheck(OR_ONLY_ORG, null)
      expect(side.allowed).toBe(true)
      if (!side.allowed) return
      expect(side.model.modelId).toBe(OR_KEY)
      expect(side.providerKey).toBe("sk-or-only")
    })

    it("without an Auto setting, the cheapest enabled added model whose key is usable", async () => {
      await setOrOnly({ added: [addedOpenRouter(OR_KEY, true), cheap, cheapOff] })
      expect((await selectSideCallModelForOrg(OR_ONLY_ORG, "t"))?.modelId).toBe(OR_CHEAP)
      const side = await preCheck(OR_ONLY_ORG, null)
      expect(side.allowed && side.model.modelId).toBe(OR_CHEAP)
    })

    it("an org with a usable native model keeps the native rule, Auto setting or not", async () => {
      await setModels({
        ...BASE_MODELS,
        autoModelKey: OR_KEY,
        added: [...BASE_MODELS.added, cheap],
      })
      try {
        expect((await selectSideCallModelForOrg(MODELS_ORG, "t"))?.modelId).toBe(FLASH_LITE)
      } finally {
        await setModels(BASE_MODELS)
      }
    })

    it("an org with no key at all gets no model, and an error that says to add a key", async () => {
      await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${NO_KEYS_ORG}, 'NoKeys', 'orm-no-keys', '{}'::jsonb) ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings`
      expect(await selectSideCallModelForOrg(NO_KEYS_ORG, "t")).toBeNull()
      const side = await preCheck(NO_KEYS_ORG, null)
      expect(side.allowed).toBe(false)
      if (side.allowed) return
      expect(side.status).toBe(500)
      expect(side.reason).toContain("Add a model key in Settings > AI models")
    })
  })
})
