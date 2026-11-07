// SPDX-License-Identifier: FSL-1.1-ALv2
// The managed Billing page's API (spec S17):
//  - 404 on every route outside the managed edition; org admins only (member 403);
//  - each route forwards one signed v2 cell-billing message (instance header,
//    HMAC over the raw body) carrying the org and the browser's request id;
//  - the control plane unreachable (or answering garbage) → 503 billing_unavailable;
//  - a refusal keeps its code (`caps_exceeded` lists the caps);
//  - a change of plan sends the org's current usage;
//  - the invoice PDF is streamed as the exact bytes with attachment headers, a
//    digest mismatch is refused, `pdf_too_large` → 502 with the code;
//  - the frame session answers the frame URL on the configured origin;
//  - the web shell's CSP names the payment frame origin in the managed edition only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createHash, createHmac, randomUUID } from "node:crypto"
import { cellBillingMessageSchema } from "@liaison/control-plane-contract"
import { app } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { contentSecurityPolicy } from "~/middleware/security-headers"
import { BillingClientTestAccess } from "~/modules/billing-managed/control-client"
import {
  deleteIdentity,
  encryptInstanceKey,
  mintIdentity,
  writeIdentity,
} from "~/modules/liaison-team/identity"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const INSTANCE_KEY = "a7".repeat(32)
const ENDPOINT = "https://control.test/webhooks/x/control"
const PAY_ORIGIN = "https://pay.frame.test"

const mutableEnv = env as {
  LIAISON_EDITION?: string
  LIAISON_ORG_HOST_TEMPLATE?: string
  LIAISON_TEAM_ENDPOINT: string
  LIAISON_PAY_FRAME_ORIGIN?: string
}
const saved = { ...mutableEnv }

interface Sent {
  url: string
  headers: Record<string, string>
  raw: string
  body: { type: string; instanceId: string; data: Record<string, unknown> }
}
let sent: Sent[] = []
let instanceId = ""

/** Answer every call with `reply` (under the kernel's `{data}` envelope) or throw. */
function control(reply: unknown | ((s: Sent) => unknown), status = 200) {
  BillingClientTestAccess.setFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const raw = String(init?.body ?? "")
    const s: Sent = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      raw,
      body: JSON.parse(raw),
    }
    sent.push(s)
    const value = typeof reply === "function" ? (reply as (s: Sent) => unknown)(s) : reply
    if (value instanceof Error) throw value
    return new Response(JSON.stringify({ data: value }), { status })
  }) as typeof fetch)
}

const SUMMARY = {
  ok: true,
  plan: "base",
  status: "active",
  periodEnd: "2026-12-01T00:00:00.000Z",
  previewEndsAt: null,
  cancelAt: null,
  nextInvoice: { amountDisplay: "€34.80", date: "2026-12-01T00:00:00.000Z" },
  plans: [
    { id: "base", priceDisplay: "€31.50", includedCredits: "250", caps: { seats: null } },
    { id: "pro", priceDisplay: "€88.50", includedCredits: "1000", caps: { seats: null } },
  ],
  topUp: { minCredits: 10, unitPriceCents: 100, currency: "EUR" },
  autoTopUp: { enabled: false, thresholdCredits: 20, amountCredits: 50 },
}

let admin: { bearer: string; orgId: string }
let member: { bearer: string }

async function call(path: string, init: RequestInit = {}, bearer = admin.bearer) {
  return app.request(`http://localhost/api/billing/managed${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}

beforeAll(async () => {
  await acquireTestLock()
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = undefined
  const identity = {
    ...mintIdentity(),
    keyCiphertext: encryptInstanceKey(INSTANCE_KEY),
    state: "registered" as const,
    registeredAt: new Date().toISOString(),
  }
  instanceId = identity.instanceId
  await withSystemDb("test-billing-identity", (db) => writeIdentity(db, identity))
  const a = await minimal.adminSession((await createTestOrg()).id)
  admin = { bearer: a.bearer, orgId: a.orgId }
  const m = await minimal.session(a.orgId, { role: "member" })
  member = { bearer: m.bearer }
})

afterAll(async () => {
  Object.assign(mutableEnv, saved)
  _setEdition(null)
  BillingClientTestAccess.setFetch(null)
  await withSystemDb("test-billing-identity", (db) => deleteIdentity(db))
  await releaseTestLock()
})

beforeEach(() => {
  sent = []
  _setEdition("managed")
  mutableEnv.LIAISON_TEAM_ENDPOINT = ENDPOINT
  mutableEnv.LIAISON_PAY_FRAME_ORIGIN = PAY_ORIGIN
})

afterEach(() => {
  BillingClientTestAccess.setFetch(null)
})

describe("access", () => {
  test("self-hosted: 404 on every route, nothing sent", async () => {
    _setEdition("self_hosted")
    control(SUMMARY)
    for (const [method, path] of [
      ["GET", "/summary"],
      ["POST", "/topup"],
      ["GET", "/invoices"],
      ["GET", "/invoices/in_1/pdf"],
      ["PUT", "/auto-topup"],
    ] as const) {
      const r = await call(path, { method, ...(method === "GET" ? {} : { body: "{}" }) })
      expect({ path, status: r.status }).toEqual({ path, status: 404 })
    }
    expect(sent).toHaveLength(0)
  })

  test("a member is refused (403), nothing sent", async () => {
    control(SUMMARY)
    const r = await call("/summary", {}, member.bearer)
    expect(r.status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  test("no session: 401", async () => {
    const r = await app.request("http://localhost/api/billing/managed/summary")
    expect(r.status).toBe(401)
  })
})

describe("forwarding", () => {
  test("summary: one signed v2 message for the caller's org; the reply passes through", async () => {
    control(SUMMARY)
    const r = await call("/summary")
    expect(r.status).toBe(200)
    expect(((await r.json()) as { data: unknown }).data).toEqual(SUMMARY)
    expect(sent).toHaveLength(1)
    const [s] = sent as [Sent]
    expect(s.url).toBe(`${ENDPOINT}/cell-billing`)
    expect(s.headers["x-liaison-instance"]).toBe(instanceId)
    expect(s.headers["x-liaison-signature"]).toBe(
      createHmac("sha256", INSTANCE_KEY).update(s.raw).digest("base64"),
    )
    expect(cellBillingMessageSchema.safeParse(s.body).success).toBe(true)
    expect(s.body.type).toBe("billing.summary")
    expect(s.body.data.orgId).toBe(admin.orgId)
  })

  test("control plane down → 503 billing_unavailable", async () => {
    control(new Error("connect ECONNREFUSED"))
    const r = await call("/summary")
    expect(r.status).toBe(503)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("billing_unavailable")
  })

  test("a reply that is not the contract's, or a 403 → 503", async () => {
    control({ ok: true, plan: "gold" })
    expect((await call("/summary")).status).toBe(503)
    control("not_trusted", 403)
    expect((await call("/summary")).status).toBe(503)
    // A non-200 is refused even when its body is a valid reply.
    control(SUMMARY, 409)
    expect((await call("/summary")).status).toBe(503)
    control(SUMMARY, 404)
    expect((await call("/summary")).status).toBe(503)
  })

  test("change plan sends the org's usage and the browser's request id; caps_exceeded lists caps", async () => {
    const requestId = randomUUID()
    control({ ok: false, code: "caps_exceeded", caps: ["seats", "storageGb"] })
    const r = await call("/change-plan", {
      method: "POST",
      body: JSON.stringify({ targetPlan: "base", requestId }),
    })
    expect(r.status).toBe(409)
    const err = ((await r.json()) as { error: { code: string; details: { caps: string[] } } }).error
    expect(err.code).toBe("caps_exceeded")
    expect(err.details.caps).toEqual(["seats", "storageGb"])
    const data = (sent[0] as Sent).body.data
    expect(data.requestId).toBe(requestId)
    expect(data.targetPlan).toBe("base")
    const usage = data.usage as Record<string, number>
    expect(usage.seats).toBeGreaterThanOrEqual(2)
    expect(usage).not.toHaveProperty("sharedMailboxes")
    expect(usage.customApps).toBe(0)
    expect(typeof usage.storageBytes).toBe("number")
  })

  test("top-up: requires_action passes through; the request id is kept", async () => {
    const requestId = randomUUID()
    control({ ok: true, result: "requires_action", invoiceId: "in_123" })
    const r = await call("/topup", {
      method: "POST",
      body: JSON.stringify({ credits: 25, requestId }),
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { data: { result: string } }).data.result).toBe("requires_action")
    expect((sent[0] as Sent).body.data).toEqual({ requestId, orgId: admin.orgId, credits: 25 })
  })

  test("frame session: the frame URL is on the configured origin with the token", async () => {
    const token = "A".repeat(43)
    control({ ok: true, token, expiresAt: "2026-11-02T23:05:00.000Z" })
    const r = await call("/frame-session", {
      method: "POST",
      body: JSON.stringify({ action: "topup", credits: 30 }),
    })
    expect(r.status).toBe(200)
    const data = ((await r.json()) as { data: Record<string, string> }).data
    expect(data.frameOrigin).toBe(PAY_ORIGIN)
    expect(data.frameUrl).toBe(`${PAY_ORIGIN}/?t=${token}`)
    expect((sent[0] as Sent).body.data.action).toBe("topup")
  })
})

describe("invoice PDF", () => {
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe, 0x80, 0x0a])
  const sha256 = createHash("sha256").update(bytes).digest("hex")

  test("streams the exact bytes as an attachment", async () => {
    control({
      ok: true,
      filename: "Invoice LS-0042.pdf",
      contentType: "application/pdf",
      base64: bytes.toString("base64"),
      sha256,
    })
    const r = await call("/invoices/in_42/pdf")
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toBe("application/pdf")
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="Invoice_LS-0042.pdf"')
    expect(Buffer.from(await r.arrayBuffer()).equals(bytes)).toBe(true)
    expect((sent[0] as Sent).body.data.invoiceId).toBe("in_42")
  })

  test("a digest mismatch is refused (502)", async () => {
    control({
      ok: true,
      filename: "a.pdf",
      contentType: "application/pdf",
      base64: bytes.toString("base64"),
      sha256: "0".repeat(64),
    })
    expect((await call("/invoices/in_42/pdf")).status).toBe(502)
  })

  test("pdf_too_large → 502 with the code", async () => {
    control({ ok: false, code: "pdf_too_large" })
    const r = await call("/invoices/in_42/pdf")
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("pdf_too_large")
  })
})

describe("CSP frame-src", () => {
  test("names the payment frame origin on the web shell in the managed edition only", () => {
    const managed = contentSecurityPolicy({ storageOrigin: null, scriptHashes: [] })
    // blob: is the document PDF frame every web shell allows (security-headers.ts).
    expect(managed).toContain(`frame-src 'self' blob: ${PAY_ORIGIN}`)
    // API responses never open it.
    expect(contentSecurityPolicy({ storageOrigin: null })).not.toContain(PAY_ORIGIN)
    _setEdition("self_hosted")
    const selfHosted = contentSecurityPolicy({ storageOrigin: null, scriptHashes: [] })
    expect(selfHosted).not.toContain(PAY_ORIGIN)
    expect(selfHosted).toMatch(/frame-src 'self' blob:(;|$)/)
  })
})
