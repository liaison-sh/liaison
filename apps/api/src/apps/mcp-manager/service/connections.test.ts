// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression tests for the mcp-manager AGENT-tool connection service (BL-169 #6).
// Proves: deriveSlug kebabs a display name; createMcpConnection persists an org row with
// the bearer token AES-encrypted (never plaintext) + a derived slug; listMcpConnections
// returns it; an unsafe URL is rejected (SSRF guard); a slug collision is reported, not 500.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { buildMcpWorld, type McpTestWorld } from "../test-helpers/world"
import { createMcpConnection, deriveSlug, listMcpConnections } from "./connections"

describe("deriveSlug", () => {
  it("kebab-cases a display name within the 32-char slug limit", () => {
    expect(deriveSlug("Inventory ERP")).toBe("inventory-erp")
    expect(deriveSlug("  Northwind  ERP!! ")).toBe("northwind-erp")
    expect(deriveSlug("ACME 2026 Stock")).toBe("acme-2026-stock")
  })
  it("falls back to a safe slug for an empty/symbol-only name", () => {
    expect(deriveSlug("")).toBe("mcp-connection")
    expect(deriveSlug("***")).toBe("mcp-connection")
  })
  it("caps the slug at 32 chars with no trailing hyphen", () => {
    const s = deriveSlug("a".repeat(40))
    expect(s.length).toBeLessThanOrEqual(32)
    expect(s.endsWith("-")).toBe(false)
  })
})

describe("createMcpConnection / listMcpConnections (BL-169 #6)", () => {
  let world: McpTestWorld

  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })
  beforeEach(async () => {
    world = await buildMcpWorld()
  })

  it("persists an http+bearer connection with the token encrypted (not plaintext) and lists it", async () => {
    const TOKEN = "erp_live_sk_8f3a2c91_secret"
    const result = await withRlsContext(world.admin, (db) =>
      createMcpConnection({
        tx: db,
        orgId: world.org.id,
        actor: world.admin,
        input: {
          displayName: "Inventory ERP",
          httpUrl: "https://mcp.northwind-erp.example",
          authFlavor: "bearer",
          bearerToken: TOKEN,
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.connection.slug).toBe("inventory-erp")
    expect(result.connection.transport).toBe("http")
    expect(result.connection.authFlavor).toBe("bearer")
    expect(result.connection.httpUrl).toBe("https://mcp.northwind-erp.example")
    expect(result.connection.connectionDefaultPolicy).toBe("gate_writes")
    expect(result.connection.disabled).toBe(false)

    // The bearer token must be stored encrypted — never as plaintext.
    const persisted = await withRlsContext(world.admin, (db) =>
      listMcpConnections({ tx: db, orgId: world.org.id }),
    )
    const row = persisted.find((c) => c.slug === "inventory-erp")
    expect(row).toBeDefined()
    expect(row?.displayName).toBe("Inventory ERP")

    const { mcpConnections } = await import("~/db/schema/app_mcp_manager")
    const { eq } = await import("drizzle-orm")
    const raw = await withRlsContext(world.admin, (db) =>
      db
        .select({ secret: mcpConnections.secretsEncrypted })
        .from(mcpConnections)
        .where(eq(mcpConnections.id, result.connection.id)),
    )
    expect(raw[0]?.secret).toBeTruthy()
    expect(raw[0]?.secret).not.toContain(TOKEN)
  })

  it("stores no secret blob for authFlavor none", async () => {
    const result = await withRlsContext(world.admin, (db) =>
      createMcpConnection({
        tx: db,
        orgId: world.org.id,
        actor: world.admin,
        input: {
          displayName: "Public MCP",
          httpUrl: "https://mcp.public-tools.example",
          authFlavor: "none",
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { mcpConnections } = await import("~/db/schema/app_mcp_manager")
    const { eq } = await import("drizzle-orm")
    const raw = await withRlsContext(world.admin, (db) =>
      db
        .select({ secret: mcpConnections.secretsEncrypted })
        .from(mcpConnections)
        .where(eq(mcpConnections.id, result.connection.id)),
    )
    expect(raw[0]?.secret).toBeNull()
  })

  it("rejects an unsafe / non-http(s) URL without inserting a row", async () => {
    const result = await withRlsContext(world.admin, (db) =>
      createMcpConnection({
        tx: db,
        orgId: world.org.id,
        actor: world.admin,
        input: { displayName: "Bad ERP", httpUrl: "file:///etc/passwd", authFlavor: "none" },
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("unsafe_url")
    const after = await withRlsContext(world.admin, (db) =>
      listMcpConnections({ tx: db, orgId: world.org.id }),
    )
    expect(after.find((c) => c.displayName === "Bad ERP")).toBeUndefined()
  })

  it("reports a slug collision cleanly (not a 500) when the derived slug already exists", async () => {
    const mk = () =>
      withRlsContext(world.admin, (db) =>
        createMcpConnection({
          tx: db,
          orgId: world.org.id,
          actor: world.admin,
          input: {
            displayName: "Inventory ERP",
            httpUrl: "https://mcp.northwind-erp.example",
            authFlavor: "none",
          },
        }),
      )
    const first = await mk()
    expect(first.ok).toBe(true)
    const second = await mk()
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.code).toBe("slug_exists")
  })
})
