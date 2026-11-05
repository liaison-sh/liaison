// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { fetchWithPinnedHost } from "~/lib/outbound-fetch"
import {
  isOperatorPrivateAppHost,
  sandboxEgressPolicy,
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
      validateSandboxFetchUrl("http://kpi-service:8787/x", ["kpi-service"], false, "kpi"),
    ).toThrow("HTTPS")
    lookupSpy.mockImplementation((async () => [{ address: "172.18.0.4", family: 4 }]) as never)
    await expect(
      fetchWithPinnedHost(
        "https://kpi-service/x",
        {},
        { ...sandboxEgressPolicy("kpi"), fetchImpl: okFetch([]) },
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
      validateSandboxFetchUrl("http://kpi-service:8787/kpi", ["kpi-service"], false, "kpi")
        .hostname,
    ).toBe("kpi-service")

    lookupSpy.mockImplementation((async () => [{ address: "172.18.0.4", family: 4 }]) as never)
    const seen: string[] = []
    const res = await fetchWithPinnedHost(
      "http://kpi-service:8787/kpi",
      {},
      { ...sandboxEgressPolicy("kpi"), fetchImpl: okFetch(seen) },
    )
    expect(res.status).toBe(200)
    expect(seen).toEqual(["http://kpi-service:8787/kpi"])
  })

  it("still requires the app's own domain allow-list", () => {
    process.env[ENV] = "kpi-service:8787"
    expect(() =>
      validateSandboxFetchUrl("http://kpi-service:8787/kpi", ["api.example.com"], false, "kpi"),
    ).toThrow("Domain not in allowlist")
  })

  it("never opens metadata or link-local addresses, even when listed", async () => {
    process.env[ENV] = "169.254.169.254,meta.internal"
    expect(() =>
      validateSandboxFetchUrl("http://169.254.169.254/latest", ["169.254.169.254"], false, "kpi"),
    ).toThrow("link-local or metadata")
    lookupSpy.mockImplementation((async () => [{ address: "169.254.169.254", family: 4 }]) as never)
    await expect(
      fetchWithPinnedHost(
        "http://meta.internal/latest",
        {},
        { ...sandboxEgressPolicy("kpi"), fetchImpl: okFetch([]) },
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
        { ...sandboxEgressPolicy("kpi"), fetchImpl: fakeFetch },
      ),
    ).rejects.toThrow("private network")
  })
})

// An org's custom app (managed edition) is a tenant's code: the operator's
// private hosts are not for it, and neither is this server itself, by its
// public address (LIAISON_CELL_PUBLIC_ADDRESSES) or its own host names.
describe("org-private custom apps", () => {
  const CUSTOM = "crm-o12345678"
  const mutableEnv = env as {
    LIAISON_ORG_HOST_TEMPLATE?: string
    LIAISON_CELL_PUBLIC_ADDRESSES?: string
  }
  let priorCell: string | undefined
  let priorTemplate: string | undefined
  beforeEach(() => {
    _setEdition("managed")
    priorCell = mutableEnv.LIAISON_CELL_PUBLIC_ADDRESSES
    priorTemplate = mutableEnv.LIAISON_ORG_HOST_TEMPLATE
    mutableEnv.LIAISON_CELL_PUBLIC_ADDRESSES = "93.184.216.34, 2a01:4f8:c0c:1::7"
    mutableEnv.LIAISON_ORG_HOST_TEMPLATE = "https://{slug}.cells.example"
  })
  afterEach(() => {
    _setEdition(null)
    mutableEnv.LIAISON_CELL_PUBLIC_ADDRESSES = priorCell
    mutableEnv.LIAISON_ORG_HOST_TEMPLATE = priorTemplate
  })

  it("never gets the operator's private hosts", async () => {
    process.env[ENV] = "kpi-service:8787"
    expect(() =>
      validateSandboxFetchUrl("http://kpi-service:8787/kpi", ["kpi-service"], false, CUSTOM),
    ).toThrow("HTTPS")
    lookupSpy.mockImplementation((async () => [{ address: "172.18.0.4", family: 4 }]) as never)
    await expect(
      fetchWithPinnedHost(
        "https://kpi-service:8787/kpi",
        {},
        { ...sandboxEgressPolicy(CUSTOM), fetchImpl: okFetch([]) },
      ),
    ).rejects.toThrow("private network")
    // An instance app still does.
    expect(
      validateSandboxFetchUrl("http://kpi-service:8787/kpi", ["kpi-service"], false, "kpi")
        .hostname,
    ).toBe("kpi-service")
  })

  it("never reaches this server's own public address, as a literal or through DNS", async () => {
    for (const url of ["https://93.184.216.34:6379/", "https://[2a01:4f8:c0c:1::7]:6432/"]) {
      expect(() =>
        validateSandboxFetchUrl(
          url,
          ["93.184.216.34", "[2a01:4f8:c0c:1::7]", "2a01:4f8:c0c:1::7"],
          false,
          CUSTOM,
        ),
      ).toThrow("this server's own address")
    }
    lookupSpy.mockImplementation((async () => [{ address: "93.184.216.34", family: 4 }]) as never)
    await expect(
      fetchWithPinnedHost(
        "https://rebind.attacker.example/",
        {},
        { ...sandboxEgressPolicy(CUSTOM), fetchImpl: okFetch([]) },
      ),
    ).rejects.toThrow("this server's own address")
    // An instance app is not refused by this rule.
    const seen: string[] = []
    await fetchWithPinnedHost(
      "https://rebind.attacker.example/",
      {},
      { ...sandboxEgressPolicy("kpi"), fetchImpl: okFetch(seen) },
    )
    expect(seen).toHaveLength(1)
  })

  it("never reaches the org hosts or the edge origin of this server by name", () => {
    for (const host of ["acme.cells.example", "cells.example"]) {
      expect(() =>
        validateSandboxFetchUrl(`https://${host}/api/org`, [host], false, CUSTOM),
      ).toThrow("this server's own address")
    }
    expect(
      validateSandboxFetchUrl("https://api.example.com/x", ["api.example.com"], false, CUSTOM)
        .hostname,
    ).toBe("api.example.com")
  })
})
