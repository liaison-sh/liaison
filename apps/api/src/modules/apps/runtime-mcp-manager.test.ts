// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Runtime test for Task 33: confirms the mcp-manager app is discovered via
// discoverInTreeApps + ensureAppsForOrg, and that its manifest scopes are
// registered. No connections are seeded, so the toolRegistry must not yet
// contain any `mcp:*` entries.
import { afterEach, describe, expect, it } from "bun:test"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createTestOrg } from "~/tests/helpers/org"

describe("Task 33 — mcp-manager runtime discovery", () => {
  let orgId: string

  afterEach(() => {
    // Don't clobber the registry — other suites share it.
  })

  it("ensureAppsForOrg registers mcp-manager (manifest auto-discovered)", async () => {
    const org = await createTestOrg()
    orgId = org.id
    await ensureAppsForOrg(orgId)

    // The manifest registry should contain an entry for this org's mcp-manager.
    const entry = manifestRegistry.get([orgId, "mcp-manager"])
    expect(entry).toBeDefined()
    expect(entry?.name).toBe("mcp-manager")
    // Roles should be present and flatten to the manager scopes.
    const allScopes = new Set<string>()
    const roles = (entry?.roles ?? {}) as Record<string, { scopes?: string[] }>
    for (const r of Object.values(roles)) {
      for (const s of r.scopes ?? []) allScopes.add(s)
    }
    expect(allScopes.has("mcp_manager:connection:read")).toBe(true)
    expect(allScopes.has("mcp_manager:connection:write")).toBe(true)
    expect(allScopes.has("mcp_manager:policy:write")).toBe(true)
  })

  it("no `mcp:*` tool registry entries exist at boot (no connections seeded)", async () => {
    const org = await createTestOrg()
    await ensureAppsForOrg(org.id)
    const orgMcpTools: unknown[] = []
    for (const [key, value] of toolRegistry.entries()) {
      const [keyOrg, keyApp] = key as unknown as [string, string]
      if (keyOrg === org.id && typeof keyApp === "string" && keyApp.startsWith("mcp:")) {
        orgMcpTools.push(value)
      }
    }
    expect(orgMcpTools).toEqual([])
  })
})
