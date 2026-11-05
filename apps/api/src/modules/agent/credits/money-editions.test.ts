// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Money on the AI-usage routes, per edition.
//  - S19: on a self-hosted instance every route below answers exactly what it
//    answered before credits became an allowance (normalised snapshots under
//    src/tests/fixtures/selfhosted-money/, recorded from the unchanged code with
//    RECORD_SELFHOSTED_MONEY=1).
//  - S18: on a managed cell the same routes answer credits only: no currency,
//    no price, no rate, no token counts (the discriminator); the balance's
//    period denominator counts a mid-period top-up.
//  - S21: the meter bills raw EUR x the pushed credit rate (x the stale factor),
//    a new rate applies without a restart, and each row keeps its USD cost and
//    the ECB rate used (A34).
//  - S22: a deduction crossing the auto top-up threshold queues one signed
//    request; a later one below it, or auto top-up off, queues none.
//  - S5d: the daily usage report sums one UTC day of billed rows in USD and is
//    posted as a v2 message to Control's cell-billing webhook.
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Serve the managed shape on a self-hosted instance (drop the edition check
//    in a serializer): the snapshot of that route differs.
//  * Leave `inputCostPerM` (or `currency`, `inputTokens`) in a managed body:
//    the discriminator fails on that route.
//  * Keep the 1.2 margin in managed: the 2.8 credits assertion fails.
//  * Ask only on a downward crossing (the old trigger): the re-ask and the
//    already-below cases queue nothing. Drop the spacing: two rows, not one.
//  * Bill a fixed-price item at list price × rate: the two-rate unit test differs.
//  * Restore a fallback factor: the no-rate test bills a row.
//  * Use `<=` on the day's end bound: the 23:59:59 / 00:00 rows change the sum.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { CREDIT_PRICING_MISSING_MESSAGE } from "~/modules/agent/credits/credit-cost"
import { finalizeUsage, spendGate } from "~/modules/agent/credits/credit-meter"
import { broadcastBalanceUpdate } from "~/modules/agent/credits/credit-service"
import { managedBalance } from "~/modules/agent/credits/managed-money"
import { OPENROUTER_CATALOGUE_CACHE_KEY } from "~/modules/agent/credits/openrouter-catalogue"
import { chargeExaCall, webCallPricingRefusal } from "~/modules/agent/tools/web-tools"
import { signAccessToken } from "~/modules/auth/jwt"
import { applyCreditRate } from "~/modules/cloud/credit-rate"
import { sendDailyUsageReports, usageOfDay } from "~/modules/cloud/usage-report"
import {
  deleteIdentity,
  encryptInstanceKey,
  mintIdentity,
  writeIdentity,
} from "~/modules/liaison-team/identity"
import { drainOnce } from "~/modules/liaison-team/outbox"
import {
  seedCreditBalance,
  seedCreditTransactions,
  seedModelPricingRows,
  seedOrgBillingState,
  setSystemConfig,
} from "~/seed/factories/billing/billing"
import { seedOrgRow, seedUserRows } from "~/seed/factories/org/rows"
import { normaliseMoneyBody } from "~/tests/fixtures/selfhosted-money/normalise"
import {
  type OpenAICompatibleStub,
  STUB_OPENROUTER_CATALOGUE,
  startOpenAICompatibleStub,
} from "~/tests/openai-compatible-stub"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8000-0000005e0001"
const ADMIN_ID = "00000000-0000-4000-8000-0000005e0002"
const MEMBER_ID = "00000000-0000-4000-8000-0000005e0003"
const M_ORG = "00000000-0000-4000-8000-0000005e1001"
const M_ADMIN = "00000000-0000-4000-8000-0000005e1002"
const METER_ORG = "00000000-0000-4000-8000-0000005e2001"
const METER_USER = "00000000-0000-4000-8000-0000005e2002"
const ALL_ORGS = [ORG_ID, M_ORG, METER_ORG]
/** A rate no response could contain by accident. */
const SECRET_RATE = "7.654321"
const TEMPLATE = "https://{slug}.cells.test"
const FLASH = "shm-flash"
const PRO = "shm-pro"
const FIXTURES = path.join(import.meta.dir, "../../../tests/fixtures/selfhosted-money")
const RECORD = process.env.RECORD_SELFHOSTED_MONEY === "1"

const ENV_VARS = [
  "OPENROUTER_BASE_URL",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "LIAISON_ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MISTRAL_API_KEY",
]
const savedEnv: Record<string, string | undefined> = {}

/** The routes S18 changes in the managed edition, as one fixture each. */
const MONEY_ROUTES: Array<{ name: string; path: string }> = [
  { name: "credits-models", path: "/api/credits/models" },
  { name: "credits-balance", path: "/api/credits/balance" },
  { name: "credits-transactions", path: "/api/credits/transactions?limit=50" },
  {
    name: "credits-usage",
    path: "/api/credits/usage?period=daily&from=2026-04-01&to=2026-04-30",
  },
  { name: "settings-ai-models", path: "/api/settings/ai/models" },
  { name: "settings-ai-openrouter-catalogue", path: "/api/settings/ai/openrouter/catalogue" },
  { name: "settings-ai-transcription", path: "/api/settings/ai/transcription" },
]

let stub: OpenAICompatibleStub
let adminToken: string
let managedToken: string
let rateVersion = 1000
const mutableEnv = env as { LIAISON_ORG_HOST_TEMPLATE?: string }
const savedTemplate = mutableEnv.LIAISON_ORG_HOST_TEMPLATE

async function get(p: string, token = adminToken): Promise<{ status: number; body: unknown }> {
  const res = await app.request(p, { headers: { Authorization: `Bearer ${token}` } })
  return { status: res.status, body: await res.json() }
}

async function seed(): Promise<void> {
  await setSystemConfig("usd_eur_rate", { rate: 1.25, fetchedAt: new Date().toISOString() })
  const settings = { ai: { models: { autoModelKey: FLASH } } }
  await seedOrgRow({
    id: ORG_ID,
    name: "Money Org",
    slug: "money-editions",
    tier: "team",
    settings,
  })
  await seedUserRows([
    { id: ADMIN_ID, orgId: ORG_ID, email: "money-admin@test.com", name: "Money Admin" },
    { id: MEMBER_ID, orgId: ORG_ID, email: "money-member@test.com", name: "Money Member" },
  ])
  await seedModelPricingRows([
    {
      provider: "google",
      modelId: FLASH,
      displayName: "Flash (money)",
      inputCostPerM: "0.10000000",
      outputCostPerM: "0.40000000",
      contextWindow: 1048576,
      autoEligible: true,
      tierMinimum: "starter",
    },
    {
      provider: "google",
      modelId: PRO,
      displayName: "Pro (money)",
      inputCostPerM: "1.25000000",
      outputCostPerM: "10.00000000",
      contextWindow: 1048576,
      autoEligible: false,
      tierMinimum: "starter",
    },
  ])
  await seedCreditBalance(ORG_ID, { included: "12.50000000", purchased: "3.25000000" })
  const byok = (
    id: string,
    userId: string,
    amount: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    description: string | null,
    at: string,
  ) => ({
    id,
    orgId: ORG_ID,
    userId,
    type: "byok_usage",
    amount,
    balanceAfter: "0",
    model,
    inputTokens,
    outputTokens,
    rawCost: amount.replace("-", ""),
    description,
    createdAt: new Date(at),
  })
  await seedCreditTransactions([
    byok(
      "00000000-0000-4000-8000-0000005e0101",
      ADMIN_ID,
      "-0.01200000",
      FLASH,
      12000,
      800,
      null,
      "2026-04-02T10:00:00Z",
    ),
    byok(
      "00000000-0000-4000-8000-0000005e0102",
      MEMBER_ID,
      "-0.40000000",
      PRO,
      90000,
      4000,
      null,
      "2026-04-02T15:00:00Z",
    ),
    byok(
      "00000000-0000-4000-8000-0000005e0103",
      ADMIN_ID,
      "-0.00300000",
      "voice-transcribe",
      0,
      0,
      "Dictation, 40 s",
      "2026-04-05T09:00:00Z",
    ),
  ])
}

/** The managed org: a period with a reset, a mid-period top-up and spends before and after. */
async function seedManaged(): Promise<void> {
  const settings = { ai: { models: { autoModelKey: FLASH } } }
  await seedOrgRow({
    id: M_ORG,
    name: "Managed Money",
    slug: "managed-money",
    tier: "team",
    settings,
  })
  await seedOrgRow({ id: METER_ORG, name: "Meter Org", slug: "meter-org", tier: "team", settings })
  await seedUserRows([
    { id: M_ADMIN, orgId: M_ORG, email: "managed-admin@test.com", name: "Managed Admin" },
    { id: METER_USER, orgId: METER_ORG, email: "meter-user@test.com", name: "Meter User" },
  ])
  await seedCreditBalance(M_ORG, { included: "85.00000000", purchased: "25.00000000" })
  await seedCreditBalance(METER_ORG, { included: "100.00000000", purchased: "0" })
  const periodEnd = new Date("2026-05-01T00:00:00Z")
  await seedOrgBillingState(M_ORG, {
    plan: "base",
    status: "active",
    periodEnd,
    includedCredits: "100",
  })
  await seedOrgBillingState(METER_ORG, {
    plan: "base",
    status: "active",
    periodEnd,
    includedCredits: "100",
  })
  const row = (
    type: string,
    amount: string,
    balanceAfter: string,
    at: string,
    usage?: {
      model: string | null
      inputTokens: number | null
      outputTokens: number | null
      rawCost: string
    },
  ) => ({
    orgId: M_ORG,
    userId: usage ? M_ADMIN : null,
    type,
    amount,
    balanceAfter,
    model: usage?.model ?? null,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    rawCost: usage?.rawCost ?? null,
    createdAt: new Date(at),
  })
  await seedCreditTransactions([
    row("usage", "-50", "0", "2026-03-20T10:00:00Z", {
      model: FLASH,
      inputTokens: 5000,
      outputTokens: 500,
      rawCost: "40",
    }),
    row("top_up", "7", "7", "2026-03-21T10:00:00Z"),
    row("monthly_reset", "100", "105", "2026-04-01T00:00:00Z"),
    row("usage", "-10", "95", "2026-04-02T10:00:00Z", {
      model: FLASH,
      inputTokens: 1000,
      outputTokens: 100,
      rawCost: "7.69",
    }),
    row("top_up", "20", "115", "2026-04-03T10:00:00Z"),
    row("tool_usage", "-5", "110", "2026-04-04T10:00:00Z", {
      model: null,
      inputTokens: null,
      outputTokens: null,
      rawCost: "3.84",
    }),
  ])
}

async function cleanup(): Promise<void> {
  for (const org of ALL_ORGS) {
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.org_billing_state WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
  }
  await sql`DELETE FROM kernel.model_pricing WHERE model_id IN (${FLASH}, ${PRO})`
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key = 'cloud.credit_rate'`
}

/** The process-wide fetch, put back after the file (a test stubs it). */
const REAL_FETCH = globalThis.fetch

beforeAll(async () => {
  await acquireTestLock()
  for (const k of ENV_VARS) savedEnv[k] = process.env[k]
  for (const k of ["LIAISON_ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MISTRAL_API_KEY"])
    delete process.env[k]
  process.env.GOOGLE_API_KEY = "test-placeholder-google"
  process.env.OPENROUTER_API_KEY = "test-placeholder-openrouter"
  stub = startOpenAICompatibleStub({ catalogue: STUB_OPENROUTER_CATALOGUE })
  process.env.OPENROUTER_BASE_URL = `${stub.url}/api/v1`
  await redis.del(OPENROUTER_CATALOGUE_CACHE_KEY)
  await cleanup()
  await seed()
  await seedManaged()
  managedToken = await signAccessToken(
    {
      userId: M_ADMIN,
      orgId: M_ORG,
      name: "Managed Admin",
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["*"],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
  adminToken = await signAccessToken(
    {
      userId: ADMIN_ID,
      orgId: ORG_ID,
      name: "Money Admin",
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["*"],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
})

afterAll(async () => {
  globalThis.fetch = REAL_FETCH
  _setEdition(null)
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = savedTemplate
  await withSystemDb("test-money-identity", (db) => deleteIdentity(db))
  stub.stop()
  await redis.del(OPENROUTER_CATALOGUE_CACHE_KEY)
  await cleanup()
  for (const k of ENV_VARS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    else delete process.env[k]
  }
  await releaseTestLock()
})

describe("S19: self-hosted money responses equal the pre-change snapshots", () => {
  for (const route of MONEY_ROUTES) {
    test(route.name, async () => {
      _setEdition("self_hosted")
      const { status, body } = await get(route.path)
      expect(status).toBe(200)
      const normalised = normaliseMoneyBody(body)
      const file = path.join(FIXTURES, `${route.name}.json`)
      if (RECORD) {
        mkdirSync(FIXTURES, { recursive: true })
        writeFileSync(file, `${JSON.stringify(normalised, null, 2)}\n`)
      }
      expect(existsSync(file)).toBe(true)
      expect(normalised).toEqual(JSON.parse(readFileSync(file, "utf8")))
    })
  }
})

// ── Managed edition ─────────────────────────────────────────────────────────

/** Money words, provider prices and token counts a managed AI-usage response must not carry (S18). */
const MONEY = /€|EUR|USD|Usd|currency|inputTokens|outputTokens|CostPerM|pricePer/

async function asManaged<T>(fn: () => Promise<T>): Promise<T> {
  _setEdition("managed")
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = TEMPLATE
  try {
    return await fn()
  } finally {
    _setEdition("self_hosted")
    mutableEnv.LIAISON_ORG_HOST_TEMPLATE = savedTemplate
  }
}

const managedGet = (p: string) => get(`https://managed-money.cells.test${p}`, managedToken)

/** Unit credit prices no list price × rate could produce by accident. */
const UNITS = { webCall: "0.0371", dictationMinute: "0.2963" }

async function pushRate(rate: string, unitPrices = UNITS): Promise<void> {
  rateVersion += 1
  const r = await applyCreditRate({ rate, unitPrices, version: rateVersion })
  expect(r.applied).toBe(true)
}

describe("S18: managed AI-usage responses carry credits only", () => {
  beforeAll(() => pushRate(SECRET_RATE))

  for (const route of MONEY_ROUTES) {
    test(`discriminator: ${route.name}`, async () => {
      const { status, body } = await asManaged(() => managedGet(route.path))
      expect(status).toBe(200)
      const text = JSON.stringify(body)
      expect(text).not.toMatch(MONEY)
      expect(text).not.toContain(SECRET_RATE)
    })
  }

  test("balance: credits left and the period's use, a mid-period top-up in the denominator", async () => {
    const { body } = await asManaged(() => managedGet("/api/credits/balance"))
    expect((body as { data: unknown }).data).toEqual({
      mode: "managed",
      tier: "team",
      credits: { included: "85.00000000", purchased: "25.00000000", total: "110.00000000" },
      period: {
        start: "2026-04-01T00:00:00.000Z",
        end: "2026-05-01T00:00:00.000Z",
        // 100 included + 5 purchased at the reset + 20 topped up since
        availableThisPeriod: "125.00000000",
        // 10 + 5 since the reset; the March spend is not this period's
        usedThisPeriod: "15.00000000",
        usedPercent: 12,
      },
    })
  })

  test("first period, upgraded: the opening grant comes from the ledger, not the plan's new figure", async () => {
    const org = "00000000-0000-4000-8000-0000005e1abc"
    await seedOrgRow({ id: org, name: "First period", slug: "first-period-money", tier: "team" })
    try {
      // Base (10 included), then Pro (33): the difference of 23 arrived as a top-up; 2 spent.
      await seedCreditBalance(org, { included: "8", purchased: "23" })
      await seedOrgBillingState(org, {
        plan: "pro",
        status: "active",
        includedCredits: "33",
        version: 2,
      })
      await seedCreditTransactions([
        { orgId: org, type: "top_up", amount: "23", balanceAfter: "33", description: "manual" },
        { orgId: org, type: "usage", amount: "-2", balanceAfter: "31", description: null },
      ])
      const b = await managedBalance(org)
      expect(b.period.availableThisPeriod).toBe("33.00000000")
      expect(b.period.usedThisPeriod).toBe("2.00000000")
      expect(b.period.usedPercent).toBe(6.1)
    } finally {
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.org_billing_state WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
    }
  })

  test("the live balance event carries credits, no currency (self-hosted keeps it)", async () => {
    const bus = await import("~/infra/events/event-bus")
    const spy = spyOn(bus, "broadcastEphemeral").mockResolvedValue(undefined as never)
    try {
      await asManaged(() => broadcastBalanceUpdate(M_ORG))
      await broadcastBalanceUpdate(M_ORG)
      const [managed, selfHosted] = spy.mock.calls.map((c) => (c[0] as { data: object }).data)
      expect(managed).toEqual({ included: "85.00000000", purchased: "25.00000000" })
      expect(selfHosted).toHaveProperty("currency", "EUR")
    } finally {
      spy.mockRestore()
    }
  })

  test("usage and transactions are credits, without token counts", async () => {
    const usage = await asManaged(() =>
      managedGet("/api/credits/usage?period=daily&from=2026-04-01&to=2026-04-30"),
    )
    expect((usage.body as { data: unknown }).data).toEqual({
      mode: "managed",
      buckets: [
        { date: "2026-04-02", total: "10.00000000", models: { [FLASH]: "10.00000000" } },
        { date: "2026-04-04", total: "5.00000000", models: { other: "5.00000000" } },
      ],
      totalCredits: "15.00000000",
    })
    const tx = await asManaged(() => managedGet("/api/credits/transactions?limit=50"))
    const items = (tx.body as { data: { items: Array<Record<string, unknown>> } }).data.items
    expect(items.length).toBe(6)
    for (const it of items) {
      expect(it).not.toHaveProperty("inputTokens")
      expect(it).not.toHaveProperty("outputTokens")
    }
  })

  test("models carry a multiplier against Auto instead of prices", async () => {
    const res = await asManaged(() => managedGet("/api/settings/ai/models"))
    const models = (res.body as { data: { models: Array<{ key: string; multiplier: unknown }> } })
      .data.models
    // Flash is Auto (1×); Pro blends (3 × 1.25 + 10) / 4 = 3.4375 against 0.175 → 20×
    expect(models.find((m) => m.key === FLASH)?.multiplier).toBe(1)
    expect(models.find((m) => m.key === PRO)?.multiplier).toBe(20)
    const credits = await asManaged(() => managedGet("/api/credits/models"))
    const picker = (
      credits.body as { data: { models: Array<{ key: string; multiplier: unknown }> } }
    ).data.models
    expect(picker.find((m) => m.key === PRO)?.multiplier).toBe(20)
    const dictation = await asManaged(() => managedGet("/api/settings/ai/transcription"))
    const avail = (dictation.body as { data: { available: Array<Record<string, unknown>> } }).data
      .available
    expect(avail.length).toBeGreaterThan(0)
    for (const m of avail) expect(typeof m.creditsPerMinute).toBe("number")
  })
})

describe("S21 / S22: the managed meter and the auto top-up trigger", () => {
  const call = (over: Partial<Parameters<typeof finalizeUsage>[1]> = {}) =>
    asManaged(() =>
      finalizeUsage(METER_ORG, {
        model: {
          provider: "openrouter",
          modelId: "openrouter/acme/metered",
          inputCostPerM: "1",
          outputCostPerM: "1",
        },
        inputTokens: 10,
        outputTokens: 5,
        // 2.5 USD at 1.25 USD per EUR = 2 EUR
        providerCostUsd: 2.5,
        keySource: "liaison",
        userId: METER_USER,
        releaseReservation: false,
        ...over,
      }),
    )
  const lastRow = async () => {
    const [r] = await sql`SELECT id, amount::text, raw_cost::text AS eur, raw_cost_usd::text AS usd,
        usd_eur_rate::text AS fx FROM kernel.credit_transactions
      WHERE org_id = ${METER_ORG} ORDER BY created_at DESC, id DESC LIMIT 1`
    return r
  }
  const requests = async () =>
    sql`SELECT data FROM kernel.control_plane_outbox WHERE type = 'billing.auto_topup_request'`

  test("credits = raw EUR × the pushed rate; USD and the ECB rate stored per row", async () => {
    await pushRate("1.40")
    expect((await call()).creditCost).toBe("2.80000000")
    expect(await lastRow()).toMatchObject({
      amount: "-2.80000000",
      eur: "2.00000000",
      usd: "2.50000000",
      fx: "1.250000",
    })
  })

  test("a new rate applies without a restart; a stale price adds 1.25/1.2", async () => {
    await pushRate("1.50")
    expect((await call()).creditCost).toBe("3.00000000")
    const stale = await call({
      model: {
        provider: "google",
        modelId: FLASH,
        inputCostPerM: "1",
        outputCostPerM: "0",
        source: "litellm_sync",
        updatedAt: new Date(Date.now() - 30 * 24 * 3600_000),
      },
      inputTokens: 1_000_000,
      outputTokens: 0,
      providerCostUsd: undefined,
    })
    // 1 EUR estimated × 1.5 × 1.25 / 1.2
    expect(stale.creditCost).toBe("1.56250000")
    expect(await lastRow()).toMatchObject({ eur: "1.00000000", usd: "1.25000000" })
  })

  test("below the threshold asks, again on a later deduction once the spacing passed; switched off, nothing", async () => {
    await sql`DELETE FROM kernel.control_plane_outbox`
    await pushRate("1.40")
    await sql`UPDATE kernel.credit_balances SET included_balance = '12', purchased_balance = '0'
      WHERE org_id = ${METER_ORG}`
    await sql`UPDATE kernel.org_billing_state
      SET auto_top_up = '{"enabled":true,"thresholdCredits":10,"amountCredits":50}'::jsonb
      WHERE org_id = ${METER_ORG}`
    await call() // 12 → 9.2: below
    const first = await lastRow()
    await call() // 9.2 → 6.4: still below, but asked a moment ago
    let rows = await requests()
    expect(rows.length).toBe(1)
    expect(rows[0].data).toMatchObject({ orgId: METER_ORG, crossingId: first.id })
    // The first request was refused within Control's hour, or lost: once the
    // cell's spacing has passed, the next deduction below the threshold asks again.
    await sql`UPDATE kernel.control_plane_outbox SET created_at = now() - interval '11 minutes'
      WHERE type = 'billing.auto_topup_request'`
    await call() // 6.4 → 3.6: still below
    const second = await lastRow()
    rows = await requests()
    expect(rows.length).toBe(2)
    expect(rows.map((r) => (r.data as { crossingId: string }).crossingId)).toContain(second.id)

    // Turned on while already below: the next deduction asks.
    await sql`DELETE FROM kernel.control_plane_outbox`
    await sql`UPDATE kernel.credit_balances SET included_balance = '5' WHERE org_id = ${METER_ORG}`
    await call() // 5 → 2.2: never crossed
    expect((await requests()).length).toBe(1)
    await sql`DELETE FROM kernel.control_plane_outbox`

    await sql`UPDATE kernel.credit_balances SET included_balance = '12' WHERE org_id = ${METER_ORG}`
    await sql`UPDATE kernel.org_billing_state
      SET auto_top_up = '{"enabled":false,"thresholdCredits":10,"amountCredits":50}'::jsonb
      WHERE org_id = ${METER_ORG}`
    await call()
    expect((await requests()).length).toBe(0)
  })
})

describe("D15 / A39: fixed-price items and a cell without a pushed rate", () => {
  const unitCall = (item: "webCall" | "dictationMinute", quantity: number) =>
    asManaged(() =>
      finalizeUsage(METER_ORG, {
        model: {
          provider: "openrouter",
          modelId: "openrouter/acme/fixed",
          inputCostPerM: "0",
          outputCostPerM: "0",
        },
        inputTokens: 0,
        outputTokens: 0,
        // A public list price: 0.005 USD.
        fixedCostUsd: 0.005,
        providerCostUsd: 0.005,
        unit: { item, quantity },
        keySource: "liaison",
        userId: METER_USER,
        releaseReservation: false,
      }),
    )
  const lastTool = async () => {
    const [r] = await sql`SELECT amount::text, raw_cost::text AS eur, raw_cost_usd::text AS usd,
        usd_eur_rate::text AS fx FROM kernel.credit_transactions
      WHERE org_id = ${METER_ORG} AND type = 'tool_usage' ORDER BY created_at DESC, id DESC LIMIT 1`
    return r
  }
  const ecbRow = async () =>
    (await sql`SELECT value FROM kernel.system_config WHERE key = 'usd_eur_rate'`)[0]?.value

  beforeAll(async () => {
    await sql`UPDATE kernel.credit_balances SET included_balance = '100', purchased_balance = '0'
      WHERE org_id = ${METER_ORG}`
    await sql`UPDATE kernel.org_billing_state
      SET auto_top_up = '{"enabled":false,"thresholdCredits":10,"amountCredits":50}'::jsonb
      WHERE org_id = ${METER_ORG}`
  })

  test("a web call and a dictation minute cost their pushed credit price, the same at any rate", async () => {
    for (const rate of ["1.5", "2.75"]) {
      await pushRate(rate)
      expect((await unitCall("webCall", 1)).creditCost).toBe("0.03710000")
      expect((await unitCall("dictationMinute", 0.5)).creditCost).toBe("0.14815000")
    }
    // credits ÷ the public list price is no function of the rate: two rates, one quotient.
  })

  test("an Exa call is billed its webCall price, the raw cost kept; without a stored ECB rate it is still billed", async () => {
    await pushRate("1.5")
    await asManaged(() =>
      chargeExaCall({ orgId: METER_ORG, userId: METER_USER }, "liaison", "web_search"),
    )
    expect(await lastTool()).toMatchObject({
      amount: "-0.03710000",
      eur: "0.00400000",
      usd: "0.00500000",
      fx: "1.250000",
    })
    const saved = await ecbRow()
    await sql`DELETE FROM kernel.system_config WHERE key = 'usd_eur_rate'`
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error("no network in this test")
    }) as unknown as typeof fetch
    try {
      await asManaged(() =>
        chargeExaCall({ orgId: METER_ORG, userId: METER_USER }, "liaison", "web_search"),
      )
    } finally {
      globalThis.fetch = realFetch
      await setSystemConfig("usd_eur_rate", saved)
    }
    // The ECB lookup only feeds the row's raw cost: the credits are the webCall price.
    expect(await lastTool()).toMatchObject({ amount: "-0.03710000", usd: "0.00500000" })
  })

  test("dictation shows the pushed per-minute credit price for every model", async () => {
    await pushRate("1.5")
    const res = await asManaged(() => managedGet("/api/settings/ai/transcription"))
    const avail = (res.body as { data: { available: Array<Record<string, unknown>> } }).data
      .available
    expect(avail.length).toBeGreaterThan(0)
    for (const m of avail) expect(m.creditsPerMinute).toBe(0.2963)
  })

  test("no pushed rate: the spend gate refuses with credit_rate_missing, web calls are refused, nothing billed, /diag says missing", async () => {
    await sql`DELETE FROM kernel.instance_settings WHERE key = 'cloud.credit_rate'`
    const before =
      await sql`SELECT count(*)::int AS n FROM kernel.credit_transactions WHERE org_id = ${METER_ORG}`
    const gate = await asManaged(() => spendGate(METER_ORG, "liaison", FLASH))
    expect(gate).toMatchObject({ allowed: false, status: 503, billingCode: "credit_rate_missing" })
    expect(await asManaged(() => webCallPricingRefusal("liaison"))).toBe(
      CREDIT_PRICING_MISSING_MESSAGE,
    )
    expect(await asManaged(() => webCallPricingRefusal("byok"))).toBeNull()
    // A call that slipped past the gate is not billed at a guessed factor.
    const billed = await asManaged(() =>
      finalizeUsage(METER_ORG, {
        model: {
          provider: "openrouter",
          modelId: "openrouter/acme/metered",
          inputCostPerM: "1",
          outputCostPerM: "1",
        },
        inputTokens: 10,
        outputTokens: 5,
        providerCostUsd: 2.5,
        keySource: "liaison",
        userId: METER_USER,
        releaseReservation: false,
      }),
    )
    expect(billed.creditCost).toBe("0")
    const after =
      await sql`SELECT count(*)::int AS n FROM kernel.credit_transactions WHERE org_id = ${METER_ORG}`
    expect(after[0].n).toBe(before[0].n)
    // Self-hosted: no gate at all.
    expect(await spendGate(METER_ORG, "liaison", FLASH)).toBeNull()

    const token = "diag-test-token"
    const mutable = env as { MONITOR_TOKEN?: string }
    const savedToken = mutable.MONITOR_TOKEN
    mutable.MONITOR_TOKEN = token
    try {
      const diag = async () =>
        (await (
          await app.request("/diag", { headers: { Authorization: `Bearer ${token}` } })
        ).json()) as {
          creditPricing: unknown
        }
      expect((await asManaged(diag)).creditPricing).toBe("missing")
      await pushRate("1.5")
      expect((await asManaged(diag)).creditPricing).toBe("ok")
      expect((await diag()).creditPricing).toBeNull()
    } finally {
      mutable.MONITOR_TOKEN = savedToken
    }
  })
})

const ARRIVED_VIA = "6f1d2c3b-4a59-4e8f-9a7b-0c1d2e3f4a5b"

describe("S5d: the daily usage report", () => {
  beforeAll(async () => {
    const billed = (type: string, rawCostUsd: string, at: string) => ({
      orgId: METER_ORG,
      type,
      amount: "-1",
      balanceAfter: "0",
      rawCostUsd,
      createdAt: new Date(at),
    })
    await seedCreditTransactions([
      billed("usage", "9.00000000", "2026-04-09T23:59:59.999Z"),
      billed("usage", "1.50000000", "2026-04-10T00:00:00Z"),
      billed("usage", "0.25000000", "2026-04-10T23:59:59.999Z"),
      billed("byok_usage", "4.00000000", "2026-04-10T12:00:00Z"),
      billed("tool_usage", "0.00500000", "2026-04-10T12:00:00Z"),
      billed("usage", "8.00000000", "2026-04-11T00:00:00Z"),
      // Metered on another cell's key and copied here when the org moved in
      // (a move just after midnight): that cell reports them, never this one.
      { ...billed("usage", "6.00000000", "2026-04-10T23:50:00Z"), arrivedVia: ARRIVED_VIA },
      { ...billed("usage", "3.00000000", "2026-04-09T12:00:00Z"), arrivedVia: ARRIVED_VIA },
    ])
  })

  test("sums one UTC day of billed model usage metered here, never rows that arrived with a move", async () => {
    const day = (await usageOfDay("2026-04-10")).filter((u) => u.orgId === METER_ORG)
    expect(day).toEqual([{ orgId: METER_ORG, rawCostUsd: "1.75000000", rows: 2 }])
    // The day before the move: only this cell's own row.
    const before = (await usageOfDay("2026-04-09")).filter((u) => u.orgId === METER_ORG)
    expect(before).toEqual([{ orgId: METER_ORG, rawCostUsd: "9.00000000", rows: 1 }])
  })

  test("is queued and posted as a signed v2 message to the cell-billing webhook", async () => {
    await withSystemDb("test-money-identity", (db) =>
      writeIdentity(db, {
        ...mintIdentity(),
        keyCiphertext: encryptInstanceKey("e5".repeat(32)),
        state: "registered" as const,
        registeredAt: new Date().toISOString(),
      }),
    )
    await sql`DELETE FROM kernel.control_plane_outbox`
    // Self-hosted: nothing is sent.
    expect(await sendDailyUsageReports(new Date("2026-04-11T00:15:00Z"))).toBe(0)
    const queued = await asManaged(() => sendDailyUsageReports(new Date("2026-04-11T00:15:00Z")))
    expect(queued).toBeGreaterThanOrEqual(1)
    const posts: Array<{ url: string; body: Record<string, unknown>; signed: boolean }> = []
    await asManaged(() =>
      drainOnce(new Date(), {
        endpoint: "https://control.test/v1",
        fetch: async (url, init) => {
          const headers = new Headers(init.headers)
          posts.push({
            url,
            body: JSON.parse(String(init.body)),
            signed: Boolean(headers.get("x-liaison-signature")),
          })
          return Response.json({ data: { ok: true } })
        },
      }),
    )
    const mine = posts.find(
      (p) => (p.body.data as { orgId?: string } | undefined)?.orgId === METER_ORG,
    )
    expect(mine?.url).toBe("https://control.test/v1/cell-billing")
    expect(mine?.signed).toBe(true)
    expect(mine?.body).toMatchObject({
      v: 2,
      type: "usage.report",
      data: {
        orgId: METER_ORG,
        day: "2026-04-10",
        rawCostUsd: "1.75000000",
        rows: 2,
        computedAt: "2026-04-11T00:15:00.000Z",
      },
    })
    const [row] = await sql`SELECT status FROM kernel.control_plane_outbox
      WHERE type = 'usage.report' AND data->>'orgId' = ${METER_ORG}`
    expect(row.status).toBe("delivered")
  })
})
