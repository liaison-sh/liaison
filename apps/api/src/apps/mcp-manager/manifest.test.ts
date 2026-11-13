// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { Ajv } from "ajv"
import { UnsafeOutboundUrlError, validateOutboundUrlNoDns } from "~/lib/outbound-fetch"
import manifest from "./app.manifest.json"
import { mcpManagerAppManifest } from "./manifest-descriptor"
import * as summarizers from "./summarizers"

describe("mcp-manager manifest", () => {
  it("declares the seven required scopes through its roles map", () => {
    const declaredScopes = new Set(
      Object.values((manifest as any).roles ?? {}).flatMap(
        (r: any) => (r.scopes ?? []) as string[],
      ),
    )
    for (const s of [
      "mcp_manager:connection:read",
      "mcp_manager:connection:write",
      "mcp_manager:connection:admin",
      "mcp_manager:policy:read",
      "mcp_manager:policy:write",
      "mcp_manager:audit:read",
      "mcp_manager:usage:read",
    ]) {
      expect(declaredScopes.has(s)).toBe(true)
    }
  })

  it("is a core app with a stable name (the registry decides, not the manifest)", () => {
    expect("trusted" in manifest).toBe(false)
    expect(manifest.name).toBe("mcp-manager")
  })

  it("is version 1.2.3 (1.2.1: the kernel member preset gets the member tier on first install; 1.2.2: remote servers only, no local-command transport; 1.2.3: every member holds the personal-connection scopes, whatever their roles)", () => {
    expect(manifest.version).toBe("1.2.7")
    expect((manifest as any).tools.add_connection.preflight).toBe("addConnectionPreflight")
    expect((manifest as any).memberPresetScopes).toEqual([
      "mcp_manager:connection:read",
      "mcp_manager:personal_connection:write",
    ])
    // Exactly the read + own-personal-write pair: never an org write, policy or admin scope.
    expect((manifest as any).everyMemberScopes).toEqual([
      "mcp_manager:connection:read",
      "mcp_manager:personal_connection:write",
    ])
  })

  it("gives every member the personal-connection scope, and editors keep org writes", () => {
    const roles = (manifest as any).roles
    expect(roles.member.extends).toBe("viewer")
    expect(roles.member.scopes).toEqual(["mcp_manager:personal_connection:write"])
    expect(roles.member.scopes).not.toContain("mcp_manager:connection:write")
    expect(roles.editor.extends).toBe("member")
    expect(roles.editor.scopes).toContain("mcp_manager:connection:write")
  })

  it("manifest-descriptor adds the runtime decoration", () => {
    expect(mcpManagerAppManifest._format).toBe("manifest")
    expect(mcpManagerAppManifest.name).toBe("mcp-manager")
    expect(mcpManagerAppManifest._bundlePath).toMatch(/handlers\.ts$/)
  })

  it("declares no entity-table schema (uses raw pgSchema)", () => {
    expect((manifest as any).schema).toBeUndefined()
  })

  it("exposes the agent connection tools: add_connection (gated) + list_connections (BL-169 #6)", () => {
    const tools = (manifest as any).tools ?? {}
    const add = tools.add_connection
    expect(add).toBeDefined()
    expect(add.handler).toBe("addConnection")
    expect(add.gated).toBe(true)
    expect(add.requiredScopes).toEqual(["mcp_manager:personal_connection:write"])
    // A personal connection's approval goes to its owner, the requester (P3-T1).
    expect(add.resourceOwner).toEqual({
      requester: { param: "ownershipScope", equals: "personal" },
    })
    expect(add.params?.properties?.ownershipScope?.enum).toEqual(["org", "personal"])
    // gated tools must advertise a summarizer that resolves to a real export
    expect(add.summarizer).toBeDefined()
    expect(typeof (summarizers as Record<string, unknown>)[add.summarizer]).toBe("function")
    // params surface (opaque-param guard) — displayName + httpUrl required, bearerToken declared
    expect(add.params?.required).toContain("displayName")
    expect(add.params?.required).toContain("httpUrl")
    expect(add.params?.properties?.bearerToken).toBeDefined()

    const list = tools.list_connections
    expect(list).toBeDefined()
    expect(list.handler).toBe("listConnections")
    expect(list.gated ?? false).toBe(false)
    expect(list.requiredScopes).toEqual(["mcp_manager:connection:read"])
  })

  it("declares every connection/policy event the routes emit (entity:action format)", () => {
    // The manifest validator regex requires two-segment entity:action.
    // Routes emit with `app: "mcp_manager"` separately — the manifest
    // entries describe entity-level event topics, not full app:entity:action.
    const emits = (manifest.events?.emits ?? []) as string[]
    for (const e of [
      "connection:created",
      "connection:updated",
      "connection:deleted",
      "connection:disabled",
      "connection:enabled",
      "connection:oauth_completed",
      "connection:oauth_callback_rejected",
      "connection:needs_reauth",
      "policy:updated",
    ]) {
      expect(emits).toContain(e)
    }
  })

  it("every gated tool declares a summarizer that resolves to a real ./summarizers export", () => {
    const tools = (manifest as any).tools as Record<
      string,
      { gated?: boolean; summarizer?: string }
    >
    const gated = Object.entries(tools).filter(([, t]) => t.gated === true)
    expect(gated.length).toBeGreaterThan(0)
    for (const [name, tool] of gated) {
      expect(tool.summarizer, `${name} is gated but declares no summarizer`).toBeDefined()
      const fn = (summarizers as Record<string, unknown>)[tool.summarizer as string]
      expect(typeof fn, `${name}'s summarizer "${tool.summarizer}" is not exported`).toBe(
        "function",
      )
    }
  })
})

// add_connection is GATED, so a URL the SSRF guard will reject used to park a pending approval and only
// fail with `unsafe_url` once a human clicked approve: an error only the agent could have fixed. The
// httpUrl pattern in the manifest params schema moves that refusal to staging, because param validation
// runs BEFORE the approval is created. Read-only, purely static: no DB and no network.
describe("mcp-manager add_connection description", () => {
  it("fits in 240 characters and sends a REST API with a key to the adapter save", () => {
    const description = manifest.tools.add_connection.description
    expect(description.length).toBeLessThanOrEqual(240)
    expect(description).toContain("api-connector__connector_adapter_save")
  })
})

describe("mcp-manager add_connection httpUrl schema (stage-time refusal)", () => {
  const validate = new Ajv({ strict: false }).compile((manifest as any).tools.add_connection.params)
  const call = (httpUrl: string) => validate({ displayName: "ERP", httpUrl })

  const REFUSED = [
    "http://mcp.example.com/mcp",
    "https://localhost:3000/mcp",
    "https://127.0.0.1/mcp",
    "https://10.0.0.5/mcp",
    "https://192.168.1.10:8080/mcp",
    "https://172.16.4.2/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]:9000/mcp",
    "ftp://mcp.example.com",
  ]
  const ALLOWED = [
    "https://mcp.northwind-erp.example",
    "https://mcp.linear.app/sse",
    "https://mcp.example.com:8443/mcp",
    "https://10-4.example.com/mcp",
  ]

  it("refuses non-HTTPS and private/loopback targets at param validation, before any approval", () => {
    for (const url of REFUSED) {
      expect(call(url), `${url} must be refused at staging`).toBe(false)
    }
  })

  it("still accepts a genuine public https endpoint", () => {
    for (const url of ALLOWED) {
      expect(call(url), `${url} must still be accepted`).toBe(true)
    }
  })

  it("never refuses a URL the handler SSRF guard would have accepted", () => {
    // The schema must stay a strict SUBSET of the authoritative guard in
    // service/connections.ts, so it can only refuse earlier, never differently.
    for (const url of [...REFUSED, ...ALLOWED]) {
      if (call(url)) continue
      let guardRejected = false
      try {
        validateOutboundUrlNoDns(url)
      } catch (err) {
        guardRejected = err instanceof UnsafeOutboundUrlError || err instanceof TypeError
      }
      expect(guardRejected, `${url} is refused by the schema but allowed by the guard`).toBe(true)
    }
  })
})
