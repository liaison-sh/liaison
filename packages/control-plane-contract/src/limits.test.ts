// SPDX-License-Identifier: FSL-1.1-ALv2
// Contract v2 additions for limits and providers: the six cap kinds and
// their one bounds table, the tenant lifecycle fields of the billing push, the
// org deletion and mail-sender endpoints, the `mail.domain_*` messages and the
// uniform limit error codes. Every addition is optional or new, so a version-2
// peer that predates them stays valid.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import c2c from "../vectors/c2c.json"
import {
  CAP_KINDS_BY_CAPS_VERSION,
  CELL_BILLING_ERROR_CODES,
  CELL_BILLING_MESSAGE_TYPES,
  CLOUD_API_BASE,
  CLOUD_CAP_BOUNDS,
  CLOUD_CAP_KINDS,
  CLOUD_DELETE_ORG_ERROR_CODES,
  CLOUD_DELETE_ORG_STATES,
  CLOUD_ERROR_CODES,
  CLOUD_LIMIT_ERROR_CODES,
  CONTRACT_VERSION,
  canonicalJson,
  cellBillingMessageSchemas,
  cellBillingOkReplySchemas,
  cellBillingReplySchemas,
  cloudBillingPushRequestSchema,
  cloudBillingStatusSchema,
  cloudCapsSchema,
  cloudDeleteOrgReplySchema,
  cloudDeleteOrgRequestSchema,
  cloudErrorReplySchema,
  cloudMailSenderReplySchema,
  cloudMailSenderRequestSchema,
  cloudPaths,
  MAIL_DOMAIN_MESSAGE_TYPES,
  MAIL_DOMAIN_STATUSES,
  managedBillingStateSchema,
  moneyVectors,
} from "./index"

const ORG = "7d1f3a52-9c4e-4b8a-8f61-2b0e5c9d4a17"

describe("cap kinds and bounds: one table", () => {
  test("nine kinds, jobsPerHour and the app day caps among them, no sharedMailboxes key", () => {
    expect<string[]>([...CLOUD_CAP_KINDS].sort()).toEqual(
      [
        "seats",
        "mailboxes",
        "storageGb",
        "jobsPerHour",
        "customApps",
        "auditDays",
        "appRunsPerDay",
        "appBridgeCallsPerDay",
        "appCpuMsPerDay",
      ].sort(),
    )
    expect(CLOUD_CAP_KINDS).toContain("jobsPerHour")
    expect(CLOUD_CAP_KINDS as readonly string[]).not.toContain("sharedMailboxes")
    expect(Object.keys(CLOUD_CAP_BOUNDS)).toEqual([...CLOUD_CAP_KINDS])
  })

  test("the schema takes each kind's bounds from the table", () => {
    for (const kind of CLOUD_CAP_KINDS) {
      const max = CLOUD_CAP_BOUNDS[kind]
      expect({ kind, ok: cloudCapsSchema.safeParse({ [kind]: 1 }).success }).toEqual({
        kind,
        ok: true,
      })
      expect({ kind, ok: cloudCapsSchema.safeParse({ [kind]: max }).success }).toEqual({
        kind,
        ok: true,
      })
      expect({ kind, ok: cloudCapsSchema.safeParse({ [kind]: max + 1 }).success }).toEqual({
        kind,
        ok: false,
      })
      expect({ kind, ok: cloudCapsSchema.safeParse({ [kind]: 0 }).success }).toEqual({
        kind,
        ok: false,
      })
      expect({ kind, ok: cloudCapsSchema.safeParse({ [kind]: 1.5 }).success }).toEqual({
        kind,
        ok: false,
      })
      expect({ kind, ok: cloudCapsSchema.safeParse({ [kind]: null }).success }).toEqual({
        kind,
        ok: true,
      })
    }
    expect(cloudCapsSchema.safeParse({ sharedMailboxes: 1 }).success).toBe(false)
  })

  test("the vectors exercise every kind: version 1's in the billing push, all in the app caps push", () => {
    const push = moneyVectors.controlToCell["billing push"].body
    expect(Object.keys(push.caps).sort()).toEqual([...CAP_KINDS_BY_CAPS_VERSION[1]].sort())
    const signed = c2c.sign.find((s) => s.name === "billing push")
    expect(Object.keys(JSON.parse(signed?.body ?? "{}").caps).sort()).toEqual(
      [...CAP_KINDS_BY_CAPS_VERSION[1]].sort(),
    )
    const app = c2c.sign.find((s) => s.name.startsWith("billing push with app caps"))
    expect(Object.keys(JSON.parse(app?.body ?? "{}").caps).sort()).toEqual(
      [...CLOUD_CAP_KINDS].sort(),
    )
  })
})

describe("the next plan in the billing push", () => {
  const body = moneyVectors.controlToCell["billing push"].body
  test("carried with its caps, null on the largest plan, absent from an older Control", () => {
    expect(cloudBillingPushRequestSchema.safeParse(body).success).toBe(true)
    expect(body.nextPlan?.id).toBe("base")
    expect(cloudBillingPushRequestSchema.safeParse({ ...body, nextPlan: null }).success).toBe(true)
    const { nextPlan: _n, ...without } = body
    expect(cloudBillingPushRequestSchema.safeParse(without).success).toBe(true)
  })
  test("a plan change no longer reports a mailbox count", () => {
    const m = moneyVectors.cellBilling.valid["billing.change_plan"]
    expect(Object.keys(m.data.usage).sort()).toEqual(["customApps", "seats", "storageBytes"])
    const bad = { ...m, data: { ...m.data, usage: { ...m.data.usage, sharedMailboxes: 1 } } }
    expect(cellBillingMessageSchemas["billing.change_plan"].safeParse(bad).success).toBe(false)
  })
})

describe("tenant lifecycle in the billing push", () => {
  test("status gains closed", () => {
    expect(cloudBillingStatusSchema.options).toEqual(["active", "past_due", "suspended", "closed"])
  })

  test("a closed push with accessUntil, closedAt and billingContact round-trips", () => {
    const body = moneyVectors.controlToCell["billing push closed"].body
    expect(body.status).toBe("closed")
    const parsed = cloudBillingPushRequestSchema.safeParse(body)
    expect(parsed.error?.issues ?? null).toBeNull()
    expect(canonicalJson(parsed.data)).toBe(canonicalJson(body))
  })

  test("the new fields are additive: a push without them is still valid", () => {
    const {
      accessUntil: _a,
      closedAt: _c,
      billingContact: _b,
      ...older
    } = moneyVectors.controlToCell["billing push"].body
    expect(cloudBillingPushRequestSchema.safeParse(older).success).toBe(true)
  })

  test("accessUntil and closedAt are ISO datetimes or null; billingContact is an address", () => {
    const body = moneyVectors.controlToCell["billing push closed"].body
    for (const bad of [
      { accessUntil: "2027-01-01" },
      { closedAt: 1793577600 },
      { billingContact: "" },
      { billingContact: "not an address" },
    ]) {
      expect({
        bad,
        ok: cloudBillingPushRequestSchema.safeParse({ ...body, ...bad }).success,
      }).toEqual({
        bad,
        ok: false,
      })
    }
    expect(
      cloudBillingPushRequestSchema.safeParse({ ...body, accessUntil: null, closedAt: null })
        .success,
    ).toBe(true)
  })

  test("the managed billing state carries status, accessUntil and billingContact", () => {
    const v = moneyVectors.managedBillingState
    expect(v.accessUntil).toBeDefined()
    expect(v.billingContact).toBeDefined()
    const parsed = managedBillingStateSchema.safeParse(v)
    expect(parsed.error?.issues ?? null).toBeNull()
    expect(canonicalJson(parsed.data)).toBe(canonicalJson(v))
    expect(managedBillingStateSchema.safeParse({ ...v, status: "closed" }).success).toBe(true)
  })

  test("the signed billing-push vector carries the lifecycle fields", () => {
    const signed = c2c.sign.find((s) => s.name === "billing push")
    const body = JSON.parse(signed?.body ?? "{}")
    for (const key of ["accessUntil", "closedAt", "billingContact"])
      expect(body).toHaveProperty(key)
    expect(cloudBillingPushRequestSchema.safeParse(body).success).toBe(true)
  })
})

describe("billing.summary openInvoice and billing.topup payment_required", () => {
  test("summary may name the open invoice to pay", () => {
    const [summary] = moneyVectors.cellBilling.replies["billing.summary"]
    expect(summary.openInvoice).toEqual({
      invoiceId: expect.any(String),
      amountDisplay: expect.any(String),
      dueAt: expect.any(String),
    })
    const schema = cellBillingOkReplySchemas["billing.summary"]
    const { openInvoice: _o, ...without } = summary
    expect(schema.safeParse(without).success).toBe(true)
    expect(
      schema.safeParse({ ...summary, openInvoice: { ...summary.openInvoice, dueAt: "soon" } })
        .success,
    ).toBe(false)
  })

  test("topup may answer payment_required", () => {
    expect(
      cellBillingReplySchemas["billing.topup"].safeParse({ ok: false, code: "payment_required" })
        .success,
    ).toBe(true)
  })
})

describe("uniform limit error codes", () => {
  test("the seven documented codes", () => {
    expect<string[]>(Object.values(CLOUD_LIMIT_ERROR_CODES).sort()).toEqual(
      [
        "payment_required",
        "org_suspended",
        "domain_limit",
        "domain_invalid",
        "domain_taken",
        "custom_app_limit",
        "custom_app_capability",
      ].sort(),
    )
  })

  test("Control's cell-billing replies may carry the billing and domain codes", () => {
    for (const code of [
      "payment_required",
      "org_suspended",
      "domain_limit",
      "domain_invalid",
      "domain_taken",
    ]) {
      expect(Object.values(CELL_BILLING_ERROR_CODES) as string[]).toContain(code)
    }
  })
})

describe("DELETE /api/cloud/orgs/:id", () => {
  const v = moneyVectors.controlToCell["delete org"]

  test("path is the org's own path", () => {
    expect(cloudPaths.org(ORG)).toBe(`${CLOUD_API_BASE}/orgs/${ORG}`)
    expect(() => cloudPaths.org("../x")).toThrow()
  })

  test("body is {orgId, timerId}", () => {
    expect(cloudDeleteOrgRequestSchema.safeParse(v.body).success).toBe(true)
    expect(cloudDeleteOrgRequestSchema.safeParse({ orgId: ORG }).success).toBe(false)
    expect(cloudDeleteOrgRequestSchema.safeParse({ ...v.body, extra: 1 }).success).toBe(false)
  })

  test("one reply vector per state", () => {
    expect(CLOUD_DELETE_ORG_STATES).toEqual(["queued", "running", "done", "failed"])
    expect(v.replies.map((r) => r.state)).toEqual([...CLOUD_DELETE_ORG_STATES])
    for (const r of v.replies) expect(cloudDeleteOrgReplySchema.safeParse(r).success).toBe(true)
    expect(cloudDeleteOrgReplySchema.safeParse({ ok: true, state: "gone" }).success).toBe(false)
  })

  test("one error vector per refusal code; export_running is the retryable one", () => {
    expect<string[]>(Object.values(CLOUD_DELETE_ORG_ERROR_CODES).sort()).toEqual(
      ["not_closed", "closed_too_recently", "operator_org", "export_running"].sort(),
    )
    expect(v.errors.map((e) => e.code).sort()).toEqual(
      Object.values(CLOUD_DELETE_ORG_ERROR_CODES).sort(),
    )
    for (const e of v.errors) {
      expect(cloudErrorReplySchema.safeParse(e).success).toBe(true)
      expect(cloudDeleteOrgReplySchema.safeParse(e).success).toBe(true)
    }
    expect(CLOUD_ERROR_CODES.exportRunning).toBe("export_running")
  })

  test("the signed DELETE vector's body parses and names the path's org", () => {
    const entry = c2c.sign.find((s) => s.name === "delete org")
    expect(entry?.method).toBe("DELETE")
    expect(entry?.path).toBe(cloudPaths.org(ORG))
    const body = JSON.parse(entry?.body ?? "{}")
    expect(cloudDeleteOrgRequestSchema.safeParse(body).success).toBe(true)
    expect(body.orgId).toBe(ORG)
  })
})

describe("PUT /api/cloud/orgs/:id/mail-sender", () => {
  const v = moneyVectors.controlToCell["mail sender"]

  test("path", () => {
    expect(cloudPaths.mailSender(ORG)).toBe(`${CLOUD_API_BASE}/orgs/${ORG}/mail-sender`)
  })

  test("a sender or null (back to the fallback), with a monotonic version", () => {
    expect(cloudMailSenderRequestSchema.safeParse(v.body).success).toBe(true)
    expect(cloudMailSenderRequestSchema.safeParse({ ...v.body, sender: null }).success).toBe(true)
    const { sender: _s, ...noSender } = v.body
    expect(cloudMailSenderRequestSchema.safeParse(noSender).success).toBe(false)
    expect(cloudMailSenderRequestSchema.safeParse({ ...v.body, version: 0 }).success).toBe(false)
    expect(
      cloudMailSenderRequestSchema.safeParse({
        ...v.body,
        sender: { ...v.body.sender, fromAddress: "x" },
      }).success,
    ).toBe(false)
    for (const r of v.replies) expect(cloudMailSenderReplySchema.safeParse(r).success).toBe(true)
  })
})

describe("mail.domain_* (cell→Control, cell-billing endpoint)", () => {
  test("four types, each a cell-billing message with requestId and orgId", () => {
    expect([...MAIL_DOMAIN_MESSAGE_TYPES]).toEqual([
      "mail.domain_add",
      "mail.domain_status",
      "mail.domain_verify",
      "mail.domain_remove",
    ])
    for (const type of MAIL_DOMAIN_MESSAGE_TYPES) {
      expect(CELL_BILLING_MESSAGE_TYPES as readonly string[]).toContain(type)
      const message = moneyVectors.cellBilling.valid[type]
      expect(message.v).toBe(CONTRACT_VERSION)
      expect(cellBillingMessageSchemas[type].safeParse(message).success).toBe(true)
    }
  })

  test("domain_add takes a lowercase domain name", () => {
    const base = moneyVectors.cellBilling.valid["mail.domain_add"]
    const schema = cellBillingMessageSchemas["mail.domain_add"]
    for (const domain of [
      "Example.COM",
      "example",
      "-x.example.com",
      "a..example.com",
      "x/y.com",
    ]) {
      expect({
        domain,
        ok: schema.safeParse({ ...base, data: { ...base.data, domain } }).success,
      }).toEqual({
        domain,
        ok: false,
      })
    }
    expect(
      schema.safeParse({ ...base, data: { ...base.data, domain: "mail.acme-audio.example" } })
        .success,
    ).toBe(true)
  })

  test("add returns the domain with its DNS records; status may answer null", () => {
    const [added] = moneyVectors.cellBilling.replies["mail.domain_add"]
    expect(added.domain.records.length).toBeGreaterThan(0)
    expect(MAIL_DOMAIN_STATUSES as readonly string[]).toContain(added.domain.status)
    const status = cellBillingOkReplySchemas["mail.domain_status"]
    expect(status.safeParse({ ok: true, domain: null }).success).toBe(true)
    expect(status.safeParse(added).success).toBe(true)
    expect(
      cellBillingOkReplySchemas["mail.domain_add"].safeParse({ ok: true, domain: null }).success,
    ).toBe(false)
    expect(
      status.safeParse({ ok: true, domain: { ...added.domain, status: "half_done" } }).success,
    ).toBe(false)
  })

  test("domain refusals are uniform errors of every mail.domain_* reply", () => {
    for (const code of ["domain_limit", "domain_invalid", "domain_taken"]) {
      for (const type of MAIL_DOMAIN_MESSAGE_TYPES) {
        expect(cellBillingReplySchemas[type].safeParse({ ok: false, code }).success).toBe(true)
      }
    }
  })
})

describe("the cloud-limits i18n namespace", () => {
  const REPO = resolve(import.meta.dir, "../../..")
  test("exists in every locale and in the generated dictionary", () => {
    for (const locale of ["en", "fr"]) {
      const path = join(REPO, `packages/shared/src/i18n/locales/${locale}/cloud-limits.json`)
      expect(typeof JSON.parse(readFileSync(path, "utf8"))).toBe("object")
    }
    const generated = readFileSync(
      join(REPO, "packages/shared/src/i18n/locales/_generated.ts"),
      "utf8",
    )
    expect(generated).toContain("./en/cloud-limits.json")
    expect(generated).toContain("./fr/cloud-limits.json")
  })
})
