// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { modelPricing } from "~/db/schema/kernel"

// Lazy import to avoid module-level side effects
let resolveModel: typeof import("./provider").resolveModel
let selectAutoModel: typeof import("./provider").selectAutoModel

beforeAll(async () => {
  const mod = await import("./provider")
  resolveModel = mod.resolveModel
  selectAutoModel = mod.selectAutoModel
})

describe("geminiSpendCapAwareFetch", () => {
  let geminiSpendCapAwareFetch: typeof import("./provider").geminiSpendCapAwareFetch
  beforeAll(async () => {
    geminiSpendCapAwareFetch = (await import("./provider")).geminiSpendCapAwareFetch
  })

  const capBody = JSON.stringify({
    error: {
      code: 429,
      message:
        "Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap.",
      status: "RESOURCE_EXHAUSTED",
    },
  })
  const rateLimitBody = JSON.stringify({
    error: {
      code: 429,
      message:
        "Quota exceeded for quota metric 'Generate Content API requests per minute'. Retry in 25s.",
      status: "RESOURCE_EXHAUSTED",
    },
  })

  it("rewrites a monthly spending cap 429 to a terminal 402 and keeps the provider message", async () => {
    const wrapped = geminiSpendCapAwareFetch(
      async () =>
        new Response(capBody, { status: 429, headers: { "content-type": "application/json" } }),
    )
    const res = await wrapped(
      "https://generativelanguage.googleapis.com/v1beta/models/x:generateContent",
    )
    expect(res.status).toBe(402)
    expect(await res.text()).toContain("monthly spending cap")
    expect(res.headers.get("content-type")).toBe("application/json")
  })

  it("leaves a per minute rate limit 429 untouched so the retry ladder still applies", async () => {
    const original = new Response(rateLimitBody, { status: 429 })
    const wrapped = geminiSpendCapAwareFetch(async () => original)
    const res = await wrapped(
      "https://generativelanguage.googleapis.com/v1beta/models/x:generateContent",
    )
    expect(res).toBe(original)
    expect(res.status).toBe(429)
  })

  it("passes every non 429 response through by identity", async () => {
    const original = new Response("ok", { status: 200 })
    const wrapped = geminiSpendCapAwareFetch(async () => original)
    expect(await wrapped("https://example.invalid")).toBe(original)
  })
})

describe("resolveModel", () => {
  it("creates an Anthropic model instance", () => {
    const model = resolveModel({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      apiKey: "test-key",
    })
    expect(model).toBeDefined()
    expect(typeof model).toBe("object")
  })

  it("creates an OpenAI model instance", () => {
    const model = resolveModel({
      provider: "openai",
      modelId: "gpt-5.4",
      apiKey: "test-key",
    })
    expect(model).toBeDefined()
    expect(typeof model).toBe("object")
  })

  it("creates a Google model instance", () => {
    const model = resolveModel({
      provider: "google",
      modelId: "gemini-flash-latest",
      apiKey: "test-key",
    })
    expect(model).toBeDefined()
    expect(typeof model).toBe("object")
  })

  it("creates a Mistral model instance", () => {
    const model = resolveModel({
      provider: "mistral",
      modelId: "mistral-large-latest",
      apiKey: "test-key",
    })
    expect(model).toBeDefined()
    expect(typeof model).toBe("object")
  })

  it("creates a custom OpenAI-compatible model instance", async () => {
    // resolveModel is async and DNS-validates the custom baseURL (SSRF guard),
    // so await it and point at a host that resolves. example.com is IANA-reserved
    // and always resolvable; the URL is only validated, never called (model
    // construction is lazy). A non-resolving host (api.custom.com) rejected and,
    // un-awaited, surfaced as an unhandled rejection mis-attributed downstream.
    const model = await resolveModel({
      provider: "custom",
      modelId: "my-model",
      apiKey: "test-key",
      baseURL: "https://example.com/v1",
    })
    expect(model).toBeDefined()
    expect(typeof model).toBe("object")
  })

  it("throws for custom provider without baseURL", () => {
    expect(() =>
      resolveModel({
        provider: "custom",
        modelId: "my-model",
        apiKey: "test-key",
      }),
    ).toThrow(/baseURL/)
  })

  it("throws for unknown provider", () => {
    expect(() =>
      resolveModel({
        provider: "unknown-provider" as any,
        modelId: "m",
        apiKey: "k",
      }),
    ).toThrow(/unknown-provider/)
  })
})

describe("selectAutoModel", () => {
  const TEST_MODELS = [
    {
      provider: "anthropic",
      modelId: "auto-test-expensive",
      displayName: "Expensive",
      inputCostPerM: "10.00000000",
      outputCostPerM: "20.00000000",
      contextWindow: 100000,
      autoEligible: true,
      source: "manual",
    },
    {
      provider: "openai",
      modelId: "auto-test-cheap",
      displayName: "Cheap",
      inputCostPerM: "0.00000001",
      outputCostPerM: "0.00000001",
      contextWindow: 100000,
      autoEligible: true,
      source: "manual",
    },
    {
      provider: "google",
      modelId: "auto-test-not-eligible",
      displayName: "Not Eligible",
      inputCostPerM: "0.00000001",
      outputCostPerM: "0.00000001",
      contextWindow: 100000,
      autoEligible: false,
      source: "manual",
    },
  ]

  beforeAll(async () => {
    await withSystemDb("test-seed-auto", async (tx) => {
      for (const m of TEST_MODELS) {
        await tx.insert(modelPricing).values(m).onConflictDoNothing()
      }
    })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.model_pricing WHERE model_id LIKE 'auto-test-%'`
  })

  it("returns cheapest auto-eligible model", async () => {
    const result = await selectAutoModel(db)
    expect(result).not.toBeNull()
    expect(result!.modelId).toBe("auto-test-cheap")
    expect(result!.provider).toBe("openai")
  })

  it("returns consistent results across calls (deterministic)", async () => {
    const r1 = await selectAutoModel(db)
    const r2 = await selectAutoModel(db)
    expect(r1).toEqual(r2)
  })

  it("only picks among the providers the org can use when they are given", async () => {
    const onlyAnthropic = await selectAutoModel(db, { providers: ["anthropic"] })
    expect(onlyAnthropic?.provider).toBe("anthropic")
    // An empty list filters nothing.
    expect(await selectAutoModel(db, { providers: [] })).toEqual(await selectAutoModel(db))
  })

  it("never picks a model that is not auto-eligible, whatever the providers", async () => {
    const pick = await selectAutoModel(db, { providers: ["google"] })
    expect(pick?.modelId).not.toBe("auto-test-not-eligible")
  })

  it("ignores non-auto-eligible models", async () => {
    const result = await selectAutoModel(db)
    expect(result!.modelId).not.toBe("auto-test-not-eligible")
  })

  it("returns null when no auto-eligible models exist", async () => {
    const backup = await sql`SELECT * FROM kernel.model_pricing WHERE auto_eligible = true`
    await sql`UPDATE kernel.model_pricing SET auto_eligible = false WHERE auto_eligible = true`
    try {
      const result = await selectAutoModel(db)
      expect(result).toBeNull()
    } finally {
      for (const row of backup) {
        await sql`UPDATE kernel.model_pricing SET auto_eligible = true WHERE id = ${row.id}`
      }
    }
  })
})
