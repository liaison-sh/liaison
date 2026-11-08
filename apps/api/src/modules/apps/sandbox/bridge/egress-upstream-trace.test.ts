// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sandboxed handler whose connection points at a stale base URL: its fetch
// gets a 404 HTML page and its JSON parse throws, which production redacts to
// "Tool execution failed". The run's upstream trace (the connection read, the
// last answer's host and status) turns that into an error naming the
// connection and the host, never a path, a query or a credential.
import { afterEach, describe, expect, it } from "bun:test"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import {
  attachUpstreamTrace,
  describeUpstreamFailure,
  type UpstreamTrace,
  upstreamFailureOf,
} from "~/modules/apps/sandbox/upstream-trace"

const HOST = "erp-old.example.com"

function bridgeCtx(trace: UpstreamTrace): BridgeContext {
  return {
    orgId: "00000000-0000-0000-0000-00000000e9e6",
    userId: "00000000-0000-0000-0000-000000000001",
    appName: "erp",
    actorType: "user",
    egress: async () => ({ allowedDomains: [HOST], manifest: { name: "erp" } }),
    callerScopes: [],
    inheritedActor: { actorType: "user" as const },
    manifest: { name: "erp" },
    txDb: null,
    bridgeOptions: { upstreamTrace: trace },
    resolveCredentials: async () => ({ baseUrl: `https://${HOST}`, token: "tok-SECRET" }),
  } as unknown as BridgeContext
}

afterEach(() => {
  SandboxBridgeTestAccess.setFetch(null)
  SandboxBridgeTestAccess.setFetchInterceptsHost(null)
})

describe("sandbox upstream trace", () => {
  it("records the connection read and the last answer's host and status", async () => {
    SandboxBridgeTestAccess.setFetchInterceptsHost((h) => h === HOST)
    SandboxBridgeTestAccess.setFetch(
      (async () =>
        new Response("<html>Not Found</html>", {
          status: 404,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    )
    const trace: UpstreamTrace = {}
    const bridge = createEgressMethods(bridgeCtx(trace))
    await bridge.connections_getCredentials("erp", "main")
    const out = JSON.parse(
      await bridge.fetch(`https://${HOST}/api/v2/orders/42?key=tok-SECRET`, "{}"),
    ) as { status: number }
    expect(out.status).toBe(404)
    expect(trace).toEqual({
      connection: { name: "erp", identifier: "main" },
      last: { host: HOST, status: 404 },
    })

    // The handler's JSON parse then throws: the error carries the trace by identity.
    const crash = new SyntaxError("JSON Parse error: Unrecognized token '<'")
    attachUpstreamTrace(crash, trace)
    const failure = upstreamFailureOf(crash)
    expect(failure).toEqual({
      host: HOST,
      status: 404,
      connection: { name: "erp", identifier: "main" },
    })
    const message = describeUpstreamFailure("erp", failure ?? { host: "", status: 0 })
    expect(message).toContain("connection 'erp/erp' (main)")
    expect(message).toContain(`called ${HOST}, which answered HTTP 404`)
    expect(message).not.toContain("/api/v2")
    expect(message).not.toContain("tok-SECRET")
  })

  it("a run whose last answer succeeded, or an untraced error, names nothing", () => {
    const ok = new Error("boom")
    attachUpstreamTrace(ok, { last: { host: HOST, status: 200 } })
    expect(upstreamFailureOf(ok)).toBeNull()
    expect(upstreamFailureOf(new Error("boom"))).toBeNull()
    expect(upstreamFailureOf("not an object")).toBeNull()
  })

  it("without a connection read, the app is named", () => {
    expect(describeUpstreamFailure("erp", { host: HOST, status: 502 })).toContain(
      `app 'erp' called ${HOST}, which answered HTTP 502`,
    )
  })
})
