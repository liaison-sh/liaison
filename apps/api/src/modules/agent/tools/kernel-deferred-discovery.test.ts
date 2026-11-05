// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Deferred KERNEL tools are reached through tool_search, like an app's. An
// admin asked the agent to "turn Social off" and it answered that it lacked
// the admin tools, without a single call: tool_search's own description said
// "Kernel tools are always loaded and never need searching", while
// apps_set_enabled (and every other app-management tool) is deferred. These
// pin the two halves: no text the model reads may claim kernel tools need no
// search while one is deferred, and a plain request finds the tool.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { sql } from "~/db"
import { buildDeferredToolsAnnouncement } from "~/modules/agent/context/context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { isDeferredTool, listDeferredTools } from "~/modules/agent/tools/tool-bridge"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { orgSetupStamp } from "~/modules/apps/setup-stamp"

const ORG_ID = "00000000-0000-0000-0000-000000db0d15"
const USER_ID = "00000000-0000-0000-0000-000000db0d16"
const ADMIN_SCOPES = ["kernel:threads:read", "kernel:apps:admin", "social:posts:read"]
const MEMBER_SCOPES = ["kernel:threads:read", "social:posts:read"]

/** Any sentence telling the model kernel tools are loaded up front / never searched. */
const NO_SEARCH_CLAIM = /kernel tools?[^.]*(always loaded|never (need|needs|require)[^.]*search)/i

function freshFrame() {
  return {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    discoveredTools: new Set<string>(),
  }
}

async function search(query: string, scopes: string[]) {
  const frame = freshFrame()
  const res = await runContextStore.run(frame, () =>
    handleToolSearch({ query }, { orgId: ORG_ID, userId: USER_ID, scopes }),
  )
  return { res, loaded: frame.discoveredTools }
}

describe("deferred kernel tools are discoverable", () => {
  beforeAll(async () => {
    // This fixed org keeps its row across runs while afterAll deletes its roles:
    // registration must re-seed them, so its setup stamp never matches.
    orgSetupStamp.enabled = false
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'KernelDeferOrg', 'kernel-defer-org') ON CONFLICT (id) DO NOTHING`
    await ensureAppsForOrg(ORG_ID)
    const { registerKernelAgentTools } = await import("./kernel-tools")
    await registerKernelAgentTools(ORG_ID)
    // The org runs a Social app (its tools are what "social" also scores).
    toolRegistry.set([ORG_ID, "social", "posts_list"], {
      appName: "social",
      name: "posts_list",
      description: "List the social posts published or scheduled on the connected pages.",
      requiredScopes: ["social:posts:read"],
      deferLoading: true,
      params: z.object({}),
      handler: async () => ({ ok: true }),
    } as never)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG_ID])
    skillRegistry.deleteByPrefix([ORG_ID])
    agentInstructionsRegistry.deleteByPrefix([ORG_ID])
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${ORG_ID})`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
    orgSetupStamp.enabled = true
  })

  it("no tool_search or catalog text claims kernel tools never need searching while one is deferred", () => {
    const deferredKernel = [...toolRegistry.entries()]
      .filter(([key]) => key[0] === ORG_ID && key[1] === "kernel")
      .filter(([key, def]) => isDeferredTool(key[1], def as { deferLoading?: boolean }))
      .map(([key]) => key[2])
    expect(deferredKernel).toContain("apps_set_enabled")

    const toolSearch = toolRegistry.get([ORG_ID, "kernel", "tool_search"])
    expect(toolSearch?.description ?? "").not.toMatch(NO_SEARCH_CLAIM)

    const announcement = buildDeferredToolsAnnouncement(
      listDeferredTools(ORG_ID, {
        actorType: "user",
        userId: USER_ID,
        orgId: ORG_ID,
        scopes: ADMIN_SCOPES,
        dimensionGrants: {},
      } as never),
    )
    expect(announcement).not.toMatch(NO_SEARCH_CLAIM)
    // The catalog the admin's turn is shown names the app-management tools.
    expect(announcement).toMatch(/^- kernel: .*\bapps_set_enabled\b/m)
    expect(announcement).toMatch(/^- kernel: .*\bapps_set_access\b/m)
  })

  it("'turn the social app off' loads apps_set_enabled for an admin, and never for a member", async () => {
    const admin = await search("turn the social app off", ADMIN_SCOPES)
    expect(admin.res.fellBackToCatalog).toBeUndefined()
    expect(admin.res.matches[0]?.name).toBe("kernel__apps_set_enabled")
    expect(admin.loaded.has("kernel__apps_set_enabled")).toBe(true)

    // A member lacks kernel:apps:admin: the tool may be named as locked (so the
    // agent can say which access is missing) but is never loaded.
    const member = await search("turn the social app off", MEMBER_SCOPES)
    expect(member.loaded.has("kernel__apps_set_enabled")).toBe(false)
    for (const m of member.res.matches.filter((m) => m.name === "kernel__apps_set_enabled")) {
      expect(m.locked).toBe(true)
    }
  })

  it("plain phrasings reach apps_set_enabled and apps_set_access for an admin", async () => {
    for (const [query, tool] of [
      ["disable app", "kernel__apps_set_enabled"],
      ["turn app off", "kernel__apps_set_enabled"],
      ["restrict app access", "kernel__apps_set_access"],
    ] as const) {
      const { res, loaded } = await search(query, ADMIN_SCOPES)
      expect(res.matches[0]?.name, query).toBe(tool)
      expect(loaded.has(tool), query).toBe(true)
    }
  })
})
