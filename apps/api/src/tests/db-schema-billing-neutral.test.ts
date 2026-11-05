// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { sql as rawSql } from "~/db"
import { creditTransactions } from "~/db/schema/kernel/credits"

const SCHEMA_PREFIX = process.env.SCHEMA_PREFIX ?? ""
const KERNEL_SCHEMA = `${SCHEMA_PREFIX}kernel`

describe("schema billing-neutralization", () => {
  test("organizations table has no stripe_customer_id column", async () => {
    const rows = (await rawSql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${KERNEL_SCHEMA} AND table_name = 'organizations'
        AND column_name = 'stripe_customer_id'
    `) as unknown as Array<{ column_name: string }>
    expect(rows.length).toBe(0)
  })

  test("credit_transactions has no stripe-named columns", async () => {
    const rows = (await rawSql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${KERNEL_SCHEMA} AND table_name = 'credit_transactions'
        AND column_name IN ('stripe_payment_intent_id', 'stripe_invoice_id')
    `) as unknown as Array<{ column_name: string }>
    expect(rows.length).toBe(0)
  })

  test("credit_transactions has edition-neutral idempotency columns", async () => {
    const rows = (await rawSql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${KERNEL_SCHEMA} AND table_name = 'credit_transactions'
        AND column_name IN ('external_payment_ref', 'cycle_id')
    `) as unknown as Array<{ column_name: string }>
    expect(rows.map((r) => r.column_name).sort()).toEqual(["cycle_id", "external_payment_ref"])
  })

  test("composite unique index on (org_id, external_payment_ref) exists", async () => {
    const rows = (await rawSql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = ${KERNEL_SCHEMA} AND tablename = 'credit_transactions'
        AND indexname = 'credit_txn_org_external_pay_uniq'
    `) as unknown as Array<{ indexdef: string }>
    expect(rows.length).toBe(1)
    expect(String(rows[0].indexdef)).toContain("org_id")
    expect(String(rows[0].indexdef)).toContain("external_payment_ref")
  })

  test("composite unique index on (org_id, cycle_id) exists", async () => {
    const rows = (await rawSql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = ${KERNEL_SCHEMA} AND tablename = 'credit_transactions'
        AND indexname = 'credit_txn_org_cycle_uniq'
    `) as unknown as Array<{ indexdef: string }>
    expect(rows.length).toBe(1)
  })

  test("Drizzle table object does not include stripe-named fields", () => {
    const keys = Object.keys(creditTransactions)
    expect(keys.includes("stripePaymentIntentId")).toBe(false)
    expect(keys.includes("stripeInvoiceId")).toBe(false)
    expect(keys.includes("externalPaymentRef")).toBe(true)
    expect(keys.includes("cycleId")).toBe(true)
  })
})
