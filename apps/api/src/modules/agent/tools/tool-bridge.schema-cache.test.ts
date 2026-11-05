// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool's provider-facing input schema is built once per registration, not
// on every turn: building a tool set converted every manifest tool's JSON
// Schema to Zod and projected it back, a few hundred tools a turn.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { ActorContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import { forgetOrgApps, rememberOrgAppStates } from "~/modules/apps/org-apps"
import { buildToolSet } from "./tool-bridge"

const ORG_ID = "11111111-1111-1111-1111-aaaaaaaa0c71"

const ADMIN: ActorContext = {
  actorType: "user",
  userId: "22222222-2222-2222-2222-bbbbbbbb0c71",
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

function plant(tool: string, params: unknown) {
  toolRegistry.set([ORG_ID, "kernel", tool], {
    appName: "kernel",
    name: tool,
    description: tool,
    requiredScopes: ["kernel:threads:read"],
    deferLoading: false,
    params,
    handler: async () => ({ ok: true }),
  } as unknown as Parameters<typeof toolRegistry.set>[1])
}

const manifestParams = () => ({
  type: "object",
  properties: {
    query: { type: "string", description: "what to look for" },
    pair: { type: "array", items: [{ type: "string" }, { type: "number" }] },
  },
  required: ["query"],
})

describe("tool set: provider input schemas", () => {
  beforeEach(() => rememberOrgAppStates(ORG_ID, []))
  afterEach(() => {
    toolRegistry.deleteByPrefix([ORG_ID])
    forgetOrgApps(ORG_ID)
  })

  it("two turns reuse one registration's schema; a re-registration gets its own", () => {
    plant("cache_probe", manifestParams())
    const first = buildToolSet(ORG_ID, ADMIN)
    const second = buildToolSet(ORG_ID, ADMIN)
    const name = Object.keys(first).find((n) => n.includes("cache_probe"))
    expect(name).toBeDefined()
    expect(second[name!].inputSchema).toBe(first[name!].inputSchema)

    plant("cache_probe", manifestParams())
    const third = buildToolSet(ORG_ID, ADMIN)
    expect(third[name!].inputSchema).not.toBe(first[name!].inputSchema)
    // The same params object again reads the same schema.
    expect(buildToolSet(ORG_ID, ADMIN)[name!].inputSchema).toBe(third[name!].inputSchema)
  })
})
