// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 Task A9 + Code-review I2 / deep-review cluster 1 — Phase 17 event contract.
//
// Pins the *contract* the Shopify app must emit for Phase 17 invoicing
// subscribers, exercised through the REAL kernel emit path:
//
//   createRpcBridge(...).emit(envelope)   // the real sandbox emit guard
//        → txDb.queueEvent(merged)        // the real outbox enqueue shape
//        → _publishEventInternal(event)   // the real channel composition + guard
//        → subscriber on events:shopify:order:created
//
// The earlier version of this test was a FALSE GREEN (deep-review cluster 1 /
// prior-review I2): it overrode `declaredEmits` to a fictional set AND
// hand-published the envelope via `_publishEventInternal`, so it validated a
// shape the production pipeline never produced and could not catch the
// event-identity drift that shipped. This rewrite removes both shortcuts:
//
//   1. declaredEmits is built ONLY from a manifest carrying the production
//      canonical emit keys (`entity:action`, e.g. `order:created`) — the same
//      keys `bundled-apps/shopify/app.manifest.json` now declares. We do NOT
//      inject a fictional key set.
//   2. The event is pushed through the real `createRpcBridge` emit guard (which
//      throws on any undeclared `entity:action`) BEFORE it ever reaches the
//      channel — so a regression to the stale single-token form
//      (`{entity:"shopify", action:"order_created"}`) fails this test loudly.
//
// PRIVACY-BOUNDARY NOTE.
//
// This file lives in the public-bound `liaison/` submodule. The Shopify app
// itself lives in `bundled-apps/shopify/` at the private wrapper-monorepo
// root — outside the submodule. Importing the app's source here would commit a
// path reference into public `liaison/` history; CLAUDE.md forbids that. So we
// reconstruct the app's *manifest emit declaration* and its *normalized emit
// envelope* as in-test fixtures kept in lockstep with the app's own
// `webhooks.test.ts` (the raw-payload → normalized-shape contract). What this
// test owns is the orthogonal cross-app invariant: given the app emits the
// documented envelope through the real bridge, a Phase-17 subscriber on the
// LOCKED channel `events:shopify:order:created` receives every contract field.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import {
  type AppEvent,
  declaredEmits,
  flushEventHandlers,
  initEventBus,
  _publishEventInternal as publishEvent,
  resetEventBus,
  subscribeToEvent,
} from "~/infra/events/event-bus"
import { redisSub } from "~/lib/redis"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const ORG_ID = "00000000-0000-0000-0000-000000000301"

// --- Production canonical emit declaration (lockstep with app.manifest.json) -
//
// The locked event identity is `{ app:"shopify", entity, action }` — three
// separate fields keyed as `entity:action`. These are the canonical Shopify
// emit keys the production manifest declares; a regression to the stale
// single-token form (`shopify:order_created`) is NOT in this set and is
// therefore rejected by the real bridge guard.
const SHOPIFY_EMIT_KEYS = [
  "order:created",
  "order:updated",
  "order:cancelled",
  "order:fulfilled",
  "refund:created",
] as const

// Minimal manifest slice the rpc bridge needs to build its declaredEmits set.
// `events.emits` is the only field the emit guard reads.
const SHOPIFY_MANIFEST_FOR_BRIDGE = {
  name: "shopify",
  schema: {},
  events: { emits: [...SHOPIFY_EMIT_KEYS] },
  connections: {},
  network: {},
}

// --- Normalized event payload emitted by webhooks.ts:normalizeOrder() --------
// Kept in lockstep with bundled-apps/shopify/src/webhooks.test.ts.
const NORMALIZED_ORDER_EVENT_DATA = {
  orderId: "5900000000001",
  customerId: "7100000000001",
  customer: {
    id: "7100000000001",
    email: "fixture@example.com",
    first_name: "Fixture",
    last_name: "Buyer",
    external_ids: { shopify: "7100000000001" },
  },
  lineItems: [
    {
      id: "12345",
      quantity: 2,
      sku: "SKU-001",
      title: "Sample product",
      variant: { id: "88001", title: "Default Title", sku: "SKU-001" },
      priceSet: { amount: "39.99", currencyCode: "EUR" },
    },
  ],
  totalPrice: { amount: "79.98", currencyCode: "EUR" },
  marketId: "gid://shopify/Market/1",
} as const

const NORMALIZED_ORDER_EVENT_METADATA = {
  market: "EU",
  currency: "EUR",
  shopify_webhook_id: "5900000000001-orders-create",
} as const

// --- Fake RlsClient that captures the bridge's `queueEvent` enqueue ----------
//
// The emit bridge's only DB touch is `txDb.queueEvent(merged)`. We capture the
// merged envelope here instead of round-tripping through Postgres — the outbox
// shape is exactly what the real outbox worker would later hand to
// `_publishEventInternal`, which this test then drives for real.
function makeCapturingTxDb(): { tx: RlsClient; queued: AppEvent[] } {
  const queued: AppEvent[] = []
  const tx = {
    queueEvent: async (event: AppEvent) => {
      queued.push(event)
    },
  } as unknown as RlsClient
  return { tx, queued }
}

/**
 * Drive a Shopify domain event through the REAL emit path: the sandbox bridge
 * emit guard, then the real channel publish. Returns the events a subscriber on
 * the locked channel observed.
 */
async function emitThroughBridgeAndChannel(envelope: {
  entity: string
  action: string
  entityId: string
  data: unknown
  metadata?: unknown
}): Promise<AppEvent[]> {
  const { tx, queued } = makeCapturingTxDb()
  const bridge = createRpcBridge(
    "shopify",
    "system:shopify",
    ORG_ID,
    tx,
    SHOPIFY_MANIFEST_FOR_BRIDGE,
  )
  // Real sandbox emit guard — throws on any undeclared `entity:action`.
  await bridge.emit(JSON.stringify(envelope))
  expect(queued).toHaveLength(1)

  // The captured envelope is what the outbox worker would publish. Drive it
  // through the real publish (channel composition + the outbox-side
  // declaredEmits guard) to the subscriber. We register the canonical emits in
  // the bus the same way runtime registration does for an installed app.
  declaredEmits.set("shopify", new Set(SHOPIFY_EMIT_KEYS))
  await publishEvent(queued[0])
  return capturedByChannelSubscriber
}

// Subscriber state captured per-test.
let capturedByChannelSubscriber: AppEvent[]

async function pollUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(50)
  }
  throw new Error("pollUntil timed out")
}

describe("Shopify order event contract: real emit path -> events:shopify:order:created", () => {
  let savedEmits: Set<string> | undefined

  beforeAll(() => {
    resetEventBus()
    initEventBus()
    savedEmits = declaredEmits.get("shopify")
  })

  beforeEach(() => {
    capturedByChannelSubscriber = []
  })

  afterEach(async () => {
    await flushEventHandlers()
  })

  afterAll(async () => {
    redisSub.removeAllListeners("message")
    if (savedEmits) declaredEmits.set("shopify", savedEmits)
    else declaredEmits.delete("shopify")
    await flushEventHandlers()
  })

  it("subscriber on the LOCKED channel receives the full Phase-17 envelope", async () => {
    await subscribeToEvent(
      "shopify",
      "order",
      "created",
      async (evt) => {
        capturedByChannelSubscriber.push(evt)
      },
      { delivery: "per-replica" },
    )

    await emitThroughBridgeAndChannel({
      entity: "order",
      action: "created",
      entityId: NORMALIZED_ORDER_EVENT_DATA.orderId,
      data: NORMALIZED_ORDER_EVENT_DATA,
      metadata: NORMALIZED_ORDER_EVENT_METADATA,
    })

    await pollUntil(() => capturedByChannelSubscriber.length > 0)

    const evt = capturedByChannelSubscriber[0] as AppEvent & {
      data: typeof NORMALIZED_ORDER_EVENT_DATA
      metadata: typeof NORMALIZED_ORDER_EVENT_METADATA
    }
    // Locked identity — three separate fields.
    expect(evt.app).toBe("shopify")
    expect(evt.entity).toBe("order")
    expect(evt.action).toBe("created")
    expect(evt.orgId).toBe(ORG_ID)
    expect(evt.entityId).toBe(NORMALIZED_ORDER_EVENT_DATA.orderId)
    // §4.5 envelope contract fields.
    expect(evt.data.orderId).toBe(NORMALIZED_ORDER_EVENT_DATA.orderId)
    expect(evt.data.customerId).toBe(NORMALIZED_ORDER_EVENT_DATA.customerId)
    expect(evt.data.customer.external_ids.shopify).toBe(NORMALIZED_ORDER_EVENT_DATA.customerId)
    expect(evt.data.lineItems[0].variant).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      sku: expect.any(String),
    })
    expect(evt.data.lineItems[0].quantity).toBe(2)
    expect(evt.data.lineItems[0].priceSet).toMatchObject({
      amount: expect.any(String),
      currencyCode: expect.any(String),
    })
    expect(evt.data.totalPrice).toMatchObject({ amount: "79.98", currencyCode: "EUR" })
    expect(evt.data.marketId).toBe("gid://shopify/Market/1")
    expect(evt.metadata.market).toBe("EU")
    expect(evt.metadata.currency).toBe("EUR")
    expect(evt.metadata.shopify_webhook_id).toBe("5900000000001-orders-create")
  })

  it("guest-checkout: data.customer is null and the contract still holds", async () => {
    await subscribeToEvent(
      "shopify",
      "order",
      "created",
      async (evt) => {
        capturedByChannelSubscriber.push(evt)
      },
      { delivery: "per-replica" },
    )

    const guestData = {
      ...NORMALIZED_ORDER_EVENT_DATA,
      orderId: "5900000000002",
      customerId: null,
      customer: null,
    }

    await emitThroughBridgeAndChannel({
      entity: "order",
      action: "created",
      entityId: guestData.orderId,
      data: guestData,
      metadata: NORMALIZED_ORDER_EVENT_METADATA,
    })

    await pollUntil(() => capturedByChannelSubscriber.some((e) => e.entityId === guestData.orderId))

    const evt = capturedByChannelSubscriber.find((e) => e.entityId === guestData.orderId) as
      | (AppEvent & { data: { customer: null; customerId: null; orderId: string } })
      | undefined
    expect(evt).toBeDefined()
    expect(evt?.data.customer).toBeNull()
    expect(evt?.data.customerId).toBeNull()
    expect(evt?.data.orderId).toBe("5900000000002")
  })

  it("REGRESSION GUARD: the stale single-token emit form is rejected by the real bridge guard", async () => {
    // The cluster-1 bug emitted `{ entity:"shopify", action:"order_created" }`
    // (single namespaced token collapsed into entity/action). The canonical
    // manifest declares `order:created`, NOT `shopify:order_created`, so the
    // real bridge emit guard MUST reject this. This is the assertion the old
    // false-green test lacked — it would have caught the drift.
    const { tx } = makeCapturingTxDb()
    const bridge = createRpcBridge(
      "shopify",
      "system:shopify",
      ORG_ID,
      tx,
      SHOPIFY_MANIFEST_FOR_BRIDGE,
    )
    await expect(
      bridge.emit(
        JSON.stringify({
          entity: "shopify",
          action: "order_created",
          entityId: "5900000000003",
          data: NORMALIZED_ORDER_EVENT_DATA,
        }),
      ),
    ).rejects.toThrow(/undeclared event "shopify:order_created"/)
  })

  it("REGRESSION GUARD: a real refund:created emit lands on its own locked channel", async () => {
    // Proves the bridge keys on `entity:action` for every entity, not just
    // orders — invoicing subscribes to `shopify/refund:created`
    // (channel events:shopify:refund:created).
    await subscribeToEvent(
      "shopify",
      "refund",
      "created",
      async (evt) => {
        capturedByChannelSubscriber.push(evt)
      },
      { delivery: "per-replica" },
    )

    await emitThroughBridgeAndChannel({
      entity: "refund",
      action: "created",
      entityId: "8800000000001",
      data: { refundId: "8800000000001", orderId: NORMALIZED_ORDER_EVENT_DATA.orderId },
    })

    await pollUntil(() => capturedByChannelSubscriber.some((e) => e.entity === "refund"))
    const evt = capturedByChannelSubscriber.find((e) => e.entity === "refund")
    expect(evt?.app).toBe("shopify")
    expect(evt?.action).toBe("created")
    expect(evt?.entityId).toBe("8800000000001")
  })
})
