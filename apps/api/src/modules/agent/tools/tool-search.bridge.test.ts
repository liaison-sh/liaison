// SPDX-License-Identifier: FSL-1.1-ALv2
//
// tool_search through the REAL in-turn tool bridge (buildToolSet -> execute ->
// executeTool -> handler), not by calling the handler with a hand-built ctx.
//
// The live QA of the named agents: after the fix that made tool_search judge
// against the turn's scope, 0 of 100 matches were still flagged locked. The
// handler read `ctx.actor`, which the handler tests supplied and the real
// dispatch never does (the kernel ctx is an AppContext: `userId` + `scopes`,
// no `actor`), so every match came back usable, was LOADED, and the next call
// failed as an unavailable tool. Only a test through the bridge sees that ctx.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { ActorContext } from "~/db/rls"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-0000-0000-0000009d0001"
const USER = "00000000-0000-0000-0000-0000009d0011"
const AGENT = "00000000-0000-0000-0000-0000009d0021"
const THREAD = "00000000-0000-0000-0000-0000009d0031"
// The agent's ceiling: discovery and nothing else. The human holds everything.
const CEILING = ["kernel:threads:read"]

const actor: ActorContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

function turnTools() {
  const runFrame = {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    agentId: AGENT,
    effectiveScope: CEILING,
    discoveredTools: new Set<string>(),
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
  const tools = buildToolSet(
    ORG,
    actor,
    THREAD,
    ALL_DEFERRED_TOOLS_UNLOCKED,
    "agent",
    runFrame as never,
  )
  return { tools, runFrame }
}

type SearchResult = {
  matches: Array<{ name: string; locked?: boolean; requiredScope?: string }>
  note?: string
}

describe("tool_search through the in-turn bridge", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES
      (${ORG}, 'ToolSearchBridgeOrg', 'tool-search-bridge-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash) VALUES
      (${USER}, ${ORG}, 'ts-bridge@test.com', 'TS Bridge', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${AGENT}, ${ORG}, 'role', '@ts-base', 'Base', ${JSON.stringify(CEILING)}::jsonb, 'You help.')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'ts-bridge-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD}, ${USER}, ${ORG}) ON CONFLICT DO NOTHING`
    await registerKernelAgentTools(ORG)
    toolRegistry.set([ORG, "sprockets", "close"], {
      appName: "sprockets",
      name: "close",
      description: "Close a sprocket.",
      requiredScopes: ["sprockets:sprockets:write"],
      handler: async () => ({ ok: true }),
    } as never)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`.catch(() => {})
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${THREAD}`
    await sql`DELETE FROM kernel.threads WHERE id = ${THREAD}`
    await sql`DELETE FROM kernel.agents WHERE id = ${AGENT}`
    await sql`DELETE FROM kernel.users WHERE id = ${USER}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("flags a tool outside the agent's ceiling locked and never loads it (select:)", async () => {
    const { tools, runFrame } = turnTools()
    const res = (await tools.kernel__tool_search.execute(
      { query: "select:sprockets__close" },
      {},
    )) as SearchResult
    const hit = res.matches.find((m) => m.name === "sprockets__close")
    expect(hit?.locked).toBe(true)
    expect(hit?.requiredScope).toBe("sprockets:sprockets:write")
    expect(runFrame.discoveredTools.has("sprockets__close")).toBe(false)
    expect(res.note ?? "").not.toContain("LOADED")
  })

  it("flags it locked on a keyword search too", async () => {
    const { tools, runFrame } = turnTools()
    const res = (await tools.kernel__tool_search.execute(
      { query: "sprockets" },
      {},
    )) as SearchResult
    expect(res.matches.find((m) => m.name === "sprockets__close")?.locked).toBe(true)
    expect(runFrame.discoveredTools.has("sprockets__close")).toBe(false)
  })

  it("agrees with list_locked_capabilities on the same turn", async () => {
    const { tools } = turnTools()
    const locked = (await tools.kernel__list_locked_capabilities.execute(
      { query: "sprockets" },
      {},
    )) as { locked: Array<{ name: string }> }
    expect(locked.locked.map((t) => t.name)).toContain("sprockets__close")
  })
})
