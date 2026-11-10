// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only Stripe API mock. Stands in for `api.stripe.com` only; every other
// host goes to the wrapped fetch. It serves the object shapes in
// `stripe-fixtures/` (the pinned API version), records every call, and refuses
// any request without the pinned `Stripe-Version` header with a 400, so a code
// path that forgets the version fails its test instead of passing on the
// account's default version.
//
// Objects live in a per-process store: `stripeMockSeed` adds or replaces one
// (cloned from its fixture with overrides), `stripeMockReset` restores the
// fixtures alone. Lists answer Stripe's list envelope; a missing id answers
// Stripe's 404 error shape. `stripeMockFailNext` makes the next call to a path
// answer a chosen status (401, 403, 429) once.
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const STRIPE_MOCK_HOST = "api.stripe.com"
export const STRIPE_MOCK_API_VERSION = "2026-10-28.endive"

/** Resource name in the URL -> fixture file and id prefix. */
const RESOURCES = {
  customers: "customer",
  subscriptions: "subscription",
  invoices: "invoice",
  charges: "charge",
  refunds: "refund",
  disputes: "dispute",
  events: "event",
} as const

export type StripeMockResource = keyof typeof RESOURCES
type StripeObject = Record<string, unknown> & { id: string }

const FIXTURE_DIR = join(import.meta.dir, "stripe-fixtures")

/** The recorded (or documented) object for a resource, freshly parsed. */
export function stripeFixture(resource: StripeMockResource): StripeObject {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${RESOURCES[resource]}.json`), "utf8"))
}

export interface StripeMockRecord {
  method: string
  url: string
  path: string
  stripeVersion: string | null
  hasAuthorization: boolean
  idempotencyKey: string | null
  body: string | null
}

const records: StripeMockRecord[] = []
const store = new Map<StripeMockResource, Map<string, StripeObject>>()
const failures = new Map<string, number>()

function freshStore(): void {
  store.clear()
  for (const r of Object.keys(RESOURCES) as StripeMockResource[]) {
    const f = stripeFixture(r)
    store.set(r, new Map([[f.id, f]]))
  }
}
freshStore()

export function stripeMockRequests(): StripeMockRecord[] {
  return [...records]
}

export function stripeMockReset(): void {
  records.length = 0
  failures.clear()
  freshStore()
}

/** Add or replace an object: the fixture's shape with `overrides` on top. */
export function stripeMockSeed(
  resource: StripeMockResource,
  overrides: Partial<StripeObject> & { id: string },
): StripeObject {
  const obj = { ...stripeFixture(resource), ...overrides } as StripeObject
  store.get(resource)?.set(obj.id, obj)
  return obj
}

/** The next request to `path` (e.g. `/v1/disputes`) answers `status` once. */
export function stripeMockFailNext(path: string, status: 401 | 403 | 404 | 429 | 500): void {
  failures.set(path, status)
}

export function stripeMockHandlesHost(hostname: string): boolean {
  return hostname === STRIPE_MOCK_HOST
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function stripeError(status: number, type: string, message: string, code?: string): Response {
  return json({ error: { type, message, ...(code ? { code } : {}) } }, status)
}

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]
/** What the mock forwards a non-Stripe request to: only the call shape of `fetch`. */
type ForwardFetch = (input: FetchInput, init?: FetchInit) => Promise<Response>

export function makeStripeMockFetch(realFetch: ForwardFetch = fetch): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return realFetch(input, init)
    }
    if (parsed.hostname !== STRIPE_MOCK_HOST) return realFetch(input, init)

    const headers = new Headers(init?.headers)
    const method = (init?.method ?? "GET").toUpperCase()
    const record: StripeMockRecord = {
      method,
      url,
      path: parsed.pathname,
      stripeVersion: headers.get("stripe-version"),
      hasAuthorization: headers.has("authorization"),
      idempotencyKey: headers.get("idempotency-key"),
      body: typeof init?.body === "string" ? init.body : null,
    }
    records.push(record)

    if (record.stripeVersion !== STRIPE_MOCK_API_VERSION) {
      return stripeError(
        400,
        "invalid_request_error",
        `Stripe-Version must be ${STRIPE_MOCK_API_VERSION}; got ${record.stripeVersion ?? "none"}.`,
        "api_version_missing",
      )
    }
    const forced = failures.get(parsed.pathname)
    if (forced !== undefined) {
      failures.delete(parsed.pathname)
      if (forced === 401)
        return stripeError(401, "invalid_request_error", "Invalid API Key provided.")
      if (forced === 403)
        return stripeError(
          403,
          "invalid_request_error",
          "The provided key does not have the required permissions.",
        )
      if (forced === 429)
        return stripeError(429, "rate_limit_error", "Too many requests.", "rate_limit")
      if (forced === 404)
        return stripeError(404, "invalid_request_error", "No such object.", "resource_missing")
      return stripeError(500, "api_error", "Internal error.")
    }

    const [, version, resource, id] = parsed.pathname.split("/")
    if (version !== "v1" || !(resource && resource in RESOURCES)) {
      return stripeError(
        404,
        "invalid_request_error",
        `Unrecognized request URL (${method}: ${parsed.pathname}).`,
      )
    }
    const objects = store.get(resource as StripeMockResource) ?? new Map()
    if (method === "GET" && !id) {
      const limit = Number(parsed.searchParams.get("limit") ?? 10)
      const all = [...objects.values()]
      return json({
        object: "list",
        data: all.slice(0, limit),
        has_more: all.length > limit,
        url: `/v1/${resource}`,
      })
    }
    if (method === "GET" && id) {
      const obj = objects.get(id)
      return obj
        ? json(obj)
        : stripeError(
            404,
            "invalid_request_error",
            `No such ${RESOURCES[resource as StripeMockResource]}: '${id}'`,
            "resource_missing",
          )
    }
    // Writes the connector makes are added with the tasks that make them.
    return stripeError(
      400,
      "invalid_request_error",
      `The mock does not serve ${method} ${parsed.pathname}.`,
    )
  }) as typeof fetch
}
