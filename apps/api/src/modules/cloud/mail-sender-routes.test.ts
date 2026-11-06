// SPDX-License-Identifier: FSL-1.1-ALv2
// `/api/mail-sender/*`: the org's sending domain in Settings → Organization
// (S29), forwarded to the control plane:
//  - 404 outside the managed edition, org admins only (member 403), no session 401;
//  - GET status, POST add {domain}, POST verify, DELETE remove each send one
//    signed `mail.domain_*` message for the caller's org with the body the
//    contract names, and answer the domain the control plane replies;
//  - the control plane down → 503 billing_unavailable;
//  - domain_limit / domain_taken → 409, domain_invalid → 422, code kept;
//  - an invalid domain is refused here (400) and never sent.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { cellBillingMessageSchema } from "@liaison/control-plane-contract"
import { app } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
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

const INSTANCE_KEY = "b8".repeat(32)
const ENDPOINT = "https://control.test/webhooks/x/control"

const mutableEnv = env as { LIAISON_TEAM_ENDPOINT: string; LIAISON_ORG_HOST_TEMPLATE?: string }
const saved = { ...mutableEnv }

interface Sent {
  url: string
  headers: Record<string, string>
  raw: string
  body: { type: string; instanceId: string; data: Record<string, unknown> }
}
let sent: Sent[] = []

function control(reply: unknown, status = 200) {
  BillingClientTestAccess.setFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const raw = String(init?.body ?? "")
    sent.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      raw,
      body: JSON.parse(raw),
    })
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify({ data: reply }), { status })
  }) as typeof fetch)
}

const DOMAIN = {
  id: "d_123",
  name: "mail.fabrikam.example",
  status: "pending",
  records: [
    { type: "MX", name: "send.mail", value: "feedback-smtp.eu-west-1.example", priority: 10 },
    { type: "TXT", name: "send.mail", value: "v=spf1 include:example ~all" },
  ],
}

let admin: { bearer: string; orgId: string }
let member: { bearer: string }

async function call(path: string, init: RequestInit = {}, bearer = admin.bearer) {
  return app.request(`http://localhost/api/mail-sender${path}`, {
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
  await withSystemDb("test-mail-sender-identity", (db) => writeIdentity(db, identity))
  const a = await minimal.adminSession((await createTestOrg()).id)
  admin = { bearer: a.bearer, orgId: a.orgId }
  const m = await minimal.session(a.orgId, { role: "member" })
  member = { bearer: m.bearer }
})

afterAll(async () => {
  Object.assign(mutableEnv, saved)
  _setEdition(null)
  BillingClientTestAccess.setFetch(null)
  await withSystemDb("test-mail-sender-identity", (db) => deleteIdentity(db))
  await releaseTestLock()
})

beforeEach(() => {
  sent = []
  _setEdition("managed")
  mutableEnv.LIAISON_TEAM_ENDPOINT = ENDPOINT
})

afterEach(() => BillingClientTestAccess.setFetch(null))

describe("access", () => {
  test("self-hosted: 404 on every route, nothing sent", async () => {
    _setEdition("self_hosted")
    control({ ok: true, domain: null })
    for (const [method, path, body] of [
      ["GET", "/status", undefined],
      ["POST", "/domain", JSON.stringify({ domain: DOMAIN.name })],
      ["POST", "/verify", "{}"],
      ["DELETE", "/domain", undefined],
    ] as const) {
      const r = await call(path, { method, ...(body ? { body } : {}) })
      expect({ path, method, status: r.status }).toEqual({ path, method, status: 404 })
    }
    expect(sent).toHaveLength(0)
  })

  test("a member is refused (403), nothing sent", async () => {
    control({ ok: true, domain: null })
    expect((await call("/status", {}, member.bearer)).status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  test("no session: 401", async () => {
    expect((await app.request("http://localhost/api/mail-sender/status")).status).toBe(401)
  })
})

describe("forwarding", () => {
  test("status: one signed mail.domain_status for the caller's org; null passes through", async () => {
    control({ ok: true, domain: null })
    const r = await call("/status")
    expect(r.status).toBe(200)
    expect(((await r.json()) as { data: unknown }).data).toEqual({ domain: null })
    const [s] = sent as [Sent]
    expect(s.url).toBe(`${ENDPOINT}/cell-billing`)
    expect(s.headers["x-liaison-signature"]).toBe(
      createHmac("sha256", INSTANCE_KEY).update(s.raw).digest("base64"),
    )
    expect(cellBillingMessageSchema.safeParse(s.body).success).toBe(true)
    expect(s.body.type).toBe("mail.domain_status")
    expect(s.body.data.orgId).toBe(admin.orgId)
  })

  test("add: forwards {domain} (lowercased), answers the domain with its records", async () => {
    control({ ok: true, domain: DOMAIN })
    const requestId = crypto.randomUUID()
    const r = await call("/domain", {
      method: "POST",
      body: JSON.stringify({ domain: "Mail.Fabrikam.Example", requestId }),
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { data: unknown }).data).toEqual({ domain: DOMAIN })
    const [s] = sent as [Sent]
    expect(s.body.type).toBe("mail.domain_add")
    expect(s.body.data).toEqual({ requestId, orgId: admin.orgId, domain: DOMAIN.name })
  })

  test("add: an invalid domain is refused here (400), nothing sent", async () => {
    control({ ok: true, domain: DOMAIN })
    for (const domain of ["not a domain", "localhost", "-bad.example", ""]) {
      const r = await call("/domain", { method: "POST", body: JSON.stringify({ domain }) })
      expect({ domain, status: r.status }).toEqual({ domain, status: 400 })
    }
    expect(sent).toHaveLength(0)
  })

  test("verify: forwards mail.domain_verify, answers the new status", async () => {
    control({ ok: true, domain: { ...DOMAIN, status: "verified" } })
    const r = await call("/verify", { method: "POST", body: "{}" })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { data: { domain: { status: string } } }
    expect(body.data.domain.status).toBe("verified")
    const [s] = sent as [Sent]
    expect(s.body.type).toBe("mail.domain_verify")
    expect(Object.keys(s.body.data).sort()).toEqual(["orgId", "requestId"])
  })

  test("remove: forwards mail.domain_remove", async () => {
    control({ ok: true })
    const r = await call("/domain", { method: "DELETE" })
    expect(r.status).toBe(200)
    const [s] = sent as [Sent]
    expect(s.body.type).toBe("mail.domain_remove")
    expect(s.body.data.orgId).toBe(admin.orgId)
  })

  test("control plane down → 503 billing_unavailable", async () => {
    control(new Error("connect ECONNREFUSED"))
    const r = await call("/status")
    expect(r.status).toBe(503)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("billing_unavailable")
  })

  test("refusals keep their code: domain_limit/taken 409, invalid 422", async () => {
    for (const [code, status] of [
      ["domain_limit", 409],
      ["domain_taken", 409],
      ["domain_invalid", 422],
    ] as const) {
      control({ ok: false, code })
      const r = await call("/domain", {
        method: "POST",
        body: JSON.stringify({ domain: DOMAIN.name }),
      })
      const body = (await r.json()) as { error: { code: string; message: string } }
      expect({ code, status: r.status, got: body.error.code }).toEqual({ code, status, got: code })
      // No account detail from the provider reaches the browser.
      expect(body.error.message).not.toMatch(/resend|plan|account/i)
    }
  })
})
