// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P1-T09: the four node session routers are mounted behind the session and
// the org limiter, and the node's event batches get their own body cap
// (a 1 MiB batch plus its envelope exceeds the generic 1 MiB JSON cap).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ID = "00000000-0000-4000-8000-000000000001"

const ROUTES: Array<[method: string, path: string]> = [
  ["GET", "/api/me/node-sessions"],
  ["GET", `/api/me/node-sessions/${ID}`],
  ["GET", `/api/me/node-sessions/${ID}/events`],
  ["POST", "/api/me/node-sessions"],
  ["POST", "/api/me/node-level-confirmations"],
  ["POST", `/api/node/sessions/${ID}/events`],
  ["POST", `/api/node/level-confirmations/${ID}/consume`],
]

describe("node session routes are mounted (P1-T09)", () => {
  let session: minimal.Session

  beforeAll(async () => {
    await acquireTestLock()
    session = await minimal.session((await createTestOrg()).id)
  })
  afterAll(releaseTestLock)

  const call = (method: string, path: string, bearer?: string, body?: string) =>
    app.request(path, {
      method,
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        "Content-Type": "application/json",
      },
      body: method === "GET" ? undefined : (body ?? "{}"),
    })

  it("each route exists behind the session (401 without a bearer, mounted with one)", async () => {
    for (const [method, path] of ROUTES) {
      const anonymous = await call(method, path)
      expect({ method, path, status: anonymous.status }).toEqual({ method, path, status: 401 })
      // Filled routes answer their own refusals (400, 401 without a node
      // credential, 404 for an unknown id with their own code); an unmounted
      // path gets the app's fallback 404, code NOT_FOUND.
      const signedIn = await call(method, path, session.bearer)
      const body = (await signedIn.json().catch(() => null)) as {
        error?: { code?: string }
      } | null
      const mounted = signedIn.status !== 404 || body?.error?.code !== "NOT_FOUND"
      expect({ method, path, mounted }).toEqual({ method, path, mounted: true })
    }
  })

  it("a 1.5 MiB POST to the events route is not refused by the generic 1 MiB cap", async () => {
    const big = JSON.stringify({ padding: "x".repeat(1.5 * 1024 * 1024) })
    const events = await call("POST", `/api/node/sessions/${ID}/events`, session.bearer, big)
    // Past the body cap: the route itself answers (401, no node credential).
    expect(events.status).toBe(401)
    // The generic cap still applies everywhere else.
    const other = await call("POST", "/api/me/node-sessions", session.bearer, big)
    expect(other.status).toBe(413)
  })
})
