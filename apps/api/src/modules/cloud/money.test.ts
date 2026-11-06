// SPDX-License-Identifier: FSL-1.1-ALv2
// The cell's billing surface in the managed edition (spec S16, S21, S41):
//  - the billing push applies only a newer version (reverse and concurrent
//    delivery keep the newest), maps the plan onto the kernel tier, sets the
//    caps, and a failed auto top-up raises one attention item for admins;
//  - credit grants are idempotent on grantId (a different amount or kind is
//    409, nothing credited); a period reset sets the included credits;
//  - the credit rate applies only a newer version and never reaches a client;
//  - the workspace lookup lists the orgs where an email is a member;
//  - `GET /api/billing/state` serves the stored push in the managed edition,
//    and the self-hosted reply is byte-identical to before;
//  - `/api/admin/billing/*` answers 404 in both editions;
//  - BYOK provider keys and own model servers are refused in the managed edition.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { managedBillingStateSchema } from "@liaison/control-plane-contract"
import { deriveControlToCellKey, signControlRequest } from "@liaison/control-plane-contract/node"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { readCreditPricing, readCreditRate } from "~/modules/cloud/credit-rate"
import {
  deleteIdentity,
  encryptInstanceKey,
  mintIdentity,
  writeIdentity,
} from "~/modules/liaison-team/identity"
import { seedUserRow } from "~/seed/factories/org/rows"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const INSTANCE_KEY = "c3".repeat(32)
const CONTROL_KEY = deriveControlToCellKey(INSTANCE_KEY)
const WRONG_KEY = deriveControlToCellKey("d4".repeat(32))
const TEMPLATE = "https://{slug}.cells.test"
const CELL = "https://cell-2-origin.cells.test"
/** A rate no response could contain by accident. */
const SECRET_RATE = "7.654321"
const UNIT_PRICES = { webCall: "0.02", dictationMinute: "0.05" }

const mutableEnv = env as { LIAISON_EDITION?: string; LIAISON_ORG_HOST_TEMPLATE?: string }
const savedEdition = mutableEnv.LIAISON_EDITION
const savedTemplate = mutableEnv.LIAISON_ORG_HOST_TEMPLATE

const now = () => Math.floor(Date.now() / 1000)

interface SendOptions {
  method?: "POST" | "PUT"
  key?: string
  ts?: number
  signBody?: string
  unsigned?: boolean
  messageId?: string
}

async function send(path: string, body: unknown, opts: SendOptions = {}) {
  const method = opts.method ?? "POST"
  const raw = JSON.stringify(body)
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (!opts.unsigned) {
    Object.assign(
      headers,
      signControlRequest(opts.key ?? CONTROL_KEY, {
        method,
        path,
        body: opts.signBody ?? raw,
        messageId: opts.messageId ?? randomUUID(),
        ts: opts.ts ?? now(),
      }),
    )
  }
  const res = await app.request(`${CELL}${path}`, { method, headers, body: raw })
  return { res, raw, headers }
}

async function createOrg(slug: string, ownerEmail: string, plan = "base") {
  const { res } = await send("/api/cloud/orgs", {
    slug,
    name: `Org ${slug}`,
    ownerEmail,
    ownerName: "Owner",
    plan,
    locale: "en",
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { orgId: string }).orgId
}

function pushBody(orgId: string, version: number, over: Record<string, unknown> = {}) {
  return {
    orgId,
    version,
    plan: "base",
    status: "active",
    periodEnd: "2026-12-01T00:00:00.000Z",
    includedCredits: "100",
    caps: { seats: 5 },
    previewEndsAt: null,
    autoTopUp: { enabled: false, thresholdCredits: 10, amountCredits: 50 },
    ...over,
  }
}

const push = (orgId: string, version: number, over: Record<string, unknown> = {}) =>
  send(`/api/cloud/orgs/${orgId}/billing`, pushBody(orgId, version, over))

const grant = (orgId: string, grantId: string, credits: string, kind: string) =>
  send(`/api/cloud/orgs/${orgId}/credits`, { orgId, grantId, credits, kind })

async function balances(orgId: string) {
  const [b] = await sql`
    SELECT included_balance::text AS inc, purchased_balance::text AS pur
    FROM kernel.credit_balances WHERE org_id = ${orgId}`
  return { included: Number(b.inc), purchased: Number(b.pur) }
}

async function txCount(orgId: string) {
  const [r] =
    await sql`SELECT count(*)::int AS n FROM kernel.credit_transactions WHERE org_id = ${orgId}`
  return r.n as number
}

/** An admin token of the org's owner, and the org's own host. */
async function ownerSession(orgId: string) {
  const [owner] = await sql`
    SELECT u.id, o.slug FROM kernel.users u JOIN kernel.organizations o ON o.id = u.org_id
    WHERE u.org_id = ${orgId} ORDER BY u.created_at LIMIT 1`
  const token = await signAccessToken(
    {
      userId: owner.id as string,
      orgId,
      name: "Owner",
      roles: ["admin"],
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
      authVersion: 1,
      permissionVersion: 1,
    },
    env.JWT_SECRET,
  )
  return {
    origin: `https://${owner.slug as string}.cells.test`,
    headers: { Authorization: `Bearer ${token}` },
  }
}

beforeAll(async () => {
  await acquireTestLock()
  // A run killed part way leaves its instance-wide rows behind (org rows go with the lock).
  await sql`DELETE FROM kernel.cloud_request_outcomes`
  await sql`DELETE FROM kernel.instance_settings WHERE key = 'cloud.credit_rate'`
  _setEdition(null)
  mutableEnv.LIAISON_EDITION = "managed"
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = TEMPLATE
  const identity = {
    ...mintIdentity(),
    keyCiphertext: encryptInstanceKey(INSTANCE_KEY),
    state: "registered" as const,
    registeredAt: new Date().toISOString(),
  }
  await withSystemDb("test-cloud-identity", (db) => writeIdentity(db, identity))
})

afterAll(async () => {
  mutableEnv.LIAISON_EDITION = savedEdition
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = savedTemplate
  _setEdition(null)
  await sql`DELETE FROM kernel.cloud_request_outcomes`
  await sql`DELETE FROM kernel.instance_settings WHERE key = 'cloud.credit_rate'`
  await withSystemDb("test-cloud-identity", (db) => deleteIdentity(db))
  await releaseTestLock()
})

beforeEach(async () => {
  mutableEnv.LIAISON_EDITION = "managed"
  mutableEnv.LIAISON_ORG_HOST_TEMPLATE = TEMPLATE
  _setEdition(null)
  await clearRedisPatterns(["cloud:*"])
})

describe("401 matrix: the money endpoints", () => {
  let orgId = ""
  beforeAll(async () => {
    orgId = await createOrg("matrix-money", "mm@acme.test")
  })

  const endpoints = () => [
    {
      name: "POST /orgs/:id/billing",
      path: `/api/cloud/orgs/${orgId}/billing`,
      method: "POST" as const,
      body: pushBody(orgId, 1),
    },
    {
      name: "POST /orgs/:id/credits",
      path: `/api/cloud/orgs/${orgId}/credits`,
      method: "POST" as const,
      body: { orgId, grantId: "in_matrix", credits: "5", kind: "topup" },
    },
    {
      name: "PUT /settings/credit-rate",
      path: "/api/cloud/settings/credit-rate",
      method: "PUT" as const,
      body: { rate: "1.5", unitPrices: UNIT_PRICES, version: 1 },
    },
    {
      name: "POST /lookup",
      path: "/api/cloud/lookup",
      method: "POST" as const,
      body: { email: "mm@acme.test" },
    },
  ]

  async function state() {
    const [o] = await sql`SELECT count(*)::int AS n FROM kernel.cloud_request_outcomes`
    const [b] = await sql`SELECT count(*)::int AS n FROM kernel.org_billing_state`
    const [r] =
      await sql`SELECT count(*)::int AS n FROM kernel.instance_settings WHERE key = 'cloud.credit_rate'`
    return { outcomes: o.n, billing: b.n, rate: r.n, credits: await balances(orgId) }
  }

  for (const variant of [
    "unsigned",
    "bad signature",
    "stale ts",
    "tampered body",
    "replay",
  ] as const) {
    test(`${variant}: 401, no side effect`, async () => {
      for (const ep of endpoints()) {
        await clearRedisPatterns(["cloud:*"])
        let res: Response
        if (variant === "replay") {
          // Lookup has no side effect; the others act once, the replay acts never.
          const first = await send(ep.path, ep.body, { method: ep.method })
          expect(first.res.status).toBe(200)
          const before = await state()
          res = await app.request(`${CELL}${ep.path}`, {
            method: ep.method,
            headers: first.headers,
            body: first.raw,
          })
          expect(await state()).toEqual(before)
        } else {
          const before = await state()
          const opts: SendOptions =
            variant === "unsigned"
              ? { unsigned: true }
              : variant === "bad signature"
                ? { key: WRONG_KEY }
                : variant === "stale ts"
                  ? { ts: now() - 301 }
                  : { signBody: JSON.stringify({ ...ep.body, tampered: true }) }
          res = (await send(ep.path, ep.body, { method: ep.method, ...opts })).res
          expect(await state()).toEqual(before)
        }
        expect({ ep: ep.name, status: res.status }).toEqual({ ep: ep.name, status: 401 })
        expect(await res.json()).toEqual({ ok: false, code: "unauthorized" })
      }
    })
  }

  test("self-hosted: every money endpoint is 404, even signed", async () => {
    mutableEnv.LIAISON_EDITION = "self_hosted"
    for (const ep of endpoints()) {
      const { res } = await send(ep.path, ep.body, { method: ep.method })
      expect(res.status).toBe(404)
    }
  })
})

describe("POST /api/cloud/orgs/:id/billing (S16)", () => {
  test("reverse delivery (v2 then v1) keeps v2", async () => {
    const orgId = await createOrg("push-reverse", "pr@acme.test")
    const v2 = await push(orgId, 2, { plan: "pro", includedCredits: "250", caps: { seats: 9 } })
    expect(v2.res.status).toBe(200)
    expect(await v2.res.json()).toEqual({ ok: true, applied: true, version: 2 })
    const v1 = await push(orgId, 1, { plan: "preview", includedCredits: "1", caps: { seats: 1 } })
    expect(v1.res.status).toBe(200)
    expect(await v1.res.json()).toEqual({ ok: true, applied: false, version: 2 })
    const [row] = await sql`
      SELECT version::int AS v, plan, included_credits::text AS inc FROM kernel.org_billing_state
      WHERE org_id = ${orgId}`
    expect(row).toMatchObject({ v: 2, plan: "pro" })
    expect(Number(row.inc)).toBe(250)
    const [org] = await sql`SELECT tier, caps FROM kernel.organizations WHERE id = ${orgId}`
    expect(org.tier).toBe("business")
    expect(org.caps).toEqual({ seats: 9 })
  })

  test("concurrent v1 and v2 pushes leave v2", async () => {
    const orgId = await createOrg("push-race", "race@acme.test")
    for (let round = 0; round < 3; round++) {
      const base = round * 2
      await Promise.all([
        push(orgId, base + 1, { plan: "preview" }),
        push(orgId, base + 2, { plan: "pro" }),
      ])
      const [row] =
        await sql`SELECT version::int AS v, plan FROM kernel.org_billing_state WHERE org_id = ${orgId}`
      expect(row).toEqual({ v: base + 2, plan: "pro" })
      const [org] = await sql`SELECT tier FROM kernel.organizations WHERE id = ${orgId}`
      expect(org.tier).toBe("business")
    }
  })

  test("the plan maps onto the kernel tier", async () => {
    const orgId = await createOrg("push-tiers", "tiers@acme.test")
    const expected = { preview: "starter", base: "team", pro: "business" } as const
    let version = 1
    for (const [plan, tier] of Object.entries(expected)) {
      const { res } = await push(orgId, version++, { plan })
      expect(res.status).toBe(200)
      const [org] = await sql`SELECT tier FROM kernel.organizations WHERE id = ${orgId}`
      expect(org.tier).toBe(tier)
    }
  })

  test("an unknown org → 404 not_found; an invalid body → 400; caps the cell refuses → 400", async () => {
    const ghost = randomUUID()
    const { res } = await push(ghost, 1)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, code: "not_found" })
    const orgId = await createOrg("push-invalid", "inv@acme.test")
    const bad = await push(orgId, 1, { plan: "gold" })
    expect(bad.res.status).toBe(400)
    const badCaps = await push(orgId, 1, { caps: { rockets: 3 } })
    expect(badCaps.res.status).toBe(400)
    const [n] =
      await sql`SELECT count(*)::int AS n FROM kernel.org_billing_state WHERE org_id = ${orgId}`
    expect(n.n).toBe(0)
  })

  test("a failed auto top-up raises exactly one attention item for the org's admins", async () => {
    const orgId = await createOrg("push-failure", "fail@acme.test")
    const failure = { code: "card_declined", at: "2026-11-02T10:00:00.000Z" }
    const autoTopUp = {
      enabled: false,
      thresholdCredits: 10,
      amountCredits: 50,
      lastFailure: failure,
    }
    for (const version of [1, 2, 3]) {
      const { res } = await push(orgId, version, { autoTopUp })
      expect(res.status).toBe(200)
    }
    const { origin, headers } = await ownerSession(orgId)
    const billingItems = async () => {
      const r = await app.request(`${origin}/api/attention-items`, { headers })
      expect(r.status).toBe(200)
      const body = (await r.json()) as {
        data: { items: { id: string; entity: string; metadata?: Record<string, unknown> }[] }
      }
      return body.data.items.filter((i) => i.entity === "billing")
    }
    const first = await billingItems()
    expect(first).toHaveLength(1)
    expect(first[0].metadata?.settingsRoute).toBe("/settings/billing")

    // A newer failure replaces it (still one); none once Control clears it.
    await push(orgId, 4, {
      autoTopUp: {
        ...autoTopUp,
        lastFailure: { code: "authentication_required", at: "2026-11-02T11:00:00.000Z" },
      },
    })
    const again = await billingItems()
    expect(again).toHaveLength(1)
    expect(again[0].id).not.toBe(first[0].id)
    await push(orgId, 5, { autoTopUp: { enabled: false, thresholdCredits: 10, amountCredits: 50 } })
    expect(await billingItems()).toHaveLength(0)
  })
})

describe("POST /api/cloud/orgs/:id/credits (S17, S21, S22)", () => {
  test("a top-up adds purchased credits once; a replay returns the first outcome", async () => {
    const orgId = await createOrg("grant-topup", "gt@acme.test")
    const before = await balances(orgId)
    const first = await grant(orgId, "in_topup_1", "25", "topup")
    expect(first.res.status).toBe(200)
    expect(await first.res.json()).toEqual({ ok: true, grantId: "in_topup_1" })
    const n = await txCount(orgId)
    const replay = await grant(orgId, "in_topup_1", "25", "topup")
    expect(replay.res.status).toBe(200)
    expect(await replay.res.json()).toEqual({ ok: true, grantId: "in_topup_1" })
    expect(await txCount(orgId)).toBe(n)
    expect(await balances(orgId)).toEqual({
      included: before.included,
      purchased: before.purchased + 25,
    })
    const [tx] = await sql`
      SELECT type, description, external_payment_ref FROM kernel.credit_transactions
      WHERE org_id = ${orgId} AND external_payment_ref = 'in_topup_1'`
    expect(tx).toEqual({
      type: "top_up",
      description: "manual",
      external_payment_ref: "in_topup_1",
    })
  })

  test("an auto top-up is a top-up described as auto", async () => {
    const orgId = await createOrg("grant-auto", "ga@acme.test")
    const { res } = await grant(orgId, "in_auto_1", "50", "auto_topup")
    expect(res.status).toBe(200)
    const [tx] = await sql`
      SELECT type, description FROM kernel.credit_transactions
      WHERE org_id = ${orgId} AND external_payment_ref = 'in_auto_1'`
    expect(tx).toEqual({ type: "top_up", description: "auto" })
  })

  test("the same grantId with another amount or kind → 409 grant_conflict, nothing credited", async () => {
    const orgId = await createOrg("grant-conflict", "gc@acme.test")
    await grant(orgId, "in_conflict", "10", "topup")
    const after = await balances(orgId)
    const n = await txCount(orgId)
    for (const [credits, kind] of [
      ["11", "topup"],
      ["10", "auto_topup"],
      ["10", "period_reset"],
    ] as const) {
      const { res } = await grant(orgId, "in_conflict", credits, kind)
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ ok: false, code: "grant_conflict" })
    }
    expect(await balances(orgId)).toEqual(after)
    expect(await txCount(orgId)).toBe(n)
  })

  test("a period reset sets the included credits (not added), once per grantId", async () => {
    const orgId = await createOrg("grant-reset", "gr@acme.test")
    await grant(orgId, "in_topup_r", "7", "topup")
    const r1 = await grant(orgId, "in_period_1", "100", "period_reset")
    expect(r1.res.status).toBe(200)
    expect(await balances(orgId)).toMatchObject({ included: 100, purchased: 7 })
    await grant(orgId, "in_period_2", "40", "period_reset")
    expect(await balances(orgId)).toMatchObject({ included: 40, purchased: 7 })
    const replay = await grant(orgId, "in_period_1", "100", "period_reset")
    expect(replay.res.status).toBe(200)
    expect(await balances(orgId)).toMatchObject({ included: 40, purchased: 7 })
  })

  test("an unknown org → 404 not_found, and the grantId stays free", async () => {
    const ghost = randomUUID()
    const { res } = await grant(ghost, "in_ghost", "5", "topup")
    expect(res.status).toBe(404)
    const [n] =
      await sql`SELECT count(*)::int AS n FROM kernel.cloud_request_outcomes WHERE idem_key LIKE '%in_ghost%'`
    expect(n.n).toBe(0)
  })
})

describe("PUT /api/cloud/settings/credit-rate (S21)", () => {
  test("applies only a newer version", async () => {
    await sql`DELETE FROM kernel.instance_settings WHERE key = 'cloud.credit_rate'`
    const put = (rate: string, version: number) =>
      send(
        "/api/cloud/settings/credit-rate",
        { rate, unitPrices: UNIT_PRICES, version },
        { method: "PUT" },
      )
    const v2 = await put("1.5", 2)
    expect(v2.res.status).toBe(200)
    expect(await v2.res.json()).toEqual({ ok: true, applied: true, version: 2 })
    const v1 = await put("9.9", 1)
    expect(await v1.res.json()).toEqual({ ok: true, applied: false, version: 2 })
    expect(await readCreditRate()).toBe("1.5")
    const v3 = await put("1.4", 3)
    expect(await v3.res.json()).toEqual({ ok: true, applied: true, version: 3 })
    expect(await readCreditRate()).toBe("1.4")
    const bad = await put("0", 4)
    expect(bad.res.status).toBe(400)
    // The unit prices are part of the push: without them, 400 and nothing changes.
    const noUnits = await send(
      "/api/cloud/settings/credit-rate",
      { rate: "1.5", version: 5 },
      { method: "PUT" },
    )
    expect(noUnits.res.status).toBe(400)
    expect(await readCreditPricing()).toEqual({ rate: "1.4", unitPrices: UNIT_PRICES })
  })

  test("the rate is never serialized to a client (every GET under credits, settings, billing)", async () => {
    await sql`DELETE FROM kernel.instance_settings WHERE key = 'cloud.credit_rate'`
    const { res } = await send(
      "/api/cloud/settings/credit-rate",
      { rate: SECRET_RATE, unitPrices: UNIT_PRICES, version: 1 },
      { method: "PUT" },
    )
    expect(res.status).toBe(200)
    const orgId = await createOrg("rate-scan", "scan@acme.test")
    await push(orgId, 1)
    const { origin, headers } = await ownerSession(orgId)

    const paths = [
      ...new Set(
        app.routes
          .filter((r) => r.method === "GET" && !r.path.includes(":") && !r.path.includes("*"))
          .map((r) => r.path)
          .filter((p) => /^\/api\/(credits|settings|billing)(\/|$)/.test(p)),
      ),
    ]
    expect(paths).toContain("/api/billing/state")
    expect(paths).toContain("/api/credits/balance")
    // No outbound call during the scan (a catalogue fetch would leave the box).
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error("no network in this test")
    }) as unknown as typeof fetch
    try {
      for (const p of paths) {
        const r = await app.request(`${origin}${p}`, { headers })
        const text = await r.text()
        expect({ path: p, leaks: text.includes(SECRET_RATE) }).toEqual({ path: p, leaks: false })
      }
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe("POST /api/cloud/lookup (S43)", () => {
  test("lists the orgs where the email is an active member, [] otherwise", async () => {
    const a = await createOrg("lookup-a", "Finder@Acme.test")
    await createOrg("lookup-b", "finder@acme.test")
    const third = await createOrg("lookup-c", "other@acme.test")
    // A deactivated membership does not count.
    await seedUserRow({
      orgId: third,
      email: "finder@acme.test",
      name: "Gone",
      status: "deactivated",
    })
    const { res } = await send("/api/cloud/lookup", { email: "FINDER@acme.test" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: true; orgs: { slug: string; name: string }[] }
    expect(body.ok).toBe(true)
    expect(body.orgs.map((o) => o.slug).sort()).toEqual(["lookup-a", "lookup-b"])
    expect(body.orgs.find((o) => o.slug === "lookup-a")?.name).toBe("Org lookup-a")
    expect(a).toBeTruthy()
    const none = await send("/api/cloud/lookup", { email: "nobody@acme.test" })
    expect(await none.res.json()).toEqual({ ok: true, orgs: [] })
  })
})

describe("GET /api/billing/state", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("managed: the stored push, in the managed shape, with no portal or checkout URL; no outbound call", async () => {
    const orgId = await createOrg("state-managed", "sm@acme.test")
    let calls = 0
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      calls++
      return realFetch(...args)
    }) as typeof fetch
    const { origin, headers } = await ownerSession(orgId)

    const empty = await app.request(`${origin}/api/billing/state`, { headers })
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as { data: unknown }).data).toEqual({
      mode: "managed",
      billingUnavailable: true,
      stale: true,
    })

    await push(orgId, 3, {
      plan: "pro",
      status: "past_due",
      includedCredits: "250",
      previewEndsAt: null,
      autoTopUp: { enabled: true, thresholdCredits: 20, amountCredits: 100 },
    })
    calls = 0
    const r = await app.request(`${origin}/api/billing/state`, { headers })
    expect(r.status).toBe(200)
    const data = ((await r.json()) as { data: Record<string, unknown> }).data
    expect(managedBillingStateSchema.parse(data)).toEqual({
      mode: "managed",
      plan: "pro",
      tier: "business",
      status: "past_due",
      periodEnd: "2026-12-01T00:00:00.000Z",
      includedCredits: "250",
      previewEndsAt: null,
      autoTopUp: { enabled: true, thresholdCredits: 20, amountCredits: 100 },
      // the suspension window (null outside suspension); no contact pushed here.
      accessUntil: null,
    })
    expect(data).not.toHaveProperty("billingPortalUrl")
    expect(data).not.toHaveProperty("checkoutUrl")
    expect(calls).toBe(0)
  })

  test("self-hosted: byte-identical to the reply before the managed edition stored billing", async () => {
    const orgId = await createOrg("state-self", "ss@acme.test")
    await push(orgId, 1)
    const { origin, headers } = await ownerSession(orgId)
    mutableEnv.LIAISON_EDITION = "self_hosted"
    const r = await app.request(`${origin}/api/billing/state`, { headers })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('{"data":{"mode":"self_hosted","byokEnabled":true}}')
  })
})

describe("/api/admin/billing/* is retired (S41)", () => {
  const ADMIN_PATHS = [
    ["POST", "/api/admin/billing/credits"],
    ["POST", "/api/admin/billing/credits/reset"],
    ["PATCH", `/api/admin/billing/org/${randomUUID()}/tier`],
  ] as const

  for (const edition of ["managed", "self_hosted"] as const) {
    test(`${edition}: 404 not_found for every route, whatever the bearer`, async () => {
      _setEdition(edition)
      // On a server without one host per org (the host check answers first otherwise).
      mutableEnv.LIAISON_ORG_HOST_TEMPLATE = undefined
      for (const [method, path] of ADMIN_PATHS) {
        const r = await app.request(`${CELL}${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.CONTROL_PLANE_API_KEY ?? "k".repeat(32)}`,
          },
          body: JSON.stringify({
            orgId: randomUUID(),
            amountCredits: "5",
            externalPaymentRef: "x",
          }),
        })
        expect({ path, status: r.status }).toEqual({ path, status: 404 })
        expect(await r.json()).toEqual({ error: { message: "not found", code: "not_found" } })
      }
    })
  }
})

describe("BYOK in the managed edition", () => {
  test("provider keys and own model servers → 403 managed_no_byok; self-hosted unchanged", async () => {
    const orgId = await createOrg("byok-managed", "byok@acme.test")
    const { origin, headers } = await ownerSession(orgId)
    const json = { ...headers, "Content-Type": "application/json" }
    const calls = [
      ["/api/settings/ai/keys", { provider: "openrouter", apiKey: "sk-or-test" }],
      ["/api/settings/ai/servers", { name: "Box", baseURL: "https://models.example.test/v1" }],
    ] as const
    for (const [path, body] of calls) {
      const r = await app.request(`${origin}${path}`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      })
      expect({ path, status: r.status }).toEqual({ path, status: 403 })
      const err = (await r.json()) as { error: { code: string } }
      expect(err.error.code).toBe("managed_no_byok")
    }
    mutableEnv.LIAISON_EDITION = "self_hosted"
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error("no network in this test")
    }) as unknown as typeof fetch
    try {
      for (const [path, body] of calls) {
        const r = await app.request(`${origin}${path}`, {
          method: "POST",
          headers: json,
          body: JSON.stringify(body),
        })
        expect({ path, status: r.status }).not.toEqual({ path, status: 403 })
      }
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
