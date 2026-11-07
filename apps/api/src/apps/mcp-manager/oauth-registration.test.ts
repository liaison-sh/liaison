// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Client registration for an MCP server's AS: pre-registered > Client ID
// Metadata Document > Dynamic Client Registration > ask for client fields.
import { afterEach, describe, expect, it } from "bun:test"
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js"
import { env } from "~/lib/env"
import {
  type OAuthFixtureHandle,
  startOAuthMcpFixture,
} from "~/modules/mcp-client/transports/fixtures/oauth-mcp-server"
import { discoverOAuthContext } from "./oauth-discovery"
import {
  callbackUrl,
  chooseClient,
  cimdDocumentUrl,
  clientMetadataDocument,
  dcrClientMetadata,
  OAuthRegistrationError,
  OAuthRegistrationTestAccess,
} from "./oauth-registration"

let fixture: OAuthFixtureHandle | null = null
/** The public base a test stands in (as the routes' mcpOAuthBaseUrl would answer). */
let pub: string | null = null
function setPub(url: string | null): void {
  pub = url
  OAuthRegistrationTestAccess.setPublicBaseUrl(url)
}
const base = () => (pub ?? env.BASE_URL).replace(/\/$/, "")
afterEach(async () => {
  await fixture?.close()
  fixture = null
  setPub(null)
})

function asMeta(over: Partial<AuthorizationServerMetadata> = {}): AuthorizationServerMetadata {
  return {
    issuer: "https://as.example",
    authorization_endpoint: "https://as.example/authorize",
    token_endpoint: "https://as.example/token",
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    ...over,
  }
}

describe("chooseClient priority", () => {
  it("uses the pre-registered client id and secret, never registering", async () => {
    fixture = await startOAuthMcpFixture({ cimd: true })
    setPub("https://liaison.example")
    const ctx = await discoverOAuthContext(fixture.mcpUrl)
    const chosen = await chooseClient({
      base: base(),
      authFlavor: "oauth_static",
      existing: { clientId: "pre-1", clientSecret: "s3cret" },
      ctx,
    })
    expect(chosen).toMatchObject({
      clientId: "pre-1",
      clientSecret: "s3cret",
      source: "preregistered",
    })
    expect(fixture.stats.registerCalls).toBe(0)
  })

  it("prefers a Client ID Metadata Document over DCR when the AS supports it", async () => {
    fixture = await startOAuthMcpFixture({ cimd: true, registration: true })
    setPub("https://liaison.example")
    const ctx = await discoverOAuthContext(fixture.mcpUrl)
    const chosen = await chooseClient({ base: base(), authFlavor: "oauth_dcr", existing: {}, ctx })
    expect(chosen.source).toBe("cimd")
    expect(chosen.clientId).toBe(
      "https://liaison.example/api/apps/mcp-manager/oauth/client-metadata.json",
    )
    expect(chosen.tokenEndpointAuthMethod).toBe("none")
    expect(fixture.stats.registerCalls).toBe(0)
  })

  it("registers dynamically when there is no CIMD (localhost BASE_URL)", async () => {
    fixture = await startOAuthMcpFixture({ cimd: true, registration: true })
    const ctx = await discoverOAuthContext(fixture.mcpUrl)
    const chosen = await chooseClient({ base: base(), authFlavor: "oauth_dcr", existing: {}, ctx })
    expect(chosen.source).toBe("dcr")
    expect(chosen.clientId.startsWith("dcr-")).toBe(true)
    expect(fixture.stats.registerCalls).toBe(1)
  })

  it("reuses a DCR client registered with the same issuer", async () => {
    fixture = await startOAuthMcpFixture()
    const ctx = await discoverOAuthContext(fixture.mcpUrl)
    const chosen = await chooseClient({
      base: base(),
      authFlavor: "oauth_dcr",
      existing: { clientId: "dcr-earlier", clientIdSource: "dcr", clientIssuer: ctx.issuer },
      ctx,
    })
    expect(chosen.clientId).toBe("dcr-earlier")
    expect(fixture.stats.registerCalls).toBe(0)
  })

  it("re-registers when the stored DCR client belongs to another issuer", async () => {
    fixture = await startOAuthMcpFixture()
    const ctx = await discoverOAuthContext(fixture.mcpUrl)
    const chosen = await chooseClient({
      base: base(),
      authFlavor: "oauth_dcr",
      existing: {
        clientId: "dcr-elsewhere",
        clientIdSource: "dcr",
        clientIssuer: "https://x.example",
      },
      ctx,
    })
    expect(chosen.clientId).not.toBe("dcr-elsewhere")
    expect(fixture.stats.registerCalls).toBe(1)
  })

  it("asks for client fields when the AS offers neither CIMD nor DCR", async () => {
    fixture = await startOAuthMcpFixture({ registration: false, cimd: false })
    const ctx = await discoverOAuthContext(fixture.mcpUrl)
    let caught: unknown
    try {
      await chooseClient({ base: base(), authFlavor: "oauth_dcr", existing: {}, ctx })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OAuthRegistrationError)
    expect((caught as OAuthRegistrationError).code).toBe("client_registration_required")
    expect((caught as Error).message).toContain(callbackUrl(base()))
  })
})

describe("Client ID Metadata Document", () => {
  it("is not offered for a non-public BASE_URL", () => {
    expect(env.BASE_URL.startsWith("https://")).toBe(false)
    expect(cimdDocumentUrl(base())).toBeNull()
  })

  it("names itself as client_id and lists the exact callback", () => {
    setPub("https://liaison.example")
    const url = cimdDocumentUrl(base())
    expect(url).toBe("https://liaison.example/api/apps/mcp-manager/oauth/client-metadata.json")
    const doc = clientMetadataDocument(base())
    expect(doc.client_id).toBe(url)
    expect(doc.redirect_uris).toEqual([
      "https://liaison.example/api/apps/mcp-manager/oauth/callback",
    ])
    expect(doc.grant_types).toEqual(["authorization_code", "refresh_token"])
    expect(doc.response_types).toEqual(["code"])
    expect(doc.token_endpoint_auth_method).toBe("none")
    expect(doc.application_type).toBe("web")
    expect(typeof doc.client_name).toBe("string")
  })
})

describe("DCR request body", () => {
  it("declares grant types, response types and a native application for a localhost callback", () => {
    const body = dcrClientMetadata(
      asMeta({ token_endpoint_auth_methods_supported: ["none"] }),
      base(),
    )
    expect(body.redirect_uris).toEqual([callbackUrl(base())])
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"])
    expect(body.response_types).toEqual(["code"])
    expect(body.application_type).toBe("native")
    expect(body.token_endpoint_auth_method).toBe("none")
  })

  it("picks a secret-bearing method when the AS does not accept public clients", () => {
    expect(
      dcrClientMetadata(
        asMeta({ token_endpoint_auth_methods_supported: ["client_secret_post"] }),
        base(),
      ).token_endpoint_auth_method,
    ).toBe("client_secret_post")
    expect(
      dcrClientMetadata(
        asMeta({
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        }),
        base(),
      ).token_endpoint_auth_method,
    ).toBe("client_secret_basic")
  })

  it("leaves the method to the AS default when the AS lists none", () => {
    expect(dcrClientMetadata(asMeta(), base()).token_endpoint_auth_method).toBeUndefined()
  })
})
