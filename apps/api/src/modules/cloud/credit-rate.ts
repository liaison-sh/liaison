// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The cell's credit rate (spec S21): the factor between a provider's cost and
// the credits it costs an org, and the credit price of each fixed-price item
// (D15, A39: a web call, a dictation minute), pushed together by the control
// plane with `PUT /api/cloud/settings/credit-rate` so they change without a
// deploy.
// Stored in `kernel.instance_settings` (privileged pool only) with the
// control plane's version; a push applies only when its version is newer.
// A server-side setting: no route serializes it to a client.

import {
  type CloudCreditRateReply,
  type CloudCreditRateRequest,
  type CloudUnitPrices,
  cloudUnitPricesSchema,
} from "@liaison/control-plane-contract"
import { sql as drizzleSql, eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { instanceSettings } from "~/db/schema/kernel"

/** The `kernel.instance_settings` key of the rate. */
export const CREDIT_RATE_SETTING = "cloud.credit_rate"

interface StoredRate {
  rate: string
  unitPrices: CloudUnitPrices
  version: number
}

export async function applyCreditRate(req: CloudCreditRateRequest): Promise<CloudCreditRateReply> {
  const value: StoredRate = { rate: req.rate, unitPrices: req.unitPrices, version: req.version }
  return withSystemDb("cloud-credit-rate", async (db) => {
    const applied = await db
      .insert(instanceSettings)
      .values({ key: CREDIT_RATE_SETTING, value })
      .onConflictDoUpdate({
        target: instanceSettings.key,
        set: { value, decidedAt: drizzleSql`now()` },
        setWhere: drizzleSql`(${instanceSettings.value}->>'version')::bigint < ${req.version}`,
      })
      .returning({ key: instanceSettings.key })
    if (applied.length > 0) return { ok: true, applied: true, version: req.version }
    const held = await readStoredRate(db)
    return { ok: true, applied: false, version: held?.version ?? req.version }
  })
}

async function readStoredRate(db: PrivilegedDb): Promise<StoredRate | null> {
  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, CREDIT_RATE_SETTING))
  const v = row?.value as Partial<StoredRate> | undefined
  if (!v || typeof v.rate !== "string" || typeof v.version !== "number") return null
  // A row without valid unit prices (written before they existed) is no pricing at all.
  const units = cloudUnitPricesSchema.safeParse(v.unitPrices)
  return units.success ? { rate: v.rate, unitPrices: units.data, version: v.version } : null
}

/** The rate the control plane last pushed, or null when none was. */
export async function readCreditRate(): Promise<string | null> {
  return (await readCreditPricing())?.rate ?? null
}

/** The rate and unit prices the control plane last pushed, or null when none were. */
export async function readCreditPricing(): Promise<{
  rate: string
  unitPrices: CloudUnitPrices
} | null> {
  const held = await withSystemDb("cloud-credit-rate-read", (db) => readStoredRate(db))
  return held ? { rate: held.rate, unitPrices: held.unitPrices } : null
}
