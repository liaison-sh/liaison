// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The gate, proved at the wire.
//
// There is a paying customer on this code, so the OFF state is the assertion
// that matters most: with demo mode off, and with demo mode on for an org that
// carries no marker, a Shopify call leaves through exactly the transport it left
// through before any of this existed. Every "went out" and "did not go out"
// below is read off a recorder sitting where the real transport sits, never off
// a config value.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { createCredentialConnection, startOAuthFlow } from "~/modules/apps/connections/service"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { DemoRestrictionError } from "~/modules/demo/demo-egress"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { installDemoShopifyConnection } from "./connection"
import { resetDemoShopifyOverlay } from "./overlay"
import { forgetDemoShopifyStore } from "./replica"
import { DEMO_SHOP_DOMAIN, DEMO_SHOPIFY_SENTINEL_TOKEN } from "./sentinel"

const SHOP_URL = `https://${DEMO_SHOP_DOMAIN}/admin/api/2026-04/graphql.json`
// A customer's own store. The fixed demo shop above never goes out on any box
// (fixture-credential.ts), so "goes out as it always did" is read off this one.
const REAL_SHOP_URL = "https://a-real-store.myshopify.com/admin/api/2026-04/graphql.json"
// A host no demo provider answers (Boxtal has its own demo carrier now, so a
// Boxtal URL is fixture-answered rather than refused).
const OTHER_URL = "https://api.carrier.example/v1/shipments"

/** Every request that actually reached the transport. */
let onTheWire: string[] = []

function sandboxFetch(orgId: string, userId: string) {
  const methods = createEgressMethods({
    orgId,
    userId,
    appName: "shopify",
    actorType: "user",
    egress: async () => ({
      allowedDomains: ["*.myshopify.com", "api.carrier.example"],
      manifest: { name: "shopify" },
    }),
    callerScopes: [],
    inheritedActor: { actorType: "user" as const },
    manifest: { name: "shopify" },
    txDb: null,
    resolveCredentials: async () => ({}),
  } as unknown as BridgeContext)
  return (url: string, body?: unknown) =>
    methods.fetch(
      url,
      JSON.stringify({ method: "POST", headers: {}, body: JSON.stringify(body ?? {}) }),
    ) as Promise<string>
}

async function graphql(
  orgId: string,
  userId: string,
  operationName: string,
  variables: Record<string, unknown> = {},
  url: string = SHOP_URL,
): Promise<any> {
  const raw = await sandboxFetch(orgId, userId)(url, {
    query: `query ${operationName} { placeholder }`,
    operationName,
    variables,
  })
  const envelope = JSON.parse(raw) as { status: number; body: string }
  return { status: envelope.status, ...(JSON.parse(envelope.body) as Record<string, unknown>) }
}

describe("the demo Shopify provider's gate", () => {
  let demoOrgId: string
  let normalOrgId: string
  let demoUserId: string
  let normalUserId: string

  beforeAll(async () => {
    await acquireTestLock()
    demoOrgId = (await ensureOrg({ slug: "shopify-demo-org", name: "Shopify Demo" })).orgId
    normalOrgId = (await ensureOrg({ slug: "shopify-normal-org", name: "Shopify Normal" })).orgId
    demoUserId = (
      await ensureUser({
        orgId: demoOrgId,
        email: "shopify-demo@example.com",
        name: "Demo",
        password: "Passw0rd!",
        role: "admin",
      })
    ).userId
    normalUserId = (
      await ensureUser({
        orgId: normalOrgId,
        email: "shopify-normal@example.com",
        name: "Normal",
        password: "Passw0rd!",
        role: "admin",
      })
    ).userId
    await markOrgAsDemo(demoOrgId, visitorMarker(24))
    // The recorder stands exactly where the real transport stands, and claims
    // both hosts so a call that is NOT intercepted still lands somewhere this
    // test can see rather than hitting the network.
    SandboxBridgeTestAccess.setFetchInterceptsHost(() => true)
    SandboxBridgeTestAccess.setFetch((async (input: unknown) => {
      onTheWire.push(String(input))
      return new Response(JSON.stringify({ data: { shop: { name: "REAL STORE" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch)
  })

  afterAll(async () => {
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    DemoModeTestAccess.set(null)
    resetDemoShopifyOverlay()
    await releaseTestLock()
  })

  afterEach(() => {
    onTheWire = []
    invalidateDemoMarker()
    resetDemoShopifyOverlay()
  })

  it("OFF: with demo mode off, a marked org's Shopify call goes out as it always did", async () => {
    DemoModeTestAccess.set(false)
    const result = await graphql(demoOrgId, demoUserId, "OrdersSearch", { first: 5 }, REAL_SHOP_URL)
    expect(onTheWire).toEqual([REAL_SHOP_URL])
    expect(result.data.shop.name).toBe("REAL STORE")
  })

  // THE PRIVATE QA BOX. It runs the product as it ships (demo mode off) and is
  // filled with the demo world, so the fixture shop has to answer there or
  // every Shopify screen on it is empty. The flag widens gate one ALONE: the
  // org gate below is unchanged, which the second case pins.
  it("QA: with LIAISON_DEMO_SHOPIFY_FIXTURES on and demo mode off, a marked org is answered from fixtures", async () => {
    DemoModeTestAccess.set(false)
    const before = env.LIAISON_DEMO_SHOPIFY_FIXTURES
    env.LIAISON_DEMO_SHOPIFY_FIXTURES = true
    try {
      const result = await graphql(demoOrgId, demoUserId, "OrdersSearch", { query: null, first: 5 })
      expect(onTheWire).toEqual([])
      expect(result.data.orders.edges).toHaveLength(5)
    } finally {
      env.LIAISON_DEMO_SHOPIFY_FIXTURES = before
    }
  })

  it("QA: the flag does NOT widen the org gate: an unmarked org still goes out", async () => {
    DemoModeTestAccess.set(false)
    const before = env.LIAISON_DEMO_SHOPIFY_FIXTURES
    env.LIAISON_DEMO_SHOPIFY_FIXTURES = true
    try {
      const result = await graphql(
        normalOrgId,
        normalUserId,
        "OrdersSearch",
        { first: 5 },
        REAL_SHOP_URL,
      )
      expect(onTheWire).toEqual([REAL_SHOP_URL])
      expect(result.data.shop.name).toBe("REAL STORE")
    } finally {
      env.LIAISON_DEMO_SHOPIFY_FIXTURES = before
    }
  })

  it("OFF: with demo mode on, an UNMARKED org's Shopify call goes out as it always did", async () => {
    DemoModeTestAccess.set(true)
    const result = await graphql(
      normalOrgId,
      normalUserId,
      "OrdersSearch",
      { first: 5 },
      REAL_SHOP_URL,
    )
    expect(onTheWire).toEqual([REAL_SHOP_URL])
    expect(result.data.shop.name).toBe("REAL STORE")
  })

  // This case used to assert that a demo org's calls to every OTHER host still
  // went out, which is precisely the hole the app-egress lockdown closed: a
  // visitor could reach Boxtal, Pennylane or Meta from the demo box. What it was
  // really pinning is that the SHOPIFY gate is keyed on the host and does not
  // silently swallow anything else, so it now pins the same scoping against the
  // posture that replaced it: another host is REFUSED (not fixture-answered),
  // and either way nothing reaches the transport.
  it("a demo org's call to another host is refused by the app-egress lockdown, not by this gate", async () => {
    DemoModeTestAccess.set(true)
    await expect(
      sandboxFetch(demoOrgId, demoUserId)(OTHER_URL, { anything: true }),
    ).rejects.toThrow(DemoRestrictionError)
    expect(onTheWire).toEqual([])
  })

  it("OFF: a demo org's calls to every OTHER host still go out with demo mode off", async () => {
    DemoModeTestAccess.set(false)
    await sandboxFetch(demoOrgId, demoUserId)(OTHER_URL, { anything: true })
    expect(onTheWire).toEqual([OTHER_URL])
  })

  it("OFF: an UNMARKED org's calls to every OTHER host still go out on the demo box", async () => {
    DemoModeTestAccess.set(true)
    await sandboxFetch(normalOrgId, normalUserId)(OTHER_URL, { anything: true })
    expect(onTheWire).toEqual([OTHER_URL])
  })

  it("ON: a demo org's Shopify call is answered from fixtures and never reaches the wire", async () => {
    DemoModeTestAccess.set(true)
    const result = await graphql(demoOrgId, demoUserId, "OrdersSearch", { query: null, first: 5 })
    expect(onTheWire).toEqual([])
    expect(result.data.orders.edges).toHaveLength(5)
    expect(result.data.ordersCount.count).toBeGreaterThan(50)
  })

  it("ON: an unmodelled Shopify write is refused and still never reaches the wire", async () => {
    DemoModeTestAccess.set(true)
    const raw = await sandboxFetch(demoOrgId, demoUserId)(SHOP_URL, {
      query:
        "mutation ProductCreate($input: ProductInput!) { productCreate(input: $input) { product { id } } }",
      operationName: "ProductCreate",
      variables: { input: { title: "Not happening" } },
    })
    const body = JSON.parse((JSON.parse(raw) as { body: string }).body) as any
    expect(body.errors[0].extensions.code).toBe("DEMO_WRITE_BLOCKED")
    expect(onTheWire).toEqual([])
  })
})

// Regression: the demo store's writes lived in the writer's memory only. With
// several api replicas and a worker, an order tagged through one process was
// untagged when read through another.
describe("the demo store's writes, across processes", () => {
  let orgId: string
  let userId: string

  beforeAll(async () => {
    orgId = (await ensureOrg({ slug: "shopify-demo-replicas", name: "Shopify Replicas" })).orgId
    userId = (
      await ensureUser({
        orgId,
        email: "shopify-replicas@example.com",
        name: "Replicas",
        password: "Passw0rd!",
        role: "admin",
      })
    ).userId
    await markOrgAsDemo(orgId, visitorMarker(24))
    await forgetDemoShopifyStore(orgId)
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    await forgetDemoShopifyStore(orgId)
  })

  async function mutate(operationName: string, variables: Record<string, unknown>) {
    const raw = await sandboxFetch(orgId, userId)(SHOP_URL, {
      query: `mutation ${operationName} { placeholder }`,
      operationName,
      variables,
    })
    return JSON.parse((JSON.parse(raw) as { body: string }).body) as any
  }

  it("a write made through one process is read through another, and a reset reaches every one", async () => {
    DemoModeTestAccess.set(true)
    const listed = await graphql(orgId, userId, "OrdersSearch", { query: null, first: 1 })
    const orderId = listed.data.orders.edges[0].node.id as string
    const tag = `replica-${Date.now()}`

    const added = await mutate("TagsAdd", { id: orderId, tags: [tag] })
    expect(added.data.tagsAdd.userErrors).toEqual([])
    const note = await mutate("OrderNoteSet", {
      input: { id: orderId, note: "Leave it at the back door" },
    })
    expect(note.data.orderUpdate.userErrors).toEqual([])

    // Another process: nothing of this org's store in its memory.
    resetDemoShopifyOverlay(orgId)
    const read = await graphql(orgId, userId, "OrderGet", { id: orderId })
    expect(read.data.order.tags).toContain(tag)
    expect(read.data.order.note).toBe("Leave it at the back door")

    // A re-seed on another process (what its forgetDemoShopifyStore does in
    // Redis): this process's replica, which holds the tag, starts again.
    await redis.incr(`demo:shopify:epoch:${orgId}`)
    await redis.del(`demo:shopify:log:${orgId}`)
    const fresh = await graphql(orgId, userId, "OrderGet", { id: orderId })
    expect(fresh.data.order.tags).not.toContain(tag)
    expect(onTheWire).toEqual([])
  })
})

describe("the demo Shopify connection cannot be upgraded by a visitor", () => {
  let demoOrgId: string
  let demoUserId: string

  beforeAll(async () => {
    await acquireTestLock()
    demoOrgId = (await ensureOrg({ slug: "shopify-upgrade-org", name: "Shopify Upgrade" })).orgId
    demoUserId = (
      await ensureUser({
        orgId: demoOrgId,
        email: "shopify-upgrade@example.com",
        name: "Demo",
        password: "Passw0rd!",
        role: "admin",
      })
    ).userId
    await markOrgAsDemo(demoOrgId, visitorMarker(24))
    DemoModeTestAccess.set(true)
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  it("installs a row carrying the sentinel and the fixed demo shop, nothing else", async () => {
    const installed = await installDemoShopifyConnection({
      orgId: demoOrgId,
      createdByUserId: demoUserId,
    })
    expect(installed.shopDomain).toBe(DEMO_SHOP_DOMAIN)
    const [row] = await sql<
      {
        identifier: string
        app_name: string
        connection_name: string
        owner_type: string
        metadata: any
      }[]
    >`SELECT identifier, app_name, connection_name, owner_type, metadata
        FROM kernel.connected_accounts WHERE org_id = ${demoOrgId}`
    expect(row.identifier).toBe(DEMO_SHOP_DOMAIN)
    expect(row.app_name).toBe("shopify")
    expect(row.connection_name).toBe("shop")
    expect(row.owner_type).toBe("org")
    expect(row.metadata.demo).toBe(true)
  })

  it("is idempotent: a re-seed keeps the same connection id", async () => {
    const first = await installDemoShopifyConnection({
      orgId: demoOrgId,
      createdByUserId: demoUserId,
    })
    const second = await installDemoShopifyConnection({
      orgId: demoOrgId,
      createdByUserId: demoUserId,
    })
    expect(second.connectionId).toBe(first.connectionId)
    const [row] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM kernel.connected_accounts WHERE org_id = ${demoOrgId}`
    expect(Number(row.count)).toBe(1)
  })

  it("stores no secret: the token is the published sentinel, not a credential", () => {
    expect(DEMO_SHOPIFY_SENTINEL_TOKEN).toBe("liaison-demo-fixture-not-a-shopify-token")
    expect(DEMO_SHOPIFY_SENTINEL_TOKEN).not.toMatch(/^shp(at|ca|ss)_/)
  })

  it("REFUSES a visitor re-connecting over it with a real Shopify token", async () => {
    await installDemoShopifyConnection({ orgId: demoOrgId, createdByUserId: demoUserId })
    await expect(
      withSystemDb("test-demo-shopify-upgrade", (tx) =>
        createCredentialConnection(tx, demoOrgId, demoUserId, "shopify", "shop", {
          identifier: "a-real-store.myshopify.com",
          credentials: { accessToken: "shpat_arealtokenarealtokenarealtoken" },
          ownerType: "org",
        }),
      ),
    ).rejects.toThrow(DemoRestrictionError)

    // And the demo row is untouched: still one row, still the demo shop.
    const rows = await sql<{ identifier: string }[]>`
      SELECT identifier FROM kernel.connected_accounts WHERE org_id = ${demoOrgId}`
    expect(rows.map((r) => r.identifier)).toEqual([DEMO_SHOP_DOMAIN])
  })

  it("REFUSES a visitor starting a real Shopify OAuth grant", async () => {
    await expect(
      startOAuthFlow(demoOrgId, demoUserId, "shopify", "shop", {
        ownerType: "org",
        shop: "a-real-store.myshopify.com",
      }),
    ).rejects.toThrow(DemoRestrictionError)
  })
})
