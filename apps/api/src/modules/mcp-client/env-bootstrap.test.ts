// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { _setEdition } from "~/lib/edition"
import { EnvBootstrapError, parseEnvConnections } from "~/modules/mcp-client/env-bootstrap"

afterEach(() => {
  _setEdition(null)
})

describe("parseEnvConnections", () => {
  it("parses an http connection with bearer auth", () => {
    _setEdition("self_hosted")
    const out = parseEnvConnections({
      LIAISON_MCP_LINEAR_TRANSPORT: "http",
      LIAISON_MCP_LINEAR_DISPLAY_NAME: "Linear",
      LIAISON_MCP_LINEAR_ORG: "00000000-0000-0000-0000-0000000000aa",
      LIAISON_MCP_LINEAR_URL: "https://mcp.linear.app",
      LIAISON_MCP_LINEAR_AUTH: "bearer",
      LIAISON_MCP_LINEAR_BEARER_TOKEN: "tk-123",
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      slug: "linear",
      transport: "http",
      displayName: "Linear",
      orgId: "00000000-0000-0000-0000-0000000000aa",
      httpUrl: "https://mcp.linear.app",
      authFlavor: "bearer",
      bearerToken: "tk-123",
      ownershipScope: "org",
      agentVisibility: "discoverable",
      exposeViaGateway: true,
      connectionDefaultPolicy: "gate_writes",
    })
  })

  it("maps INTERNAL_DW group to slug internal-dw", () => {
    _setEdition("self_hosted")
    const out = parseEnvConnections({
      LIAISON_MCP_INTERNAL_DW_TRANSPORT: "http",
      LIAISON_MCP_INTERNAL_DW_DISPLAY_NAME: "Internal DW",
      LIAISON_MCP_INTERNAL_DW_ORG: "00000000-0000-0000-0000-0000000000aa",
      LIAISON_MCP_INTERNAL_DW_URL: "https://dw.local",
      LIAISON_MCP_INTERNAL_DW_AUTH: "none",
    })
    expect(out[0].slug).toBe("internal-dw")
  })

  it("refuses at boot, naming the variable, every declaration of a local-command (stdio) server", () => {
    // The stdio transport was removed: a boot env that still declares one must fail loudly so the
    // operator notices, on every edition, whichever stdio variable is present.
    const base = {
      LIAISON_MCP_FS_DISPLAY_NAME: "FS",
      LIAISON_MCP_FS_ORG: "00000000-0000-0000-0000-0000000000aa",
      LIAISON_MCP_FS_AUTH: "none",
    }
    for (const edition of ["self_hosted", "managed"] as const) {
      _setEdition(edition)
      for (const [extra, varName] of [
        [{ LIAISON_MCP_FS_TRANSPORT: "stdio" }, "LIAISON_MCP_FS_TRANSPORT"],
        [
          {
            LIAISON_MCP_FS_TRANSPORT: "http",
            LIAISON_MCP_FS_URL: "https://fs",
            LIAISON_MCP_FS_STDIO_COMMAND: "/usr/bin/mcp-fs",
          },
          "LIAISON_MCP_FS_STDIO_COMMAND",
        ],
        [
          {
            LIAISON_MCP_FS_TRANSPORT: "http",
            LIAISON_MCP_FS_URL: "https://fs",
            LIAISON_MCP_FS_STDIO_ARGS: '["--root"]',
          },
          "LIAISON_MCP_FS_STDIO_ARGS",
        ],
        [
          {
            LIAISON_MCP_FS_TRANSPORT: "http",
            LIAISON_MCP_FS_URL: "https://fs",
            LIAISON_MCP_FS_STDIO_ENV_HOME: "/srv",
          },
          "LIAISON_MCP_FS_STDIO_ENV_HOME",
        ],
      ] as const) {
        let thrown: unknown
        try {
          parseEnvConnections({ ...base, ...extra })
        } catch (err) {
          thrown = err
        }
        expect(thrown).toBeInstanceOf(EnvBootstrapError)
        expect((thrown as EnvBootstrapError).varName).toBe(varName)
        expect((thrown as Error).message).toContain("no longer supported")
      }
    }
  })

  it("rejects missing required ORG with a structured error pointing at the var", () => {
    _setEdition("self_hosted")
    expect(() =>
      parseEnvConnections({
        LIAISON_MCP_X_TRANSPORT: "http",
        LIAISON_MCP_X_DISPLAY_NAME: "X",
        LIAISON_MCP_X_URL: "https://x",
        LIAISON_MCP_X_AUTH: "none",
        // missing _ORG
      }),
    ).toThrow(/LIAISON_MCP_X_ORG/)
  })

  it("rejects the configuration combo agent_visibility=hidden AND expose_via_gateway=false", () => {
    _setEdition("self_hosted")
    expect(() =>
      parseEnvConnections({
        LIAISON_MCP_X_TRANSPORT: "http",
        LIAISON_MCP_X_DISPLAY_NAME: "X",
        LIAISON_MCP_X_ORG: "00000000-0000-0000-0000-0000000000aa",
        LIAISON_MCP_X_URL: "https://x",
        LIAISON_MCP_X_AUTH: "none",
        LIAISON_MCP_X_AGENT_VISIBILITY: "hidden",
        LIAISON_MCP_X_EXPOSE_VIA_GATEWAY: "false",
      }),
    ).toThrow(/dead|unreachable|both hidden/i)
  })

  it("disambiguates token-vs-suffix when the token itself starts with OAUTH", () => {
    _setEdition("self_hosted")
    const out = parseEnvConnections({
      LIAISON_MCP_OAUTH_FOO_TRANSPORT: "http",
      LIAISON_MCP_OAUTH_FOO_DISPLAY_NAME: "OAuth Foo",
      LIAISON_MCP_OAUTH_FOO_ORG: "00000000-0000-0000-0000-0000000000aa",
      LIAISON_MCP_OAUTH_FOO_URL: "https://oauth-foo",
      LIAISON_MCP_OAUTH_FOO_AUTH: "oauth_static",
      LIAISON_MCP_OAUTH_FOO_OAUTH_CLIENT_ID: "cid",
      LIAISON_MCP_OAUTH_FOO_OAUTH_AUTHORIZATION_URL: "https://oauth-foo/authorize",
      LIAISON_MCP_OAUTH_FOO_OAUTH_TOKEN_URL: "https://oauth-foo/token",
    })
    expect(out).toHaveLength(1)
    expect(out[0].slug).toBe("oauth-foo")
    expect(out[0].oauthClientId).toBe("cid")
    expect(out[0].oauthTokenUrl).toBe("https://oauth-foo/token")
    expect(out[0].oauthAuthorizationUrl).toBe("https://oauth-foo/authorize")
  })

  it("throws on unknown suffix (typo prevention)", () => {
    _setEdition("self_hosted")
    expect(() =>
      parseEnvConnections({
        LIAISON_MCP_LINEAR_TOKEN: "tk", // typo of BEARER_TOKEN
      }),
    ).toThrow(/unknown suffix/)
  })
})
