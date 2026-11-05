// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sandboxed app's ctx.fetch whose upstream drops the connection before
// answering ("The socket connection was closed unexpectedly", Bun's wording for
// a pooled keep-alive socket the far end already closed). An idempotent read is
// retried once; a write is never replayed; what still fails is a typed 503
// upstream_connection_closed that the seams log at warn.
import { afterEach, describe, expect, it } from "bun:test"
import { classifyFailure, UPSTREAM_CONNECTION_CLOSED } from "~/lib/failure-severity"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"

const HOST = "graph.facebook.com"
const URL_ = `https://${HOST}/v21.0/act_1/insights`

function bridgeCtx(): BridgeContext {
  return {
    orgId: "00000000-0000-0000-0000-00000000e9e5",
    userId: "00000000-0000-0000-0000-000000000001",
    appName: "ads",
    actorType: "user",
    allowedDomains: [HOST],
    callerScopes: [],
    inheritedActor: { actorType: "user" as const },
    manifest: { name: "ads" },
    txDb: null,
    resolveCredentials: async () => ({}),
  } as unknown as BridgeContext
}

function dropped(): Error {
  return new Error(
    "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
  )
}

/** Installs a transport that fails the first `failures` calls, then answers 200. */
function transport(failures: number): { calls: string[] } {
  const calls: string[] = []
  SandboxBridgeTestAccess.setFetchInterceptsHost((h) => h === HOST)
  SandboxBridgeTestAccess.setFetch((async (_url: string, init?: RequestInit) => {
    calls.push(String(init?.method ?? "GET"))
    if (calls.length <= failures) throw dropped()
    return new Response('{"data":[]}', { status: 200 })
  }) as unknown as typeof fetch)
  return { calls }
}

const appFetch = (opts: Record<string, unknown>) =>
  createEgressMethods(bridgeCtx()).fetch(URL_, JSON.stringify(opts))

afterEach(() => {
  SandboxBridgeTestAccess.setFetch(null)
  SandboxBridgeTestAccess.setFetchInterceptsHost(null)
})

describe("ctx.fetch: a dropped connection", () => {
  it("an idempotent GET is retried once and returns the answer", async () => {
    const { calls } = transport(1)
    const out = JSON.parse(await appFetch({ method: "GET" })) as { status: number }
    expect(out.status).toBe(200)
    expect(calls).toEqual(["GET", "GET"])
  })

  it("a GET dropped twice is a typed 503 upstream_connection_closed, logged as expected", async () => {
    const { calls } = transport(2)
    const err = (await appFetch({ method: "GET" }).catch((e: unknown) => e)) as Error & {
      status?: number
      code?: string
    }
    expect(calls).toEqual(["GET", "GET"])
    expect(err.status).toBe(503)
    expect(err.code).toBe(UPSTREAM_CONNECTION_CLOSED)
    expect(err.message).toContain(HOST)
    expect(classifyFailure({ status: err.status, code: err.code })).toEqual({
      level: "warn",
      reason: "upstream_unavailable",
    })
  })

  it("a POST is never replayed", async () => {
    const { calls } = transport(1)
    const err = (await appFetch({ method: "POST", body: "a=1" }).catch((e: unknown) => e)) as {
      code?: string
    }
    expect(calls).toEqual(["POST"])
    expect(err.code).toBe(UPSTREAM_CONNECTION_CLOSED)
  })

  it("a real fault stays a fault: a 500 or a statusless throw is not an expected failure", () => {
    expect(classifyFailure({ status: 500, code: "something_else" }).level).toBe("error")
    expect(classifyFailure({}).level).toBe("error")
    expect(classifyFailure({ status: 404, code: "not_found" })).toEqual({
      level: "warn",
      reason: "not_found",
    })
  })
})
