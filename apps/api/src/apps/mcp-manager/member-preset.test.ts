// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A new org's kernel `member` preset carries mcp_manager:personal_connection:write
// once mcp-manager is installed (S16, A31, A56). The kernel DEFAULT_ROLES stay
// kernel-only: the grant comes from the app's registration (`memberPresetScopes`),
// on its FIRST install in the org only, so an admin's later removal survives a
// reboot. Existing orgs got it from migration 0133.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { validateAppManifest } from "~/modules/apps/contract"
import { registerApps } from "~/modules/apps/runtime"
import { DEFAULT_ROLES, seedDefaultRoles } from "~/modules/permissions/default-roles"
import manifest from "./app.manifest.json"
import { mcpManagerAppManifest } from "./manifest-descriptor"

const WITH_APP = "00000000-0000-0000-0000-0000000f7a01"
const WITHOUT_APP = "00000000-0000-0000-0000-0000000f7a02"
const SCOPE = "mcp_manager:personal_connection:write"

async function memberPresetScopes(orgId: string): Promise<string[]> {
  const rows = await sql<{ scope: string }[]>`
    SELECT g.scope FROM kernel.role_scope_grants g
    JOIN kernel.roles r ON r.id = g.role_id
    WHERE r.org_id = ${orgId} AND r.name = 'member'
    ORDER BY g.scope`
  return rows.map((r) => r.scope)
}

describe("kernel member preset gains the personal-connection scope when mcp-manager is installed", () => {
  beforeAll(async () => {
    for (const [id, slug] of [
      [WITH_APP, "fix7-member-preset-with"],
      [WITHOUT_APP, "fix7-member-preset-without"],
    ]) {
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${id}, ${slug}, ${slug}) ON CONFLICT (id) DO NOTHING`
      await withSystemDb("fix7-default-roles", (tx) => seedDefaultRoles(tx, id))
    }
  })
  beforeEach(() => resetAppRegistries())
  afterAll(async () => {
    resetAppRegistries()
    for (const org of [WITH_APP, WITHOUT_APP]) {
      await sql`DELETE FROM kernel.pending_events WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN
        (SELECT id FROM kernel.roles WHERE org_id = ${org})`
      await sql`DELETE FROM kernel.roles WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.apps WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
    }
  })

  it("DEFAULT_ROLES stay kernel-only: the member preset is not seeded with the app scope", async () => {
    expect(DEFAULT_ROLES.find((r) => r.name === "member")?.scopes).not.toContain(SCOPE)
    expect(await memberPresetScopes(WITHOUT_APP)).not.toContain(SCOPE)
  })

  it("a new org with mcp-manager installed has the scope on its kernel member preset", async () => {
    await registerApps([mcpManagerAppManifest as any], WITH_APP)
    expect(await memberPresetScopes(WITH_APP)).toContain(SCOPE)
    // Only the member preset: viewer stays read-only.
    const viewer = await sql<{ scope: string }[]>`
      SELECT g.scope FROM kernel.role_scope_grants g JOIN kernel.roles r ON r.id = g.role_id
      WHERE r.org_id = ${WITH_APP} AND r.name = 'viewer'`
    expect(viewer.map((r) => r.scope)).not.toContain(SCOPE)
  })

  it("a new org without mcp-manager does not get it", async () => {
    expect(await memberPresetScopes(WITHOUT_APP)).not.toContain(SCOPE)
  })

  it("an admin's later removal is not undone by a reboot", async () => {
    await sql`DELETE FROM kernel.role_scope_grants WHERE scope = ${SCOPE} AND role_id =
      (SELECT id FROM kernel.roles WHERE org_id = ${WITH_APP} AND name = 'member')`
    expect(await memberPresetScopes(WITH_APP)).not.toContain(SCOPE)
    // A reboot: in-memory registrations are gone, the app registers again.
    resetAppRegistries()
    await registerApps([mcpManagerAppManifest as any], WITH_APP)
    expect(await memberPresetScopes(WITH_APP)).not.toContain(SCOPE)
  })

  it("the manifest may only hand the preset scopes of its own member tier", () => {
    expect(validateAppManifest(manifest).success).toBe(true)
    const widened = { ...manifest, memberPresetScopes: ["mcp_manager:connection:write"] }
    const res = validateAppManifest(widened)
    expect(res.success).toBe(false)
    expect((res as any).error).toContain("memberPresetScopes")
  })
})
