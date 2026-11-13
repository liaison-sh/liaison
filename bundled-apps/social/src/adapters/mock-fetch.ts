// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TEST-ONLY mock fetch for adapter unit tests. Maps a URL path substring to a
// canned JSON response so adapters can be exercised against captured fixtures
// with no network. Records calls for assertions.

import type { SocialAuth } from "../ctx"
import type { AdapterFetch } from "./types"

/**
 * A connected account's credential for an adapter test. The mock fetch plays the
 * host: a request naming it is recorded with `Authorization: Bearer <token>`.
 */
export function testAuth(token: string, connection = "facebook"): SocialAuth {
  return { connection, identifier: token, scheme: "bearer" }
}

/** Every account id the unit tests connect (the host lists active accounts by identifier). */
export const TEST_ACCOUNT_IDS = [
  "U1",
  "acct-1",
  "chan-1",
  "fb-user",
  "ig-1",
  "ig-fine",
  "ig-slow",
  "ig-stuck",
  "ig1",
  "page-1",
  "page-throws",
  "pg1",
  "user-1",
  "user-9",
]

/** What `ctx.connections.getAccounts(name)` answers when every test account is connected. */
export function connectedAccountList(): Array<{ identifier: string; status: string }> {
  return TEST_ACCOUNT_IDS.map((identifier) => ({ identifier, status: "active" }))
}

/** The headers the host sends for `init` (its `auth` added as the bridge adds it). */
export function hostHeaders(init?: {
  headers?: Record<string, string>
  auth?: SocialAuth
}): Record<string, string> | undefined {
  const auth = init?.auth
  if (!auth) return init?.headers
  const token = "identifier" in auth ? auth.identifier : "app-token"
  return { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` }
}

export interface MockCall {
  url: string
  method: string
  body?: unknown
  headers?: Record<string, string>
}

export interface MockFetch extends AdapterFetch {
  calls: MockCall[]
}

/**
 * `routes` maps a path substring → response (json body, optional status).
 * The first route whose key is a substring of the request URL wins.
 */
export function makeMockFetch(
  routes: Record<string, unknown>,
  opts: { status?: number } = {},
): MockFetch {
  const calls: MockCall[] = []
  const base: AdapterFetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body, headers: hostHeaders(init) })
    const match = Object.entries(routes).find(([path]) => url.includes(path))
    const status = opts.status ?? 200
    const json = match ? match[1] : {}
    // Mirror the REAL sandbox fetch contract ({status, headers, body-string}) —
    // the old Response-shaped mock kept tests green while every live call threw.
    return {
      status,
      headers: {},
      body: JSON.stringify(json),
    }
  }
  const fn = base as MockFetch
  fn.calls = calls
  return fn
}
