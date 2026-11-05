// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T25 — `gatewayHidden` filter on `buildToolSet({audience: "gateway"})`.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { z } from "zod"
import type { ActorContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import {
  ALL_DEFERRED_TOOLS_UNLOCKED,
  buildToolSet,
  listDeferredTools,
  listGatewayTools,
} from "./tool-bridge"

const ORG_ID = "11111111-1111-1111-1111-aaaaaaaaaaaa"

const ACTOR: ActorContext = {
  actorType: "user",
  userId: "22222222-2222-2222-2222-bbbbbbbbbbbb",
  orgId: ORG_ID,
  // Wildcard so the test focuses on the gatewayHidden axis, not scope plumbing.
  scopes: ["mcp"],
  dimensionGrants: {},
}

function plant(args: { tool: string; gatewayHidden?: boolean; deferLoading?: boolean }) {
  toolRegistry.set([ORG_ID, "mcp", `fixture:${args.tool}`], {
    appName: "mcp",
    name: `fixture:${args.tool}`,
    description: `fixture ${args.tool}`,
    requiredScopes: [`mcp:fixture:${args.tool}`],
    deferLoading: args.deferLoading ?? false,
    agentVisible: true,
    gatewayHidden: args.gatewayHidden,
    params: z.object({}),
    handler: async () => ({ ok: true }),
  } as unknown as Parameters<typeof toolRegistry.set>[1])
}

function unplant(tool: string) {
  toolRegistry.delete([ORG_ID, "mcp", `fixture:${tool}`])
}

describe("buildToolSet `gatewayHidden` filter", () => {
  beforeEach(() => {
    plant({ tool: "visible" })
    plant({ tool: "hidden", gatewayHidden: true })
  })
  afterEach(() => {
    unplant("visible")
    unplant("hidden")
  })

  it("audience=agent (default) → both visible and hidden tools appear", () => {
    const set = buildToolSet(ORG_ID, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const names = Object.keys(set)
    expect(names).toContain("mcp__fixture_visible")
    expect(names).toContain("mcp__fixture_hidden")
  })

  it("audience=gateway → only non-hidden tools appear", () => {
    const set = buildToolSet(ORG_ID, ACTOR, undefined, undefined, "gateway")
    const names = Object.keys(set)
    expect(names).toContain("mcp__fixture_visible")
    expect(names).not.toContain("mcp__fixture_hidden")
  })

  it("gatewayHidden=undefined behaves like visible (default)", () => {
    plant({ tool: "default-vis" })
    try {
      const set = buildToolSet(ORG_ID, ACTOR, undefined, undefined, "gateway")
      expect(Object.keys(set)).toContain("mcp__fixture_default-vis")
    } finally {
      unplant("default-vis")
    }
  })

  it("listGatewayTools also respects gatewayHidden; the agent's deferred list does not", () => {
    plant({ tool: "def-vis", deferLoading: true })
    plant({ tool: "def-hid", deferLoading: true, gatewayHidden: true })
    try {
      const gateway = listGatewayTools(ORG_ID, ACTOR).map((t) => t.toolName)
      expect(gateway).toContain("fixture:def-vis")
      expect(gateway).not.toContain("fixture:def-hid")
      const agent = listDeferredTools(ORG_ID, ACTOR).map((t) => t.toolName)
      expect(agent).toContain("fixture:def-vis")
      expect(agent).toContain("fixture:def-hid")
    } finally {
      unplant("def-vis")
      unplant("def-hid")
    }
  })
})
