// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T26 — `buildToolSet` filters MCP tools whose connection is unreachable
// (health=down/failed/needs_reauth OR disabled=true). The slug→connectionId
// map (`slugIndex`) is the reverse lookup; the gate (`HealthGate`) is the
// state.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { z } from "zod"
import type { ActorContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import { _resetHealthGate, getHealthGate } from "~/modules/mcp-client/health-gate"
import { slugIndex } from "~/modules/mcp-client/slug-index"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet, listDeferredTools } from "./tool-bridge"

const ORG_ID = "11111111-1111-1111-1111-aaaaaaaaaaaa"
const CONN_ID = "33333333-3333-3333-3333-cccccccccccc"

const ACTOR: ActorContext = {
  actorType: "user",
  userId: "22222222-2222-2222-2222-bbbbbbbbbbbb",
  orgId: ORG_ID,
  scopes: ["mcp"],
  dimensionGrants: {},
}

function plantMcpTool(slug: string, tool: string) {
  toolRegistry.set([ORG_ID, "mcp", `${slug}:${tool}`], {
    appName: "mcp",
    name: `${slug}:${tool}`,
    description: `${slug}.${tool}`,
    requiredScopes: [`mcp:${slug}:${tool}`],
    deferLoading: false,
    agentVisible: true,
    params: z.object({}),
    handler: async () => ({ ok: true }),
  } as unknown as Parameters<typeof toolRegistry.set>[1])
  slugIndex.set(ORG_ID, slug, CONN_ID)
}

function unplantMcpTool(slug: string, tool: string) {
  toolRegistry.delete([ORG_ID, "mcp", `${slug}:${tool}`])
  slugIndex.delete(ORG_ID, slug)
}

describe("buildToolSet health-gate filter for MCP tools", () => {
  beforeEach(() => {
    _resetHealthGate()
    plantMcpTool("linear", "search")
  })
  afterEach(() => {
    unplantMcpTool("linear", "search")
    _resetHealthGate()
  })

  it("connection in healthy state → tool appears in agent tool set", () => {
    getHealthGate().setHealthStatus(CONN_ID, "connected")
    const set = buildToolSet(ORG_ID, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    expect(Object.keys(set)).toContain("mcp__linear_search")
  })

  it("connection marked down → tool omitted from agent tool set", () => {
    getHealthGate().setHealthStatus(CONN_ID, "down")
    const set = buildToolSet(ORG_ID, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    expect(Object.keys(set)).not.toContain("mcp__linear_search")
  })

  it("connection marked failed → tool omitted", () => {
    getHealthGate().setHealthStatus(CONN_ID, "failed")
    expect(
      Object.keys(buildToolSet(ORG_ID, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)),
    ).not.toContain("mcp__linear_search")
  })

  it("connection marked needs_reauth → tool omitted", () => {
    getHealthGate().setHealthStatus(CONN_ID, "needs_reauth")
    expect(
      Object.keys(buildToolSet(ORG_ID, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)),
    ).not.toContain("mcp__linear_search")
  })

  it("connection disabled → tool omitted regardless of health", () => {
    getHealthGate().setHealthStatus(CONN_ID, "connected")
    getHealthGate().setDisabled(CONN_ID, true)
    expect(
      Object.keys(buildToolSet(ORG_ID, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)),
    ).not.toContain("mcp__linear_search")
  })

  it("recovery: down → connected restores visibility", () => {
    getHealthGate().setHealthStatus(CONN_ID, "down")
    expect(
      Object.keys(buildToolSet(ORG_ID, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)),
    ).not.toContain("mcp__linear_search")
    getHealthGate().setHealthStatus(CONN_ID, "connected")
    expect(
      Object.keys(buildToolSet(ORG_ID, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)),
    ).toContain("mcp__linear_search")
  })

  it("listDeferredTools also filters unreachable connections", () => {
    toolRegistry.set([ORG_ID, "mcp", "linear:def"], {
      appName: "mcp",
      name: "linear:def",
      description: "deferred",
      requiredScopes: ["mcp:linear:def"],
      deferLoading: true,
      agentVisible: true,
      params: z.object({}),
      handler: async () => ({ ok: true }),
    } as unknown as Parameters<typeof toolRegistry.set>[1])
    try {
      getHealthGate().setHealthStatus(CONN_ID, "down")
      const names = listDeferredTools(ORG_ID, ACTOR).map((t) => t.toolName)
      expect(names).not.toContain("linear:def")
      getHealthGate().setHealthStatus(CONN_ID, "connected")
      const names2 = listDeferredTools(ORG_ID, ACTOR).map((t) => t.toolName)
      expect(names2).toContain("linear:def")
    } finally {
      toolRegistry.delete([ORG_ID, "mcp", "linear:def"])
    }
  })
})
