// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import Redis from "ioredis"
import { sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { creditBalances } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { RESP_PROTOCOL } from "~/lib/redis"

let checkBalance: typeof import("./credit-service").checkBalance
let deductCredits: typeof import("./credit-service").deductCredits
let addCredits: typeof import("./credit-service").addCredits
let initOrgCredits: typeof import("./credit-service").initOrgCredits

const ORG_ID = "00000000-0000-0000-0000-c00000000001"
const USER_ID = "00000000-0000-0000-0000-c00000000002"

beforeAll(async () => {
  const mod = await import("./credit-service")
  checkBalance = mod.checkBalance
  deductCredits = mod.deductCredits
  addCredits = mod.addCredits
  initOrgCredits = mod.initOrgCredits

  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'Credit Test Org', 'credit-test') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER_ID}, ${ORG_ID}, 'credit@test.com', 'Credit User', 'active', 1) ON CONFLICT DO NOTHING`
})

afterEach(async () => {
  await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("initOrgCredits", () => {
  it("creates a credit_balances row for a new org", async () => {
    await initOrgCredits(ORG_ID, "EUR", "20.00000000")

    const [row] = await sql`SELECT * FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
    expect(row.included_balance).toBe("20.00000000")
    expect(row.purchased_balance).toBe("0.00000000")
    expect(row.currency).toBe("EUR")
  })
})

describe("checkBalance", () => {
  it("returns allowed: true when balance > 0", async () => {
    await initOrgCredits(ORG_ID, "EUR", "20.00000000")

    const result = await checkBalance(db, ORG_ID)
    expect(result.allowed).toBe(true)
    expect(result.included).toBe("20.00000000")
    expect(result.purchased).toBe("0.00000000")
    expect(result.currency).toBe("EUR")
  })

  it("returns allowed: false when balance = 0", async () => {
    await initOrgCredits(ORG_ID, "EUR", "0")

    const result = await checkBalance(db, ORG_ID)
    expect(result.allowed).toBe(false)
  })

  it("returns allowed: false when no credit_balances row exists", async () => {
    const result = await checkBalance(db, ORG_ID)
    expect(result.allowed).toBe(false)
  })
})

describe("deductCredits — consumption order", () => {
  it("path 1: deducts entirely from included when included >= cost", async () => {
    await initOrgCredits(ORG_ID, "EUR", "10.00000000")

    const result = await deductCredits(ORG_ID, {
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 500,
      rawCost: "0.50000000",
      creditCost: "0.50000000",
      userId: USER_ID,
    })

    const [balance] = await sql`SELECT * FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
    expect(balance.included_balance).toBe("9.50000000")
    expect(balance.purchased_balance).toBe("0.00000000")
    expect(result.balanceAfter).toBe("9.50000000")
  })

  it("path 2: splits deduction across included and purchased", async () => {
    await initOrgCredits(ORG_ID, "EUR", "0.30000000")
    // Add purchased balance
    await withPrivilegedDb(ORG_ID, "test", async (tx) => {
      await tx
        .update(creditBalances)
        .set({ purchasedBalance: "5.00000000" })
        .where(eq(creditBalances.orgId, ORG_ID))
    })

    const result = await deductCredits(ORG_ID, {
      model: "claude-sonnet-4-6",
      inputTokens: 2000,
      outputTokens: 1000,
      rawCost: "0.50000000",
      creditCost: "0.50000000",
      userId: USER_ID,
    })

    const [balance] = await sql`SELECT * FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
    expect(balance.included_balance).toBe("0.00000000")
    expect(balance.purchased_balance).toBe("4.80000000")
    expect(result.balanceAfter).toBe("4.80000000")
  })

  it("path 3: deducts entirely from purchased when included = 0", async () => {
    await initOrgCredits(ORG_ID, "EUR", "0")
    await withPrivilegedDb(ORG_ID, "test", async (tx) => {
      await tx
        .update(creditBalances)
        .set({ purchasedBalance: "10.00000000" })
        .where(eq(creditBalances.orgId, ORG_ID))
    })

    const result = await deductCredits(ORG_ID, {
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 500,
      rawCost: "0.25000000",
      creditCost: "0.25000000",
      userId: USER_ID,
    })

    const [balance] = await sql`SELECT * FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
    expect(balance.included_balance).toBe("0.00000000")
    expect(balance.purchased_balance).toBe("9.75000000")
    expect(result.balanceAfter).toBe("9.75000000")
  })

  it("records credit_transaction with correct fields", async () => {
    await initOrgCredits(ORG_ID, "EUR", "10.00000000")

    await deductCredits(ORG_ID, {
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 500,
      rawCost: "0.50000000",
      creditCost: "0.50000000",
      userId: USER_ID,
    })

    const txns = await sql`SELECT * FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    expect(txns.length).toBe(1)
    expect(txns[0].type).toBe("usage")
    expect(txns[0].amount).toBe("-0.50000000")
    expect(txns[0].balance_after).toBe("9.50000000")
    expect(txns[0].model).toBe("claude-sonnet-4-6")
    expect(txns[0].input_tokens).toBe(1000)
    expect(txns[0].output_tokens).toBe(500)
    expect(txns[0].raw_cost).toBe("0.50000000")
    expect(txns[0].user_id).toBe(USER_ID)
  })

  it("floors the balance at 0 — a single oversized deduction never goes negative", async () => {
    await initOrgCredits(ORG_ID, "EUR", "0.10000000")
    await withPrivilegedDb(ORG_ID, "test", async (tx) => {
      await tx
        .update(creditBalances)
        .set({ purchasedBalance: "1.00000000" })
        .where(eq(creditBalances.orgId, ORG_ID))
    })

    // Cost (5.00) far exceeds the 1.10 total balance — one expensive call.
    const result = await deductCredits(ORG_ID, {
      model: "claude-opus-4-6",
      inputTokens: 100000,
      outputTokens: 50000,
      rawCost: "5.00000000",
      creditCost: "5.00000000",
      userId: USER_ID,
    })

    const [balance] = await sql`SELECT * FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
    expect(balance.included_balance).toBe("0.00000000")
    expect(balance.purchased_balance).toBe("0.00000000")
    expect(Number(balance.purchased_balance)).toBeGreaterThanOrEqual(0)
    expect(result.balanceAfter).toBe("0.00000000")
  })
})

describe("addCredits", () => {
  it("top_up increases purchased_balance", async () => {
    await initOrgCredits(ORG_ID, "EUR", "5.00000000")

    const _result = await addCredits(ORG_ID, {
      amount: "25.00000000",
      type: "top_up",
      description: "Purchased 25 credits",
      externalPaymentRef: "pi_test_123",
    })

    const [balance] = await sql`SELECT * FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
    expect(balance.purchased_balance).toBe("25.00000000")
    expect(balance.included_balance).toBe("5.00000000")

    const txns = await sql`SELECT * FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    expect(txns.length).toBe(1)
    expect(txns[0].type).toBe("top_up")
    expect(txns[0].amount).toBe("25.00000000")
    expect(txns[0].external_payment_ref).toBe("pi_test_123")
  })

  it("monthly_reset sets included_balance", async () => {
    await initOrgCredits(ORG_ID, "EUR", "3.00000000")

    const _result = await addCredits(ORG_ID, {
      amount: "20.00000000",
      type: "monthly_reset",
      description: "Monthly reset to €20.00",
    })

    const [balance] = await sql`SELECT * FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
    expect(balance.included_balance).toBe("20.00000000")

    const txns = await sql`SELECT * FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    expect(txns.length).toBe(1)
    expect(txns[0].type).toBe("monthly_reset")
    expect(txns[0].description).toBe("Monthly reset to €20.00")
  })

  it("throws when credit_balances row does not exist", async () => {
    // No initOrgCredits call — row is missing
    await expect(
      addCredits(ORG_ID, {
        amount: "10.00000000",
        type: "top_up",
        description: "Should fail",
      }),
    ).rejects.toThrow()
  })
})

describe("checkBalance — overspend floored at 0", () => {
  it("returns allowed: false after an overspend, with balance floored at 0", async () => {
    await initOrgCredits(ORG_ID, "EUR", "0.01000000")

    // Deduct far more than available — the balance floors at 0, never negative.
    await deductCredits(ORG_ID, {
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      rawCost: "1.00000000",
      creditCost: "1.00000000",
      userId: USER_ID,
    })

    const [balance] = await sql`SELECT * FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
    expect(Number(balance.included_balance)).toBeGreaterThanOrEqual(0)
    expect(Number(balance.purchased_balance)).toBeGreaterThanOrEqual(0)

    const result = await checkBalance(db, ORG_ID)
    expect(result.allowed).toBe(false)
  })
})

describe("addCredits idempotency", () => {
  const IDEM_ORG_ID = "00000000-0000-0000-0000-000000000099"

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${IDEM_ORG_ID}, 'Idem Test Org', 'idem-test-org') ON CONFLICT DO NOTHING`
    await initOrgCredits(IDEM_ORG_ID, "EUR", "10.00000000")
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${IDEM_ORG_ID}`
    await sql`UPDATE kernel.credit_balances SET included_balance = '10.00000000', purchased_balance = '0.00000000' WHERE org_id = ${IDEM_ORG_ID}`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${IDEM_ORG_ID}`
    await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${IDEM_ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${IDEM_ORG_ID}`
  })

  it("top_up with externalPaymentRef succeeds on first call", async () => {
    const result = await addCredits(IDEM_ORG_ID, {
      amount: "5.00000000",
      type: "top_up",
      externalPaymentRef: "pi_idem_001",
    })
    expect(result.balanceAfter).toBe("15.00000000")
    expect(result.alreadyProcessed).toBeUndefined()
  })

  it("duplicate externalPaymentRef returns alreadyProcessed", async () => {
    await addCredits(IDEM_ORG_ID, {
      amount: "5.00000000",
      type: "top_up",
      externalPaymentRef: "pi_idem_002",
    })
    const dup = await addCredits(IDEM_ORG_ID, {
      amount: "5.00000000",
      type: "top_up",
      externalPaymentRef: "pi_idem_002",
    })
    expect(dup.alreadyProcessed).toBe(true)
    // Balance should reflect only one top-up
    const balance = await checkBalance(db, IDEM_ORG_ID)
    expect(balance.purchased).toBe("5.00000000")
  })

  it("monthly_reset with cycleId is idempotent", async () => {
    await addCredits(IDEM_ORG_ID, {
      amount: "20.00000000",
      type: "monthly_reset",
      cycleId: "inv_idem_001",
    })
    const dup = await addCredits(IDEM_ORG_ID, {
      amount: "20.00000000",
      type: "monthly_reset",
      cycleId: "inv_idem_001",
    })
    expect(dup.alreadyProcessed).toBe(true)
  })

  it("addCredits without idempotency keys is not subject to idempotency", async () => {
    const r1 = await addCredits(IDEM_ORG_ID, { amount: "1.00000000", type: "refund" })
    const r2 = await addCredits(IDEM_ORG_ID, { amount: "1.00000000", type: "refund" })
    expect(r1.alreadyProcessed).toBeUndefined()
    expect(r2.alreadyProcessed).toBeUndefined()
    expect(Number(r2.balanceAfter)).toBeGreaterThan(Number(r1.balanceAfter))
  })

  it("concurrent duplicate PI — exactly one transaction row", async () => {
    const [r1, r2] = await Promise.all([
      addCredits(IDEM_ORG_ID, {
        amount: "5.00000000",
        type: "top_up",
        externalPaymentRef: "pi_idem_concurrent",
      }),
      addCredits(IDEM_ORG_ID, {
        amount: "5.00000000",
        type: "top_up",
        externalPaymentRef: "pi_idem_concurrent",
      }),
    ])
    const results = [r1, r2]
    const processed = results.filter((r) => !r.alreadyProcessed)
    const skipped = results.filter((r) => r.alreadyProcessed === true)
    expect(processed.length).toBe(1)
    expect(skipped.length).toBe(1)
    const txns =
      await sql`SELECT * FROM kernel.credit_transactions WHERE org_id = ${IDEM_ORG_ID} AND external_payment_ref = 'pi_idem_concurrent'`
    expect(txns.length).toBe(1)
  })

  it("same externalPaymentRef in different orgs is allowed", async () => {
    const SECOND_ORG = "00000000-0000-0000-0000-0000000000aa"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${SECOND_ORG}, 'Cross Org Test', 'cross-org-test') ON CONFLICT DO NOTHING`
    await initOrgCredits(SECOND_ORG, "EUR", "0")
    try {
      const ra = await addCredits(IDEM_ORG_ID, {
        amount: "1.00000000",
        type: "top_up",
        externalPaymentRef: "shared_ref_001",
      })
      const rb = await addCredits(SECOND_ORG, {
        amount: "1.00000000",
        type: "top_up",
        externalPaymentRef: "shared_ref_001",
      })
      expect(ra.alreadyProcessed).toBeUndefined()
      expect(rb.alreadyProcessed).toBeUndefined()
    } finally {
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${SECOND_ORG}`
      await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${SECOND_ORG}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${SECOND_ORG}`
    }
  })

  it("conflict on same ref with different amount throws idempotency_conflict", async () => {
    await addCredits(IDEM_ORG_ID, {
      amount: "5.00000000",
      type: "top_up",
      externalPaymentRef: "pi_conflict_001",
    })
    let caught: unknown = null
    try {
      await addCredits(IDEM_ORG_ID, {
        amount: "99.00000000",
        type: "top_up",
        externalPaymentRef: "pi_conflict_001",
      })
    } catch (err) {
      caught = err
    }
    expect(caught).not.toBeNull()
    expect((caught as { code?: string }).code).toBe("idempotency_conflict")
  })
})

describe("concurrent deductions", () => {
  it("two concurrent deductions both complete and both record transactions", async () => {
    await initOrgCredits(ORG_ID, "EUR", "10.00000000")

    const [_r1, _r2] = await Promise.all([
      deductCredits(ORG_ID, {
        model: "m",
        inputTokens: 100,
        outputTokens: 50,
        rawCost: "1.00000000",
        creditCost: "1.00000000",
        userId: USER_ID,
      }),
      deductCredits(ORG_ID, {
        model: "m",
        inputTokens: 100,
        outputTokens: 50,
        rawCost: "1.00000000",
        creditCost: "1.00000000",
        userId: USER_ID,
      }),
    ])

    const [balance] = await sql`SELECT * FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
    expect(balance.included_balance).toBe("8.00000000")

    const txns = await sql`SELECT * FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    expect(txns.length).toBe(2)
  })

  it("handles concurrent deductions across the included/purchased boundary", async () => {
    const splitOrg = "00000000-0000-0000-0000-0000000c0004"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${splitOrg}, 'SplitOrg', 'split-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${splitOrg}, '0.50000000', '10.00000000', 'EUR') ON CONFLICT (org_id) DO UPDATE SET included_balance = '0.50000000', purchased_balance = '10.00000000'`

    try {
      // Two concurrent 1.00 deductions — both cross the included/purchased boundary
      await Promise.all([
        deductCredits(splitOrg, {
          model: "test",
          inputTokens: 100,
          outputTokens: 50,
          rawCost: "0.80000000",
          creditCost: "1.00000000",
          userId: USER_ID,
        }),
        deductCredits(splitOrg, {
          model: "test",
          inputTokens: 100,
          outputTokens: 50,
          rawCost: "0.80000000",
          creditCost: "1.00000000",
          userId: USER_ID,
        }),
      ])

      // Both deductions should have been applied — total deducted = 2.00
      // Starting: 0.50 included + 10.00 purchased = 10.50
      // After: 10.50 - 2.00 = 8.50 total
      const [balance] = await sql`SELECT * FROM kernel.credit_balances WHERE org_id = ${splitOrg}`
      const total = Number(balance.included_balance) + Number(balance.purchased_balance)
      expect(total).toBeCloseTo(8.5, 2)
      // Included should be drained to 0
      expect(Number(balance.included_balance)).toBe(0)
    } finally {
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${splitOrg}`
      await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${splitOrg}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${splitOrg}`
    }
  })
})

describe("broadcastBalanceUpdate", () => {
  it("a balance update goes through the event bus", async () => {
    await initOrgCredits(ORG_ID, "EUR", "20.00000000")
    const { broadcastBalanceUpdate } = await import("./credit-service")
    // Another process's view: its own Redis connection, subscribed to the bus's channels. A
    // broadcast on this process's sockets alone (bufferAndBroadcast) never reaches it.
    const peer = new Redis(env.REDIS_URL, { protocol: RESP_PROTOCOL, maxRetriesPerRequest: null })
    try {
      const received = new Promise<Record<string, unknown>>((resolve) => {
        peer.on("pmessage", (_pattern: string, _channel: string, raw: string) => {
          const event = JSON.parse(raw) as Record<string, unknown>
          if (event.orgId === ORG_ID) resolve(event)
        })
      })
      await peer.psubscribe("*events:kernel:credit:balance_update")
      await broadcastBalanceUpdate(ORG_ID)
      const event = await Promise.race([
        received,
        new Promise<null>((r) => setTimeout(() => r(null), 3_000)),
      ])
      expect(event).not.toBeNull()
      expect(event?.ephemeral).toBe(true)
      expect(event?.data).toEqual({
        included: "20.00000000",
        purchased: "0.00000000",
        currency: "EUR",
      })
    } finally {
      peer.disconnect()
    }
  })
})
