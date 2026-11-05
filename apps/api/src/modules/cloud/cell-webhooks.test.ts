// SPDX-License-Identifier: FSL-1.1-ALv2
// The cell's own inbound callbacks (S30, A25, A47): one Gmail push subscription
// and one Meta app callback per cell, fanned out to the orgs they concern. The
// lookups and the per-org dispatch are injected, so these run without a database.
import { describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import {
  type CellWebhookDeps,
  cellMetaVerifyToken,
  createCellWebhookRoutes,
} from "~/modules/cloud/cell-webhooks"

const AUDIENCE = "https://cell-a.example.test/webhooks/_cell/gmail-push"
const SA = "gmail-push-cell-a@example.iam.gserviceaccount.com"
const META_SECRET = "meta-app-secret-test"
const ORG_A = "00000000-0000-4000-8000-00000000000a"
const ORG_B = "00000000-0000-4000-8000-00000000000b"
const ORG_S = "00000000-0000-4000-8000-00000000000c"

interface Call {
  orgId: string
  appName: string
  endpointName: string
  body: string
  authorization: string | null
  replayKey?: string
}

function harness(over: Partial<CellWebhookDeps> = {}) {
  const forwarded: Call[] = []
  const dispatched: Call[] = []
  const deps: CellWebhookDeps = {
    managed: () => true,
    gmailPush: () => ({ audience: AUDIENCE, serviceAccount: SA }),
    metaAppSecret: () => META_SECRET,
    verifyOidc: async (token, audience, serviceAccount) =>
      token === "good-token" && audience === AUDIENCE && serviceAccount === SA
        ? { valid: true }
        : { valid: false, reason: "bad_token" },
    gmailOrgsFor: async (address) =>
      address === "shared@example.test"
        ? [
            { orgId: ORG_A, appName: "mail" },
            { orgId: ORG_B, appName: "tickets" },
          ]
        : address === "suspended@example.test"
          ? [
              { orgId: ORG_S, appName: "mail" },
              { orgId: ORG_A, appName: "mail" },
            ]
          : [],
    metaOrgsForPages: async (pageIds) => {
      const map = new Map<string, string[]>()
      for (const p of pageIds) {
        if (p === "page-a") map.set(p, [ORG_A])
        if (p === "page-b") map.set(p, [ORG_B])
        if (p === "page-s") map.set(p, [ORG_S])
      }
      return map
    },
    suspended: async (orgId) => orgId === ORG_S,
    forward: async (orgId, appName, endpointName, req) => {
      forwarded.push({
        orgId,
        appName,
        endpointName,
        body: req.body,
        authorization: req.headers.get("authorization"),
      })
      return new Response("{}", { status: 200 })
    },
    dispatchVerified: async (_c, orgId, appName, endpointName, req) => {
      dispatched.push({
        orgId,
        appName,
        endpointName,
        body: req.rawBody,
        authorization: null,
        replayKey: req.replayKey,
      })
      return new Response("{}", { status: 200 })
    },
    ...over,
  }
  return { routes: createCellWebhookRoutes(deps), forwarded, dispatched }
}

function gmailBody(emailAddress: string, messageId = "m-1"): string {
  return JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress, historyId: "42" })).toString("base64"),
      messageId,
    },
    subscription: "projects/example/subscriptions/gmail-push-cell-a-sub",
  })
}

function postGmail(
  routes: ReturnType<typeof harness>["routes"],
  body: string,
  token = "good-token",
) {
  return routes.request("/gmail-push", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body,
  })
}

function metaSign(body: string, secret = META_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

function postMeta(
  routes: ReturnType<typeof harness>["routes"],
  body: string,
  sig = metaSign(body),
) {
  return routes.request("/meta", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body,
  })
}

describe("cell Gmail push (S30)", () => {
  it("valid token + known address: each matching org's handler gets the original request once", async () => {
    const h = harness()
    const body = gmailBody("Shared@Example.test")
    const res = await postGmail(h.routes, body)
    expect(res.status).toBe(200)
    expect(h.forwarded.map((c) => [c.orgId, c.appName, c.endpointName])).toEqual([
      [ORG_A, "mail", "gmail-push"],
      [ORG_B, "tickets", "gmail-push"],
    ])
    // The original body and bearer: each app re-verifies with its own config.
    for (const c of h.forwarded) {
      expect(c.body).toBe(body)
      expect(c.authorization).toBe("Bearer good-token")
    }
  })

  it("an address no org holds: 204 and no handler (Pub/Sub stops retrying)", async () => {
    const h = harness()
    const res = await postGmail(h.routes, gmailBody("nobody@example.test"))
    expect(res.status).toBe(204)
    expect(h.forwarded).toEqual([])
  })

  it("a bad or missing token: 401 and no handler", async () => {
    const h = harness()
    expect((await postGmail(h.routes, gmailBody("shared@example.test"), "forged")).status).toBe(401)
    const noBearer = await h.routes.request("/gmail-push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: gmailBody("shared@example.test"),
    })
    expect(noBearer.status).toBe(401)
    expect(h.forwarded).toEqual([])
  })

  it("a suspended org is skipped, the others still get it", async () => {
    const h = harness()
    const res = await postGmail(h.routes, gmailBody("suspended@example.test"))
    expect(res.status).toBe(200)
    expect(h.forwarded.map((c) => c.orgId)).toEqual([ORG_A])
  })

  it("an org whose handler fails transiently makes Pub/Sub retry (5xx)", async () => {
    const h = harness({
      forward: async (orgId) => new Response("", { status: orgId === ORG_B ? 503 : 200 }),
    })
    const res = await postGmail(h.routes, gmailBody("shared@example.test"))
    expect(res.status).toBe(503)
  })

  it("no audience configured on the cell: 503, never an unverified delivery", async () => {
    const h = harness({ gmailPush: () => ({}) })
    const res = await postGmail(h.routes, gmailBody("shared@example.test"))
    expect(res.status).toBe(503)
    expect(h.forwarded).toEqual([])
  })
})

describe("cell Meta callback (A25, A47)", () => {
  const payload = {
    object: "page",
    entry: [
      {
        id: "page-a",
        time: 1,
        changes: [{ field: "feed", value: { item: "comment", comment_id: "c1" } }],
      },
      {
        id: "page-b",
        time: 2,
        changes: [{ field: "feed", value: { item: "comment", comment_id: "c2" } }],
      },
      { id: "page-unknown", time: 3, changes: [] },
    ],
  }

  it("a bad signature: 401 and no handler", async () => {
    const h = harness()
    const body = JSON.stringify(payload)
    expect((await postMeta(h.routes, body, metaSign(body, "wrong-secret"))).status).toBe(401)
    expect((await postMeta(h.routes, body, "")).status).toBe(401)
    expect(h.dispatched).toEqual([])
  })

  it("two pages of two orgs in one payload: each org gets only its own entry", async () => {
    const h = harness()
    const res = await postMeta(h.routes, JSON.stringify(payload))
    expect(res.status).toBe(200)
    expect(h.dispatched.map((c) => [c.orgId, c.appName, c.endpointName])).toEqual([
      [ORG_A, "social", "meta"],
      [ORG_B, "social", "meta"],
    ])
    const a = JSON.parse(h.dispatched[0]!.body)
    const b = JSON.parse(h.dispatched[1]!.body)
    expect(a).toEqual({ object: "page", entry: [payload.entry[0]] })
    expect(b).toEqual({ object: "page", entry: [payload.entry[1]] })
    // A replay identity per org body, so a redelivery is deduplicated per org.
    expect(h.dispatched[0]!.replayKey).toBeTruthy()
    expect(h.dispatched[0]!.replayKey).not.toBe(h.dispatched[1]!.replayKey)
  })

  it("a suspended org's entries are dropped; an unknown page reaches nobody; Meta still gets 200", async () => {
    const h = harness()
    const body = JSON.stringify({
      object: "page",
      entry: [{ id: "page-s" }, { id: "page-unknown" }],
    })
    const res = await postMeta(h.routes, body)
    expect(res.status).toBe(200)
    expect(h.dispatched).toEqual([])
  })

  it("answers the hub.challenge handshake against the cell's verify token only", async () => {
    const h = harness()
    const token = cellMetaVerifyToken(META_SECRET)
    const ok = await h.routes.request(
      `/meta?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345`,
    )
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe("12345")
    const bad = await h.routes.request(
      "/meta?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345",
    )
    expect(bad.status).toBe(403)
  })

  it("no Meta app secret on this cell: 503", async () => {
    const h = harness({ metaAppSecret: () => undefined })
    expect((await postMeta(h.routes, JSON.stringify(payload))).status).toBe(503)
    expect(h.dispatched).toEqual([])
  })
})

describe("self-hosted (S19)", () => {
  it("every /webhooks/_cell route is a 404", async () => {
    const h = harness({ managed: () => false })
    expect((await postGmail(h.routes, gmailBody("shared@example.test"))).status).toBe(404)
    expect((await postMeta(h.routes, JSON.stringify({ object: "page", entry: [] }))).status).toBe(
      404,
    )
    expect(
      (await h.routes.request("/meta?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1"))
        .status,
    ).toBe(404)
    expect(h.forwarded).toEqual([])
    expect(h.dispatched).toEqual([])
  })
})

describe("instance config the apps read (A47)", () => {
  it("social gets the server's Meta callback and handshake token in managed with a Meta app secret only", async () => {
    const { _setEdition } = await import("~/lib/edition")
    const { env } = await import("~/lib/env")
    const { instanceConfigDefault } = await import("~/modules/apps/instance-config-defaults")
    const saved = { secret: env.META_APP_SECRET, base: env.BASE_URL }
    try {
      env.META_APP_SECRET = META_SECRET
      env.BASE_URL = "https://cell-a.example.test/"
      _setEdition("managed")
      expect(instanceConfigDefault("social", "cellMetaCallbackUrl")).toBe(
        "https://cell-a.example.test/webhooks/_cell/meta",
      )
      expect(instanceConfigDefault("social", "cellMetaVerifyToken")).toBe(
        cellMetaVerifyToken(META_SECRET),
      )
      _setEdition("self_hosted")
      expect(instanceConfigDefault("social", "cellMetaCallbackUrl")).toBeNull()
      expect(instanceConfigDefault("social", "cellMetaVerifyToken")).toBeNull()
      _setEdition("managed")
      env.META_APP_SECRET = undefined
      expect(instanceConfigDefault("social", "cellMetaCallbackUrl")).toBeNull()
    } finally {
      _setEdition(null)
      env.META_APP_SECRET = saved.secret
      env.BASE_URL = saved.base
    }
  })

  it("mail and tickets get the push audience and service account; mail keeps its topic", async () => {
    const { env } = await import("~/lib/env")
    const { instanceConfigDefault } = await import("~/modules/apps/instance-config-defaults")
    const saved = { a: env.GMAIL_PUSH_AUDIENCE, s: env.GMAIL_PUSH_SERVICE_ACCOUNT }
    try {
      env.GMAIL_PUSH_AUDIENCE = AUDIENCE
      env.GMAIL_PUSH_SERVICE_ACCOUNT = SA
      for (const app of ["mail", "tickets"]) {
        expect(instanceConfigDefault(app, "gmailPushAudience")).toBe(AUDIENCE)
        expect(instanceConfigDefault(app, "gmailPushServiceAccount")).toBe(SA)
      }
      expect(instanceConfigDefault("tickets", "gmailPushTopic")).toBeNull()
    } finally {
      env.GMAIL_PUSH_AUDIENCE = saved.a
      env.GMAIL_PUSH_SERVICE_ACCOUNT = saved.s
    }
  })
})
