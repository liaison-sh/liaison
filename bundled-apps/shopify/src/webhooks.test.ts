// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B9 — Shopify webhook handlers tests.
//
// Covers:
//   • dedup ledger (`webhook_deliveries`) — second delivery with same id
//     returns 200 without re-emitting.
//   • concurrent delivery — two parallel handlers on the same id ⇒ exactly
//     one emit, both 200 (UNIQUE(webhookId) loser sees the row).
//   • Phase-17 contract fields on shopify:order_created.
//   • resolveContact called with flat-string externalId (per Task A0 SDK
//     signature; bridge keys it under `shopify`).
//   • Guest checkout (payload.customer == null) skips resolveContact.
//   • Downstream emit failure ⇒ 5xx, ledger row stays in `processing`.
//   • inventory_levels/update short-circuits when not in allowlist.
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { channelName, loadDeclaredEmits } from "./lib/emit.testutil"
import {
  appUninstalledHandler,
  customersCreateHandler,
  draftOrdersCreateHandler,
  draftOrdersDeleteHandler,
  draftOrdersUpdateHandler,
  inventoryLevelsUpdateHandler,
  ordersCreateHandler,
  ordersUpdatedHandler,
  productsCreateHandler,
  productsUpdateHandler,
  refundsCreateHandler,
  buyerTaxIdFromNoteAttributes,
  shippingRefundMinor,
} from "./webhooks"

const ORG = "00000000-0000-0000-0000-000000000001"
const USER = "00000000-0000-0000-0000-000000000002"
const declaredEmits = loadDeclaredEmits()

type StoredRow = { id: string } & Record<string, unknown>

interface CtxSpy {
  inserts: Array<{ entity: string; data: Record<string, unknown> }>
  updates: Array<{ entity: string; id: string; data: Record<string, unknown> }>
  rows: Map<string, StoredRow[]>
  emits: Array<{ entity: string; action: string; entityId?: string; data?: unknown; metadata?: Record<string, unknown> }>
  channels: string[]
  resolveContactCalls: Array<{ email?: string; name?: string; externalId?: string }>
  failNextEmit: boolean
  // Concurrency knobs.
  uniqueInsert: boolean // when true, second insert with the same webhookId throws.
}

function makeCtx(): { ctx: AppContext; spy: CtxSpy } {
  const spy: CtxSpy = {
    inserts: [],
    updates: [],
    rows: new Map(),
    emits: [],
    channels: [],
    resolveContactCalls: [],
    failNextEmit: false,
    uniqueInsert: true,
  }
  let nextId = 1000
  const ctx = {
    userId: USER,
    orgId: ORG,
    db: {
      findMany: async (entity: string, opts?: { where?: Record<string, unknown>; limit?: number }) => {
        const all = spy.rows.get(entity) ?? []
        const where = opts?.where ?? {}
        const filtered = all.filter((r) =>
          Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
        )
        return opts?.limit ? filtered.slice(0, opts.limit) : filtered
      },
      findOne: async (entity: string, id: string) => {
        const all = spy.rows.get(entity) ?? []
        return all.find((r) => r.id === id) ?? null
      },
      insert: async (entity: string, data: Record<string, unknown>) => {
        // Enforce UNIQUE(webhookId) for webhook_deliveries.
        if (spy.uniqueInsert && entity === "webhook_deliveries" && data.webhookId) {
          const arr = spy.rows.get(entity) ?? []
          if (arr.some((r) => r.webhookId === data.webhookId)) {
            const e = new Error("UNIQUE constraint failed: webhookId") as Error & { code?: string }
            e.code = "UNIQUE_VIOLATION"
            throw e
          }
        }
        spy.inserts.push({ entity, data })
        const id = `row-${nextId++}`
        const row = Object.assign({}, data, { id }) as StoredRow
        const arr = spy.rows.get(entity) ?? []
        arr.push(row)
        spy.rows.set(entity, arr)
        return { id }
      },
      update: async (entity: string, id: string, data: Record<string, unknown>) => {
        spy.updates.push({ entity, id, data })
        const arr = spy.rows.get(entity) ?? []
        const idx = arr.findIndex((r) => r.id === id)
        if (idx >= 0) arr[idx] = Object.assign({}, arr[idx], data, { id }) as StoredRow
      },
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async () => 0,
    },
    // Enforcing emit: throws (like the kernel rpc-bridge guard) if a handler
    // emits an `${entity}:${action}` not declared in the real app.manifest.json,
    // so a drift between a webhook handler and the manifest fails HERE.
    emit: async (e: { entity: string; action: string; entityId?: string; data?: unknown; metadata?: Record<string, unknown> }) => {
      if (spy.failNextEmit) {
        spy.failNextEmit = false
        throw new Error("downstream emit failed")
      }
      const eventKey = `${e.entity}:${e.action}`
      if (!declaredEmits.has(eventKey)) {
        throw new Error(`webhook emitted undeclared event "${eventKey}"`)
      }
      spy.channels.push(channelName("shopify", e.entity, e.action))
      spy.emits.push(e)
    },
    enqueueJob: async () => undefined,
    resolveContact: async (params: { email?: string; name?: string; externalId?: string }) => {
      spy.resolveContactCalls.push(params)
      return {}
    },
    // The demo store is connected (an active `shop` account): a webhook for a shop
    // with no connected account is refused.
    connections: {
      getAccounts: async (_name: string) => [
        { id: "acct-demo", ownerType: "org", identifier: "demo.myshopify.com" },
      ],
      getToken: async (_name: string) => "token",
    } as never,
    fetch: async () => ({ status: 200, headers: {}, body: "" }),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agent_run: async () => "{}",
    realtime_publish: async () => "{}",
    grants_setUserScopes: async () => "{}",
    bulk: {
      fetchToBlob: async () => ({ blobId: "x", sizeBytes: 0 }),
      iterateJsonl: async function* () {},
      deleteBlob: async () => undefined,
    },
  } as unknown as AppContext
  return { ctx, spy }
}

const FIXTURE_CUSTOMER = {
  id: 5_555,
  email: "alice@example.com",
  first_name: "Alice",
  last_name: "Chen",
}

const FIXTURE_ORDER = {
  id: 1_001,
  name: "#1001",
  email: "alice@example.com",
  currency: "EUR",
  total_price: "42.00",
  customer: FIXTURE_CUSTOMER,
  market: { id: "mkt_eu", name: "EU" },
  line_items: [
    {
      id: 9_001,
      variant_id: 8_001,
      variant_title: "Default",
      sku: "ALC-1",
      title: "Aldcaste",
      quantity: 1,
    },
  ],
  fulfillment_status: null,
}

const HDR = (id: string, extra: Record<string, string> = {}) => ({
  "x-shopify-webhook-id": id,
  "x-shopify-shop-domain": "demo.myshopify.com",
  ...extra,
})

describe("webhooks — dedup ledger", () => {
  it("second delivery with same X-Shopify-Webhook-Id returns 200 without re-emitting", async () => {
    const { ctx, spy } = makeCtx()
    await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh1"))
    await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh1"))
    const orderEmits = spy.emits.filter((e) => e.entity === "order" && e.action === "created")
    expect(orderEmits.length).toBe(1)
  })

  it("ledger row is flipped to 'processed' after successful emit", async () => {
    const { ctx, spy } = makeCtx()
    await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-ok"))
    const row = (spy.rows.get("webhook_deliveries") ?? []).find(
      (r) => r.webhookId === "wh-ok",
    )
    expect(row?.status).toBe("processed")
  })
})

describe("webhooks — orders/create contract", () => {
  it("emits shopify.order.created with Phase-17 contract fields", async () => {
    const { ctx, spy } = makeCtx()
    await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh2"))
    const evt = spy.emits.find((e) => e.entity === "order" && e.action === "created")
    expect(evt).toBeDefined()
    // Cluster-1 — resolves to the canonical channel (not the old collapsed
    // `events:shopify:shopify:order_created`).
    expect(spy.channels).toContain(channelName("shopify", "order", "created"))
    const data = evt?.data as Record<string, unknown>
    const customer = data?.customer as { external_ids?: { shopify?: string } }
    expect(data.orderId).toBe(String(FIXTURE_ORDER.id))
    expect(customer.external_ids?.shopify).toBe(String(FIXTURE_CUSTOMER.id))
    const lines = data.lineItems as Array<{
      variant: { id: string; title: string; sku: string }
    }>
    const line = lines[0] as {
      variant: { id: string; title: string; sku: string }
      priceSet?: { amount: string; currencyCode: string }
      quantity?: number
    }
    expect(line).toBeDefined()
    expect(line.variant.id).toBe(String(FIXTURE_ORDER.line_items[0]?.variant_id))
    expect(line.variant.title).toBe("Default")
    expect(line.variant.sku).toBe("ALC-1")
    // Phase-17 contract: lineItems[].priceSet is the canonical price shape.
    expect(line.priceSet).toBeDefined()
    expect(typeof line.priceSet?.amount).toBe("string")
    expect(typeof line.priceSet?.currencyCode).toBe("string")
    const total = data.totalPrice as { amount: string; currencyCode: string }
    expect(total.currencyCode).toBe("EUR")
    expect(typeof total.amount).toBe("string")
    // Phase-17 contract: marketId is present (may be null on stores without Markets).
    expect("marketId" in data).toBe(true)
    // Order-level payment state is threaded onto the event so invoicing's
    // auto-issue flow can record a paid checkout's invoice as PAID at issue time.
    expect("financialStatus" in data).toBe(true)
    // Phase-17 contract: metadata (axes) is a top-level field on the emit
    // envelope, not embedded under data. The attention translator reads
    // event.metadata directly (translator.ts axes extraction).
    const meta = (evt?.metadata ?? {}) as { shopify_webhook_id?: string; market?: string; currency?: string }
    expect(meta.shopify_webhook_id).toBe("wh2")
    expect(meta.market).toBe("EU")
    expect(meta.currency).toBe("EUR")
  })

  it("customer.country is populated from ship-to (falls back to default_address, then billing)", async () => {
    // Invoicing's order-paid auto-flow classifies the tax treatment from
    // event.customer.country — without it every webhook order defaults to the
    // issuer's country (domestic) and an export order gets standard VAT and no
    // HS/customs enrichment.
    const { ctx, spy } = makeCtx()
    const shipTo = {
      ...FIXTURE_ORDER,
      shipping_address: { country_code: "us", country: "United States" },
      billing_address: { country_code: "FR" },
      customer: { ...FIXTURE_CUSTOMER, default_address: { country_code: "DE" } },
    }
    await ordersCreateHandler(shipTo, ctx, HDR("wh-country-ship"))
    let evt = spy.emits.find((e) => e.entity === "order" && e.action === "created")
    expect((evt?.data as { customer?: { country?: string | null } }).customer?.country).toBe("US")

    const { ctx: ctx2, spy: spy2 } = makeCtx()
    const noShip = {
      ...FIXTURE_ORDER,
      billing_address: { country_code: "FR" },
      customer: { ...FIXTURE_CUSTOMER, default_address: { country_code: "DE" } },
    }
    await ordersCreateHandler(noShip, ctx2, HDR("wh-country-default"))
    evt = spy2.emits.find((e) => e.entity === "order" && e.action === "created")
    expect((evt?.data as { customer?: { country?: string | null } }).customer?.country).toBe("DE")

    const { ctx: ctx3, spy: spy3 } = makeCtx()
    await ordersCreateHandler(FIXTURE_ORDER, ctx3, HDR("wh-country-none"))
    evt = spy3.emits.find((e) => e.entity === "order" && e.action === "created")
    expect((evt?.data as { customer?: { country?: string | null } }).customer?.country).toBeNull()
  })

  it("resolveContact is called with externalId as a flat string", async () => {
    const { ctx, spy } = makeCtx()
    await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-rc"))
    expect(spy.resolveContactCalls.length).toBe(1)
    const args = spy.resolveContactCalls[0]
    expect(args).toBeDefined()
    expect(args?.email).toBe(FIXTURE_CUSTOMER.email)
    expect(args?.externalId).toBe(String(FIXTURE_CUSTOMER.id))
    expect(typeof args?.externalId).toBe("string")
  })

  it("guest checkout (payload.customer == null) skips resolveContact + emits with null customer", async () => {
    const { ctx, spy } = makeCtx()
    const guestOrder = { ...FIXTURE_ORDER, customer: null }
    await ordersCreateHandler(guestOrder, ctx, HDR("wh-guest"))
    expect(spy.resolveContactCalls.length).toBe(0)
    const evt = spy.emits.find((e) => e.entity === "order" && e.action === "created")
    const data = (evt?.data ?? {}) as Record<string, unknown>
    expect(data.customer).toBeNull()
    expect(data.customerId).toBeNull()
  })

  it("emits poNumber on the order event when the webhook payload carries a PO", async () => {
    // Event/normalized shapes are camelCase (orderId, customerId, totalPrice, ...) -- invoicing's
    // consumer (shopify-order-paid.ts's ShopifyOrderCreatedEvent) reads event.poNumber, NOT
    // event.po_number (that snake_case spelling is the reads.ts TOOL RESULT convention only).
    const { ctx, spy } = makeCtx()
    const withPo = { ...FIXTURE_ORDER, po_number: "PO-8842" }
    await ordersCreateHandler(withPo, ctx, HDR("wh-po-present"))
    const evt = spy.emits.find((e) => e.entity === "order" && e.action === "created")
    const data = (evt?.data ?? {}) as Record<string, unknown>
    expect(data.poNumber).toBe("PO-8842")
    // Regression guard: if the emitted key's casing slips back to po_number, this must fail.
    expect("po_number" in data).toBe(false)
  })

  it("emits poNumber as null, matching every sibling field, when the order carries no PO", async () => {
    const { ctx, spy } = makeCtx()
    await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-po-absent"))
    const evt = spy.emits.find((e) => e.entity === "order" && e.action === "created")
    const data = (evt?.data ?? {}) as Record<string, unknown>
    expect(data.poNumber).toBeNull()
    expect("po_number" in data).toBe(false)

    // Shopify sending an explicit "" (rather than omitting the field/sending null) must also
    // normalize to null, never a literal empty string reaching invoicing.
    const { ctx: ctx2, spy: spy2 } = makeCtx()
    const emptyPo = { ...FIXTURE_ORDER, po_number: "" }
    await ordersCreateHandler(emptyPo, ctx2, HDR("wh-po-empty-string"))
    const evt2 = spy2.emits.find((e) => e.entity === "order" && e.action === "created")
    const data2 = (evt2?.data ?? {}) as Record<string, unknown>
    expect(data2.poNumber).toBeNull()
  })

  // Boxtal "To prepare" contract: the emitted order:updated payload must carry the internal
  // staff note so an event-driven consumer sees it, honestly, alongside the pull-based reads.
  it("orders/updated emits the internal staff note on the order:updated payload", async () => {
    const { ctx, spy } = makeCtx()
    const withNote = { ...FIXTURE_ORDER, note: "Ship with the spare pedal" }
    await ordersUpdatedHandler(withNote, ctx, HDR("wh-note-present"))
    const evt = spy.emits.find((e) => e.entity === "order" && e.action === "updated")
    const data = (evt?.data ?? {}) as Record<string, unknown>
    expect(data.note).toBe("Ship with the spare pedal")
  })

  it("orders/updated emits note as null, never undefined, when the order carries none", async () => {
    const { ctx, spy } = makeCtx()
    await ordersUpdatedHandler(FIXTURE_ORDER, ctx, HDR("wh-note-absent"))
    const evt = spy.emits.find((e) => e.entity === "order" && e.action === "updated")
    const data = (evt?.data ?? {}) as Record<string, unknown>
    expect(data.note).toBeNull()
  })
})

describe("webhooks — customers/create", () => {
  it("calls resolveContact with externalId as a flat string (bridge keys it under 'shopify')", async () => {
    const { ctx, spy } = makeCtx()
    await customersCreateHandler(FIXTURE_CUSTOMER, ctx, HDR("wh3"))
    const args = spy.resolveContactCalls[0]
    expect(args).toBeDefined()
    expect(args?.email).toBe(FIXTURE_CUSTOMER.email)
    expect(args?.externalId).toBe(String(FIXTURE_CUSTOMER.id))
    expect(typeof args?.externalId).toBe("string")
    expect(args?.name).toBe("Alice Chen")
  })
})

describe("webhooks — downstream emit failure", () => {
  it("downstream error returns 5xx; row flips to 'failed' so retries re-process (I12)", async () => {
    const { ctx, spy } = makeCtx()
    spy.failNextEmit = true
    const res = await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh4"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const row = (spy.rows.get("webhook_deliveries") ?? []).find(
      (r) => r.webhookId === "wh4",
    )
    expect(row?.status).toBe("failed")
    expect((row as { failureCount?: number })?.failureCount).toBeGreaterThan(0)
  })

  it("retry after a 'failed' row re-runs the handler and emits (I12)", async () => {
    const { ctx, spy } = makeCtx()
    spy.failNextEmit = true
    // 1st delivery fails — row ends up "failed".
    await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-retry"))
    const initialEmits = spy.emits.length
    // 2nd delivery (Shopify retry) — should re-process & emit, not dedup.
    const res2 = await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-retry"))
    expect(res2.status).toBe(200)
    expect(spy.emits.length).toBe(initialEmits + 1)
    const row = (spy.rows.get("webhook_deliveries") ?? []).find(
      (r) => r.webhookId === "wh-retry",
    )
    expect(row?.status).toBe("processed")
  })
})

describe("webhooks — inventory_levels/update allowlist", () => {
  it("short-circuits when location not in install_metadata.inventoryLocationAllowlist", async () => {
    const { ctx, spy } = makeCtx()
    await ctx.db.insert("install_metadata", {
      shopDomain: "demo.myshopify.com",
      inventoryLocationAllowlist: ["loc-1"],
    })
    await inventoryLevelsUpdateHandler(
      { inventory_item_id: "ii-1", location_id: "loc-2", available: 5 },
      ctx,
      HDR("wh-inv-skip"),
    )
    expect(spy.emits.length).toBe(0)
  })

  it("passes through when allowlist is null (no restriction)", async () => {
    const { ctx, spy } = makeCtx()
    await inventoryLevelsUpdateHandler(
      { inventory_item_id: "ii-1", location_id: "loc-2", available: 5 },
      ctx,
      HDR("wh-inv-ok"),
    )
    expect(spy.emits.length).toBe(1)
  })

  it("passes through when location is in allowlist", async () => {
    const { ctx, spy } = makeCtx()
    await ctx.db.insert("install_metadata", {
      shopDomain: "demo.myshopify.com",
      inventoryLocationAllowlist: ["loc-1", "loc-2"],
    })
    await inventoryLevelsUpdateHandler(
      { inventory_item_id: "ii-1", location_id: "loc-1", available: 10 },
      ctx,
      HDR("wh-inv-pass"),
    )
    expect(spy.emits.length).toBe(1)
  })
})

describe("webhooks — concurrent delivery", () => {
  it("two parallel handlers on the same webhookId ⇒ exactly one emit, both 200", async () => {
    const { ctx, spy } = makeCtx()
    const [r1, r2] = await Promise.all([
      ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-race")),
      ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-race")),
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const orderEmits = spy.emits.filter((e) => e.entity === "order" && e.action === "created")
    expect(orderEmits.length).toBe(1)
  })
})

describe("webhooks — missing webhook id", () => {
  it("returns 400 when X-Shopify-Webhook-Id header is absent", async () => {
    const { ctx } = makeCtx()
    const res = await ordersCreateHandler(FIXTURE_ORDER, ctx, {
      "x-shopify-shop-domain": "demo.myshopify.com",
    })
    expect(res.status).toBe(400)
  })
})

describe("webhooks — shop-domain validation", () => {
  it("rejects (401, no emit) when X-Shopify-Shop-Domain does not match the installed shop", async () => {
    const { ctx, spy } = makeCtx()
    await ctx.db.insert("install_metadata", { shopDomain: "demo.myshopify.com" })
    const res = await ordersCreateHandler(
      FIXTURE_ORDER,
      ctx,
      HDR("wh-spoof", { "x-shopify-shop-domain": "evil.myshopify.com" }),
    )
    expect(res.status).toBe(401)
    expect(spy.emits.length).toBe(0)
    // The spoofed delivery must never enter the ledger.
    expect(spy.rows.get("webhook_deliveries") ?? []).toHaveLength(0)
  })

  it("accepts when the shop-domain header matches the installed shop", async () => {
    const { ctx, spy } = makeCtx()
    await ctx.db.insert("install_metadata", { shopDomain: "demo.myshopify.com" })
    const res = await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-match"))
    expect(res.status).toBe(200)
    expect(spy.emits.length).toBe(1)
  })

  it("refuses a delivery with no X-Shopify-Shop-Domain header (a stripped-header replay)", async () => {
    const { ctx, spy } = makeCtx()
    await ctx.db.insert("install_metadata", { shopDomain: "demo.myshopify.com" })
    const res = await ordersCreateHandler(FIXTURE_ORDER, ctx, { "x-shopify-webhook-id": "wh-stripped" })
    expect(res.status).toBe(401)
    expect(spy.emits.length).toBe(0)
    expect(spy.rows.get("webhook_deliveries") ?? []).toHaveLength(0)
  })

  it("refuses a shop this organization has no connected account for (reconnected in another org)", async () => {
    // The store was connected here, then disconnected and connected in another
    // organization. A shared app secret signs both orgs' deliveries, so the HMAC
    // alone cannot tell them apart: the connected account decides.
    const { ctx, spy } = makeCtx()
    await ctx.db.insert("install_metadata", {
      shopDomain: "demo.myshopify.com",
      connectionStatus: "connected",
    })
    ;(ctx as { connections: Record<string, unknown> }).connections = {
      getAccounts: async (_name: string) => [],
      getToken: async (_name: string) => "token",
    }
    const res = await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-other-org"))
    expect(res.status).toBe(401)
    expect(spy.emits.length).toBe(0)
  })

  it("a connected store with no install row is accepted, and the row is recovered", async () => {
    // The connect event that writes install_metadata was lost (boot or redeploy
    // race): the store is connected, so its orders must still land.
    const { ctx, spy } = makeCtx()
    expect(spy.rows.get("install_metadata") ?? []).toHaveLength(0)
    const res = await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-recover"))
    expect(res.status).toBe(200)
    expect(spy.emits.length).toBe(1)
    const rows = spy.rows.get("install_metadata") ?? []
    expect(rows.some((r) => r.shopDomain === "demo.myshopify.com")).toBe(true)
  })

  it("refuses when the install is disconnected (app uninstalled), even with an account row", async () => {
    const { ctx, spy } = makeCtx()
    await ctx.db.insert("install_metadata", {
      shopDomain: "demo.myshopify.com",
      connectionStatus: "disconnected",
    })
    const res = await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-disconnected"))
    expect(res.status).toBe(401)
    expect(spy.emits.length).toBe(0)
  })

  it("refuses before any install exists (no connected account, no install_metadata)", async () => {
    const { ctx, spy } = makeCtx()
    ;(ctx as { connections: Record<string, unknown> }).connections = {
      getAccounts: async (_name: string) => [],
      getToken: async (_name: string) => "token",
    }
    const res = await ordersCreateHandler(
      FIXTURE_ORDER,
      ctx,
      HDR("wh-preinstall", { "x-shopify-shop-domain": "anything.myshopify.com" }),
    )
    expect(res.status).toBe(401)
    expect(spy.emits.length).toBe(0)
  })
})

// X3d — X3c moved the install_metadata self-heal off the read path, so a
// connected shop with a missing row (connect event lost) now stays unhealed
// until the hourly scan job runs, up to an hour later. Webhook dispatch is a
// legitimate write path (unlike a read), so it heals immediately via
// `ensureInstallMetadata` before the domain check runs.
describe("webhooks — install_metadata self-heal on write paths (X3d)", () => {
  const activeConnection = () => ({
    getAccounts: async (_name: string) => [
      { id: "acct-1", ownerType: "org", identifier: "demo.myshopify.com" },
    ],
    getToken: async (_name: string) => "token",
  })

  it("heals from an active connection before the domain check, then rejects a mismatched domain", async () => {
    const { ctx, spy } = makeCtx()
    ;(ctx as { connections: Record<string, unknown> }).connections = activeConnection()
    const res = await ordersCreateHandler(
      FIXTURE_ORDER,
      ctx,
      HDR("wh-heal-spoof", { "x-shopify-shop-domain": "evil.myshopify.com" }),
    )
    expect(res.status).toBe(401)
    expect(spy.emits.length).toBe(0)
  })

  it("heals from an active connection and accepts a matching domain, persisting the row", async () => {
    const { ctx, spy } = makeCtx()
    ;(ctx as { connections: Record<string, unknown> }).connections = activeConnection()
    const res = await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-heal-match"))
    expect(res.status).toBe(200)
    expect(spy.emits.length).toBe(1)
    const rows = spy.rows.get("install_metadata") ?? []
    expect(rows.some((r) => r.shopDomain === "demo.myshopify.com")).toBe(true)
  })

})

describe("webhooks — app/uninstalled heals install_metadata before flipping (X3d)", () => {
  it("heals a missing row from the active connection, then flips it to disconnected", async () => {
    const { ctx, spy } = makeCtx()
    ;(ctx as { connections: Record<string, unknown> }).connections = {
      getAccounts: async (_name: string) => [
        { id: "acct-1", ownerType: "org", identifier: "demo.myshopify.com" },
      ],
      getToken: async (_name: string) => "token",
    }
    const result = await appUninstalledHandler(
      { shop: "demo.myshopify.com" },
      ctx,
      HDR("wh-uninstall-heal"),
    )
    expect(result.status).toBe(200)
    const rows = spy.rows.get("install_metadata") ?? []
    expect(rows).toHaveLength(1)
    expect(rows[0]?.connectionStatus).toBe("disconnected")
  })
})

describe("webhooks — products/create + products/update (customs sync)", () => {
  const PRODUCT = {
    id: 7_777,
    admin_graphql_api_id: "gid://shopify/Product/7777",
    title: "Customs Widget",
    status: "active",
  }

  it("products/create emits shopify.product.created with the product gid as entityId", async () => {
    const { ctx, spy } = makeCtx()
    const res = await productsCreateHandler(PRODUCT, ctx, HDR("wh-prod-c"))
    expect(res.status).toBe(200)
    const evt = spy.emits.find((e) => e.entity === "product" && e.action === "created")
    expect(evt).toBeDefined()
    // entityId must be the gid — invoicing feeds it straight into products_get.
    expect(evt?.entityId).toBe("gid://shopify/Product/7777")
    expect(spy.channels).toContain(channelName("shopify", "product", "created"))
  })

  it("products/update emits shopify.product.updated with the gid (invoicing re-syncs customs)", async () => {
    const { ctx, spy } = makeCtx()
    const res = await productsUpdateHandler(PRODUCT, ctx, HDR("wh-prod-u"))
    expect(res.status).toBe(200)
    const evt = spy.emits.find((e) => e.entity === "product" && e.action === "updated")
    expect(evt?.entityId).toBe("gid://shopify/Product/7777")
  })

  it("constructs the gid from a numeric id when admin_graphql_api_id is absent", async () => {
    const { ctx, spy } = makeCtx()
    await productsUpdateHandler({ id: 4242, title: "No-gid product" }, ctx, HDR("wh-prod-numeric"))
    const evt = spy.emits.find((e) => e.entity === "product" && e.action === "updated")
    expect(evt?.entityId).toBe("gid://shopify/Product/4242")
  })
})

describe("webhooks — refunds/create reconciles the invoice", () => {
  const REFUND = {
    id: 9_999,
    order_id: 1_001,
    transactions: [{ amount: "42.00", currency: "EUR" }],
  }

  it("emits BOTH refund:created_manual (attention) AND refund:created (invoice reconcile)", async () => {
    const { ctx, spy } = makeCtx()
    const res = await refundsCreateHandler(REFUND, ctx, HDR("wh-refund"))
    expect(res.status).toBe(200)
    const manual = spy.emits.find((e) => e.entity === "refund" && e.action === "created_manual")
    const created = spy.emits.find((e) => e.entity === "refund" && e.action === "created")
    expect(manual).toBeDefined()
    expect(created).toBeDefined()
  })

  it("refund:created carries order_id + major amount + currency for the invoicing adapter", async () => {
    const { ctx, spy } = makeCtx()
    await refundsCreateHandler(REFUND, ctx, HDR("wh-refund2"))
    const created = spy.emits.find((e) => e.entity === "refund" && e.action === "created")
    const data = (created?.data ?? {}) as Record<string, unknown>
    expect(data.order_id).toBe(String(REFUND.order_id))
    expect(data.amount).toBe("42.00")
    expect(data.currency).toBe("EUR")
  })

  it("a second delivery of the same refund webhook id dedups (no re-emit)", async () => {
    const { ctx, spy } = makeCtx()
    await refundsCreateHandler(REFUND, ctx, HDR("wh-refund-dup"))
    await refundsCreateHandler(REFUND, ctx, HDR("wh-refund-dup"))
    const created = spy.emits.filter((e) => e.entity === "refund" && e.action === "created")
    expect(created.length).toBe(1)
  })

  it("a shipping-only refund (no refund_line_items) omits the field entirely, unchanged", async () => {
    const { ctx, spy } = makeCtx()
    // REFUND carries no refund_line_items at all (a shipping-only manual refund) -- the emitted
    // event must stay exactly as it was before line attribution existed: no refund_line_items key.
    await refundsCreateHandler(REFUND, ctx, HDR("wh-refund-shipping"))
    const created = spy.emits.find((e) => e.entity === "refund" && e.action === "created")
    const data = (created?.data ?? {}) as Record<string, unknown>
    expect(data.order_id).toBe(String(REFUND.order_id))
    expect("refund_line_items" in data).toBe(false)
  })

  it("refund:created carries per-line attribution (variant gid + minor-unit amount) for a two-line order", async () => {
    const { ctx, spy } = makeCtx()
    const twoLineRefund = {
      id: 10_500,
      order_id: 2_002,
      transactions: [{ amount: "27.63", currency: "EUR" }],
      refund_line_items: [
        {
          line_item_id: 501,
          subtotal: "9.99",
          total_tax: "0.83",
          line_item: { variant_id: 8_101 },
        },
        {
          line_item_id: 502,
          subtotal: "15.00",
          total_tax: "1.25",
          line_item: { variant_id: 8_102 },
        },
      ],
    }
    await refundsCreateHandler(twoLineRefund, ctx, HDR("wh-refund-lines"))
    const created = spy.emits.find((e) => e.entity === "refund" && e.action === "created")
    const data = (created?.data ?? {}) as Record<string, unknown>
    const lines = data.refund_line_items as Array<{ external_id: string; amount_minor: string }>
    expect(lines).toBeDefined()
    expect(lines.length).toBe(2)
    // 9.99 + 0.83 = 10.82 -> 1082 minor units, gid built from the NESTED order line item's
    // numeric variant_id (a refund_line_items entry carries no variant id of its own).
    expect(lines[0]).toEqual({ external_id: "gid://shopify/ProductVariant/8101", amount_minor: "1082" })
    // 15.00 + 1.25 = 16.25 -> 1625 minor units. The two lines' shares (1082, 1625) do not split
    // the transaction amount evenly -- each is computed from its OWN subtotal/tax, not a division
    // of the refund total.
    expect(lines[1]).toEqual({ external_id: "gid://shopify/ProductVariant/8102", amount_minor: "1625" })
  })

  it("a refund_line_items entry with no variant (custom line) emits a null external_id, never a guess", async () => {
    const { ctx, spy } = makeCtx()
    const customLineRefund = {
      id: 10_501,
      order_id: 2_003,
      transactions: [{ amount: "5.00", currency: "EUR" }],
      refund_line_items: [
        { line_item_id: 601, subtotal: "5.00", total_tax: "0.00", line_item: {} },
      ],
    }
    await refundsCreateHandler(customLineRefund, ctx, HDR("wh-refund-custom-line"))
    const created = spy.emits.find((e) => e.entity === "refund" && e.action === "created")
    const data = (created?.data ?? {}) as Record<string, unknown>
    const lines = data.refund_line_items as Array<{ external_id: string | null; amount_minor: string }>
    expect(lines[0]).toEqual({ external_id: null, amount_minor: "500" })
  })
})

describe("webhooks - draft_orders/create, update, delete (quotes-are-draft-orders)", () => {
  const FIXTURE_DRAFT_ORDER = {
    id: 3_001,
    name: "#D3",
    status: "open",
    email: "buyer@example.com",
    currency: "EUR",
    total_price: "108.00",
    subtotal_price: "120.00",
    total_tax: "0.00",
    taxes_included: false,
    tax_exempt: false,
    note: "Quote for Acme Co",
    tags: "liaison-quote, market:eu",
    customer: {
      id: 5_555,
      email: "buyer@example.com",
      first_name: "Bea",
      last_name: "Buyer",
      default_address: { company: "Acme Co" },
    },
    billing_address: {
      name: "Bea Buyer",
      company: "Acme Co",
      address1: "1 Market St",
      city: "Dublin",
      zip: "D01",
      country_code: "ie",
    },
    applied_discount: {
      title: "Loyalty",
      description: "10 percent off",
      value_type: "percentage",
      value: "10.0",
      amount: "12.00",
    },
    shipping_line: { title: "Standard", price: "0.00" },
    tax_lines: [],
    line_items: [
      {
        id: 8_001,
        title: "Aldcaste",
        sku: "ALC-1",
        variant_id: 9_001,
        product_id: 7_001,
        quantity: 2,
        price: "60.00",
        applied_discount: { value_type: "fixed_amount", value: "6.00", amount: "6.00" },
        taxable: true,
        requires_shipping: true,
        custom: false,
      },
    ],
  }

  it("draft_orders/create emits draft_order:created with the DraftOrder gid as entityId", async () => {
    const { ctx, spy } = makeCtx()
    const res = await draftOrdersCreateHandler(FIXTURE_DRAFT_ORDER, ctx, HDR("wh-do-create"))
    expect(res.status).toBe(200)
    const evt = spy.emits.find((e) => e.entity === "draft_order" && e.action === "created")
    expect(evt).toBeDefined()
    expect(evt?.entityId).toBe("gid://shopify/DraftOrder/3001")
    expect(spy.channels).toContain(channelName("shopify", "draft_order", "created"))
  })

  it("draft_orders/create resolves the customer into kernel.contacts", async () => {
    const { ctx, spy } = makeCtx()
    await draftOrdersCreateHandler(FIXTURE_DRAFT_ORDER, ctx, HDR("wh-do-create-contact"))
    expect(spy.resolveContactCalls).toContainEqual({
      email: "buyer@example.com",
      name: "Bea Buyer",
      externalId: "5555",
    })
  })

  it("draft_orders/create emits the normalized shape with gids, addresses, discounts and line items", async () => {
    const { ctx, spy } = makeCtx()
    await draftOrdersCreateHandler(FIXTURE_DRAFT_ORDER, ctx, HDR("wh-do-create-shape"))
    const evt = spy.emits.find((e) => e.entity === "draft_order" && e.action === "created")
    const data = evt?.data as Record<string, unknown>
    expect(data.draftOrderId).toBe("gid://shopify/DraftOrder/3001")
    expect(data.status).toBe("open")
    expect(data.orderId).toBeNull()
    expect(data.orderName).toBeNull()
    expect(data.shopDomain).toBe("demo.myshopify.com")
    expect(data.totalPrice).toBe("108.00")
    expect(data.tags).toEqual(["liaison-quote", "market:eu"])
    const customer = data.customer as Record<string, unknown>
    expect(customer.id).toBe("gid://shopify/Customer/5555")
    expect(customer.company).toBe("Acme Co")
    const billing = data.billingAddress as Record<string, unknown>
    expect(billing.countryCode).toBe("IE")
    const discount = data.appliedDiscount as Record<string, unknown>
    expect(discount.valueType).toBe("PERCENTAGE")
    expect(discount.amount).toBe("12.00")
    const shippingLine = data.shippingLine as Record<string, unknown>
    expect(shippingLine.title).toBe("Standard")
    const lineItems = data.lineItems as Array<Record<string, unknown>>
    expect(lineItems).toHaveLength(1)
    expect(lineItems[0]?.variantId).toBe("gid://shopify/ProductVariant/9001")
    expect(lineItems[0]?.productId).toBe("gid://shopify/Product/7001")
    // quantity(2) * price(60.00) - discount.amount(6.00) = 114.00
    expect(lineItems[0]?.discountedTotal).toBe("114.00")
    expect(evt?.metadata).toMatchObject({ shopify_webhook_id: "wh-do-create-shape", currency: "EUR" })
  })

  it("draft_orders/create emits poNumber when a person typed a PO on the draft in the Shopify admin", async () => {
    // This is the salesperson path: a draft order created (or edited) directly in the Shopify
    // admin, not through our own draft_orders_create mutation. Invoicing's draft-order sync
    // learns of it ONLY from this webhook event. NormalizedDraftOrder is camelCase throughout
    // (draftOrderId, orderId, orderName, ...), so the field is poNumber, not po_number.
    const { ctx, spy } = makeCtx()
    await draftOrdersCreateHandler({ ...FIXTURE_DRAFT_ORDER, po_number: "PO-7731" }, ctx, HDR("wh-do-po-present"))
    const evt = spy.emits.find((e) => e.entity === "draft_order" && e.action === "created")
    const data = evt?.data as Record<string, unknown>
    expect(data.poNumber).toBe("PO-7731")
    // Regression guard: if the emitted key's casing slips to po_number, this must fail.
    expect("po_number" in data).toBe(false)
  })

  it("draft_orders/create emits poNumber as null, matching every sibling field, when the draft carries no PO", async () => {
    const { ctx, spy } = makeCtx()
    await draftOrdersCreateHandler(FIXTURE_DRAFT_ORDER, ctx, HDR("wh-do-po-absent"))
    const evt = spy.emits.find((e) => e.entity === "draft_order" && e.action === "created")
    const data = (evt?.data ?? {}) as Record<string, unknown>
    expect(data.poNumber).toBeNull()
    expect("po_number" in data).toBe(false)
  })

  it("a second delivery with the same webhook id dedups (no re-emit)", async () => {
    const { ctx, spy } = makeCtx()
    await draftOrdersCreateHandler(FIXTURE_DRAFT_ORDER, ctx, HDR("wh-do-dup"))
    await draftOrdersCreateHandler(FIXTURE_DRAFT_ORDER, ctx, HDR("wh-do-dup"))
    const created = spy.emits.filter((e) => e.entity === "draft_order" && e.action === "created")
    expect(created.length).toBe(1)
  })

  it("draft_orders/update emits draft_order:updated with the same normalized shape", async () => {
    const { ctx, spy } = makeCtx()
    const res = await draftOrdersUpdateHandler(
      { ...FIXTURE_DRAFT_ORDER, status: "invoice_sent" },
      ctx,
      HDR("wh-do-update"),
    )
    expect(res.status).toBe(200)
    const evt = spy.emits.find((e) => e.entity === "draft_order" && e.action === "updated")
    expect(evt?.entityId).toBe("gid://shopify/DraftOrder/3001")
    expect((evt?.data as Record<string, unknown>).status).toBe("invoice_sent")
    expect(spy.channels).toContain(channelName("shopify", "draft_order", "updated"))
  })

  it("draft_orders/update emits poNumber when a person edits the PO on the draft in the Shopify admin", async () => {
    const { ctx, spy } = makeCtx()
    await draftOrdersUpdateHandler(
      { ...FIXTURE_DRAFT_ORDER, po_number: "PO-9012" },
      ctx,
      HDR("wh-do-update-po-present"),
    )
    const evt = spy.emits.find((e) => e.entity === "draft_order" && e.action === "updated")
    const data = evt?.data as Record<string, unknown>
    expect(data.poNumber).toBe("PO-9012")
    expect("po_number" in data).toBe(false)
  })

  it("draft_orders/update emits poNumber as null when the draft carries no PO", async () => {
    const { ctx, spy } = makeCtx()
    await draftOrdersUpdateHandler(FIXTURE_DRAFT_ORDER, ctx, HDR("wh-do-update-po-absent"))
    const evt = spy.emits.find((e) => e.entity === "draft_order" && e.action === "updated")
    const data = (evt?.data ?? {}) as Record<string, unknown>
    expect(data.poNumber).toBeNull()
  })

  it("draft_orders/delete emits draft_order:deleted from a minimal { id } payload", async () => {
    const { ctx, spy } = makeCtx()
    const res = await draftOrdersDeleteHandler({ id: 3_001 }, ctx, HDR("wh-do-delete"))
    expect(res.status).toBe(200)
    const evt = spy.emits.find((e) => e.entity === "draft_order" && e.action === "deleted")
    expect(evt).toBeDefined()
    expect(evt?.entityId).toBe("gid://shopify/DraftOrder/3001")
    const data = evt?.data as Record<string, unknown>
    expect(data.name).toBeNull()
    expect(data.lineItems).toEqual([])
    expect(spy.channels).toContain(channelName("shopify", "draft_order", "deleted"))
  })
})

// Cluster-1 (canonical event identity) — webhook emit convergence.
//
// The enforcing emit mock above throws if a handler emits an undeclared
// `${entity}:${action}`. These tests pin the channel composition and the
// manual-refund identity so the namespace-collapse regression cannot return.
describe("webhooks — Cluster-1 canonical emit identity", () => {
  it("orders/create resolves to events:shopify:order:created (not the old doubled channel)", async () => {
    const { ctx, spy } = makeCtx()
    await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-c1-order"))
    expect(spy.channels).toEqual([channelName("shopify", "order", "created")])
    // Guard against the pre-fix collapse `events:shopify:shopify:order_created`.
    expect(spy.channels).not.toContain(channelName("shopify", "shopify", "order_created"))
  })

  it("refunds/create emits the MANUAL-refund identity refund:created_manual", async () => {
    const { ctx, spy } = makeCtx()
    await refundsCreateHandler(
      { id: 4242, order_id: 9, transactions: [{ amount: "10.00", currency: "EUR" }] },
      ctx,
      HDR("wh-c1-refund"),
    )
    const evt = spy.emits.find((e) => e.entity === "refund")
    expect(evt?.action).toBe("created_manual")
    expect(spy.channels).toContain(channelName("shopify", "refund", "created_manual"))
  })
})

describe("webhooks — mark processed before emit", () => {
  it("row is marked processed before emit so a crash between the two does not re-emit on retry", async () => {
    const { ctx, spy } = makeCtx()
    // Track the sequence of significant side-effects to verify ordering.
    const callLog: string[] = []
    // Wrap db.update so we can detect the markProcessed call.
    const origUpdate = ctx.db.update.bind(ctx.db)
    ctx.db.update = async (entity: string, id: string, data: Record<string, unknown>) => {
      if (entity === "webhook_deliveries" && (data as { status?: string }).status === "processed") {
        callLog.push("markProcessed")
      }
      return origUpdate(entity, id, data)
    }
    // Wrap ctx.emit to record when channels are published.
    const origEmit = ctx.emit.bind(ctx)
    ctx.emit = async (...args: Parameters<typeof ctx.emit>) => {
      callLog.push("emit")
      return origEmit(...args)
    }
    const headers = HDR("wh-mark-before-emit")
    await ordersCreateHandler(FIXTURE_ORDER, ctx, headers)
    // Both operations must have run.
    expect(callLog).toContain("markProcessed")
    expect(callLog).toContain("emit")
    // markProcessed must precede emit — the at-least-once safety property.
    expect(callLog.indexOf("markProcessed")).toBeLessThan(callLog.indexOf("emit"))
  })
})

describe("webhooks — app/uninstalled flips connectionStatus", () => {
  it("appUninstalledHandler sets connectionStatus to disconnected on install_metadata", async () => {
    const { ctx, spy } = makeCtx()
    // Seed an install_metadata row (connected state).
    spy.rows.set("install_metadata", [
      { id: "meta-1", shopDomain: "demo.myshopify.com", connectionStatus: "connected" },
    ])
    spy.rows.set("webhook_deliveries", [])
    const result = await appUninstalledHandler(
      { shop: "demo.myshopify.com" },
      ctx,
      HDR("wh-uninstall-1"),
    )
    expect(result.status).toBe(200)
    // connectionStatus must be flipped to 'disconnected'.
    const upd = spy.updates.find(
      (u) => u.entity === "install_metadata" && u.id === "meta-1",
    )
    expect(upd).toBeDefined()
    expect(upd?.data.connectionStatus).toBe("disconnected")
    // The event must still be emitted.
    const evt = spy.emits.find((e) => e.entity === "app" && e.action === "uninstalled")
    expect(evt).toBeDefined()
  })
})

describe("webhooks — orders/create tax + address + shipping enrichment (invoicing contract)", () => {
  // A tax-INCLUSIVE French B2C order with a digital line and a shipping line —
  // the shape the invoicing split/de-tax flow consumes.
  const TAXED_ORDER = {
    ...FIXTURE_ORDER,
    id: 1_002,
    taxes_included: true,
    billing_address: {
      name: "Pascal Client",
      address1: "11 Bis route Exemple",
      zip: "78110",
      city: "Le Vesinet",
      country_code: "fr",
    },
    shipping_address: {
      address1: "11 Bis route Exemple",
      zip: "78110",
      city: "Le Vesinet",
      country_code: "FR",
    },
    line_items: [
      {
        id: 9_101,
        variant_id: 8_101,
        sku: "EMB-ET2",
        title: "Tessera 2",
        quantity: 1,
        price: "949.00",
        requires_shipping: true,
        tax_lines: [{ title: "TVA", rate: 0.2, price: "158.17" }],
        discount_allocations: [{ amount: "0.00" }],
      },
      {
        id: 9_102,
        variant_id: 8_102,
        sku: "EMB-SOUND",
        title: "Tessera Sound",
        quantity: 1,
        price: "79.00",
        requires_shipping: false,
        tax_lines: [{ title: "TVA", rate: 0.2, price: "13.17" }],
      },
    ],
    shipping_lines: [
      {
        title: "DHL Express",
        price: "29.99",
        discounted_price: "29.99",
        tax_lines: [{ rate: 0.2, price: "5.00" }],
      },
    ],
  }

  it("carries taxes_included, per-line tax facts, requires_shipping, addresses, and shipping lines on the emitted event", async () => {
    const { ctx, spy } = makeCtx()
    await ordersCreateHandler(TAXED_ORDER, ctx, HDR("wh-taxed"))
    const evt = spy.emits.find((e) => e.entity === "order" && e.action === "created")
    expect(evt).toBeDefined()
    const data = evt?.data as Record<string, unknown>

    expect(data.taxesIncluded).toBe(true)

    const billing = data.billingAddress as Record<string, unknown>
    expect(billing.address1).toBe("11 Bis route Exemple")
    expect(billing.zip).toBe("78110")
    expect(billing.city).toBe("Le Vesinet")
    expect(billing.country_code).toBe("FR") // upper-cased

    const lines = data.lineItems as Array<Record<string, unknown>>
    const hardware = lines.find((l) => l.title === "Tessera 2")!
    const software = lines.find((l) => l.title === "Tessera Sound")!
    expect(hardware.requiresShipping).toBe(true)
    expect(software.requiresShipping).toBe(false)
    const hwTax = (hardware.taxLines as Array<Record<string, unknown>>)[0]!
    expect(hwTax.rate).toBe(0.2)
    expect(hwTax.amount).toBe("158.17")

    const shipping = data.shippingLines as Array<Record<string, unknown>>
    expect(shipping).toHaveLength(1)
    expect(shipping[0]!.title).toBe("DHL Express")
    expect((shipping[0]!.priceSet as Record<string, unknown>).amount).toBe("29.99")
    expect(((shipping[0]!.taxLines as Array<Record<string, unknown>>)[0]!).rate).toBe(0.2)
  })

  it("legacy payloads (no tax fields) emit taxesIncluded=false, requiresShipping=true, null addresses, empty shippingLines", async () => {
    const { ctx, spy } = makeCtx()
    await ordersCreateHandler(FIXTURE_ORDER, ctx, HDR("wh-legacy"))
    const evt = spy.emits.find((e) => e.entity === "order" && e.action === "created")
    const data = evt?.data as Record<string, unknown>
    expect(data.taxesIncluded).toBe(false)
    expect(data.billingAddress).toBeNull()
    expect(data.shippingLines).toEqual([])
    const lines = data.lineItems as Array<Record<string, unknown>>
    expect(lines[0]!.requiresShipping).toBe(true)
    expect(lines[0]!.taxLines).toEqual([])
  })
})

describe("webhooks: invoicing tax facts (marketplace tax, buyer VAT id, shipping refunds)", () => {
  // red: drop channelLiable from normalizeTaxLines -> invoicing cannot tell the Shop channel's
  // marketplace tax from the merchant's own and invoices it.
  it("orders/create carries each tax line's channel liability", async () => {
    const { ctx, spy } = makeCtx()
    await ordersCreateHandler(
      {
        ...FIXTURE_ORDER,
        id: 3_386,
        line_items: [
          {
            id: 1,
            variant_id: 777,
            title: "Tessera 2",
            quantity: 1,
            price: "899.00",
            requires_shipping: true,
            tax_lines: [{ title: "CA State Tax", rate: 0.0725, price: "65.18", channel_liable: true }],
          },
        ],
        shipping_lines: [],
      },
      ctx,
      HDR("wh-channel-liable"),
    )
    const evt = spy.emits.find((e) => e.entity === "order" && e.action === "created")
    const li = ((evt?.data as Record<string, unknown>).lineItems as Array<Record<string, unknown>>)[0]!
    const tl = (li.taxLines as Array<Record<string, unknown>>)[0]!
    expect(tl.channelLiable).toBe(true)
    expect(tl.amount).toBe("65.18")
  })

  // red: drop buyerTaxId from normalizeOrder -> the buyer's VAT number never reaches the invoice.
  it("orders/create carries the buyer's VAT id from a checkout attribute named for it", async () => {
    const { ctx, spy } = makeCtx()
    await ordersCreateHandler(
      {
        ...FIXTURE_ORDER,
        id: 3_387,
        note_attributes: [
          { name: "Gift message", value: "Happy birthday" },
          { name: "Numéro de TVA", value: "IT01234567890" },
        ],
      },
      ctx,
      HDR("wh-buyer-vat"),
    )
    const evt = spy.emits.find((e) => e.entity === "order" && e.action === "created")
    expect((evt?.data as Record<string, unknown>).buyerTaxId).toBe("IT01234567890")
  })

  it("an attribute that is not a tax id is never read as one", () => {
    expect(buyerTaxIdFromNoteAttributes([{ name: "Gift message", value: "FR123" }])).toBeNull()
    expect(buyerTaxIdFromNoteAttributes([{ name: "VAT number", value: " DE123456789 " }])).toBe("DE123456789")
    expect(buyerTaxIdFromNoteAttributes(undefined)).toBeNull()
  })

  // red: drop shipping_refund_minor from the refund:created emit -> invoicing credits a shipping
  // refund on the goods invoice.
  it("refunds/create carries the refunded shipping, from shipping lines or shipping adjustments", async () => {
    const { ctx, spy } = makeCtx()
    await refundsCreateHandler(
      {
        id: 77_001,
        order_id: 3_386,
        transactions: [{ amount: "83.00", currency: "USD" }],
        refund_shipping_lines: [
          {
            subtotal_amount_set: { shop_money: { amount: "83.00", currency_code: "USD" } },
            total_tax_amount_set: { shop_money: { amount: "0.00", currency_code: "USD" } },
          },
        ],
      },
      ctx,
      HDR("wh-refund-shipping-lines"),
    )
    const created = spy.emits.find((e) => e.entity === "refund" && e.action === "created")
    expect((created?.data as Record<string, unknown>).shipping_refund_minor).toBe("8300")
    expect(
      shippingRefundMinor(
        {
          id: 1,
          order_adjustments: [
            { kind: "shipping_refund", amount: "-20.00", tax_amount: "-4.00" },
            { kind: "refund_discrepancy", amount: "-1.00", tax_amount: "0.00" },
          ],
        },
        "EUR",
      ),
    ).toBe("2400")
  })
})
