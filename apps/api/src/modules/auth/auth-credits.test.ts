// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("bootstrapRegister creates credit_balances", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("creates a credit_balances row for the new org", async () => {
    const { bootstrapRegister } = await import("~/modules/auth/auth")

    await bootstrapRegister("credit-test@test.com", "12345678", "Credit Test User")

    const orgs = await sql`SELECT id FROM kernel.organizations LIMIT 1`
    expect(orgs.length).toBe(1)

    const [balance] = await sql`SELECT * FROM kernel.credit_balances WHERE org_id = ${orgs[0].id}`
    expect(balance).toBeDefined()
    expect(balance.included_balance).toBe("20.00000000")
    expect(balance.purchased_balance).toBe("0.00000000")
    expect(balance.currency).toBe("EUR")
  })
})
