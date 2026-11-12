// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Stand-in providers for recording contract fixtures of apps whose provider
// offers no sandbox account the recorder can use: the Meta Graph API (ads,
// social), the YouTube Data API, the Google Ads API and the Merchant API. Each
// answers the documented response shape of the endpoints the apps call, with
// plausible, fictional values (no real account, page or person). They sit
// behind the sandbox bridge's test fetch seam (SandboxBridgeTestAccess), so the
// rest of a recorded run (allowlist, auth, the database, other apps) is the real
// bridge. A request no route answers gets a Graph-style 404 and is listed in
// `misses`, so a recorder can refuse to write a fixture built on a miss.
//
// Sources for the shapes: developers.facebook.com/docs/graph-api and
// /docs/marketing-api reference pages (insights, campaigns, adsets, ads,
// adcreatives, adimages, customaudiences, report runs, page feed, comments,
// conversations, subscribed_apps, app subscriptions, Send API),
// developers.google.com/youtube/v3/docs (search, commentThreads, comments,
// videos), developers.google.com/google-ads/api/rest (googleAds:searchStream,
// <resource>:mutate) and developers.google.com/merchant/api/reference
// (products, aggregateProductStatuses).

import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"

export interface FakeRequest {
  method: string
  url: URL
  /** Path without the API version prefix (`/act_1/insights`). */
  path: string
  query: Record<string, string>
  body: string
  form: Record<string, string>
  json: unknown
}

export type FakeAnswer = { status?: number; body: unknown; headers?: Record<string, string> }
export type FakeRoute = (req: FakeRequest) => FakeAnswer | undefined

export interface FakeProviders {
  misses: string[]
  /** Requests answered, in order (`METHOD host/path`). */
  seen: string[]
  uninstall(): void
}

const VERSION_PREFIX = /^\/(v\d+(\.\d+)?|youtube\/v3)(?=\/)/

function parseRequest(input: string, init: RequestInit | undefined): FakeRequest {
  const url = new URL(input)
  const body = typeof init?.body === "string" ? init.body : ""
  const form: Record<string, string> = {}
  let json: unknown = null
  if (body.startsWith("{") || body.startsWith("[")) {
    try {
      json = JSON.parse(body)
    } catch {
      json = null
    }
  } else if (body) {
    for (const [k, v] of new URLSearchParams(body)) form[k] = v
  }
  return {
    method: String(init?.method ?? "GET").toUpperCase(),
    url,
    path: url.pathname.replace(VERSION_PREFIX, ""),
    query: Object.fromEntries(url.searchParams),
    body,
    form,
    json,
  }
}

/**
 * Route `hosts` to `routes` (first answer wins) behind the bridge's test fetch
 * seam until `uninstall()`.
 */
export function installFakeProviders(hosts: string[], routes: FakeRoute[]): FakeProviders {
  const misses: string[] = []
  const seen: string[] = []
  const handled = new Set(hosts)
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = parseRequest(String(input instanceof Request ? input.url : input), init)
    const label = `${req.method} ${req.url.host}${req.url.pathname}`
    for (const route of routes) {
      const answer = route(req)
      if (answer) {
        seen.push(label)
        return new Response(JSON.stringify(answer.body), {
          status: answer.status ?? 200,
          headers: { "content-type": "application/json", ...(answer.headers ?? {}) },
        })
      }
    }
    misses.push(`${label}?${req.url.searchParams}`)
    return new Response(
      JSON.stringify({
        error: {
          message: `Unknown path components: ${req.path}`,
          type: "OAuthException",
          code: 2500,
        },
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
  SandboxBridgeTestAccess.setFetchInterceptsHost((h) => handled.has(h))
  SandboxBridgeTestAccess.setFetch(fake)
  return {
    misses,
    seen,
    uninstall() {
      SandboxBridgeTestAccess.setFetch(null)
      SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    },
  }
}

/** A route for `method` on a path matching `pattern` (string: exact; RegExp: test). */
export function on(
  method: string,
  pattern: string | RegExp,
  answer: (req: FakeRequest, m: RegExpMatchArray | null) => unknown,
  host?: string,
): FakeRoute {
  return (req) => {
    if (req.method !== method) return undefined
    if (host && req.url.host !== host) return undefined
    const m =
      typeof pattern === "string"
        ? req.path === pattern
          ? null
          : undefined
        : req.path.match(pattern)
    if (m === undefined || (typeof pattern !== "string" && !m)) return undefined
    const body = answer(req, m ?? null)
    if (body === undefined) return undefined
    return body && typeof body === "object" && "__status" in (body as object)
      ? { status: (body as { __status: number }).__status, body: (body as { body: unknown }).body }
      : { body }
  }
}

/** A Graph list envelope: one page, no next. */
export function graphPage(data: unknown[]): unknown {
  return { data, paging: { cursors: { before: "QVFIUmFiZA", after: "QVFIUnpiZA" } } }
}
