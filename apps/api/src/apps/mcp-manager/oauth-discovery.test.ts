// SPDX-License-Identifier: FSL-1.1-ALv2
//
// OAuth discovery for an MCP server (MCP authorization 2025-11-25 + the
// 2026-07-28 client MUSTs): Protected Resource Metadata from the challenge or
// the path-aware well-known, a strict `resource` match, AS metadata in the RFC
// 8414 / OIDC order, the issuer match and the S256 requirement.
import { afterEach, describe, expect, it } from "bun:test"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import {
  type OAuthFixtureHandle,
  startOAuthMcpFixture,
} from "~/modules/mcp-client/transports/fixtures/oauth-mcp-server"
import {
  discoverOAuthContext,
  OAuthDiscoveryError,
  probeMcpServer,
  resourceMatches,
  selectScope,
} from "./oauth-discovery"

let fixture: OAuthFixtureHandle | null = null
afterEach(async () => {
  await fixture?.close()
  fixture = null
})

async function discoveryError(p: Promise<unknown>): Promise<OAuthDiscoveryError> {
  try {
    await p
  } catch (err) {
    if (err instanceof OAuthDiscoveryError) return err
    throw err
  }
  throw new Error("expected discovery to be refused")
}

describe("probeMcpServer", () => {
  it("reads the 401 challenge of an unauthenticated initialize", async () => {
    fixture = await startOAuthMcpFixture()
    const probe = await probeMcpServer(fixture.mcpUrl)
    expect(probe.status).toBe(401)
    expect(probe.challenge?.resourceMetadataUrl).toBe(
      `${new URL(fixture.mcpUrl).origin}/.well-known/oauth-protected-resource/mcp`,
    )
    expect(probe.challenge?.scope).toBe("mcp:tools")
  })
})

describe("discoverOAuthContext", () => {
  it("finds PRM at the path-aware location when the challenge names no metadata URL", async () => {
    // The fixture serves PRM ONLY at /.well-known/oauth-protected-resource/mcp
    // (the root 404s), and its challenge carries no resource_metadata.
    fixture = await startOAuthMcpFixture({ challengeWithResourceMetadata: false })
    const probe = await probeMcpServer(fixture.mcpUrl)
    expect(probe.challenge?.resourceMetadataUrl).toBeUndefined()
    const ctx = await discoverOAuthContext(fixture.mcpUrl, { challenge: probe.challenge })
    expect(ctx.legacy).toBe(false)
    expect(ctx.resource).toBe(fixture.mcpUrl)
    expect(ctx.issuer).toBe(fixture.issuer)
    expect(ctx.metadata.token_endpoint).toBe(`${fixture.issuer}/token`)
    expect(ctx.issSupported).toBe(true)
  })

  it("follows the challenge's resource_metadata URL", async () => {
    fixture = await startOAuthMcpFixture()
    const probe = await probeMcpServer(fixture.mcpUrl)
    const ctx = await discoverOAuthContext(fixture.mcpUrl, { challenge: probe.challenge })
    expect(ctx.resourceMetadataUrl).toBe(probe.challenge?.resourceMetadataUrl)
    expect(ctx.challengeScope).toBe("mcp:tools")
    expect(ctx.prmScopes).toEqual(["mcp:tools"])
  })

  it("discovers a path issuer at /.well-known/oauth-authorization-server/<path>", async () => {
    fixture = await startOAuthMcpFixture({ asPath: "/tenant1" })
    const ctx = await discoverOAuthContext(fixture.mcpUrl)
    expect(ctx.issuer).toBe(fixture.issuer)
    expect(ctx.issuer.endsWith("/tenant1")).toBe(true)
  })

  it("refuses PRM whose resource is another server's, naming the URL to use", async () => {
    // The HubSpot eu1 alias: its PRM names https://mcp.hubspot.com.
    fixture = await startOAuthMcpFixture({ prmResourceOverride: "https://mcp.example.com" })
    const err = await discoveryError(discoverOAuthContext(fixture.mcpUrl))
    expect(err.code).toBe("resource_mismatch")
    expect(err.message).toContain("https://mcp.example.com")
    expect(err.message).toContain("Use https://mcp.example.com")
  })

  it("refuses AS metadata whose issuer is not the issuer it was fetched for", async () => {
    fixture = await startOAuthMcpFixture({ issuerOverride: "https://other-issuer.example" })
    const err = await discoveryError(discoverOAuthContext(fixture.mcpUrl))
    expect(err.code).toBe("issuer_mismatch")
  })

  it("refuses an AS that does not advertise code_challenge_methods_supported", async () => {
    fixture = await startOAuthMcpFixture({ codeChallengeMethods: null })
    const err = await discoveryError(discoverOAuthContext(fixture.mcpUrl))
    expect(err.code).toBe("pkce_unsupported")
  })

  it("refuses an AS whose PKCE methods lack S256", async () => {
    fixture = await startOAuthMcpFixture({ codeChallengeMethods: ["plain"] })
    const err = await discoveryError(discoverOAuthContext(fixture.mcpUrl))
    expect(err.code).toBe("pkce_unsupported")
  })

  it("falls back to the server origin as the AS for a server without PRM (pre-2025)", async () => {
    let origin = ""
    const legacy = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          })
        }
        if (path === "/mcp") return new Response("unauthorized", { status: 401 })
        return new Response("not found", { status: 404 })
      },
    })
    origin = `http://127.0.0.1:${legacy.port}`
    try {
      const ctx = await discoverOAuthContext(`${origin}/mcp`)
      expect(ctx.legacy).toBe(true)
      expect(ctx.issuer).toBe(origin)
      // The canonical server URI stands in for the absent PRM resource.
      expect(ctx.resource).toBe(`${origin}/mcp`)
    } finally {
      legacy.stop(true)
    }
  })
})

/**
 * A one-off MCP server + AS on one loopback origin. `routes` answers by path;
 * `/mcp` answers 401 unless a route overrides it. `{origin}` in a JSON body is
 * replaced with the server's origin.
 */
async function withServer(
  routes: Record<string, number | Record<string, unknown>>,
  fn: (origin: string) => Promise<void>,
): Promise<void> {
  let origin = ""
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname
      const route = routes[path]
      if (typeof route === "number") return new Response("status", { status: route })
      if (route) {
        return new Response(JSON.stringify(route).replaceAll("{origin}", origin), {
          headers: { "content-type": "application/json" },
        })
      }
      if (path === "/mcp") return new Response("unauthorized", { status: 401 })
      return new Response("not found", { status: 404 })
    },
  })
  origin = `http://127.0.0.1:${server.port}`
  try {
    await fn(origin)
  } finally {
    server.stop(true)
  }
}

const asMetadata = (issuer: string) => ({
  issuer,
  authorization_endpoint: "{origin}/authorize",
  token_endpoint: "{origin}/token",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
})

describe("discoverOAuthContext: RFC 8414 strictness and the SSRF-safe fetch", () => {
  it("never falls back to the root metadata for an issuer with a path", async () => {
    await withServer(
      {
        "/.well-known/oauth-protected-resource/mcp": {
          resource: "{origin}/mcp",
          authorization_servers: ["{origin}/tenant1"],
        },
        // Only at the root: another tenant's document must not be used.
        "/.well-known/oauth-authorization-server": asMetadata("{origin}/tenant1"),
        "/.well-known/openid-configuration": asMetadata("{origin}/tenant1"),
      },
      async (origin) => {
        const err = await discoveryError(discoverOAuthContext(`${origin}/mcp`))
        expect(err.code).toBe("as_metadata_missing")
      },
    )
  })

  it("compares the issuer exactly (no trailing-slash tolerance) for a PRM-named issuer", async () => {
    await withServer(
      {
        "/.well-known/oauth-protected-resource/mcp": {
          resource: "{origin}/mcp",
          authorization_servers: ["{origin}/as"],
        },
        "/.well-known/oauth-authorization-server/as": asMetadata("{origin}/as/"),
      },
      async (origin) => {
        const err = await discoveryError(discoverOAuthContext(`${origin}/mcp`))
        expect(err.code).toBe("issuer_mismatch")
      },
    )
  })

  it("a PRM 5xx is a discovery failure, not a switch to legacy origin discovery", async () => {
    await withServer(
      {
        "/.well-known/oauth-protected-resource/mcp": 503,
        "/.well-known/oauth-protected-resource": 503,
        "/.well-known/oauth-authorization-server": asMetadata("{origin}"),
      },
      async (origin) => {
        const err = await discoveryError(discoverOAuthContext(`${origin}/mcp`))
        expect(err.code).toBe("discovery_failed")
        expect(err.message).toContain("503")
      },
    )
  })

  it("PRM and AS metadata are fetched through the SSRF-safe outbound fetch", async () => {
    fixture = await startOAuthMcpFixture()
    const seen: string[] = []
    OutboundFetchTestAccess.setFetch((async (input: unknown, init?: RequestInit) => {
      seen.push(String(input))
      return fetch(String(input), { ...init, redirect: "manual" })
    }) as unknown as typeof fetch)
    try {
      const probe = await probeMcpServer(fixture.mcpUrl)
      seen.length = 0
      await discoverOAuthContext(fixture.mcpUrl, { challenge: probe.challenge })
    } finally {
      OutboundFetchTestAccess.setFetch(null)
    }
    const origin = new URL(fixture.mcpUrl).origin
    expect(seen).toContain(`${origin}/.well-known/oauth-protected-resource/mcp`)
    expect(seen.some((u) => u.includes("/.well-known/oauth-authorization-server"))).toBe(true)
  })
})

describe("resourceMatches", () => {
  it("tolerates one trailing slash, nothing else", () => {
    expect(resourceMatches("https://mcp.hubspot.com", "https://mcp.hubspot.com/")).toBe(true)
    expect(resourceMatches("https://mcp.notion.com/mcp", "https://mcp.notion.com/mcp")).toBe(true)
    expect(resourceMatches("https://mcp-eu1.hubspot.com", "https://mcp.hubspot.com")).toBe(false)
    expect(resourceMatches("https://mcp.notion.com/mcp", "https://mcp.notion.com")).toBe(false)
  })
})

describe("selectScope", () => {
  const base = {
    prmScopes: ["a", "b"],
    challengeScope: undefined as string | undefined,
    metadata: { scopes_supported: ["a", "b", "c"] },
  }
  it("prefers the challenge's scope", () => {
    expect(selectScope({ ...base, challengeScope: "c" })).toBe("c")
  })
  it("falls back to PRM scopes_supported", () => {
    expect(selectScope(base)).toBe("a b")
  })
  it("never yields an empty scope", () => {
    expect(selectScope({ ...base, prmScopes: [] })).toBeUndefined()
    expect(selectScope({ ...base, prmScopes: undefined })).toBeUndefined()
  })
  it("drops offline_access unless the AS lists it", () => {
    expect(selectScope({ ...base, challengeScope: "a offline_access" })).toBe("a")
    expect(
      selectScope({
        ...base,
        challengeScope: "a offline_access",
        metadata: { scopes_supported: ["a", "offline_access"] },
      }),
    ).toBe("a offline_access")
  })
  it("unions in scopes asked for earlier (step-up)", () => {
    expect(selectScope({ ...base, challengeScope: "a" }, ["c", "a"])).toBe("a c")
  })
})
