// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, mock } from "bun:test"
import { createRpcBridge, SandboxBridgeTestAccess } from "~/modules/apps/sandbox/rpc-bridge"

afterEach(() => {
  SandboxBridgeTestAccess.setFetch(null)
})

describe("RPC bridge — fetch domain allowlist", () => {
  const manifest = {
    name: "fetch-test",
    schema: {},
    events: {},
    connections: {
      github: { allowedDomains: ["github.com", "*.github.com"] },
    },
    network: { allowedDomains: ["example.com"] },
  }
  const mockTx = { execute: async () => [], queueEvent: async () => {} } as any

  it("rejects fetch to unlisted domain", async () => {
    const bridge = createRpcBridge("fetch-test", "u1", "o1", mockTx, manifest as any)
    await expect(bridge.fetch("https://evil.com/data", "{}")).rejects.toThrow("not in allowlist")
  })

  it("allows fetch to exact domain match", async () => {
    SandboxBridgeTestAccess.setFetch(
      mock(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
    )
    const bridge = createRpcBridge("fetch-test", "u1", "o1", mockTx, manifest as any)
    const result = JSON.parse(await bridge.fetch("https://example.com/endpoint", "{}"))
    expect(result.status).toBe(200)
    expect(result.body).toBe("ok")
  })

  it("allows fetch to wildcard subdomain match", async () => {
    SandboxBridgeTestAccess.setFetch(
      mock(async () => new Response("subdomain ok", { status: 200 })) as unknown as typeof fetch,
    )
    const bridge = createRpcBridge("fetch-test", "u1", "o1", mockTx, manifest as any)
    const result = JSON.parse(await bridge.fetch("https://api.github.com/repos", "{}"))
    expect(result.status).toBe(200)
    expect(result.body).toBe("subdomain ok")
  })

  it("wildcard does not match the root domain itself", async () => {
    const restrictedManifest = {
      ...manifest,
      connections: { gitlab: { allowedDomains: ["*.restricted.io"] } },
      network: { allowedDomains: [] },
    }
    const bridge = createRpcBridge("fetch-test", "u1", "o1", mockTx, restrictedManifest as any)
    await expect(bridge.fetch("https://restricted.io/api", "{}")).rejects.toThrow(
      "not in allowlist",
    )
  })

  it("rejects invalid URLs", async () => {
    const bridge = createRpcBridge("fetch-test", "u1", "o1", mockTx, manifest as any)
    await expect(bridge.fetch("not-a-url", "{}")).rejects.toThrow()
  })

  it("rejects redirects to a domain outside the allowlist", async () => {
    SandboxBridgeTestAccess.setFetch(
      mock(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.com/steal" },
          }),
      ) as unknown as typeof fetch,
    )

    const bridge = createRpcBridge("fetch-test", "u1", "o1", mockTx, manifest as any)
    await expect(bridge.fetch("https://example.com/start", "{}")).rejects.toThrow("allowlist")
  })

  it("rejects redirects to private-network targets", async () => {
    SandboxBridgeTestAccess.setFetch(
      mock(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://127.0.0.1/private" },
          }),
      ) as unknown as typeof fetch,
    )

    const manifestWithPrivateExact = {
      ...manifest,
      network: { allowedDomains: ["example.com", "127.0.0.1"] },
    }

    const bridge = createRpcBridge(
      "fetch-test",
      "u1",
      "o1",
      mockTx,
      manifestWithPrivateExact as any,
    )
    await expect(bridge.fetch("https://example.com/start", "{}")).rejects.toThrow("private network")
  })

  it("rejects oversized responses", async () => {
    SandboxBridgeTestAccess.setFetch(
      mock(
        async () => new Response("x".repeat(1_000_001), { status: 200 }),
      ) as unknown as typeof fetch,
    )

    const bridge = createRpcBridge("fetch-test", "u1", "o1", mockTx, manifest as any)
    await expect(bridge.fetch("https://example.com/large", "{}")).rejects.toThrow("exceeds")
  })

  it("maps aborted fetches to timeout errors", async () => {
    SandboxBridgeTestAccess.setFetch(
      mock(async () => {
        const err = new DOMException("Timed out", "AbortError")
        throw err
      }) as unknown as typeof fetch,
    )

    const bridge = createRpcBridge("fetch-test", "u1", "o1", mockTx, manifest as any)
    await expect(bridge.fetch("https://example.com/slow", "{}")).rejects.toThrow("timed out")
  })

  // An app may TIGHTEN one call's deadline, never extend it past the sandbox ceiling. The SDK
  // accepted `timeoutMs`, carried it across the IPC boundary, and the bridge dropped it: boxtal's
  // label import therefore retried 8 times at the 10s ceiling, 80s inside a 60s tool budget, which
  // is how print_pack held a worker for 39s in prod and timed the operator out at 30s.
  it("honours a caller's timeoutMs, tightening the abort deadline for that one call", async () => {
    let seen: number | null = null
    SandboxBridgeTestAccess.setFetch(
      mock(async (_url: string, init: RequestInit) => {
        // AbortSignal.timeout's remaining budget is not readable, so assert through the error the
        // bridge reports: it names the deadline it actually armed.
        seen = (init.signal as AbortSignal & { __ms?: number }).__ms ?? null
        const err = new DOMException("Timed out", "AbortError")
        throw err
      }) as unknown as typeof fetch,
    )
    const bridge = createRpcBridge("fetch-test", "u1", "o1", mockTx, manifest as any)
    await expect(
      bridge.fetch("https://example.com/slow", JSON.stringify({ timeoutMs: 5000 })),
    ).rejects.toThrow("timed out after 5000ms")
    expect(seen).toBe(null) // the signal is opaque; the message above is the assertion that counts
  })

  it("clamps a caller's timeoutMs to the sandbox ceiling, so an app cannot pin a worker for longer", async () => {
    SandboxBridgeTestAccess.setFetch(
      mock(async () => {
        const err = new DOMException("Timed out", "AbortError")
        throw err
      }) as unknown as typeof fetch,
    )
    const bridge = createRpcBridge("fetch-test", "u1", "o1", mockTx, manifest as any)
    // 10 minutes requested, the ceiling is what gets armed and what the error reports.
    await expect(
      bridge.fetch("https://example.com/slow", JSON.stringify({ timeoutMs: 600_000 })),
    ).rejects.toThrow(/timed out after (?!600000)\d+ms/)
  })

  it("falls back to the ceiling when timeoutMs is absent or nonsense", async () => {
    SandboxBridgeTestAccess.setFetch(
      mock(async () => {
        const err = new DOMException("Timed out", "AbortError")
        throw err
      }) as unknown as typeof fetch,
    )
    const bridge = createRpcBridge("fetch-test", "u1", "o1", mockTx, manifest as any)
    const ceiling = (await bridge
      .fetch("https://example.com/slow", "{}")
      .catch((e: Error) => e.message)) as string
    for (const bad of [{ timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: "soon" }]) {
      await expect(bridge.fetch("https://example.com/slow", JSON.stringify(bad))).rejects.toThrow(
        ceiling,
      )
    }
  })
})
