// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S31: a managed cell embeds on OpenRouter with the cell's key and zero
// data retention, and meters each embed batch to the org's credits as ONE
// usage row, attributed to a real org user (the system-work
// convention). While payment is required nothing is sent. A
// self-hosted instance keeps its Google embedder and writes no row (S19).
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Drop the managed branch of resolveOrgEmbedder: the managed test sees no
//    OpenRouter request (the Google path runs).
//  * Drop managedZdrRouting from the embeddings body: `zdr` is missing.
//  * Meter per text instead of per batch: ten rows, not one.
//  * Skip the gate per batch: the past_due org's call reaches the stub.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import { clearOrgBillingStatusCache } from "~/modules/cloud/billing-status"
import {
  embeddingLegOffLoggedFor,
  invalidateOrgEmbedder,
  MessageIndexerTestAccess,
  resolveOrgEmbedder,
} from "~/modules/search/message-indexer"
import { clearTestCreditPricing, setTestCreditPricing } from "~/tests/helpers/credit-pricing"
import {
  cleanupManagedOrg,
  type ManagedOpenRouterStub,
  STUB_CALL_COST_USD,
  seedManagedOrg,
  setManagedOrgStatus,
  startManagedOpenRouterStub,
} from "~/tests/helpers/managed-openrouter"

const ORG = "00000000-0000-4000-8000-0000003e0001"
const USER = "00000000-0000-4000-8000-0000003e0002"
const CELL_KEY = "sk-or-test-cell-key"
const ENV_VARS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "GOOGLE_API_KEY",
  "LIAISON_OFFLINE_SIDE_CALLS",
]
const savedEnv: Record<string, string | undefined> = {}
let stub: ManagedOpenRouterStub

const TEXTS = Array.from({ length: 10 }, (_, i) => `message number ${i}`)

beforeAll(async () => {
  for (const k of ENV_VARS) savedEnv[k] = process.env[k]
  stub = startManagedOpenRouterStub()
  process.env.OPENROUTER_BASE_URL = stub.baseUrl
  process.env.OPENROUTER_API_KEY = CELL_KEY
  delete process.env.LIAISON_OFFLINE_SIDE_CALLS
  MessageIndexerTestAccess.setEmbedderFactory(null)
  await seedManagedOrg({ orgId: ORG, userId: USER })
  await setTestCreditPricing()
})

afterAll(async () => {
  stub.stop()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _setEdition(null)
  await clearTestCreditPricing()
  await cleanupManagedOrg(ORG)
})

beforeEach(async () => {
  stub.requests.length = 0
  clearOrgBillingStatusCache()
  invalidateOrgEmbedder(ORG)
  await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
  await setManagedOrgStatus(ORG, "active")
})

afterEach(() => {
  _setEdition(null)
  clearOrgBillingStatusCache()
})

describe("managed edition", () => {
  beforeEach(() => _setEdition("managed"))

  test("embeds on OpenRouter with the cell key and zdr, one usage row per batch", async () => {
    const embedder = await resolveOrgEmbedder(ORG)
    expect(embedder).not.toBeNull()
    expect(embedder?.dimensions).toBe(3072)
    const { vectors } = await (embedder as NonNullable<typeof embedder>).embed(TEXTS)
    expect(vectors).toHaveLength(10)
    expect(vectors[0]).toHaveLength(3072)

    expect(stub.requests).toHaveLength(1)
    const [req] = stub.requests
    expect(req.path).toBe("/api/v1/embeddings")
    expect(req.authorization).toBe(`Bearer ${CELL_KEY}`)
    expect(req.body.model).toBe("google/gemini-embedding-001")
    expect(req.body.input).toEqual(TEXTS)
    expect(req.body.provider).toMatchObject({ zdr: true, data_collection: "deny" })

    const rows = await sql<
      {
        type: string
        model: string
        raw_cost_usd: string
        user_id: string | null
        amount: string
      }[]
    >`SELECT type, model, raw_cost_usd, user_id, amount FROM kernel.credit_transactions
      WHERE org_id = ${ORG}`
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe("usage")
    expect(rows[0].model).toBe("openrouter/google/gemini-embedding-001")
    expect(Number(rows[0].raw_cost_usd)).toBeCloseTo(STUB_CALL_COST_USD, 8)
    expect(rows[0].user_id).toBe(USER)
    expect(Number(rows[0].amount)).toBeLessThan(0)
  })

  for (const status of ["past_due", "suspended"]) {
    test(`${status}: no embed call, keyword only, said once`, async () => {
      await setManagedOrgStatus(ORG, status)
      clearOrgBillingStatusCache()
      const embedder = await resolveOrgEmbedder(ORG)
      if (embedder) {
        const first = await embedder.embed(TEXTS)
        const second = await embedder.embed(TEXTS)
        expect(first.vectors).toEqual([])
        expect(second.vectors).toEqual([])
      }
      expect(stub.requests).toHaveLength(0)
      expect(embeddingLegOffLoggedFor(ORG)).toBe(true)
      const [n] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.credit_transactions WHERE org_id = ${ORG}`
      expect(n.n).toBe(0)
    })
  }

  test("an embedder built while active stops spending once payment is required", async () => {
    const embedder = await resolveOrgEmbedder(ORG)
    await setManagedOrgStatus(ORG, "past_due")
    clearOrgBillingStatusCache()
    const { vectors } = await (embedder as NonNullable<typeof embedder>).embed(TEXTS)
    expect(vectors).toEqual([])
    expect(stub.requests).toHaveLength(0)
  })
})

describe("self-hosted (S19)", () => {
  test("embeds on Google with the deployment's Google key, no OpenRouter call, no usage row", async () => {
    _setEdition("self_hosted")
    process.env.GOOGLE_API_KEY = "google-test-placeholder"
    const realFetch = globalThis.fetch
    const googleUrls: string[] = []
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("generativelanguage.googleapis.com")) {
        googleUrls.push(url)
        return Response.json({ embeddings: TEXTS.map(() => ({ values: [0.1, 0.2] })) })
      }
      return realFetch(input, init)
    }) as typeof fetch)
    try {
      const embedder = await resolveOrgEmbedder(ORG)
      expect(embedder?.modelId).toBe("gemini-embedding-001")
      await (embedder as NonNullable<typeof embedder>).embed(TEXTS)
    } finally {
      spy.mockRestore()
    }
    expect(googleUrls.length).toBeGreaterThan(0)
    expect(stub.requests).toHaveLength(0)
    const [n] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.credit_transactions WHERE org_id = ${ORG}`
    expect(n.n).toBe(0)
  })
})
