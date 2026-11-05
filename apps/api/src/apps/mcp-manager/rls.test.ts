// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { withRlsContext } from "~/db/rls"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { buildMcpWorld, type McpTestWorld } from "./test-helpers/world"

describe("mcp_connections RLS", () => {
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

  it("personal connection invisible to non-owner in same org", async () => {
    // Alice has the editor role which grants mcp_manager:connection:read
    // AND :write — per spec §3.4 personal-INSERT requires :write (the row
    // is still personal-scoped, so other users can't see it).
    await withRlsContext(world.alice, async (db) => {
      await db.insert(mcpConnections).values({
        orgId: world.org.id,
        slug: "alice-linear",
        displayName: "Alice's Linear",
        transport: "http",
        httpUrl: "https://mcp.linear.app",
        ownershipScope: "personal",
        ownerUserId: world.alice.userId,
        authFlavor: "none",
        createdBy: world.alice.userId,
      })
    })
    // Give bob a read scope so the RLS predicate's ownership branch (not the
    // scope branch) is what gates the read.
    const bobReader = { ...world.bob, scopes: ["mcp_manager:connection:read"] }
    const bobRows = await withRlsContext(bobReader, (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.slug, "alice-linear")),
    )
    expect(bobRows).toHaveLength(0)
  })

  it("org-shared connection visible to every org member with read scope", async () => {
    await withRlsContext(world.admin, async (db) => {
      await db.insert(mcpConnections).values({
        orgId: world.org.id,
        slug: "shared-jira",
        displayName: "Acme Jira",
        transport: "http",
        httpUrl: "https://mcp.atlassian.com",
        ownershipScope: "org",
        ownerUserId: null,
        authFlavor: "none",
        createdBy: world.admin.userId,
      })
    })
    const bobReader = { ...world.bob, scopes: ["mcp_manager:connection:read"] }
    const bobRows = await withRlsContext(bobReader, (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.slug, "shared-jira")),
    )
    expect(bobRows).toHaveLength(1)
  })

  it("rejects org-shared INSERT without mcp_manager:connection:write scope", async () => {
    const bobReader = { ...world.bob, scopes: ["mcp_manager:connection:read"] }
    let err: unknown
    try {
      await withRlsContext(bobReader, (db) =>
        db.insert(mcpConnections).values({
          orgId: world.org.id,
          slug: "bobby",
          displayName: "bobby",
          transport: "http",
          httpUrl: "https://x.example",
          ownershipScope: "org",
          ownerUserId: null,
          authFlavor: "none",
          createdBy: bobReader.userId,
        }),
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause
    // 42501 = insufficient privilege (RLS); message includes "row-level security"
    expect(cause?.code === "42501" || /row-level security/.test(cause?.message ?? "")).toBe(true)
  })

  it("the member-wide personal scope inserts a personal row but never an org row (P3-T1)", async () => {
    const member = {
      ...world.bob,
      scopes: ["mcp_manager:connection:read", "mcp_manager:personal_connection:write"],
    }
    const row = (slug: string, ownershipScope: "org" | "personal") => ({
      orgId: world.org.id,
      slug,
      displayName: slug,
      transport: "http" as const,
      httpUrl: "https://x.example",
      ownershipScope,
      ownerUserId: ownershipScope === "personal" ? member.userId : null,
      authFlavor: "none" as const,
      createdBy: member.userId,
    })
    await withRlsContext(member, (db) =>
      db.insert(mcpConnections).values(row("bob-personal", "personal")),
    )
    const mine = await withRlsContext(member, (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.slug, "bob-personal")),
    )
    expect(mine).toHaveLength(1)

    let err: unknown
    try {
      await withRlsContext(member, (db) => db.insert(mcpConnections).values(row("bob-org", "org")))
    } catch (e) {
      err = e
    }
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause
    expect(cause?.code === "42501" || /row-level security/.test(cause?.message ?? "")).toBe(true)
  })

  it("cross-org read is blocked (otherAdmin cannot see orgA rows)", async () => {
    await withRlsContext(world.admin, async (db) => {
      await db.insert(mcpConnections).values({
        orgId: world.org.id,
        slug: "secret-orga",
        displayName: "orgA-only",
        transport: "http",
        httpUrl: "https://x.example",
        ownershipScope: "org",
        ownerUserId: null,
        authFlavor: "none",
        createdBy: world.admin.userId,
      })
    })
    const otherRows = await withRlsContext(world.otherAdmin, (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.slug, "secret-orga")),
    )
    expect(otherRows).toHaveLength(0)
  })
})
