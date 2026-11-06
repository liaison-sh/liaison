// SPDX-License-Identifier: FSL-1.1-ALv2
// Contract v2 money messages: the Control→cell billing push, credit grant,
// credit rate and lookup; the cell→Control `cell-billing` messages and their
// replies; the managed billing-state reply the web app reads.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import c2c from "../vectors/c2c.json"
import {
  CELL_BILLING_ENDPOINT,
  CELL_BILLING_ERROR_CODES,
  CELL_BILLING_MESSAGE_TYPES,
  type CellBillingMessageType,
  CLOUD_API_BASE,
  CLOUD_ERROR_CODES,
  CLOUD_PLAN_TIERS,
  CONTRACT_VERSION,
  canonicalJson,
  cellBillingDataSchemas,
  cellBillingErrorReplySchema,
  cellBillingMessageSchema,
  cellBillingMessageSchemas,
  cellBillingOkReplySchemas,
  cellBillingReplySchemas,
  cloudBillingPushReplySchema,
  cloudBillingPushRequestSchema,
  cloudCreditGrantReplySchema,
  cloudCreditGrantRequestSchema,
  cloudCreditRateReplySchema,
  cloudCreditRateRequestSchema,
  cloudDeleteOrgReplySchema,
  cloudDeleteOrgRequestSchema,
  cloudErrorReplySchema,
  cloudLookupReplySchema,
  cloudLookupRequestSchema,
  cloudMailSenderReplySchema,
  cloudMailSenderRequestSchema,
  cloudPaths,
  contractVectors,
  ENDPOINTS,
  managedBillingStateSchema,
  moneyVectors,
} from "./index"
import { deriveInstanceKey, signBody } from "./node"

const SRC = import.meta.dir
const PKG = resolve(SRC, "..")
const REPO = resolve(SRC, "../../..")

const ORG = "7d1f3a52-9c4e-4b8a-8f61-2b0e5c9d4a17"

function issuePaths(result: { error?: { issues: { path: PropertyKey[] }[] } }): string[][] {
  return result.error?.issues.map((i) => i.path.map(String)) ?? []
}

describe("cell-billing endpoint and message types", () => {
  test("one endpoint name, outside the v1 ENDPOINTS, matching the webhook-name rule", () => {
    expect(CELL_BILLING_ENDPOINT).toBe("cell-billing")
    expect(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(CELL_BILLING_ENDPOINT)).toBe(true)
    expect(Object.values(ENDPOINTS) as string[]).not.toContain(CELL_BILLING_ENDPOINT)
  })

  test("the frozen list of cell→Control message types", () => {
    expect<string[]>([...CELL_BILLING_MESSAGE_TYPES].sort()).toEqual(
      [
        "billing.summary",
        "billing.change_plan",
        "billing.cancel",
        "billing.resume",
        "billing.frame_session",
        "billing.invoices",
        "billing.invoice_pdf",
        "billing.topup",
        "billing.auto_topup_settings",
        "billing.auto_topup_request",
        "usage.report",
        "mail.domain_add",
        "mail.domain_status",
        "mail.domain_verify",
        "mail.domain_remove",
        "move.heartbeat",
        "move.status",
      ].sort(),
    )
  })

  test("every type has a data, envelope, reply schema and a valid and invalid vector", () => {
    const types = [...CELL_BILLING_MESSAGE_TYPES].sort()
    expect(Object.keys(cellBillingDataSchemas).sort()).toEqual(types)
    expect(Object.keys(cellBillingMessageSchemas).sort()).toEqual(types)
    expect(Object.keys(cellBillingOkReplySchemas).sort()).toEqual(types)
    expect(Object.keys(cellBillingReplySchemas).sort()).toEqual(types)
    expect(Object.keys(moneyVectors.cellBilling.valid).sort()).toEqual(types)
    expect(Object.keys(moneyVectors.cellBilling.invalid).sort()).toEqual(types)
    expect(Object.keys(moneyVectors.cellBilling.replies).sort()).toEqual(types)
  })
})

describe("cell-billing messages", () => {
  test("valid vectors round-trip unchanged through their envelope and the union", () => {
    for (const type of CELL_BILLING_MESSAGE_TYPES) {
      const message = moneyVectors.cellBilling.valid[type]
      const parsed = cellBillingMessageSchemas[type].safeParse(message)
      expect({ type, error: parsed.error?.issues ?? null }).toEqual({ type, error: null })
      expect(canonicalJson(parsed.data)).toBe(canonicalJson(message))
      const viaUnion = cellBillingMessageSchema.safeParse(message)
      expect({ type, ok: viaUnion.success }).toEqual({ type, ok: true })
      expect(canonicalJson(viaUnion.data)).toBe(canonicalJson(message))
    }
  })

  test("invalid vectors fail on the named path", () => {
    for (const type of CELL_BILLING_MESSAGE_TYPES) {
      const { message, path } = moneyVectors.cellBilling.invalid[type]
      const parsed = cellBillingMessageSchemas[type].safeParse(message)
      expect({ type, success: parsed.success }).toEqual({ type, success: false })
      expect({ type, paths: issuePaths(parsed) }).toEqual({
        type,
        paths: expect.arrayContaining([[...path]]),
      })
    }
  })

  test("every message carries requestId and orgId, envelope v is 2", () => {
    for (const type of CELL_BILLING_MESSAGE_TYPES) {
      const message = moneyVectors.cellBilling.valid[type]
      expect(message.v).toBe(CONTRACT_VERSION)
      for (const key of ["requestId", "orgId"] as const) {
        const { [key]: _drop, ...rest } = message.data as Record<string, unknown>
        const parsed = cellBillingMessageSchemas[type].safeParse({ ...message, data: rest })
        expect({ type, key, paths: issuePaths(parsed) }).toEqual({
          type,
          key,
          paths: expect.arrayContaining([["data", key]]),
        })
      }
      expect(cellBillingMessageSchemas[type].safeParse({ ...message, v: 1 }).success).toBe(false)
      expect(
        cellBillingMessageSchemas[type].safeParse({ ...message, data: { ...message.data, x: 1 } })
          .success,
      ).toBe(false)
    }
  })

  test("a message of one type does not parse as another", () => {
    const summary = moneyVectors.cellBilling.valid["billing.summary"]
    expect(cellBillingMessageSchemas["billing.cancel"].safeParse(summary).success).toBe(false)
    expect(cellBillingMessageSchema.safeParse({ ...summary, type: "billing.refund" }).success).toBe(
      false,
    )
  })

  test("frame_session: each action carries exactly the fields it needs", () => {
    const base = moneyVectors.cellBilling.valid["billing.frame_session"]
    const schema = cellBillingMessageSchemas["billing.frame_session"]
    const withData = (data: Record<string, unknown>) => ({
      ...base,
      data: { requestId: base.data.requestId, orgId: base.data.orgId, ...data },
    })
    expect(schema.safeParse(withData({ action: "card" })).success).toBe(true)
    expect(schema.safeParse(withData({ action: "topup", credits: 25 })).success).toBe(true)
    expect(
      schema.safeParse(withData({ action: "confirm_invoice", invoiceId: "in_test_1" })).success,
    ).toBe(true)
    for (const bad of [
      { action: "topup" },
      { action: "topup", credits: 0 },
      { action: "topup", credits: 2.5 },
      { action: "confirm_invoice" },
      { action: "card", credits: 10 },
      { action: "card", invoiceId: "in_test_1" },
      { action: "confirm_invoice", invoiceId: "in_test_1", credits: 10 },
      { action: "refund" },
    ]) {
      expect({ bad, ok: schema.safeParse(withData(bad)).success }).toEqual({ bad, ok: false })
    }
  })

  test("change_plan carries the usage Control compares to the target plan's caps", () => {
    const base = moneyVectors.cellBilling.valid["billing.change_plan"]
    const schema = cellBillingMessageSchemas["billing.change_plan"]
    const { storageBytes: _s, ...partial } = base.data.usage
    expect(schema.safeParse({ ...base, data: { ...base.data, usage: partial } }).success).toBe(
      false,
    )
    expect(
      schema.safeParse({ ...base, data: { ...base.data, targetPlan: "enterprise" } }).success,
    ).toBe(false)
  })

  test("usage.report day is a calendar day and the cost a non-negative decimal string", () => {
    const base = moneyVectors.cellBilling.valid["usage.report"]
    const schema = cellBillingMessageSchemas["usage.report"]
    for (const day of ["2026-11-1", "2026-13-01", "2026-11-01T00:00:00Z"]) {
      expect(schema.safeParse({ ...base, data: { ...base.data, day } }).success).toBe(false)
    }
    for (const rawCostUsd of ["-1", "1e3", "abc", 3]) {
      expect(schema.safeParse({ ...base, data: { ...base.data, rawCostUsd } }).success).toBe(false)
    }
  })

  test("a signed cell-billing vector verifies with the instance key and parses", () => {
    const v = contractVectors.signing.find((s) => JSON.parse(s.rawBody).type === "billing.topup")
    expect(v).toBeDefined()
    if (!v) return
    expect(deriveInstanceKey(v.masterSecret, v.instanceId)).toBe(v.instanceKey)
    expect(signBody(v.instanceKey, v.rawBody)).toBe(v.signature)
    const body = JSON.parse(v.rawBody)
    expect(cellBillingMessageSchema.safeParse(body).success).toBe(true)
    expect(body.instanceId).toBe(v.instanceId)
  })
})

describe("cell-billing replies", () => {
  test("every ok reply vector parses with its type's schema and round-trips", () => {
    for (const type of CELL_BILLING_MESSAGE_TYPES) {
      for (const reply of moneyVectors.cellBilling.replies[type]) {
        const ok = cellBillingOkReplySchemas[type].safeParse(reply)
        expect({ type, error: ok.error?.issues ?? null }).toEqual({ type, error: null })
        expect(canonicalJson(ok.data)).toBe(canonicalJson(reply))
        expect(cellBillingReplySchemas[type].safeParse(reply).success).toBe(true)
      }
    }
  })

  test("an ok reply of one type is not the reply of another", () => {
    const summary = moneyVectors.cellBilling.replies["billing.summary"][0]
    expect(cellBillingOkReplySchemas["billing.invoices"].safeParse(summary).success).toBe(false)
  })

  test("every documented error code parses as the uniform error, in every reply union", () => {
    expect(moneyVectors.cellBilling.errors.map((e) => e.code).sort()).toEqual(
      Object.values(CELL_BILLING_ERROR_CODES).sort(),
    )
    for (const error of moneyVectors.cellBilling.errors) {
      expect(cellBillingErrorReplySchema.safeParse(error).success).toBe(true)
      for (const type of CELL_BILLING_MESSAGE_TYPES) {
        expect(cellBillingReplySchemas[type].safeParse(error).success).toBe(true)
      }
    }
    expect(cellBillingErrorReplySchema.safeParse({ ok: false, code: "boom" }).success).toBe(false)
  })

  test("caps_exceeded lists the exceeded caps; no other code carries caps", () => {
    expect(
      cellBillingErrorReplySchema.safeParse({ ok: false, code: "caps_exceeded" }).success,
    ).toBe(false)
    expect(
      cellBillingErrorReplySchema.safeParse({ ok: false, code: "caps_exceeded", caps: [] }).success,
    ).toBe(false)
    expect(
      cellBillingErrorReplySchema.safeParse({
        ok: false,
        code: "billing_unavailable",
        caps: ["seats"],
      }).success,
    ).toBe(false)
  })

  test("invoice_pdf: a PDF in base64 with its sha256, or pdf_too_large", () => {
    const schema = cellBillingReplySchemas["billing.invoice_pdf"]
    const [pdf] = moneyVectors.cellBilling.replies["billing.invoice_pdf"]
    expect(pdf.contentType).toBe("application/pdf")
    expect(schema.safeParse({ ...pdf, contentType: "text/html" }).success).toBe(false)
    expect(schema.safeParse({ ...pdf, sha256: "abc" }).success).toBe(false)
    expect(schema.safeParse({ ...pdf, base64: "not base64!" }).success).toBe(false)
    expect(schema.safeParse({ ok: false, code: "pdf_too_large" }).success).toBe(true)
  })

  test("summary: no URL anywhere, prices only as Control-made display strings", () => {
    const [summary] = moneyVectors.cellBilling.replies["billing.summary"]
    const schema = cellBillingOkReplySchemas["billing.summary"]
    expect(JSON.stringify(summary)).not.toMatch(/https?:\/\//)
    for (const key of ["billingPortalUrl", "checkoutUrl", "hostedInvoiceUrl"]) {
      expect(schema.safeParse({ ...summary, [key]: "https://x.example" }).success).toBe(false)
    }
    expect(
      schema.safeParse({ ...summary, topUp: { ...summary.topUp, currency: "eur" } }).success,
    ).toBe(false)
    const pending = { targetPlan: "base", effectiveAt: "2026-12-01T00:00:00.000Z" }
    expect(
      schema.safeParse({ ...summary, pendingChange: { ...pending, kind: "upgrade_unpaid" } })
        .success,
    ).toBe(true)
    expect(
      schema.safeParse({ ...summary, pendingChange: { ...pending, kind: "sideways" } }).success,
    ).toBe(false)
  })

  test("change_plan and topup: requires_action names the invoice to confirm", () => {
    expect(
      cellBillingOkReplySchemas["billing.change_plan"].safeParse({
        ok: true,
        result: "requires_action",
        effectiveAt: "2026-11-02T10:00:00.000Z",
      }).success,
    ).toBe(false)
    expect(
      cellBillingOkReplySchemas["billing.topup"].safeParse({ ok: true, result: "requires_action" })
        .success,
    ).toBe(false)
  })

  test("frame_session token is 32 random bytes base64url", () => {
    const [reply] = moneyVectors.cellBilling.replies["billing.frame_session"]
    const schema = cellBillingOkReplySchemas["billing.frame_session"]
    expect(schema.safeParse({ ...reply, token: "short" }).success).toBe(false)
    expect(schema.safeParse({ ...reply, url: "https://x.example" }).success).toBe(false)
  })
})

describe("Control→cell money endpoints (§3.4)", () => {
  test("paths", () => {
    expect(cloudPaths.orgs()).toBe(`${CLOUD_API_BASE}/orgs`)
    expect(cloudPaths.handoff(ORG)).toBe(`${CLOUD_API_BASE}/orgs/${ORG}/handoff`)
    expect(cloudPaths.billing(ORG)).toBe(`${CLOUD_API_BASE}/orgs/${ORG}/billing`)
    expect(cloudPaths.credits(ORG)).toBe(`${CLOUD_API_BASE}/orgs/${ORG}/credits`)
    expect(cloudPaths.creditRate()).toBe(`${CLOUD_API_BASE}/settings/credit-rate`)
    expect(cloudPaths.lookup()).toBe(`${CLOUD_API_BASE}/lookup`)
    expect(() => cloudPaths.billing("../x")).toThrow()
  })

  const bodies = [
    ["billing push", cloudBillingPushRequestSchema, cloudBillingPushReplySchema],
    ["billing push closed", cloudBillingPushRequestSchema, cloudBillingPushReplySchema],
    ["credit grant", cloudCreditGrantRequestSchema, cloudCreditGrantReplySchema],
    ["credit rate", cloudCreditRateRequestSchema, cloudCreditRateReplySchema],
    ["lookup", cloudLookupRequestSchema, cloudLookupReplySchema],
    ["delete org", cloudDeleteOrgRequestSchema, cloudDeleteOrgReplySchema],
    ["mail sender", cloudMailSenderRequestSchema, cloudMailSenderReplySchema],
  ] as const

  test("valid bodies and replies round-trip; invalid bodies fail on the named path", () => {
    expect(Object.keys(moneyVectors.controlToCell).sort()).toEqual(
      bodies.map(([name]) => name).sort(),
    )
    for (const [name, request, reply] of bodies) {
      const v = moneyVectors.controlToCell[name]
      const parsed = request.safeParse(v.body)
      expect({ name, error: parsed.error?.issues ?? null }).toEqual({ name, error: null })
      expect(canonicalJson(parsed.data)).toBe(canonicalJson(v.body))
      expect(request.safeParse({ ...v.body, extra: 1 }).success).toBe(false)
      const bad = request.safeParse(v.invalid.body)
      expect({ name, paths: issuePaths(bad) }).toEqual({
        name,
        paths: expect.arrayContaining([[...v.invalid.path]]),
      })
      for (const r of v.replies) {
        const ok = reply.safeParse(r)
        expect({ name, error: ok.error?.issues ?? null }).toEqual({ name, error: null })
      }
    }
  })

  test("billing push: version is a positive integer, autoTopUp is required", () => {
    const body = moneyVectors.controlToCell["billing push"].body
    for (const version of [0, -1, 1.5, "3"]) {
      expect(cloudBillingPushRequestSchema.safeParse({ ...body, version }).success).toBe(false)
    }
    const { autoTopUp: _a, ...noAuto } = body
    expect(cloudBillingPushRequestSchema.safeParse(noAuto).success).toBe(false)
    expect(cloudBillingPushRequestSchema.safeParse({ ...body, previewEndsAt: null }).success).toBe(
      true,
    )
    expect(cloudBillingPushRequestSchema.safeParse({ ...body, status: "trialing" }).success).toBe(
      false,
    )
  })

  test("credit grant kinds are topup, auto_topup and period_reset", () => {
    const body = moneyVectors.controlToCell["credit grant"].body
    for (const kind of ["topup", "auto_topup", "period_reset"]) {
      expect(cloudCreditGrantRequestSchema.safeParse({ ...body, kind }).success).toBe(true)
    }
    expect(cloudCreditGrantRequestSchema.safeParse({ ...body, kind: "gift" }).success).toBe(false)
    expect(cloudCreditGrantRequestSchema.safeParse({ ...body, credits: "0" }).success).toBe(false)
  })

  test("credit rate is a positive decimal string", () => {
    const body = moneyVectors.controlToCell["credit rate"].body
    for (const rate of ["0", "0.000", "-1", "x", 1.5]) {
      expect(cloudCreditRateRequestSchema.safeParse({ ...body, rate }).success).toBe(false)
    }
  })

  test("credit rate carries the fixed-price items' credit prices", () => {
    const body = moneyVectors.controlToCell["credit rate"].body
    const { unitPrices: _u, ...noUnits } = body
    expect(cloudCreditRateRequestSchema.safeParse(noUnits).success).toBe(false)
    for (const unitPrices of [
      { webCall: "0.04" },
      { webCall: "0.04", dictationMinute: "0.3", search: "1" },
      { webCall: 0.04, dictationMinute: "0.3" },
      { webCall: "-1", dictationMinute: "0.3" },
    ]) {
      expect(cloudCreditRateRequestSchema.safeParse({ ...body, unitPrices }).success).toBe(false)
    }
    // A free item is a choice Control may make.
    expect(
      cloudCreditRateRequestSchema.safeParse({
        ...body,
        unitPrices: { webCall: "0", dictationMinute: "0.3" },
      }).success,
    ).toBe(true)
  })

  test("a grant with a different amount has its own error code", () => {
    expect(CLOUD_ERROR_CODES.grantConflict).toBe("grant_conflict")
    expect(cloudErrorReplySchema.safeParse({ ok: false, code: "grant_conflict" }).success).toBe(
      true,
    )
  })

  test("the signed billing-push vector's body parses as the push", () => {
    const entry = c2c.sign.find((s) => s.name === "billing push")
    expect(entry).toBeDefined()
    if (!entry) return
    expect(entry.path).toBe(cloudPaths.billing(ORG))
    expect(cloudBillingPushRequestSchema.safeParse(JSON.parse(entry.body)).success).toBe(true)
  })
})

describe("managed billing state (GET /api/billing/state, managed edition)", () => {
  test("the vector parses and round-trips; no portal or checkout URL is accepted", () => {
    const v = moneyVectors.managedBillingState
    const parsed = managedBillingStateSchema.safeParse(v)
    expect(parsed.error?.issues ?? null).toBeNull()
    expect(canonicalJson(parsed.data)).toBe(canonicalJson(v))
    for (const key of ["billingPortalUrl", "checkoutUrl"]) {
      expect(managedBillingStateSchema.safeParse({ ...v, [key]: "" }).success).toBe(false)
    }
    expect(managedBillingStateSchema.safeParse({ ...v, mode: "self_hosted" }).success).toBe(false)
  })

  test("plan → tier map, and the vector's tier matches its plan", () => {
    expect(CLOUD_PLAN_TIERS).toEqual({ preview: "starter", base: "team", pro: "business" })
    const v = moneyVectors.managedBillingState
    expect(v.tier).toBe(CLOUD_PLAN_TIERS[v.plan])
    expect(managedBillingStateSchema.safeParse({ ...v, tier: "free" }).success).toBe(false)
  })
})

describe("public repo hygiene", () => {
  const files = [
    ...readdirSync(SRC)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(SRC, f)),
    ...readdirSync(join(PKG, "vectors")).map((f) => join(PKG, "vectors", f)),
  ]

  test("no deployment host names in the contract or its vectors", () => {
    // Assembled so this file does not match itself.
    const host = ["liaison", "sh"].join(".")
    for (const file of files) {
      expect({ file, hit: readFileSync(file, "utf8").includes(host) }).toEqual({
        file,
        hit: false,
      })
    }
  })

  test("the cloud-billing namespace exists in every locale (owned by the Billing page)", () => {
    for (const locale of ["en", "fr"]) {
      const path = join(REPO, `packages/shared/src/i18n/locales/${locale}/cloud-billing.json`)
      expect(typeof JSON.parse(readFileSync(path, "utf8"))).toBe("object")
    }
    const generated = readFileSync(
      join(REPO, "packages/shared/src/i18n/locales/_generated.ts"),
      "utf8",
    )
    expect(generated).toContain("./en/cloud-billing.json")
    expect(generated).toContain("./fr/cloud-billing.json")
  })
})

// Type-level: the union's type narrows on `type`.
const _typeCheck: CellBillingMessageType = "billing.topup"
void _typeCheck
