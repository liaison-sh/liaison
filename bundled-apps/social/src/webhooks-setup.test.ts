// SPDX-License-Identifier: FSL-1.1-ALv2
//
// webhooks_setup against a fake Graph: the app-level page subscription and the per-Page
// subscribed_apps are both made with the right parameters, the verify token the kernel's
// handshake checks is provisioned before Meta is asked, a failing Page is reported, and a second
// run changes nothing.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { facebookAdapter } from "./adapters/facebook"
import { onConnectionEstablished } from "./connection"
import type { SocialToolCtx } from "./ctx"
import { createMockDb, type MockDb } from "./test-db"
import {
  CELL_CALLBACK_KEY,
  CELL_VERIFY_TOKEN_KEY,
  VERIFY_TOKEN_KEY,
  WEBHOOK_FIELDS,
  webhooksSetup,
  webhooksSetupPreflight,
} from "./webhooks-setup"

const APP_ID = "app-77"
const SECRET = "meta-secret"
const BASE = "https://liaison.example.com"
const CALLBACK = `${BASE}/webhooks/org-1/social/meta`

interface Call {
  method: string
  path: string
  auth?: string
  body?: Record<string, unknown>
}

/** A stateful fake of the Graph endpoints the tool touches. */
function fakeGraph(
  opts: {
    failPage?: string
    pages?: Array<{ id: string; name: string }>
    /** The instance's cell callback and verify token (managed edition). */
    cell?: { callback: string; verifyToken: string }
    /** The app-level callback Meta already holds. */
    currentCallback?: string
  } = {},
) {
  const pages = opts.pages ?? [
    { id: "P1", name: "Kestrel" },
    { id: "P2", name: "Resonant Audio Labs" },
  ]
  const state = {
    appSub: null as null | { object: string; callback_url: string; fields: Array<{ name: string }>; active: boolean },
    pageSubs: {} as Record<string, string[]>,
    verifyTokenAtSubscribe: null as unknown,
  }
  if (opts.currentCallback) {
    state.appSub = {
      object: "page",
      callback_url: opts.currentCallback,
      fields: WEBHOOK_FIELDS.map((name) => ({ name })),
      active: true,
    }
  }
  const calls: Call[] = []
  let config: Record<string, unknown> = opts.cell
    ? { [CELL_CALLBACK_KEY]: opts.cell.callback, [CELL_VERIFY_TOKEN_KEY]: opts.cell.verifyToken }
    : {}
  const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const u = new URL(url)
    const path = u.pathname.replace(/^\/v\d+\.\d+/, "")
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    const auth = init?.headers?.Authorization
    calls.push({ method, path, auth, body })
    const ok = (b: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(b) })
    if (method === "GET" && path === "/app") return ok({ id: APP_ID })
    if (path === `/${APP_ID}/subscriptions`) {
      const token = method === "GET" ? auth?.replace(/^Bearer /, "") : body?.access_token
      if (token !== `${APP_ID}|${SECRET}`) return { status: 400, headers: {}, body: JSON.stringify({ error: { code: 190, message: "bad app token" } }) }
      if (method === "GET") return ok({ data: state.appSub ? [state.appSub] : [] })
      // Meta checks the callback with the hub.challenge handshake before it accepts.
      state.verifyTokenAtSubscribe = config[VERIFY_TOKEN_KEY] ?? null
      if (body?.verify_token !== (config[CELL_VERIFY_TOKEN_KEY] ?? config[VERIFY_TOKEN_KEY])) {
        return { status: 400, headers: {}, body: JSON.stringify({ error: { code: 2200, message: "Callback verification failed" } }) }
      }
      state.appSub = {
        object: String(body?.object),
        callback_url: String(body?.callback_url),
        fields: String(body?.fields).split(",").map((name) => ({ name })),
        active: true,
      }
      return ok({ success: true })
    }
    if (method === "GET" && path === "/me/accounts") {
      return ok({ data: pages.map((p) => ({ ...p, access_token: `tok-${p.id}` })) })
    }
    const m = /^\/([^/]+)\/subscribed_apps$/.exec(path)
    if (m) {
      const pageId = m[1] as string
      if (auth !== `Bearer tok-${pageId}`) return { status: 400, headers: {}, body: JSON.stringify({ error: { code: 190, message: "wrong token" } }) }
      if (pageId === opts.failPage) {
        return { status: 403, headers: {}, body: JSON.stringify({ error: { code: 200, message: "Requires pages_manage_metadata permission" } }) }
      }
      if (method === "GET") {
        const f = state.pageSubs[pageId]
        return ok({ data: f ? [{ id: APP_ID, subscribed_fields: f }] : [] })
      }
      state.pageSubs[pageId] = String(body?.subscribed_fields).split(",")
      return ok({ success: true })
    }
    throw new Error(`unrouted ${method} ${path}`)
  }
  const cfg = {
    get: async (k: string) => (k === "socialMetaAppSecret" ? SECRET : (config[k] ?? null)),
    setSecret: async (k: string, v: string) => {
      config = { ...config, [k]: v }
    },
  }
  return { fetch, cfg, calls, state, getConfig: () => config }
}

async function seededCtx(g: ReturnType<typeof fakeGraph>, base: string | undefined = BASE) {
  const db = createMockDb()
  const ctx = {
    orgId: "org-1",
    db,
    fetch: g.fetch,
    connections: { getToken: async () => "user-tok" },
    config: g.cfg,
    enqueueJob: async () => {},
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  } as unknown as SocialToolCtx & { config: typeof g.cfg }
  await onConnectionEstablished(
    {
      app: "kernel",
      entity: "connected_account",
      action: "create",
      orgId: "org-1",
      data: { id: "ca-1", appName: "social", connectionName: "facebook", identifier: "U1", kernelPublicBaseUrl: base },
    } as never,
    ctx,
  )
  return { ctx, db: db as MockDb }
}

const writes = (calls: Call[]) => calls.filter((c) => c.method === "POST")

describe("social manifest: Facebook connection", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))
  test("requests pages_manage_metadata (needed for /{page-id}/subscribed_apps)", () => {
    expect(manifest.connections.facebook.scopes).toContain("pages_manage_metadata")
  })
  test("declares the verify token as an app-held secret and webhooks_setup as gated with a preflight", () => {
    expect(manifest.connections.facebook.appSecretConfigKeys).toContain(VERIFY_TOKEN_KEY)
    const tool = manifest.tools.webhooks_setup
    expect(tool.gated).toBe(true)
    expect(tool.handler).toBe("webhooksSetupHandler")
    expect(tool.preflight).toBe("webhooksSetupPreflightHandler")
  })
  test("the subscribed fields are the ones the webhook parser reads", () => {
    const parseWebhook = facebookAdapter.parseWebhook
    if (!parseWebhook) throw new Error("facebook adapter has no parseWebhook")
    const parsed = parseWebhook({
      entry: [
        { changes: [{ field: "feed", value: { comment_id: "c1", post_id: "p1", message: "hi" } }] },
        { messaging: [{ sender: { id: "s1" }, message: { mid: "m1", text: "yo" } }] },
      ],
    })
    expect(parsed.findings.length).toBe(1)
    expect(parsed.messages.length).toBe(1)
    expect([...WEBHOOK_FIELDS].sort()).toEqual(["feed", "messages"])
  })
})

describe("webhooks_setup", () => {
  test("runs the way the app sandbox calls it: the org from getOrgId(), no Uint8Array", async () => {
    const g = fakeGraph()
    const { ctx } = await seededCtx(g)
    const sandboxCtx = { ...ctx, orgId: undefined, getOrgId: () => "org-1" } as unknown as typeof ctx
    const realUint8Array = globalThis.Uint8Array
    // @ts-expect-error the QuickJS sandbox has no typed arrays
    delete globalThis.Uint8Array
    let r: Awaited<ReturnType<typeof webhooksSetup>>
    try {
      r = await webhooksSetup({}, sandboxCtx)
    } finally {
      globalThis.Uint8Array = realUint8Array
    }
    if (!("pages" in r)) throw new Error(JSON.stringify(r))
    expect(r.callback_url).toBe(CALLBACK)
    expect(String(g.getConfig()[VERIFY_TOKEN_KEY])).toMatch(/^[0-9a-f]{48}$/)
  })

  test("subscribes the app's page object and every managed Page with the right parameters", async () => {
    const g = fakeGraph()
    const { ctx } = await seededCtx(g)
    const r = await webhooksSetup({}, ctx)
    if (!("pages" in r)) throw new Error(JSON.stringify(r))
    expect(r.status).toBe("completed")
    expect(r.callback_url).toBe(CALLBACK)
    expect(r.app).toEqual({ app_id: APP_ID, status: "subscribed", fields: ["feed", "messages"] })

    const appPost = writes(g.calls).find((c) => c.path === `/${APP_ID}/subscriptions`)
    expect(appPost?.body).toEqual({
      object: "page",
      callback_url: CALLBACK,
      fields: "feed,messages",
      include_values: true,
      verify_token: g.getConfig()[VERIFY_TOKEN_KEY],
      access_token: `${APP_ID}|${SECRET}`,
    })
    // The token was stored before Meta's handshake ran, and it is a real random token.
    expect(typeof g.state.verifyTokenAtSubscribe).toBe("string")
    expect(String(g.state.verifyTokenAtSubscribe)).toMatch(/^[0-9a-f]{48}$/)

    for (const id of ["P1", "P2"]) {
      const post = writes(g.calls).find((c) => c.path === `/${id}/subscribed_apps`)
      expect(post?.auth).toBe(`Bearer tok-${id}`)
      expect(post?.body).toEqual({ subscribed_fields: "feed,messages" })
    }
    expect(r.pages.map((p) => [p.page_id, p.status])).toEqual([
      ["P1", "subscribed"],
      ["P2", "subscribed"],
    ])
  })

  test("a Page Meta refuses is reported with its error, the others still subscribe", async () => {
    const g = fakeGraph({ failPage: "P1" })
    const { ctx } = await seededCtx(g)
    const r = await webhooksSetup({}, ctx)
    if (!("pages" in r)) throw new Error(JSON.stringify(r))
    expect(r.status).toBe("partial")
    expect(r.failed_pages).toBe(1)
    const p1 = r.pages.find((p) => p.page_id === "P1")
    expect(p1?.status).toBe("failed")
    expect(p1?.error).toContain("pages_manage_metadata")
    expect(r.pages.find((p) => p.page_id === "P2")?.status).toBe("subscribed")
  })

  test("a second run changes nothing and reports unchanged", async () => {
    const g = fakeGraph()
    const { ctx } = await seededCtx(g)
    await webhooksSetup({}, ctx)
    const token = g.getConfig()[VERIFY_TOKEN_KEY]
    g.calls.length = 0
    const r = await webhooksSetup({}, ctx)
    if (!("pages" in r)) throw new Error(JSON.stringify(r))
    expect(writes(g.calls)).toEqual([])
    expect(r.status).toBe("completed")
    expect(r.app.status).toBe("unchanged")
    expect(r.pages.every((p) => p.status === "unchanged")).toBe(true)
    expect(g.getConfig()[VERIFY_TOKEN_KEY]).toBe(token)
  })

  test("keeps a Page's other subscribed fields when adding ours", async () => {
    const g = fakeGraph({ pages: [{ id: "P1", name: "Kestrel" }] })
    g.state.pageSubs.P1 = ["message_echoes"]
    const { ctx } = await seededCtx(g)
    const r = await webhooksSetup({}, ctx)
    if (!("pages" in r)) throw new Error(JSON.stringify(r))
    expect(g.state.pageSubs.P1).toEqual(["message_echoes", "feed", "messages"])
  })

  test("refuses at staging when the public address is unknown, and accepts callback_base_url", async () => {
    const g = fakeGraph()
    const { ctx } = await seededCtx(g, "")
    const pre = await webhooksSetupPreflight({}, ctx)
    expect("error" in pre && pre.error.code).toBe("callback_base_url_missing")
    expect(await webhooksSetupPreflight({ callback_base_url: "https://other.example.com/" }, ctx)).toEqual({ ok: true })
    const r = await webhooksSetup({ callback_base_url: "https://other.example.com/" }, ctx)
    if (!("pages" in r)) throw new Error(JSON.stringify(r))
    expect(r.callback_url).toBe("https://other.example.com/webhooks/org-1/social/meta")
  })

  test("refuses at staging without a connected Facebook account", async () => {
    const g = fakeGraph()
    const db = createMockDb()
    const ctx = { orgId: "org-1", db, fetch: g.fetch, connections: {}, config: g.cfg } as unknown as SocialToolCtx & {
      config: typeof g.cfg
    }
    const pre = await webhooksSetupPreflight({}, ctx)
    expect("error" in pre && pre.error.code).toBe("not_connected")
    expect(g.calls).toEqual([])
  })
})

// Managed edition (A25, A47): one Meta app serves every workspace on every cell, and it has ONE
// app-level callback, so it points at the cell's /webhooks/_cell/meta, which routes deliveries by
// Page id; until an edge callback exists, exactly one cell carries Meta.
describe("webhooks_setup on a managed cell", () => {
  const CELL = { callback: "https://cell-a.example.test/webhooks/_cell/meta", verifyToken: "cell-token" }

  test("subscribes the app to the cell callback with the cell's verify token, whatever base is passed", async () => {
    const g = fakeGraph({ cell: CELL })
    const { ctx } = await seededCtx(g)
    const r = await webhooksSetup({ callback_base_url: "https://elsewhere.example.com" }, ctx)
    if (!("pages" in r)) throw new Error(JSON.stringify(r))
    expect(r.status).toBe("completed")
    expect(r.callback_url).toBe(CELL.callback)
    expect(g.state.appSub?.callback_url).toBe(CELL.callback)
    // The workspace's own verify token is not minted: the cell answers the handshake.
    expect(g.getConfig()[VERIFY_TOKEN_KEY]).toBeUndefined()
  })

  test("records the subscribed Page ids on the account, which the cell routes deliveries by", async () => {
    const g = fakeGraph({ cell: CELL })
    const { ctx, db } = await seededCtx(g)
    await webhooksSetup({}, ctx)
    const rows = (await db.findMany("sync_state", { where: { platform: "facebook", account_external_id: "U1" } })) as Array<{
      metadata?: Record<string, unknown>
    }>
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.metadata?.meta_page_ids).toEqual(["P1", "P2"])
  })

  test("refuses, writing nothing, when the app's callback points at another cell", async () => {
    const g = fakeGraph({ cell: CELL, currentCallback: "https://cell-b.example.test/webhooks/_cell/meta" })
    const { ctx } = await seededCtx(g)
    const r = await webhooksSetup({}, ctx)
    expect("error" in r && r.error.code).toBe("meta_callback_other_cell")
    expect(writes(g.calls)).toEqual([])
    expect(g.state.appSub?.callback_url).toBe("https://cell-b.example.test/webhooks/_cell/meta")
  })

  test("takes the app over from a workspace-host callback (the pre-cell layout)", async () => {
    const g = fakeGraph({ cell: CELL, currentCallback: `${BASE}/webhooks/org-9/social/meta` })
    const { ctx } = await seededCtx(g)
    const r = await webhooksSetup({}, ctx)
    if (!("pages" in r)) throw new Error(JSON.stringify(r))
    expect(r.app.status).toBe("subscribed")
    expect(g.state.appSub?.callback_url).toBe(CELL.callback)
  })

  test("self-hosted (no cell callback): the workspace callback and no Page ids recorded", async () => {
    const g = fakeGraph()
    const { ctx, db } = await seededCtx(g)
    const r = await webhooksSetup({}, ctx)
    if (!("pages" in r)) throw new Error(JSON.stringify(r))
    expect(r.callback_url).toBe(CALLBACK)
    const rows = (await db.findMany("sync_state", { where: { platform: "facebook" } })) as Array<{
      metadata?: Record<string, unknown>
    }>
    for (const row of rows) expect(row.metadata?.meta_page_ids).toBeUndefined()
  })
})
