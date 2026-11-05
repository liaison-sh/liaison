// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { fetchWithPinnedHost } from "~/lib/outbound-fetch"
import {
  isOperatorPrivateAppHost,
  SANDBOX_PRIVATE_HOST_POLICY,
  validateSandboxFetchUrl,
} from "~/modules/apps/sandbox/bridge/shared"

// LIAISON_APP_PRIVATE_HOSTS: the operator's list of private hosts (`host` or
// `host:port`) an app may reach over plain HTTP on a private address. The
// app's own domain allow-list still applies; link-local and metadata
// addresses stay refused; every host not on the list keeps the public-HTTPS rule.

const ENV = "LIAISON_APP_PRIVATE_HOSTS"
let prior: string | undefined
let lookupSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  prior = process.env[ENV]
  lookupSpy = spyOn(dnsPromises, "lookup")
})
afterEach(() => {
  if (prior === undefined) delete process.env[ENV]
  else process.env[ENV] = prior
  lookupSpy.mockRestore()
})

const okFetch = (seen: string[]) =>
  (async (input: unknown) => {
    seen.push(String(input))
    return new Response("ok", { status: 200 })
  }) as unknown as typeof fetch

describe("LIAISON_APP_PRIVATE_HOSTS", () => {
  it("is empty by default: a private host stays refused", async () => {
    delete process.env[ENV]
    expect(isOperatorPrivateAppHost(new URL("http://kpi-service:8787/x"))).toBe(false)
    expect(() =>
      validateSandboxFetchUrl("http://kpi-service:8787/x", ["kpi-service"], false),
    ).toThrow("HTTPS")
    lookupSpy.mockImplementation((async () => [{ address: "172.18.0.4", family: 4 }]) as never)
    await expect(
      fetchWithPinnedHost(
        "https://kpi-service/x",
        {},
        { ...SANDBOX_PRIVATE_HOST_POLICY, fetchImpl: okFetch([]) },
      ),
    ).rejects.toThrow("private network")
  })

  it("lets a listed host be reached over HTTP on a private address", async () => {
    process.env[ENV] = "kpi-service:8787, other.internal"
    expect(isOperatorPrivateAppHost(new URL("http://kpi-service:8787/kpi"))).toBe(true)
    expect(isOperatorPrivateAppHost(new URL("http://KPI-SERVICE:8787/kpi"))).toBe(true)
    expect(isOperatorPrivateAppHost(new URL("http://other.internal/kpi"))).toBe(true)
    expect(isOperatorPrivateAppHost(new URL("https://other.internal:9443/kpi"))).toBe(true)
    // A port pinned in the entry must match.
    expect(isOperatorPrivateAppHost(new URL("http://kpi-service:9999/kpi"))).toBe(false)
    expect(isOperatorPrivateAppHost(new URL("http://kpi-service/kpi"))).toBe(false)
    // No suffix reach.
    expect(isOperatorPrivateAppHost(new URL("http://x.kpi-service:8787/kpi"))).toBe(false)

    expect(
      validateSandboxFetchUrl("http://kpi-service:8787/kpi", ["kpi-service"], false).hostname,
    ).toBe("kpi-service")

    lookupSpy.mockImplementation((async () => [{ address: "172.18.0.4", family: 4 }]) as never)
    const seen: string[] = []
    const res = await fetchWithPinnedHost(
      "http://kpi-service:8787/kpi",
      {},
      { ...SANDBOX_PRIVATE_HOST_POLICY, fetchImpl: okFetch(seen) },
    )
    expect(res.status).toBe(200)
    expect(seen).toEqual(["http://kpi-service:8787/kpi"])
  })

  it("still requires the app's own domain allow-list", () => {
    process.env[ENV] = "kpi-service:8787"
    expect(() =>
      validateSandboxFetchUrl("http://kpi-service:8787/kpi", ["api.example.com"], false),
    ).toThrow("Domain not in allowlist")
  })

  it("never opens metadata or link-local addresses, even when listed", async () => {
    process.env[ENV] = "169.254.169.254,meta.internal"
    expect(() =>
      validateSandboxFetchUrl("http://169.254.169.254/latest", ["169.254.169.254"], false),
    ).toThrow("link-local or metadata")
    lookupSpy.mockImplementation((async () => [{ address: "169.254.169.254", family: 4 }]) as never)
    await expect(
      fetchWithPinnedHost(
        "http://meta.internal/latest",
        {},
        { ...SANDBOX_PRIVATE_HOST_POLICY, fetchImpl: okFetch([]) },
      ),
    ).rejects.toThrow("link-local or metadata")
  })

  it("does not carry the private allowance to a redirect target that is not listed", async () => {
    process.env[ENV] = "kpi-service:8787"
    lookupSpy.mockImplementation((async (host: string) =>
      host === "kpi-service"
        ? [{ address: "172.18.0.4", family: 4 }]
        : [{ address: "10.0.0.9", family: 4 }]) as never)
    const fakeFetch = (async (input: unknown) => {
      const u = String(input)
      if (u.startsWith("http://kpi-service:8787"))
        return new Response(null, { status: 302, headers: { location: "https://db.internal/x" } })
      return new Response("leak", { status: 200 })
    }) as unknown as typeof fetch
    await expect(
      fetchWithPinnedHost(
        "http://kpi-service:8787/kpi",
        {},
        { ...SANDBOX_PRIVATE_HOST_POLICY, fetchImpl: fakeFetch },
      ),
    ).rejects.toThrow("private network")
  })
})
