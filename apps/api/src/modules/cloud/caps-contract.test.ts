// SPDX-License-Identifier: FSL-1.1-ALv2
// The plan caps Control sends (org creation, billing push, the plan list) are
// exactly the caps an org can hold: the contract's caps schema names the same
// kinds as the cell's `orgCapsSchema`, and every caps object in the contract
// vectors is one the cell accepts. A key only Control knew made org creation
// fail as an opaque cell error.
import { describe, expect, it } from "bun:test"
import {
  CLOUD_CAP_BOUNDS,
  CLOUD_CAP_KINDS,
  CLOUD_LIMIT_ERROR_CODES,
  cloudCapsSchema,
  moneyVectors,
} from "@liaison/control-plane-contract"
import c2c from "@liaison/control-plane-contract/vectors/c2c.json"
import {
  ORG_CAP_BOUNDS,
  ORG_CAP_KINDS,
  ORG_SUSPENDED_CODE,
  ORG_SUSPENDED_WS_CLOSE,
  orgCapsSchema,
  orgSuspendedErrorSchema,
  PAYMENT_REQUIRED_CODE,
} from "@liaison/shared"

/** Every `caps` object (not a `caps_exceeded` name list) anywhere in a value. */
function capsObjects(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) for (const v of value) capsObjects(v, out)
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "caps" && v && typeof v === "object" && !Array.isArray(v)) out.push(v)
      else capsObjects(v, out)
    }
  }
  return out
}

describe("plan caps: contract and cell agree", () => {
  it("names the same cap kinds, jobsPerHour among them", () => {
    expect([...CLOUD_CAP_KINDS].sort()).toEqual([...ORG_CAP_KINDS].sort())
    expect(ORG_CAP_KINDS).toContain("jobsPerHour")
    const kinds: string[] = [...ORG_CAP_KINDS].sort()
    expect(kinds).toEqual(
      ["seats", "mailboxes", "storageGb", "jobsPerHour", "customApps", "auditDays"].sort(),
    )
  })

  it("takes every bound from one table", () => {
    // The same object, not an equal copy: a second literal could drift.
    expect(ORG_CAP_BOUNDS).toBe(CLOUD_CAP_BOUNDS)
    expect(Object.keys(ORG_CAP_BOUNDS).sort()).toEqual([...ORG_CAP_KINDS].sort())
    for (const kind of ORG_CAP_KINDS) {
      const max = ORG_CAP_BOUNDS[kind]
      for (const schema of [orgCapsSchema, cloudCapsSchema]) {
        expect({ kind, ok: schema.safeParse({ [kind]: max }).success }).toEqual({ kind, ok: true })
        expect({ kind, ok: schema.safeParse({ [kind]: max + 1 }).success }).toEqual({
          kind,
          ok: false,
        })
      }
    }
  })

  it("every caps object in the vectors is one the cell accepts", () => {
    const signedBodies = c2c.sign.flatMap((s) => (s.body ? [JSON.parse(s.body) as unknown] : []))
    const all = capsObjects([moneyVectors, signedBodies])
    expect(all.length).toBeGreaterThan(2)
    for (const caps of all) {
      expect(orgCapsSchema.safeParse(caps).error?.issues ?? null).toBeNull()
      expect(cloudCapsSchema.safeParse(caps).success).toBe(true)
    }
  })

  it("the contract refuses a cap the cell does not know, and a zero cap", () => {
    for (const key of ["sharedMailboxes", "customAppsMax", "auditRetentionDays"]) {
      expect(cloudCapsSchema.safeParse({ seats: 3, [key]: 1 }).success).toBe(false)
    }
    expect(cloudCapsSchema.safeParse({ seats: 0 }).success).toBe(false)
    expect(cloudCapsSchema.safeParse({ seats: null, jobsPerHour: 600 }).success).toBe(true)
  })
})

describe("limit codes: product and contract agree", () => {
  it("org_suspended and payment_required are the contract's codes", () => {
    expect(ORG_SUSPENDED_CODE).toBe(CLOUD_LIMIT_ERROR_CODES.orgSuspended)
    expect(PAYMENT_REQUIRED_CODE).toBe(CLOUD_LIMIT_ERROR_CODES.paymentRequired)
    expect(ORG_SUSPENDED_WS_CLOSE).toBe(4004)
  })

  it("the 403 org_suspended error carries accessUntil and contact", () => {
    const body = {
      code: "org_suspended",
      accessUntil: "2027-01-16T10:00:00.000Z",
      contact: "billing@example.com",
    }
    expect(orgSuspendedErrorSchema.safeParse(body).success).toBe(true)
    expect(
      orgSuspendedErrorSchema.safeParse({ ...body, accessUntil: null, contact: null }).success,
    ).toBe(true)
    const { contact: _c, ...noContact } = body
    expect(orgSuspendedErrorSchema.safeParse(noContact).success).toBe(false)
    expect(
      orgSuspendedErrorSchema.safeParse({ ...body, code: "demo_workspace_expired" }).success,
    ).toBe(false)
  })
})
