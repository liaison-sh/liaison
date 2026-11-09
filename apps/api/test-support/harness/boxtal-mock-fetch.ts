// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 E2E harness — server-side Boxtal sandbox-fetch mock.
//
// THE load-bearing E2E decision (see the E2E plan §"Boxtal mock + routing"):
// the Boxtal client bases are hardcoded by `environment` (no `api_base_url`
// override seam like Shopify's `install_metadata`), and the sandbox-fetch
// bridge enforces `allowedDomains` + HTTPS + private-host blocking. So a
// `Bun.serve` mock dialled by URL CANNOT be reached. Instead the mock is a
// `typeof fetch` installed into the SPAWNED server via `SandboxBridgeTestAccess.setFetch`
// (rpc-bridge.ts:76, threaded into `fetchWithPinnedHost`'s `fetchImpl`).
//
// `makeBoxtalMockFetch()`:
//   * matches on hostname — Boxtal v1 (`*.envoimoinscher.com`, XML cotation)
//     and v3 (`api.boxtal.{build,com}`, JSON orders) — and returns canned
//     `Response`s sourced from the recorded-real shapes + the shipped XML
//     fixtures.
//   * delegates to the REAL `fetch` for every other host, so the Shopify
//     live-store E2E suite (which shares the same spawned server) is untouched.
//   * records every Boxtal request `{ url, method, headers, body, actor }` so
//     scenarios can assert "no v3 POST before approval", "exactly one order",
//     per-user isolation, etc.
//   * mutable per-scenario MODE state (422-phone, 5xx, CONFIRMED-flip,
//     tracking-status) is seeded by the `_test` control route below. The mode
//     is a per-server-process global, so Boxtal scenarios MUST run serially
//     within a worker (the default for `.scenario.test.ts`).
//
// The control route + boot-wire live alongside in `boxtal-install-routes.ts`
// (control) and `index.e2e.ts` (boot). This module owns the fetch-impl + the
// recorder + the mode registry only.

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// — recorder —

export interface BoxtalMockRecord {
  url: string
  method: string
  /** Lowercased header map (Bun normalizes header names to lowercase). */
  headers: Record<string, string>
  /** Actor marker the bridge injects when LIAISON_TEST_INJECT_ACTOR=1. */
  actor: string | null
  body: string | null
  receivedAt: number
}

const records: BoxtalMockRecord[] = []

export function boxtalMockAllRequests(): BoxtalMockRecord[] {
  return [...records]
}
export function boxtalMockClearRequests(): void {
  records.length = 0
}

// — mutable per-scenario mode —

export type BoxtalCreateMode = "pending" | "phone_422" | "server_5xx"

interface BoxtalMockState {
  /** Which XML cotation fixture the v1 mock serves. */
  cotationFixture: "multi" | "empty" | "error" | "dev"
  /** Behaviour of the next v3 create. */
  createMode: BoxtalCreateMode
  /** Order ids whose GET should report CONFIRMED (label/docs available). */
  confirmedOrderIds: Set<string>
  /** Order ids whose GET should report a non-cancellable tracking status. */
  dispatchedOrderIds: Set<string>
  /** Order ids whose GET should report CANCELLED (idempotent re-cancel no-op). */
  cancelledOrderIds: Set<string>
  /** Tracking status the /tracking endpoint reports for a given order id. */
  trackingStatusByOrder: Map<string, string>
  /** Optional per-order latest-checkpoint message (the carrier's human-readable
   *  event text). When unset the endpoint emits a status-appropriate default. */
  trackingMessageByOrder: Map<string, string>
  /** Optional per-order collection deadline (ISO date) the carrier reports for a
   *  parcel sitting at a pickup/relay point — the date by which it must be
   *  collected before it returns to sender. Only meaningful for a
   *  REACHED_DELIVERY_PICKUP_POINT parcel; the endpoint emits it on the tracking
   *  package so `track` can surface the authoritative deadline. */
  pickupDeadlineByOrder: Map<string, string>
  /** How long a successful create takes to answer, in ms, after it is recorded: a slow
   *  carrier, so a test can see the purchase while the buying call is still running. */
  createLatencyMs: number
}

const state: BoxtalMockState = {
  cotationFixture: "multi",
  createMode: "pending",
  confirmedOrderIds: new Set(),
  dispatchedOrderIds: new Set(),
  cancelledOrderIds: new Set(),
  trackingStatusByOrder: new Map(),
  trackingMessageByOrder: new Map(),
  pickupDeadlineByOrder: new Map(),
  createLatencyMs: 0,
}

export function setBoxtalMockMode(patch: {
  cotationFixture?: "multi" | "empty" | "error" | "dev"
  createMode?: BoxtalCreateMode
  confirmOrderId?: string
  dispatchOrderId?: string
  cancelOrderId?: string
  trackingStatus?: { orderId: string; status: string; message?: string; pickupDeadline?: string }
  createLatencyMs?: number
}): void {
  if (patch.cotationFixture) state.cotationFixture = patch.cotationFixture
  if (patch.createLatencyMs !== undefined) state.createLatencyMs = patch.createLatencyMs
  if (patch.createMode) state.createMode = patch.createMode
  if (patch.confirmOrderId) state.confirmedOrderIds.add(patch.confirmOrderId)
  if (patch.dispatchOrderId) state.dispatchedOrderIds.add(patch.dispatchOrderId)
  if (patch.cancelOrderId) state.cancelledOrderIds.add(patch.cancelOrderId)
  if (patch.trackingStatus) {
    state.trackingStatusByOrder.set(patch.trackingStatus.orderId, patch.trackingStatus.status)
    if (patch.trackingStatus.message) {
      state.trackingMessageByOrder.set(patch.trackingStatus.orderId, patch.trackingStatus.message)
    }
    if (patch.trackingStatus.pickupDeadline) {
      state.pickupDeadlineByOrder.set(
        patch.trackingStatus.orderId,
        patch.trackingStatus.pickupDeadline,
      )
    }
  }
}

export function resetBoxtalMockMode(): void {
  state.cotationFixture = "multi"
  state.createMode = "pending"
  state.confirmedOrderIds.clear()
  state.dispatchedOrderIds.clear()
  state.cancelledOrderIds.clear()
  state.trackingStatusByOrder.clear()
  state.trackingMessageByOrder.clear()
  state.pickupDeadlineByOrder.clear()
  state.createLatencyMs = 0
}

/**
 * The carrier-vocabulary checkpoint message a real Boxtal `/tracking` response
 * carries per status. The mock previously hardcoded "Parcel announced" for every
 * status — actively wrong for a DELIVERED/EXCEPTION/FAILED_ATTEMPT parcel, which
 * left `track`'s newest event label uninformative. A scenario can still override
 * the text per order via `trackingStatus.message`.
 */
const TRACKING_STATUS_MESSAGE: Record<string, string> = {
  ANNOUNCED: "Parcel announced",
  SHIPPED: "Picked up by carrier",
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  FAILED_ATTEMPT: "Delivery attempt failed — recipient absent",
  REACHED_DELIVERY_PICKUP_POINT: "Awaiting collection at the pickup point",
  DELIVERED: "Delivered",
  RETURNED: "Returned to sender",
  EXCEPTION: "Delivery exception — parcel held",
}

// — fixtures —

// This file lives at `apps/api/test-support/harness/`. Walk up four levels to
// `liaison/`, then into the boxtal app's XML cotation fixtures.
const FIXTURE_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "bundled-apps",
  "boxtal",
  "src",
  "__fixtures__",
  "boxtal",
)

function cotationXml(): string {
  const file = `cotation-${state.cotationFixture}.xml`
  return readFileSync(join(FIXTURE_DIR, file), "utf8")
}

// The EU customs-union member set — an intra-EU route (both endpoints EU) ships CUSTOMS-FREE on the
// domestic/economy carriers (Colissimo / Mondial Relay), NOT on the international customs-capable set.
// Only a route leaving the union (one endpoint non-EU) is a true EXPORT. Mirrors bundled-apps/boxtal
// customs.ts EU_MEMBERS (kept inline — this _test harness must not import bundled-app internals).
const EU_MEMBERS_MOCK = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
])

/**
 * Pick the cotation fixture for a given request. A real Boxtal cotation returns
 * DIFFERENT carriers by route: domestic/EU-economy services (Colissimo / Mondial
 * Relay / Chronopost) for a CUSTOMS-FREE intra-EU route, and international,
 * customs-capable carriers (UPS / FedEx / DPD international) for a true EXPORT
 * that LEAVES the EU customs union. The default "multi" fixture is the
 * domestic/EU-economy list, so on the DEFAULT path we transparently serve the
 * international fixture ONLY when the route is a genuine export — i.e. one
 * endpoint is OUTSIDE the EU (customs required). Before this the discriminator
 * was `to !== from`, which wrongly served the international-ONLY fixture for an
 * INTRA-EU cross-border route (FR→DE/NL/BE) — so an EU-domestic batch could not
 * be quoted on Colissimo/Mondial Relay at all, the `create_shipment` on those
 * drafts hit `offer_not_quoted`, and a weak agent fabricated the tail (l766 S4).
 * An FR→FR route and an FR→DE route are BOTH intra-EU domestic; only FR→US/JP/GB/CH
 * (leaving the union) is an export. An EXPLICITLY-selected fixture (empty / error /
 * dev — the fault-mode registry) always wins, so this never masks a configured
 * fault. The cotation request encodes both countries in its query string
 * (`expediteur.pays` / `destinataire.pays`, see boxtal-v1-client buildCotationQuery).
 */
function cotationXmlFor(url: string): string {
  if (state.cotationFixture !== "multi") return cotationXml()
  let params: URLSearchParams
  try {
    params = new URL(url).searchParams
  } catch {
    return cotationXml()
  }
  const from = (params.get("expediteur.pays") ?? "").trim().toUpperCase()
  const to = (params.get("destinataire.pays") ?? "").trim().toUpperCase()
  // A true EXPORT (international carriers) only when the route LEAVES the EU customs union — i.e. either
  // endpoint is non-EU. An intra-EU cross-border route (both EU, e.g. FR→DE) stays on the domestic/EU-
  // economy fixture (Colissimo / Mondial Relay), which is what an EU-domestic batch must ship on.
  const isCustomsExport = !!from && !!to && !(EU_MEMBERS_MOCK.has(from) && EU_MEMBERS_MOCK.has(to))
  if (isCustomsExport) {
    return readFileSync(join(FIXTURE_DIR, "cotation-international.xml"), "utf8")
  }
  return cotationXml()
}

// — JSON response helpers (v3 wraps every body in `{ status, timestamp, content }`) —

function v3Envelope(content: unknown, httpStatus = 200): Response {
  return new Response(
    JSON.stringify({ status: httpStatus, timestamp: new Date().toISOString(), content }),
    { status: httpStatus, headers: { "content-type": "application/json" } },
  )
}

function jsonResponse(body: unknown, httpStatus = 200): Response {
  return new Response(JSON.stringify(body), {
    status: httpStatus,
    headers: { "content-type": "application/json" },
  })
}

function xmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/xml" } })
}

/** Deterministic order id from the create body so retries/confirm flips line up. */
function orderIdFromBody(body: string | null): string {
  const h = createHash("sha256")
    .update(body ?? "")
    .digest("hex")
    .slice(0, 12)
  return `boxtal-order-${h}`
}

const RECORDED_CONTENT_CATEGORIES = [
  { id: "content:v1:10120", label: "Books / printed matter" },
  { id: "content:v1:10250", label: "Electronics / accessories" },
  { id: "content:v1:10999", label: "Other goods" },
]

// — the fetch-impl —

const BOXTAL_V1_HOSTS = new Set(["test.envoimoinscher.com", "www.envoimoinscher.com"])
const BOXTAL_V3_HOSTS = new Set(["api.boxtal.build", "api.boxtal.com"])

/** Hosts the Boxtal mock serves canned bytes for (the bridge calls it directly). */
export function boxtalMockHandlesHost(hostname: string): boolean {
  return BOXTAL_V1_HOSTS.has(hostname) || BOXTAL_V3_HOSTS.has(hostname)
}

/**
 * M0.3 — the e2e server installs the Boxtal sandbox-fetch mock unless live mode
 * is explicitly opted in. `BOXTAL_E2E_LIVE === "1"` bypasses the mock so every
 * Boxtal-host outbound call reaches the real sandbox via the production
 * `fetchWithPinnedHost` path (rpc-bridge.ts). Any other value (unset, "", "0",
 * "false") keeps the deterministic mock — the CI default.
 */
export function shouldInstallBoxtalMock(
  env: { BOXTAL_E2E_LIVE?: string | undefined; [key: string]: string | undefined } = process.env,
): boolean {
  return env.BOXTAL_E2E_LIVE !== "1"
}

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

export function makeBoxtalMockFetch(realFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return realFetch(input, init)
    }

    const isBoxtal = BOXTAL_V1_HOSTS.has(host) || BOXTAL_V3_HOSTS.has(host)
    if (!isBoxtal) {
      // Not a Boxtal host — defer to the real fetch (keeps Shopify live-store
      // scenarios on the same spawned server working unchanged).
      return realFetch(input, init)
    }

    const method = (init?.method ?? "GET").toUpperCase()
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = new Headers(init.headers)
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v
      })
    }
    const body = typeof init?.body === "string" ? init.body : null
    records.push({
      url,
      method,
      headers,
      actor: headers["x-liaison-actor"] ?? null,
      body,
      receivedAt: Date.now(),
    })

    const path = new URL(url).pathname

    // — v1 cotation (XML) —
    if (BOXTAL_V1_HOSTS.has(host) && path === "/api/v1/cotation") {
      return xmlResponse(cotationXmlFor(url))
    }

    // — v3 token exchange —
    if (BOXTAL_V3_HOSTS.has(host) && path === "/iam/account-app/token" && method === "POST") {
      return jsonResponse({ accessToken: "mock-boxtal-bearer", expiresIn: 3600 })
    }

    // — v3 content-category —
    if (BOXTAL_V3_HOSTS.has(host) && path === "/shipping/v3.1/content-category") {
      return v3Envelope(RECORDED_CONTENT_CATEGORIES)
    }

    // — v3 subscriptions —
    if (BOXTAL_V3_HOSTS.has(host) && path === "/shipping/v3.1/subscription" && method === "POST") {
      return v3Envelope({
        id: `sub-${createHash("sha256")
          .update(body ?? "")
          .digest("hex")
          .slice(0, 8)}`,
      })
    }
    // The live API ignores a secret sent inline with the create; only this
    // endpoint sets a subscription's signing key (setSubscriptionWebhookSecret).
    if (
      BOXTAL_V3_HOSTS.has(host) &&
      /^\/shipping\/v3\.1\/subscription\/[^/]+\/webhook-secret$/.test(path) &&
      method === "PUT"
    ) {
      return v3Envelope({})
    }
    if (
      BOXTAL_V3_HOSTS.has(host) &&
      path.startsWith("/shipping/v3.1/subscription/") &&
      method === "DELETE"
    ) {
      return v3Envelope({})
    }

    // — v3 shipping-order create —
    if (
      BOXTAL_V3_HOSTS.has(host) &&
      path === "/shipping/v3.1/shipping-order" &&
      method === "POST"
    ) {
      if (state.createMode === "server_5xx") {
        return jsonResponse({ status: 502, message: "Bad Gateway" }, 502)
      }
      if (state.createMode === "phone_422") {
        return jsonResponse(
          { status: 422, message: "ValidationException.Phone — recipient phone is invalid" },
          422,
        )
      }
      const id = orderIdFromBody(body)
      if (state.createLatencyMs > 0) await Bun.sleep(state.createLatencyMs)
      return v3Envelope({
        id,
        status: "PENDING",
        deliveryPriceExclTax: { value: 7.8, currency: "EUR" },
        expectedTakingOverDate: "2026-06-01",
        estimatedDeliveryDate: "2026-06-04",
      })
    }

    // — v3 shipping-order sub-resources (tracking / documents) —
    const trackingMatch = path.match(/^\/shipping\/v3\.1\/shipping-order\/([^/]+)\/tracking$/)
    if (BOXTAL_V3_HOSTS.has(host) && trackingMatch && method === "GET") {
      const id = decodeURIComponent(trackingMatch[1])
      const status = state.trackingStatusByOrder.get(id) ?? "ANNOUNCED"
      const message =
        state.trackingMessageByOrder.get(id) ??
        TRACKING_STATUS_MESSAGE[status] ??
        "Parcel announced"
      // The carrier reports a collection deadline ONLY for a parcel sitting at a
      // pickup point; emit it on the package so `track` surfaces the authoritative
      // date. Absent for any other state.
      const pickupDeadline =
        status === "REACHED_DELIVERY_PICKUP_POINT" ? state.pickupDeadlineByOrder.get(id) : undefined
      return v3Envelope([
        {
          status,
          trackingNumber: `1Z-${id.slice(-8)}`,
          trackingDateTime: "2026-06-01T09:00:00Z",
          ...(pickupDeadline ? { pickupDeadline } : {}),
          history: [{ status, trackingDateTime: "2026-06-01T09:00:00Z", message }],
        },
      ])
    }

    const docsMatch = path.match(/^\/shipping\/v3\.1\/shipping-order\/([^/]+)\/shipping-document$/)
    if (BOXTAL_V3_HOSTS.has(host) && docsMatch && method === "GET") {
      const id = decodeURIComponent(docsMatch[1])
      if (!state.confirmedOrderIds.has(id)) {
        // PENDING — documents still generating.
        return v3Envelope([])
      }
      return v3Envelope([
        {
          url: `https://api.boxtal.build/files/${id}/label.pdf?sig=${Date.now()}`,
          type: "LABEL",
          format: "PDF_A4",
        },
        {
          url: `https://api.boxtal.build/files/${id}/cn23.pdf?sig=${Date.now()}`,
          type: "CN23",
          format: "PDF_A4",
        },
      ])
    }

    const orderMatch = path.match(/^\/shipping\/v3\.1\/shipping-order\/([^/]+)$/)
    if (BOXTAL_V3_HOSTS.has(host) && orderMatch) {
      const id = decodeURIComponent(orderMatch[1])
      if (method === "DELETE") {
        return v3Envelope({ id, status: "CANCELLED" })
      }
      // GET order detail — flippable to CANCELLED (re-cancel no-op) / CONFIRMED.
      const status = state.cancelledOrderIds.has(id)
        ? "CANCELLED"
        : state.confirmedOrderIds.has(id)
          ? "CONFIRMED"
          : "PENDING"
      return v3Envelope({
        id,
        status,
        deliveryPriceExclTax: { value: 7.8, currency: "EUR" },
        expectedTakingOverDate: "2026-06-01",
        estimatedDeliveryDate: "2026-06-04",
      })
    }

    // Unhandled Boxtal path — 404 with an inspectable body.
    return jsonResponse({ mock: "boxtal", unhandled: path, method }, 404)
  }) as typeof fetch
}
