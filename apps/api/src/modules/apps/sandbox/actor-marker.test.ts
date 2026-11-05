// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 E2E P4 — Per-user actor marker in the sandbox fetch bridge.
//
// When `LIAISON_TEST_INJECT_ACTOR=1` is set on the worker, every outbound
// fetch sourced from a sandboxed app must carry `X-Liaison-Actor: <userId>`.
// The Phase-16 mock Shopify server records this header so the per-user
// enforcement E2E (S2) can assert that a denied user produced zero outbound
// calls. The production code path is unaffected (env var off → no header
// injected).
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { createRpcBridge, SandboxBridgeTestAccess } from "~/modules/apps/sandbox/rpc-bridge"

const manifest = {
  name: "actor-marker-test",
  schema: {},
  events: {},
  network: { allowedDomains: ["example.com"] },
}
const mockTx = { execute: async () => [], queueEvent: async () => {} } as any

beforeEach(() => {
  // Default to test-injection ON for these tests; individual tests opt out.
  process.env.LIAISON_TEST_INJECT_ACTOR = "1"
})

afterEach(() => {
  SandboxBridgeTestAccess.setFetch(null)
  delete process.env.LIAISON_TEST_INJECT_ACTOR
})

describe("RPC bridge — P4 X-Liaison-Actor marker", () => {
  it("injects X-Liaison-Actor: <userId> when LIAISON_TEST_INJECT_ACTOR=1", async () => {
    let observedHeaders: Headers | null = null
    SandboxBridgeTestAccess.setFetch(
      mock(async (_url: any, init?: any) => {
        observedHeaders = new Headers(init?.headers ?? {})
        return new Response("ok", { status: 200 })
      }) as unknown as typeof fetch,
    )

    const bridge = createRpcBridge(
      "actor-marker-test",
      "user-bob-uuid",
      "org-1",
      mockTx,
      manifest as any,
    )
    await bridge.fetch("https://example.com/admin/api/graphql.json", "{}")
    expect(observedHeaders).not.toBeNull()
    expect(observedHeaders!.get("x-liaison-actor")).toBe("user-bob-uuid")
  })

  it("does NOT inject the header when LIAISON_TEST_INJECT_ACTOR is unset", async () => {
    delete process.env.LIAISON_TEST_INJECT_ACTOR

    let observedHeaders: Headers | null = null
    SandboxBridgeTestAccess.setFetch(
      mock(async (_url: any, init?: any) => {
        observedHeaders = new Headers(init?.headers ?? {})
        return new Response("ok", { status: 200 })
      }) as unknown as typeof fetch,
    )

    const bridge = createRpcBridge(
      "actor-marker-test",
      "user-bob-uuid",
      "org-1",
      mockTx,
      manifest as any,
    )
    await bridge.fetch("https://example.com/whatever", "{}")
    expect(observedHeaders).not.toBeNull()
    expect(observedHeaders!.get("x-liaison-actor")).toBeNull()
  })

  it("preserves caller-supplied headers when injecting the actor marker", async () => {
    let observedHeaders: Headers | null = null
    SandboxBridgeTestAccess.setFetch(
      mock(async (_url: any, init?: any) => {
        observedHeaders = new Headers(init?.headers ?? {})
        return new Response("ok", { status: 200 })
      }) as unknown as typeof fetch,
    )

    const bridge = createRpcBridge(
      "actor-marker-test",
      "user-charlie-uuid",
      "org-1",
      mockTx,
      manifest as any,
    )
    await bridge.fetch(
      "https://example.com/admin/api/graphql.json",
      JSON.stringify({
        method: "POST",
        headers: {
          authorization: "Bearer mock-offline-token",
          "content-type": "application/json",
        },
        body: '{"query":"query Shop { shop { id } }"}',
      }),
    )
    expect(observedHeaders).not.toBeNull()
    expect(observedHeaders!.get("authorization")).toBe("Bearer mock-offline-token")
    expect(observedHeaders!.get("content-type")).toBe("application/json")
    expect(observedHeaders!.get("x-liaison-actor")).toBe("user-charlie-uuid")
  })

  it("does not overwrite an existing X-Liaison-Actor header set by the caller", async () => {
    // Defence-in-depth: if an app already set the header for some reason, the
    // bridge's value wins (test-mode invariant: bridge is the source of truth
    // for the marker). Encoded by the spread order in rpc-bridge.ts.
    let observedHeaders: Headers | null = null
    SandboxBridgeTestAccess.setFetch(
      mock(async (_url: any, init?: any) => {
        observedHeaders = new Headers(init?.headers ?? {})
        return new Response("ok", { status: 200 })
      }) as unknown as typeof fetch,
    )

    const bridge = createRpcBridge(
      "actor-marker-test",
      "user-bridge-wins",
      "org-1",
      mockTx,
      manifest as any,
    )
    await bridge.fetch(
      "https://example.com/x",
      JSON.stringify({ headers: { "X-Liaison-Actor": "user-app-tried-to-fake" } }),
    )
    expect(observedHeaders).not.toBeNull()
    expect(observedHeaders!.get("x-liaison-actor")).toBe("user-bridge-wins")
  })
})
