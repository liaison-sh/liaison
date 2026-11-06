// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The AI models API (S6, S7, S8) through the real app: auth, the admin scope,
// the pickers' list, OpenRouter's catalogue and test call against a stub, the
// org's own servers, and the daily price refresh.
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Let PATCH disable the model Auto runs: "refuses switching off the Auto
//    model" fails (no 409 auto_model).
//  * Accept an unavailable autoModelKey: the 400 assertion fails.
//  * Add the model when its test call fails: "a failed test call adds nothing"
//    fails.
//  * Drop the routing options from OpenRouter calls: the stub's recorded
//    request has no `provider` field and the add test fails.
//  * List custom:* entries on GET /keys: the A14 assertion fails.
//  * Forget to remove a server's models with it: the DELETE /servers test fails.
//  * Drop `defaultReasoningLevel` from the PATCH body, the stored settings or the
//    turn's model: "the org default reasoning level" test fails.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { resolveModelForPreCheck } from "~/modules/agent/credits/credit-meter"
import { OPENROUTER_CATALOGUE_CACHE_KEY } from "~/modules/agent/credits/openrouter-catalogue"
import { refreshOpenRouterPrices } from "~/modules/agent/credits/openrouter-price-job"
import { signAccessToken } from "~/modules/auth/jwt"
import { isNoZeroRetentionRefusal, testCallRateLimitKey } from "~/modules/settings/ai-models-routes"
import { clearTestCreditPricing, setTestCreditPricing } from "~/tests/helpers/credit-pricing"
import {
  type OpenAICompatibleStub,
  STUB_OPENROUTER_CATALOGUE,
  startOpenAICompatibleStub,
} from "~/tests/openai-compatible-stub"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8000-0000000f0001"
const ADMIN_ID = "00000000-0000-4000-8000-0000000f0002"
const MEMBER_ID = "00000000-0000-4000-8000-0000000f0003"
const THREAD_ID = "00000000-0000-4000-8000-0000000f0010"
const FLASH_LITE = "airoutes-flash-lite"
const PRO = "airoutes-pro"
const OR_KEY = "openrouter/deepseek/deepseek-v4.1-flash"

let stub: OpenAICompatibleStub
let adminToken: string
let memberToken: string
const savedEnv: Record<string, string | undefined> = {}
const ENV_VARS = [
  "OPENROUTER_BASE_URL",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "LIAISON_ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MISTRAL_API_KEY",
  "LIAISON_ALLOW_PRIVATE_MODEL_SERVERS",
]

async function call(
  method: string,
  path: string,
  body?: unknown,
  token = adminToken,
): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

async function googleAutoEligible(): Promise<string[]> {
  const rows =
    await sql`SELECT model_id FROM kernel.model_pricing WHERE provider = 'google' AND auto_eligible = true AND model_id NOT LIKE 'openrouter/%' AND model_id NOT LIKE 'custom/%'`
  return rows.map((r) => String(r.model_id))
}

async function orgModels(): Promise<any> {
  const [row] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${ORG_ID}`
  const settings = (row?.settings ?? {}) as { ai?: { models?: Record<string, unknown> } }
  return settings.ai?.models ?? {}
}

describe("AI models API", () => {
  beforeAll(async () => {
    await acquireTestLock()
    for (const k of ENV_VARS) savedEnv[k] = process.env[k]
    // Only the keys this test gives the org count; Google stays usable via env.
    for (const k of [
      "OPENROUTER_API_KEY",
      "LIAISON_ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "MISTRAL_API_KEY",
    ])
      delete process.env[k]
    process.env.GOOGLE_API_KEY = "test-placeholder-google"
    delete process.env.LIAISON_ALLOW_PRIVATE_MODEL_SERVERS

    stub = startOpenAICompatibleStub({ catalogue: STUB_OPENROUTER_CATALOGUE })
    process.env.OPENROUTER_BASE_URL = `${stub.url}/api/v1`
    await redis.del(OPENROUTER_CATALOGUE_CACHE_KEY)
    // A fresh stored ECB rate, so the conversion is exact and no test reaches the ECB.
    await sql`
      INSERT INTO kernel.system_config (key, value, updated_at)
      VALUES ('usd_eur_rate', ${JSON.stringify({ rate: 1.25, fetchedAt: new Date().toISOString() })}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`

    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'AiModelsOrg', 'ai-models-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ADMIN_ID}, ${ORG_ID}, 'ai-models-admin@test.com', 'Admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${MEMBER_ID}, ${ORG_ID}, 'ai-models-member@test.com', 'Member') ON CONFLICT DO NOTHING`
    await sql`
      INSERT INTO kernel.model_pricing
        (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES
        ('google', ${FLASH_LITE}, 'Flash Lite (routes)', '0.00000001', '0.00000001', 1048576, true, 'starter'),
        ('google', ${PRO}, 'Pro (routes)', '1.00000000', '8.00000000', 1048576, false, 'starter'),
        ('anthropic', 'airoutes-claude', 'Claude (routes)', '1.00000000', '5.00000000', 200000, false, 'starter')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'ai-models-chat', 'agent_chat', ${ADMIN_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${ADMIN_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`

    const token = (userId: string, scopes: string[]) =>
      signAccessToken(
        {
          userId,
          orgId: ORG_ID,
          name: "AI models",
          authVersion: 1,
          permissionVersion: 1,
          scopes,
          dimensionGrants: {},
        },
        env.JWT_SECRET,
      )
    adminToken = await token(ADMIN_ID, ["*"])
    memberToken = await token(MEMBER_ID, ["kernel:threads:read", "kernel:threads:write"])
  })

  afterAll(async () => {
    stub.stop()
    await redis.del(OPENROUTER_CATALOGUE_CACHE_KEY)
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${THREAD_ID}`
    await sql`DELETE FROM kernel.threads WHERE id = ${THREAD_ID}`
    await sql`DELETE FROM kernel.model_pricing WHERE model_id IN (${FLASH_LITE}, ${PRO}, 'airoutes-claude')`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    for (const k of ENV_VARS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
      else delete process.env[k]
    }
    await releaseTestLock()
  })

  it("is admin only", async () => {
    expect((await call("GET", "/api/settings/ai/models", undefined, memberToken)).status).toBe(403)
    expect(
      (await call("GET", "/api/settings/ai/openrouter/catalogue", undefined, memberToken)).status,
    ).toBe(403)
    expect((await call("POST", "/api/settings/ai/servers", {}, memberToken)).status).toBe(403)
  })

  it("GET /models lists every provider and every native model, keyed or not", async () => {
    const { status, json } = await call("GET", "/api/settings/ai/models")
    expect(status).toBe(200)
    const data = json.data
    expect(data.providers.map((p: any) => p.provider)).toEqual([
      "anthropic",
      "openai",
      "google",
      "mistral",
      "openrouter",
    ])
    expect(data.providers.find((p: any) => p.provider === "openrouter")).toMatchObject({
      label: "OpenRouter",
      keySet: false,
      usable: false,
    })
    const claude = data.models.find((m: any) => m.key === "airoutes-claude")
    expect(claude).toMatchObject({ native: true, enabled: true, available: false })
    expect(data.models.find((m: any) => m.key === FLASH_LITE)).toMatchObject({
      native: true,
      enabled: true,
      available: true,
      provider: "google",
      providerLabel: "Google",
    })
    expect(data.servers).toEqual([])
    expect(data.auto).toEqual({ modelKey: null, resolvedKey: FLASH_LITE })
  })

  it("refuses switching off the model Auto runs (409 auto_model)", async () => {
    const res = await call("PATCH", "/api/settings/ai/models", { disable: [FLASH_LITE] })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe("auto_model")
    expect((await orgModels()).disabled ?? []).not.toContain(FLASH_LITE)
  })

  it("switching a native model off takes it out of the pickers and the thread PATCH refuses it", async () => {
    const res = await call("PATCH", "/api/settings/ai/models", { disable: [PRO] })
    expect(res.status).toBe(200)
    expect(res.json.data.disabled).toEqual([PRO])

    const list = await call("GET", "/api/credits/models")
    expect(list.status).toBe(200)
    const keys = list.json.data.models.map((m: any) => m.key)
    expect(keys).toContain(FLASH_LITE)
    expect(keys).not.toContain(PRO)
    expect(list.json.data.autoModelKey).toBeNull()
    expect(list.json.data.autoResolvedKey).toBe(FLASH_LITE)
    // Off a demo box, Auto runs at its usual level.
    expect(list.json.data.autoReasoningLevel).toBe("high")
    const entry = list.json.data.models.find((m: any) => m.key === FLASH_LITE)
    expect(entry.modelId).toBe(FLASH_LITE)
    expect(entry.reasoning.allowedLevels.length).toBeGreaterThan(0)

    const patch = await call("PATCH", `/api/threads/${THREAD_ID}`, { agentModelId: PRO })
    expect(patch.status).toBe(403)

    expect((await call("PATCH", "/api/settings/ai/models", { enable: [PRO] })).status).toBe(200)
    expect((await call("PATCH", `/api/threads/${THREAD_ID}`, { agentModelId: PRO })).status).toBe(
      200,
    )
  })

  it("refuses an Auto model that is not available (400) and an unknown model", async () => {
    const off = await call("PATCH", "/api/settings/ai/models", { autoModelKey: "airoutes-claude" })
    expect(off.status).toBe(400)
    const unknown = await call("PATCH", "/api/settings/ai/models", { disable: ["nope-model"] })
    expect(unknown.status).toBe(400)
  })

  it("the org default reasoning level: admin only, validated, served and carried to the turn", async () => {
    const asMember = await call(
      "PATCH",
      "/api/settings/ai/models",
      { defaultReasoningLevel: "high" },
      memberToken,
    )
    expect(asMember.status).toBe(403)
    const bad = await call("PATCH", "/api/settings/ai/models", { defaultReasoningLevel: "max" })
    expect(bad.status).toBe(400)
    expect((await orgModels()).defaultReasoningLevel).toBeUndefined()

    const set = await call("PATCH", "/api/settings/ai/models", { defaultReasoningLevel: "low" })
    expect(set.status).toBe(200)
    expect(set.json.data.defaultReasoningLevel).toBe("low")
    expect((await orgModels()).defaultReasoningLevel).toBe("low")
    expect((await call("GET", "/api/settings/ai/models")).json.data.defaultReasoningLevel).toBe(
      "low",
    )
    const served = (await call("GET", "/api/credits/models")).json.data
    expect(served.defaultReasoningLevel).toBe("low")
    // Auto runs at the org default rather than High.
    expect(served.autoReasoningLevel).toBe("low")
    // Every turn's model carries it, chosen or picked by Auto.
    for (const requested of [null, PRO]) {
      const resolved = await resolveModelForPreCheck(ORG_ID, requested, { turn: true })
      if (!("model" in resolved)) throw new Error("no model resolved")
      expect(resolved.model.orgDefaultReasoningLevel).toBe("low")
    }

    const cleared = await call("PATCH", "/api/settings/ai/models", { defaultReasoningLevel: null })
    expect(cleared.status).toBe(200)
    expect(cleared.json.data.defaultReasoningLevel).toBeNull()
    expect((await orgModels()).defaultReasoningLevel).toBeUndefined()
    expect((await call("GET", "/api/credits/models")).json.data.autoReasoningLevel).toBe("high")
    const after = await resolveModelForPreCheck(ORG_ID, null, { turn: true })
    if (!("model" in after)) throw new Error("no model resolved")
    expect(after.model.orgDefaultReasoningLevel).toBeUndefined()
  })

  it("blocked OpenRouter hosts: admin only, validated, served, replacing the default until reset", async () => {
    const view = async () => (await call("GET", "/api/settings/ai/models")).json.data.blockedHosts
    expect(await view()).toEqual({
      hosts: ["OpenInference"],
      isDefault: true,
      defaultHosts: ["OpenInference"],
    })
    const asMember = await call(
      "PATCH",
      "/api/settings/ai/models",
      { blockedHosts: ["Wafer"] },
      memberToken,
    )
    expect(asMember.status).toBe(403)
    for (const bad of [[""], ["   "], Array.from({ length: 21 }, (_, i) => `host${i}`), "Wafer"]) {
      const res = await call("PATCH", "/api/settings/ai/models", { blockedHosts: bad })
      expect(res.status).toBe(400)
    }
    expect((await orgModels()).blockedHosts).toBeUndefined()

    const set = await call("PATCH", "/api/settings/ai/models", {
      blockedHosts: [" Wafer ", "wafer", "Morph"],
    })
    expect(set.status).toBe(200)
    expect(set.json.data.blockedHosts).toEqual({
      hosts: ["Wafer", "Morph"],
      isDefault: false,
      defaultHosts: ["OpenInference"],
    })
    expect((await orgModels()).blockedHosts).toEqual(["Wafer", "Morph"])
    expect((await view()).hosts).toEqual(["Wafer", "Morph"])

    // An empty list is the org's own choice: nothing blocked, not the default.
    const none = await call("PATCH", "/api/settings/ai/models", { blockedHosts: [] })
    expect(none.json.data.blockedHosts).toMatchObject({ hosts: [], isDefault: false })
    expect((await orgModels()).blockedHosts).toEqual([])

    const reset = await call("PATCH", "/api/settings/ai/models", { blockedHosts: null })
    expect(reset.status).toBe(200)
    expect(reset.json.data.blockedHosts).toMatchObject({
      hosts: ["OpenInference"],
      isDefault: true,
    })
    expect((await orgModels()).blockedHosts).toBeUndefined()
  })

  it("the catalogue needs an OpenRouter key (412)", async () => {
    const res = await call("GET", "/api/settings/ai/openrouter/catalogue")
    expect(res.status).toBe(412)
  })

  it("on the managed edition a test call runs on the platform key, metered to the org's credits", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-platform"
    _setEdition("managed")
    const usageRows = async () =>
      (
        await sql`SELECT type, amount::text, raw_cost_usd::text AS usd, usd_eur_rate::text AS fx
          FROM kernel.credit_transactions WHERE org_id = ${ORG_ID} AND description = 'Model test call'`
      ).map((r) => ({ ...r }))
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${ORG_ID}, '0', '0', 'EUR') ON CONFLICT (org_id) DO NOTHING`
    await setTestCreditPricing()
    try {
      // No credits: refused before any call.
      const chats = () => stub.requests.filter((r) => r.path === "/api/v1/chat/completions").length
      const before = chats()
      const broke = await call("POST", "/api/settings/ai/openrouter/models", {
        upstreamId: "deepseek/deepseek-v4.1-flash",
      })
      expect(broke.status).toBe(402)
      expect(broke.json.error.code).toBe("insufficient_credits")
      expect(chats()).toBe(before)

      await sql`UPDATE kernel.credit_balances SET included_balance = '5' WHERE org_id = ${ORG_ID}`
      const res = await call("POST", "/api/settings/ai/openrouter/models", {
        upstreamId: "deepseek/deepseek-v4.1-flash",
      })
      expect(res.status).toBe(201)
      // The managed reply carries a multiplier, never the provider's prices (S18).
      expect(JSON.stringify(res.json)).not.toMatch(/CostPerM/)
      expect(res.json.data).toHaveProperty("multiplier")
      expect(stub.requests.at(-1)?.authorization).toBe("Bearer sk-or-platform")
      const rows = await usageRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ type: "usage", fx: "1.250000" })
      expect(Number(rows[0].amount)).toBeLessThan(0)
      expect(Number(rows[0].usd)).toBeGreaterThan(0)
    } finally {
      delete process.env.OPENROUTER_API_KEY
      _setEdition(null)
      await clearTestCreditPricing()
      await sql`UPDATE kernel.organizations
        SET settings = jsonb_set(settings, '{ai,models,added}', '[]'::jsonb) WHERE id = ${ORG_ID}`
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
      await redis.del(testCallRateLimitKey(ORG_ID))
    }
  })

  it("saves an OpenRouter key after validating it against /key", async () => {
    const res = await call("POST", "/api/settings/ai/keys", {
      provider: "openrouter",
      apiKey: "sk-or-v1-routes-test",
    })
    expect(res.status).toBe(200)
    const validation = stub.requests.find((r) => r.path === "/api/v1/key")
    expect(validation?.authorization).toBe("Bearer sk-or-v1-routes-test")
  })

  it("serves the catalogue in EUR, tools-only by default, searchable and cached", async () => {
    const res = await call("GET", "/api/settings/ai/openrouter/catalogue")
    expect(res.status).toBe(200)
    const rows = res.json.data.models
    expect(rows.map((r: any) => r.upstreamId)).toEqual([
      "deepseek/deepseek-v4.1-flash",
      "acme/always-thinks",
    ])
    expect(rows[0]).toEqual({
      upstreamId: "deepseek/deepseek-v4.1-flash",
      displayName: "DeepSeek: DeepSeek V4.1 Flash",
      contextWindow: 1048576,
      inputCostPerM: "0.24000000",
      outputCostPerM: "0.96000000",
      tools: true,
      reasoningEfforts: ["low", "high"],
      canDisableReasoning: true,
      added: false,
      addable: true,
    })
    expect(rows[1].canDisableReasoning).toBe(false)

    const all = await call("GET", "/api/settings/ai/openrouter/catalogue?toolsOnly=false&q=acme")
    expect(all.json.data.models.map((r: any) => r.upstreamId)).toEqual([
      "acme/always-thinks",
      "acme/no-tools",
    ])
    expect(stub.requests.filter((r) => r.path === "/api/v1/models").length).toBe(1)
    expect(await redis.get(OPENROUTER_CATALOGUE_CACHE_KEY)).not.toBeNull()
  })

  it("a model with no fixed price is listed but cannot be added (422 variable_price)", async () => {
    stub.options.catalogue = [
      ...STUB_OPENROUTER_CATALOGUE,
      {
        id: "acme/auto-router",
        name: "Acme: Auto Router",
        context_length: 128000,
        pricing: { prompt: "-1", completion: "-1" },
        supported_parameters: ["tools"],
      },
      {
        id: "acme/unpriced",
        name: "Acme: Unpriced",
        context_length: 128000,
        supported_parameters: ["tools"],
      },
    ]
    await redis.del(OPENROUTER_CATALOGUE_CACHE_KEY)
    const chats = () => stub.requests.filter((r) => r.path === "/api/v1/chat/completions").length
    try {
      const cat = await call("GET", "/api/settings/ai/openrouter/catalogue?q=acme")
      expect(cat.status).toBe(200)
      const rows = cat.json.data.models
      for (const id of ["acme/auto-router", "acme/unpriced"]) {
        const row = rows.find((r: any) => r.upstreamId === id)
        expect(row).toMatchObject({ addable: false, inputCostPerM: null })
        expect(row.notAddableReason).toContain("no fixed price")
      }
      expect(rows.find((r: any) => r.upstreamId === "acme/always-thinks").addable).toBe(true)

      const before = chats()
      const res = await call("POST", "/api/settings/ai/openrouter/models", {
        upstreamId: "acme/auto-router",
      })
      expect(res.status).toBe(422)
      expect(res.json.error.code).toBe("variable_price")
      expect(chats()).toBe(before)
      expect((await orgModels()).added ?? []).toEqual([])
    } finally {
      stub.options.catalogue = STUB_OPENROUTER_CATALOGUE
      await redis.del(OPENROUTER_CATALOGUE_CACHE_KEY)
    }
  })

  describe("a managed cell: a model with no zero-retention endpoint", () => {
    beforeAll(async () => {
      _setEdition("managed")
      await setTestCreditPricing()
    })
    afterAll(async () => {
      await clearTestCreditPricing()
      _setEdition(null)
    })

    const add = async (message: string) => {
      stub.options.failWith = { status: 404, message }
      try {
        return await call("POST", "/api/settings/ai/openrouter/models", {
          upstreamId: "deepseek/deepseek-v4.1-flash",
        })
      } finally {
        stub.options.failWith = undefined
      }
    }

    it.each([
      "No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy",
      "ZDR violation: this model has no zero data retention endpoint",
      "No endpoints available matching your guardrail restrictions and data policy.",
    ])("%s is refused in plain words", async (message) => {
      const res = await add(message)
      expect(res.status).toBe(422)
      expect(res.json.error.code).toBe("model_no_zdr")
      expect(res.json.error.message).toBe(
        "This model has no provider that keeps zero data, so it cannot be used here.",
      )
      expect((await orgModels()).added ?? []).toEqual([])
    })

    it("any other failure keeps the provider's message", async () => {
      const res = await add("Provider returned error")
      expect(res.status).toBe(422)
      expect(res.json.error.code).toBe("test_call_failed")
      expect(res.json.error.message).toContain("Provider returned error")
    })

    it("the test call itself asks for zero retention", async () => {
      const before = stub.requests.length
      await add("Provider returned error")
      const calls = stub.requests.slice(before).filter((r) => r.path === "/api/v1/chat/completions")
      expect(calls.length).toBeGreaterThan(0)
      for (const c of calls) expect(c.body.provider).toMatchObject({ zdr: true })
    })
  })

  it("OpenRouter's words for no zero-retention endpoint, and only those", () => {
    expect(isNoZeroRetentionRefusal("ZDR violation")).toBe(true)
    expect(isNoZeroRetentionRefusal("rate limited")).toBe(false)
  })

  it("a failed test call adds nothing and says why (422)", async () => {
    stub.options.failWith = {
      status: 404,
      message: "No endpoints found matching your data policy",
    }
    try {
      const res = await call("POST", "/api/settings/ai/openrouter/models", {
        upstreamId: "deepseek/deepseek-v4.1-flash",
      })
      expect(res.status).toBe(422)
      expect(res.json.error.message).toContain("No endpoints found matching your data policy")
      expect((await orgModels()).added ?? []).toEqual([])
    } finally {
      stub.options.failWith = undefined
    }
  })

  it("adds an OpenRouter model after a test call that calls the tool, with the routing options", async () => {
    const before = stub.requests.length
    const res = await call("POST", "/api/settings/ai/openrouter/models", {
      upstreamId: "deepseek/deepseek-v4.1-flash",
    })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({
      key: OR_KEY,
      provider: "openrouter",
      providerLabel: "OpenRouter",
      enabled: true,
      native: false,
      inputCostPerM: "0.24000000",
      tools: true,
    })
    const calls = stub.requests.slice(before).filter((r) => r.path === "/api/v1/chat/completions")
    expect(calls.length).toBe(2)
    for (const c of calls) {
      // The routing options, plus the org's blocked hosts (the instance default here).
      expect(c.body.provider).toEqual({
        data_collection: "deny",
        require_parameters: true,
        ignore: ["OpenInference"],
      })
      expect(c.body.model).toBe("deepseek/deepseek-v4.1-flash")
    }
    const stored = (await orgModels()).added
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      key: OR_KEY,
      upstreamId: "deepseek/deepseek-v4.1-flash",
      reasoningEfforts: ["low", "high"],
      canDisableReasoning: true,
      enabled: true,
    })

    const dup = await call("POST", "/api/settings/ai/openrouter/models", {
      upstreamId: "deepseek/deepseek-v4.1-flash",
    })
    expect(dup.status).toBe(409)

    const picker = await call("GET", "/api/credits/models", undefined, memberToken)
    const or = picker.json.data.models.find((m: any) => m.key === OR_KEY)
    expect(or).toMatchObject({
      modelId: OR_KEY,
      providerLabel: "OpenRouter",
      tierMinimum: "starter",
      reasoning: { allowedLevels: ["off", "low", "medium", "high"], defaultLevel: "off" },
    })
    const cat = await call("GET", "/api/settings/ai/openrouter/catalogue")
    expect(cat.json.data.models[0].added).toBe(true)
  })

  it("sets Auto to an added model, and switching it off is refused", async () => {
    const res = await call("PATCH", "/api/settings/ai/models", { autoModelKey: OR_KEY })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ autoModelKey: OR_KEY, resolvedKey: OR_KEY })
    const list = await call("GET", "/api/credits/models", undefined, memberToken)
    expect(list.json.data.autoModelKey).toBe(OR_KEY)
    expect(list.json.data.autoResolvedKey).toBe(OR_KEY)
    const refused = await call("PATCH", "/api/settings/ai/models", { disable: [OR_KEY] })
    expect(refused.status).toBe(409)
    const del = await call("DELETE", `/api/settings/ai/models/${OR_KEY}`)
    expect(del.status).toBe(409)
    // Back to the automatic rule, and Flash Lite can still not be switched off.
    expect((await call("PATCH", "/api/settings/ai/models", { autoModelKey: null })).status).toBe(
      200,
    )
  })

  it("refuses clearing Auto, or removing the OpenRouter key, when Auto would be left with nothing", async () => {
    const eligible = await googleAutoEligible()
    expect((await call("PATCH", "/api/settings/ai/models", { autoModelKey: OR_KEY })).status).toBe(
      200,
    )
    try {
      // Auto is the OpenRouter model, so every Google Auto candidate may go off.
      expect((await call("PATCH", "/api/settings/ai/models", { disable: eligible })).status).toBe(
        200,
      )
      const cleared = await call("PATCH", "/api/settings/ai/models", { autoModelKey: null })
      expect(cleared.status).toBe(409)
      expect(cleared.json.error.code).toBe("auto_model")
      expect((await orgModels()).autoModelKey).toBe(OR_KEY)

      const keyGone = await call("DELETE", "/api/settings/ai/keys/openrouter")
      expect(keyGone.status).toBe(409)
      expect(keyGone.json.error.code).toBe("auto_model")
      expect(keyGone.json.error.message).toContain("Auto")
      const [row] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${ORG_ID}`
      const settings = (row?.settings ?? {}) as { providerKeys?: Record<string, unknown> }
      expect(settings.providerKeys?.openrouter).toBeDefined()
    } finally {
      expect((await call("PATCH", "/api/settings/ai/models", { enable: eligible })).status).toBe(
        200,
      )
      expect((await call("PATCH", "/api/settings/ai/models", { autoModelKey: null })).status).toBe(
        200,
      )
    }
  })

  it("the price job refreshes added OpenRouter prices and marks a vanished model", async () => {
    await sql`
      INSERT INTO kernel.system_config (key, value, updated_at)
      VALUES ('usd_eur_rate', ${JSON.stringify({ rate: 1.5, fetchedAt: new Date().toISOString() })}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`
    const result = await refreshOpenRouterPrices(new Date("2026-10-23T02:30:00.000Z"))
    expect(result.updated).toBeGreaterThanOrEqual(1)
    const entry = (await orgModels()).added.find((m: any) => m.key === OR_KEY)
    expect(entry).toMatchObject({
      inputCostPerM: "0.20000000",
      outputCostPerM: "0.80000000",
      priceUpdatedAt: "2026-10-23T02:30:00.000Z",
      unavailableSince: null,
    })

    stub.options.catalogue = STUB_OPENROUTER_CATALOGUE.slice(1)
    try {
      await refreshOpenRouterPrices(new Date("2026-10-24T02:30:00.000Z"))
      const gone = (await orgModels()).added.find((m: any) => m.key === OR_KEY)
      expect(gone.unavailableSince).toBe("2026-10-24T02:30:00.000Z")
      expect(gone.inputCostPerM).toBe("0.20000000")
    } finally {
      stub.options.catalogue = STUB_OPENROUTER_CATALOGUE
      await refreshOpenRouterPrices(new Date("2026-10-25T02:30:00.000Z"))
    }
  })

  it("refuses an own server on a private address unless the operator allows it", async () => {
    const refused = await call("POST", "/api/settings/ai/servers", {
      name: "Lab box",
      baseURL: `${stub.url}/v1`,
    })
    expect(refused.status).toBe(400)
    expect(refused.json.error.message).toBe("This address is on a private network")
  })

  it("adds an own server with its key, tests a model on it, and removes both", async () => {
    process.env.LIAISON_ALLOW_PRIVATE_MODEL_SERVERS = "true"
    try {
      const created = await call("POST", "/api/settings/ai/servers", {
        name: "Lab box",
        baseURL: `${stub.url}/v1/`,
        apiKey: "sk-lab-secret",
      })
      expect(created.status).toBe(201)
      const server = created.json.data
      expect(server).toMatchObject({ name: "Lab box", baseURL: `${stub.url}/v1`, keySet: true })
      expect(server.id).toMatch(/^[0-9a-f]{8}$/)

      // A14: the server's key is not a provider key.
      const keys = await call("GET", "/api/settings/ai/keys")
      expect(keys.json.data.map((k: any) => k.provider)).toEqual(["openrouter"])

      const before = stub.requests.length
      const added = await call("POST", `/api/settings/ai/servers/${server.id}/models`, {
        name: "llama-3.3-70b",
      })
      expect(added.status).toBe(201)
      const key = `custom/${server.id}/llama-3.3-70b`
      expect(added.json.data).toMatchObject({
        key,
        provider: "custom",
        providerLabel: "Lab box",
        tools: true,
        contextWindow: 32768,
        test: { toolCalled: true },
      })
      const sent = stub.requests.slice(before).filter((r) => r.path === "/v1/chat/completions")
      expect(sent.length).toBe(2)
      expect(sent[0]!.authorization).toBe("Bearer sk-lab-secret")
      expect(sent[0]!.body.model).toBe("llama-3.3-70b")

      const picker = await call("GET", "/api/credits/models", undefined, memberToken)
      expect(picker.json.data.models.find((m: any) => m.key === key)).toMatchObject({
        providerLabel: "Lab box",
        inputCostPerM: null,
        reasoning: { allowedLevels: ["off"], defaultLevel: "off" },
      })

      const page = await call("GET", "/api/settings/ai/models")
      expect(page.json.data.servers).toEqual([
        expect.objectContaining({ id: server.id, name: "Lab box", keySet: true }),
      ])

      const removed = await call("DELETE", `/api/settings/ai/servers/${server.id}`)
      expect(removed.status).toBe(204)
      const models = await orgModels()
      expect(models.servers).toEqual([])
      expect(models.added.map((m: any) => m.key)).toEqual([OR_KEY])
      const [row] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${ORG_ID}`
      const settings = (row?.settings ?? {}) as { providerKeys?: Record<string, unknown> }
      expect(Object.keys(settings.providerKeys ?? {})).toEqual(["openrouter"])
    } finally {
      delete process.env.LIAISON_ALLOW_PRIVATE_MODEL_SERVERS
    }
  })

  it("a server that does not answer is not added (422)", async () => {
    process.env.LIAISON_ALLOW_PRIVATE_MODEL_SERVERS = "true"
    try {
      const created = await call("POST", "/api/settings/ai/servers", {
        name: "Down box",
        baseURL: `${stub.url}/v1`,
      })
      stub.options.failWith = { status: 500, message: "model not loaded" }
      const res = await call("POST", `/api/settings/ai/servers/${created.json.data.id}/models`, {
        name: "llama",
      })
      expect(res.status).toBe(422)
      expect(res.json.error.message).toContain("did not answer")
      expect(res.json.error.message).toContain("model not loaded")
      expect((await orgModels()).added.map((m: any) => m.key)).toEqual([OR_KEY])
    } finally {
      stub.options.failWith = undefined
      delete process.env.LIAISON_ALLOW_PRIVATE_MODEL_SERVERS
    }
  })

  it("test calls are rate limited per org (429 rate_limited)", async () => {
    await redis.del(testCallRateLimitKey(ORG_ID))
    stub.options.failWith = { status: 500, message: "boom" }
    try {
      for (let i = 0; i < 10; i++) {
        const res = await call("POST", "/api/settings/ai/openrouter/models", {
          upstreamId: "acme/always-thinks",
        })
        expect(res.status).toBe(422)
      }
      const chats = () => stub.requests.filter((r) => r.path.endsWith("/chat/completions")).length
      const before = chats()
      const limited = await app.request("/api/settings/ai/openrouter/models", {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ upstreamId: "acme/always-thinks" }),
      })
      expect(limited.status).toBe(429)
      expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0)
      expect(((await limited.json()) as any).error.code).toBe("rate_limited")

      const server = (await call("GET", "/api/settings/ai/models")).json.data.servers[0]
      const own = await call("POST", `/api/settings/ai/servers/${server.id}/models`, {
        name: "another-model",
      })
      expect(own.status).toBe(429)
      expect(own.json.error.code).toBe("rate_limited")
      expect(chats()).toBe(before)
    } finally {
      stub.options.failWith = undefined
      await redis.del(testCallRateLimitKey(ORG_ID))
    }
  })

  it("removes an added model", async () => {
    const res = await call("DELETE", `/api/settings/ai/models/${OR_KEY}`)
    expect(res.status).toBe(204)
    expect((await orgModels()).added).toEqual([])
    expect((await call("DELETE", `/api/settings/ai/models/${OR_KEY}`)).status).toBe(404)
  })
})
