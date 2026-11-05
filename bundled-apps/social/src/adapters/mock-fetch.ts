// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TEST-ONLY mock fetch for adapter unit tests. Maps a URL path substring to a
// canned JSON response so adapters can be exercised against captured fixtures
// with no network. Records calls for assertions.

import type { AdapterFetch } from "./types"

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
    calls.push({ url, method: init?.method ?? "GET", body: init?.body, headers: init?.headers })
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
