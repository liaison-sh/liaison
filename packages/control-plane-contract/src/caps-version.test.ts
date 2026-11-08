// SPDX-License-Identifier: FSL-1.1-ALv2
// The caps version and the `apps.usage` message: the rollout of the app cap
// kinds is safe in both mixed-version pairs.
//  - new Control, old cell: Control sends a cell only the kinds of the caps
//    version it reported (a cell that reported none is version 1), so the old
//    cell's strict caps schema never sees a kind it would refuse;
//  - old Control, new cell: app usage travels in its own `apps.usage`
//    message, never inside `usage.report`, so an old Control refusing the new
//    type leaves the billing report as it was.
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import c2c from "../vectors/c2c.json"
import {
  CAP_KINDS_BY_CAPS_VERSION,
  CAPS_CONTRACT_VERSION,
  CLOUD_CAP_KINDS,
  capKindsForCapsVersion,
  capsForCapsVersion,
  cellBillingMessageSchemas,
  cloudBillingPushRequestSchema,
  cloudCapsSchema,
  moneyVectors,
} from "./index"

/** The caps schema of a caps-version-1 cell: strict over the six original kinds. */
const v1CapsSchema = z.strictObject(
  Object.fromEntries(
    CAP_KINDS_BY_CAPS_VERSION[1].map((k) => [k, z.number().int().min(1).nullable().optional()]),
  ),
)

const fullCaps = {
  seats: 3,
  mailboxes: 2,
  storageGb: 5,
  jobsPerHour: 600,
  customApps: 2,
  auditDays: 45,
  appRunsPerDay: 5000,
  appBridgeCallsPerDay: 50_000,
  appCpuMsPerDay: 600_000,
}

describe("caps version", () => {
  test("version 2 is this contract's and holds every kind; version 1 the original six", () => {
    expect(CAPS_CONTRACT_VERSION).toBe(2)
    expect(CAP_KINDS_BY_CAPS_VERSION[2]).toEqual(CLOUD_CAP_KINDS)
    const v1: string[] = [...CAP_KINDS_BY_CAPS_VERSION[1]].sort()
    expect(v1).toEqual(
      ["auditDays", "customApps", "jobsPerHour", "mailboxes", "seats", "storageGb"].sort(),
    )
    for (const k of ["appRunsPerDay", "appBridgeCallsPerDay", "appCpuMsPerDay"]) {
      expect(CLOUD_CAP_KINDS).toContain(k as never)
    }
  })

  test("an unknown, absent or odd version reads as 1", () => {
    for (const v of [undefined, null, 0, 1, 1.5, -3]) {
      expect(capKindsForCapsVersion(v)).toEqual(CAP_KINDS_BY_CAPS_VERSION[1])
    }
    expect(capKindsForCapsVersion(2)).toEqual(CLOUD_CAP_KINDS)
    expect(capKindsForCapsVersion(7)).toEqual(CLOUD_CAP_KINDS)
  })

  test("new Control -> old cell: the caps it sends pass the old cell's strict schema", () => {
    expect(v1CapsSchema.safeParse(fullCaps).success).toBe(false)
    const forOld = capsForCapsVersion(fullCaps, undefined)
    expect(v1CapsSchema.safeParse(forOld).success).toBe(true)
    expect(Object.keys(forOld)).not.toContain("appRunsPerDay")
  })

  test("new Control -> new cell: every kind is sent and accepted", () => {
    const forNew = capsForCapsVersion(fullCaps, 2)
    expect(forNew).toEqual(fullCaps)
    expect(cloudCapsSchema.safeParse(forNew).success).toBe(true)
  })

  test("the signed vector of a billing push with app caps parses on a version 2 cell", () => {
    const v = c2c.sign.find((s) => s.name.startsWith("billing push with app caps"))
    expect(v).toBeDefined()
    const body = JSON.parse(v?.body ?? "{}")
    expect(cloudBillingPushRequestSchema.safeParse(body).success).toBe(true)
    expect(v1CapsSchema.safeParse(body.caps).success).toBe(false)
  })
})

describe("apps.usage", () => {
  test("a separate message type: usage.report stays exactly as it was", () => {
    const report = moneyVectors.cellBilling.valid["usage.report"]
    // An app row inside usage.report is refused (strict), so it never rides there.
    const withApps = { ...report, data: { ...report.data, apps: [] } }
    expect(cellBillingMessageSchemas["usage.report"].safeParse(withApps).success).toBe(false)
    expect(cellBillingMessageSchemas["usage.report"].safeParse(report).success).toBe(true)
  })

  test("carries the cell's caps version and per (app, executor) rows; cpuMs may be null", () => {
    const m = moneyVectors.cellBilling.valid["apps.usage"]
    const parsed = cellBillingMessageSchemas["apps.usage"].safeParse(m)
    expect(parsed.success).toBe(true)
    expect(parsed.data?.data.capsVersion).toBe(CAPS_CONTRACT_VERSION)
    const empty = { ...m, data: { ...m.data, rows: [] } }
    expect(cellBillingMessageSchemas["apps.usage"].safeParse(empty).success).toBe(true)
    const negative = {
      ...m,
      data: { ...m.data, rows: [{ ...m.data.rows[0], runs: -1 }] },
    }
    expect(cellBillingMessageSchemas["apps.usage"].safeParse(negative).success).toBe(false)
  })
})
