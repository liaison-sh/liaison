// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-169 #6: prove the mcp-manager agent tools (add_connection, list_connections) actually
// land in the per-org toolRegistry when the app is registered the default way — the chaos
// world reaches them this way, so a mis-registration is what kept tool_search from finding them.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { getDefaultApps, initAppsForOrg } from "~/modules/apps/init"

const ORG = "22222222-2222-2222-2222-222222222222"

describe("mcp-manager app tool registration (BL-169 #6)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'MCP Registration Test', 'mcp-registration-test')
      ON CONFLICT (id) DO NOTHING`
  })
  beforeEach(() => resetAppRegistries())
  afterAll(async () => {
    resetAppRegistries()
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("registers mcp-manager by default with the add_connection + list_connections agent tools", async () => {
    const apps = await getDefaultApps()
    expect(apps.map((a) => a.name)).toContain("mcp-manager")

    await initAppsForOrg(ORG, apps)

    const add = toolRegistry.get([ORG, "mcp-manager", "add_connection"])
    expect(add).toBeDefined()
    // Every member may call it (personal connections, P3-T1); an org-shared
    // connection still needs mcp_manager:connection:write, checked by the service.
    expect(add?.requiredScopes).toEqual(["mcp_manager:personal_connection:write"])
    expect(add?.gated).toBe(true)
    // Agent-facing (direct) — NOT deferLoading. deferLoading is reserved for internal
    // cross-app plumbing tools (e.g. mail.composeForApp); an agent-callable tool must be
    // in the default tool set so the chaos agent can invoke it without a discovery hop.
    expect(add?.deferLoading).toBeFalsy()

    const list = toolRegistry.get([ORG, "mcp-manager", "list_connections"])
    expect(list).toBeDefined()
    expect(list?.requiredScopes).toEqual(["mcp_manager:connection:read"])
    expect(list?.deferLoading).toBeFalsy()
  })
})
