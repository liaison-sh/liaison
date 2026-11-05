// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A managed cell's pushed credit pricing for tests (S21, D15, A39): a managed
// cell meters nothing without one, so a test that exercises metered managed
// usage sets it first. Neutral values, not anyone's real prices.
import type { CloudUnitPrices } from "@liaison/control-plane-contract"
import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { CREDIT_RATE_SETTING } from "~/modules/cloud/credit-rate"
import { setInstanceSetting } from "~/seed/factories/billing/billing"

export const TEST_UNIT_PRICES: CloudUnitPrices = { webCall: "0.02", dictationMinute: "0.05" }

/** Replace the cell's pricing (whatever version it held) with these values. */
export async function setTestCreditPricing(
  rate = "1.2",
  unitPrices: CloudUnitPrices = TEST_UNIT_PRICES,
): Promise<void> {
  await setInstanceSetting(CREDIT_RATE_SETTING, { rate, unitPrices, version: 1 })
}

export async function clearTestCreditPricing(): Promise<void> {
  await sql`DELETE FROM ${sql(schemaRef("kernel"))}.instance_settings WHERE key = ${CREDIT_RATE_SETTING}`
}
