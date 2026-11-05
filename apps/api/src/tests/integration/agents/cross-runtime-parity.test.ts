// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T18, the literal S13 check: the SAME agent, asked from the in-app sandbox
// turn and from the composition API an external runtime fetches, is authorized
// identically. Both sides are driven at their real seams: the in-app side
// through `buildToolSet` with the turn's run frame (the shape
// agent-service.ts builds at its "5. Build tool set" step), the external side
// through a real HTTP request to GET /api/agents/:agentId/definition.
//
// Deferred tools are normalized before comparing, and since the composed
// definition went on its context diet the normalization runs the OTHER way. The
// definition carries the HOT set only (everything else is reached from a local
// session by searching tools, exactly as the in-app turn reaches it), so the
// in-app set is built with ALL_DEFERRED_TOOLS_UNLOCKED and then narrowed by the
// same `isDeferredTool` split the composition applies. The two meta tools the
// gateway always appends are dropped.
//
// The test is designed to keep failing if the two paths ever compute scope
// differently, which is the security regression it exists to catch.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { env } from "~/lib/env"
import { effectiveScopeDm } from "~/modules/agent/scopes/effective-scope"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import {
  ALL_DEFERRED_TOOLS_UNLOCKED,
  buildToolSet,
  isDeferredTool,
} from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { signAccessToken } from "~/modules/auth/jwt"
import {
  cleanupSeededOrg,
  grantScope,
  seedAgentForOrg,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { LIAISON_META_TOOLS } from "~/modules/mcp/tool-projection"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// The ceiling is strictly narrower than the grantor's own scopes: the human
// holds test:items:write, the agent does not, so every tool needing it is the
// "inside the user's scopes, outside the ceiling" case both sides must drop.
// `kernel:threads:read` is on the ceiling so the comparison has a HOT tool to
// make: every tool the seeded app registers is deferred, and the definition
// carries the hot set, so a ceiling of app scopes alone would make both sides
// agree on an empty set and prove nothing.
const CEILING = ["test:items:read", "test:gated:write", "kernel:threads:read"]
const OUTSIDE_CEILING_SCOPE = "test:items:write"

describe("cross-runtime authorization parity (S13)", () => {
  let orgId: string
  let ownerId: string
  let threadId: string
  let agentId: string
  let actor: UserContext
  let bearer: string

  beforeAll(async () => {
    await acquireTestLock()
    await initSandboxPool()
    const seeded = await seedOrgWithTicketsApp()
    orgId = seeded.orgId
    ownerId = seeded.ownerId
    threadId = seeded.threadId
    agentId = (await seedAgentForOrg(orgId, { scopeCeiling: CEILING })).agentId
    // The kernel tools are what the HOT half of the comparison is made of: the
    // seeded app's own tools are all deferred, so without these both sides
    // would agree on an empty set and the property would be vacuous.
    await registerKernelAgentTools(orgId)
    // The definition route is gated on `kernel:agents:read` (FX2 item 2). The
    // parity property is about the TOOL SET the two runtimes authorize, so the
    // caller has to be able to reach the route at all; the ceiling above is
    // still what narrows what comes back.
    await grantScope(orgId, ownerId, "kernel:agents:read")
    await grantScope(orgId, ownerId, "kernel:threads:read")

    const perms = await withPrivilegedDb(orgId, "parity-perms", (tx) =>
      loadEffectivePermissions(tx, ownerId, orgId),
    )
    actor = userContextFor(orgId, ownerId, perms.scopes)

    const [row] = await sql<{ name: string; auth_version: number; permission_version: number }[]>`
      SELECT name, auth_version, permission_version FROM kernel.users WHERE id = ${ownerId}`
    bearer = await signAccessToken(
      {
        userId: ownerId,
        orgId,
        name: row!.name,
        authVersion: row!.auth_version,
        permissionVersion: row!.permission_version,
        roles: perms.roles,
        scopes: perms.scopes,
        dimensionGrants: perms.dimensionGrants,
      },
      env.JWT_SECRET,
      900,
    )
  }, 60_000)

  afterAll(async () => {
    await shutdownSandboxPool()
    if (orgId) await cleanupSeededOrg(orgId)
    await releaseTestLock()
  })

  /** The in-app turn's catalog, built exactly as agent-service builds it. */
  function inAppToolNames(): Set<string> {
    const effectiveScope = effectiveScopeDm(CEILING, actor.scopes ?? [])
    const rootRunId = crypto.randomUUID()
    const set = buildToolSet(orgId, actor, threadId, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", {
      runId: rootRunId,
      parentRunId: null,
      rootRunId,
      nestingDepth: 0,
      background: false,
      discoveredTools: ALL_DEFERRED_TOOLS_UNLOCKED,
      agentId,
      agentCeiling: [...CEILING],
      effectiveScope,
      turnScopeAccumulator: createTurnScopeAccumulator(),
    })
    return new Set(Object.keys(set))
  }

  /** The in-app names the provider is shown from step 0: the definition's half. */
  function hotToolNames(names: Set<string>): Set<string> {
    const hot = new Set<string>()
    for (const name of names) {
      const [appName, ...rest] = name.split("__")
      const def = toolRegistry.get([orgId, appName, rest.join("__")])
      if (!def || isDeferredTool(appName, def)) continue
      hot.add(name)
    }
    return hot
  }

  /** The composition API's catalog, over the real route. */
  async function definitionToolNames(): Promise<Set<string>> {
    const res = await app.request(`/api/agents/${agentId}/definition`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { mcpToolList: { name: string }[] } }
    return new Set(
      body.data.mcpToolList
        .map((t) => t.name)
        // Deferred-tool normalization is already done (both sides unlock
        // everything); what remains is the gateway's always-appended meta
        // tools, which have no in-app counterpart.
        .filter((n) => !LIAISON_META_TOOLS.has(n)),
    )
  }

  it("the in-app turn and the definition route carry the same hot tool set", async () => {
    const inApp = hotToolNames(inAppToolNames())
    const external = await definitionToolNames()
    expect(inApp.size).toBeGreaterThan(0)
    expect([...external].sort()).toEqual([...inApp].sort())
  }, 60_000)

  it("a tool inside the user's scopes but outside the agent ceiling is absent from both", async () => {
    // The human really does hold the scope: the exclusion below is the
    // ceiling's doing, not a missing grant.
    expect(actor.scopes).toContain(OUTSIDE_CEILING_SCOPE)
    const overCeiling = Object.keys(
      buildToolSet(orgId, actor, threadId, ALL_DEFERRED_TOOLS_UNLOCKED, "agent"),
    ).filter((n) => !inAppToolNames().has(n))
    // The fixture is only meaningful if the ceiling actually withholds
    // something the user could otherwise call.
    expect(overCeiling.length).toBeGreaterThan(0)

    const inApp = inAppToolNames()
    const external = await definitionToolNames()
    for (const name of overCeiling) {
      expect(inApp.has(name)).toBe(false)
      expect(external.has(name)).toBe(false)
    }
  }, 60_000)
})
