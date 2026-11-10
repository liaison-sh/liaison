// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import * as toolBridgeModule from "~/modules/agent/tools/tool-bridge"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  createMcpConnection,
  mintAccessToken,
  resolveConnectionFromToken,
} from "~/modules/mcp/connection-service"
import {
  cleanupSeededOrg,
  seedAgentForOrg,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import {
  LIAISON_APPROVAL_STATUS,
  LIAISON_CALL_TOOL,
  LIAISON_META_TOOLS,
  LIAISON_TOOL_SEARCH,
  listMcpTools,
} from "~/modules/mcp/tool-projection"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"

describe("tools/list projection parity", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("listMcpTools tool names == buildToolSet keys (excluding meta-tools)", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const actor = userContextFor(orgId, ownerId, scopes)

    const agentSet = buildToolSet(orgId, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const agentNames = new Set(Object.keys(agentSet))

    const mcp = await listMcpTools({ orgId, actor })
    const mcpNonMeta = mcp.filter((t) => !LIAISON_META_TOOLS.has(t.name)).map((t) => t.name)

    expect(new Set(mcpNonMeta)).toEqual(agentNames)
    expect(mcpNonMeta.length).toBeGreaterThan(0)

    // A known tool's inputSchema is a JSON-Schema object with the right keys.
    const createItem = mcp.find((t) => t.name.startsWith("test__createItem"))!
    expect(createItem.inputSchema.type).toBe("object")
    const props = createItem.inputSchema.properties as Record<string, unknown>
    expect(props).toHaveProperty("title")
    expect(props).toHaveProperty("team")
  }, 30_000)

  it("meta-tools always present even with zero installed apps", async () => {
    const { orgId, ownerId } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    // A context with no scopes sees no app tools — only the two meta-tools.
    const actor = userContextFor(orgId, ownerId, [])
    const mcp = await listMcpTools({ orgId, actor })
    const names = mcp.map((t) => t.name)
    expect(names).toContain(LIAISON_TOOL_SEARCH)
    expect(names).toContain(LIAISON_APPROVAL_STATUS)
    expect(names).toContain(LIAISON_CALL_TOOL)
  }, 30_000)

  it("scope filtering parity: reduced-scope context yields the same reduced set", async () => {
    const { orgId, ownerId } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const reduced = userContextFor(orgId, ownerId, ["test:items:read"])

    const agentSet = buildToolSet(orgId, reduced, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const mcp = (await listMcpTools({ orgId, actor: reduced }))
      .filter((t) => !LIAISON_META_TOOLS.has(t.name))
      .map((t) => t.name)
    expect(new Set(mcp)).toEqual(new Set(Object.keys(agentSet)))
  }, 30_000)

  it("PRODUCTION-SEAM parity: mint→resolve context deep-equals DB-resolved agent context, same catalog + gated partition (spec line 188)", async () => {
    const { orgId, ownerId } = await seedOrgWithTicketsApp()
    orgs.push(orgId)

    // Drive the REAL production MCP path: connection → mintAccessToken (which
    // calls loadEffectivePermissions + signs the JWT) → resolveConnectionFromToken
    // (which verifies the JWT and reads scopes/dimensionGrants back). This is
    // the exact seam the other parity tests bypass by hand-rolling userContextFor.
    const { connection } = await createMcpConnection({
      orgId,
      userId: ownerId,
      clientId: "claude-code",
      label: "Claude Code",
    })
    const { token } = await mintAccessToken(connection.id)
    const resolved = await resolveConnectionFromToken(token)

    // The in-app agent's source of truth, resolved independently from the DB.
    const perms = await withPrivilegedDb(orgId, "parity-perms", (tx) =>
      loadEffectivePermissions(tx, ownerId, orgId),
    )

    // The JWT roundtrip must not drop/mangle scopes or dimensionGrants — the
    // exact mutation the spec's anti-tautology guard targets.
    expect(new Set(resolved.scopes)).toEqual(new Set(perms.scopes))
    expect(resolved.dimensionGrants).toEqual(perms.dimensionGrants)
    expect(resolved.userId).toBe(ownerId)
    expect(resolved.orgId).toBe(orgId)

    // Catalog + gated/non-gated partition parity, each path driven by its OWN
    // independently-built context (production-resolved vs DB-resolved).
    const mcpCtx: UserContext = {
      actorType: "user",
      userId: resolved.userId,
      orgId: resolved.orgId,
      scopes: resolved.scopes,
      dimensionGrants: resolved.dimensionGrants,
    }
    const agentCtx: UserContext = {
      actorType: "user",
      userId: ownerId,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    }
    const agentSet = buildToolSet(orgId, agentCtx, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const mcpNonMeta = new Set(
      (await listMcpTools({ orgId, actor: mcpCtx }))
        .filter((t) => !LIAISON_META_TOOLS.has(t.name))
        .map((t) => t.name),
    )
    expect(mcpNonMeta).toEqual(new Set(Object.keys(agentSet)))
    // Gated/non-gated classification asserted as a pair: the gated subset the
    // MCP path would block must equal the gated subset the agent path blocks.
    const gatedOf = (set: Record<string, { gated?: boolean }>) =>
      new Set(
        Object.entries(set)
          .filter(([, d]) => d.gated)
          .map(([k]) => k),
      )
    const mcpAsAgentSet = buildToolSet(orgId, mcpCtx, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    expect(gatedOf(mcpAsAgentSet)).toEqual(gatedOf(agentSet))
  }, 30_000)

  // DEFECT 1a (2026-07-15) — spawn_agent structurally requires an in-process
  // agent execution thread (chat root) to chain the new sub-run's
  // parent_run_id; an external MCP client has no such thread, so the call can
  // never succeed. It must never appear in the outbound MCP tools/list, even
  // for an actor holding the full kernel:agents:spawn scope.
  it("listMcpTools NEVER includes kernel__spawn_agent even with full scope", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    await registerKernelAgentTools(orgId)
    const actor = userContextFor(orgId, ownerId, [...scopes, "kernel:agents:spawn"])

    // The in-process agent DOES see it (sanity check the tool actually
    // registered and is reachable for the audience it's meant for).
    const agentSet = buildToolSet(orgId, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    expect(agentSet.kernel__spawn_agent).toBeDefined()

    const mcpNames = (await listMcpTools({ orgId, actor })).map((t) => t.name)
    expect(mcpNames).not.toContain("kernel__spawn_agent")
  }, 30_000)

  // P2a-T05: proof that the D3 fail-closed rule (P2a-T04, buildToolSet's
  // scope-filter line) covers the gateway audience too, not just the
  // in-app agent — listMcpTools routes through the same buildToolSet gate,
  // so this is a regression guard, not a new-bug-fix test.
  it("listMcpTools excludes a scope-less tool from the gateway catalog", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    // Full wildcard actor, same as tool-bridge.test.ts's fail-closed guard:
    // the exclusion must hold even for an actor who holds every scope.
    const actor = userContextFor(orgId, ownerId, [...scopes, "*"])

    // A tool declaring no `requiredScopes`, same fixture shape as
    // tool-bridge.test.ts. Registration refuses that shape, so the list is
    // stripped after the fact to model a definition that slipped through.
    toolRegistry.set([orgId, "fc", "noScopeTool"], {
      appName: "fc",
      name: "noScopeTool",
      description: "Declares no scope at all",
      requiredScopes: ["fc:placeholder"],
      handler: async () => ({ ok: true }),
    })
    delete (toolRegistry.get([orgId, "fc", "noScopeTool"]) as { requiredScopes?: string[] })
      .requiredScopes
    try {
      const mcpNames = (await listMcpTools({ orgId, actor })).map((t) => t.name)
      expect(mcpNames).not.toContain("fc__noScopeTool")
    } finally {
      toolRegistry.delete([orgId, "fc", "noScopeTool"])
    }
  }, 30_000)

  it("listMcpTools includes kernel__approval_withdraw for a caller holding only kernel:approvals:read", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    await registerKernelAgentTools(orgId)
    const actor = userContextFor(orgId, ownerId, [
      ...scopes.filter((s) => !s.startsWith("kernel:approvals") && s !== "*" && s !== "kernel:*"),
      "kernel:approvals:read",
    ])

    const agentSet = buildToolSet(orgId, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    expect(agentSet.kernel__approval_withdraw).toBeDefined()

    const mcpNames = (await listMcpTools({ orgId, actor })).map((t) => t.name)
    expect(mcpNames).toContain("kernel__approval_withdraw")
  }, 30_000)

  it("lists the two skill tools always loaded, and no other tool", async () => {
    // Claude Code and the desktop's Agent SDK defer an MCP catalog behind their
    // own tool search unless a tool carries `_meta["anthropic/alwaysLoad"]`.
    // Every Liaison instruction sends the model to the skill tools first, so a
    // deferred pair cost a ToolSearch round trip (or a guessed name) on turn one.
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    await registerKernelAgentTools(orgId)
    const actor = userContextFor(orgId, ownerId, [...scopes, "kernel:skills:read"])
    const tools = await listMcpTools({ orgId, actor })
    const pinned = tools
      .filter((t) => t._meta?.["anthropic/alwaysLoad"] === true)
      .map((t) => t.name)
    expect(pinned.sort()).toEqual(["kernel__skill_read", "kernel__skill_search"])
  }, 30_000)

  describe("explicit effective scope", () => {
    // Two fixture tools on one resource: a reader and a writer. The actor
    // holds both scopes; the effective scope decides which the catalog shows.
    function registerReaderWriter(orgId: string): () => void {
      toolRegistry.set([orgId, "fc", "effReader"], {
        appName: "fc",
        name: "effReader",
        description: "Reads a:b",
        requiredScopes: ["a:b:read"],
        handler: async () => ({ ok: true }),
      } as any)
      toolRegistry.set([orgId, "fc", "effWriter"], {
        appName: "fc",
        name: "effWriter",
        description: "Writes a:b",
        requiredScopes: ["a:b:write"],
        handler: async () => ({ ok: true }),
      } as any)
      return () => {
        toolRegistry.delete([orgId, "fc", "effReader"])
        toolRegistry.delete([orgId, "fc", "effWriter"])
      }
    }

    it("listMcpTools narrows the catalog to an explicitly passed effective scope", async () => {
      const { orgId, ownerId } = await seedOrgWithTicketsApp()
      orgs.push(orgId)
      const actor = userContextFor(orgId, ownerId, ["a:b:read", "a:b:write"])
      const unregister = registerReaderWriter(orgId)
      try {
        const names = (await listMcpTools({ orgId, actor }, undefined, ["a:b:read"])).map(
          (t) => t.name,
        )
        expect(names).toContain("fc__effReader")
        expect(names).not.toContain("fc__effWriter")
      } finally {
        unregister()
      }
    }, 30_000)

    it("listMcpTools omitting the effective scope keeps todays actor-scope behavior", async () => {
      const { orgId, ownerId } = await seedOrgWithTicketsApp()
      orgs.push(orgId)
      const actor = userContextFor(orgId, ownerId, ["a:b:read", "a:b:write"])
      const unregister = registerReaderWriter(orgId)
      try {
        const names = (await listMcpTools({ orgId, actor }, undefined)).map((t) => t.name)
        expect(names).toContain("fc__effReader")
        expect(names).toContain("fc__effWriter")
      } finally {
        unregister()
      }
    }, 30_000)

    it("listMcpTools effective scope never widens past the actor and fails closed when empty", async () => {
      const { orgId, ownerId } = await seedOrgWithTicketsApp()
      orgs.push(orgId)
      const actor = userContextFor(orgId, ownerId, ["a:b:read"])
      const unregister = registerReaderWriter(orgId)
      try {
        const wider = (
          await listMcpTools({ orgId, actor }, undefined, ["a:b:read", "a:b:write"])
        ).map((t) => t.name)
        expect(wider).toContain("fc__effReader")
        expect(wider).not.toContain("fc__effWriter")

        const empty = (await listMcpTools({ orgId, actor }, undefined, [])).map((t) => t.name)
        expect(empty).not.toContain("fc__effReader")
        expect(empty).not.toContain("fc__effWriter")
        // The meta-tools carry no scope and stay listed.
        expect(empty).toContain(LIAISON_TOOL_SEARCH)
        expect(empty).toContain(LIAISON_APPROVAL_STATUS)
      } finally {
        unregister()
      }
    }, 30_000)
  })

  // The projection narrows the catalog with a scope set, and it used to do
  // that by handing `buildToolSet` a hand-rolled `{ effectiveScope }` frame.
  // That frame is a TURN FRAME everywhere else in the system, and it carried no
  // scope accumulator: a frame that exists but cannot say what the turn has
  // read resolves the taint to `null`, which the write boundaries refuse. The
  // set this call builds is projected into schemas and thrown away, so nothing
  // was executed under it and nothing broke -- but the frame reached
  // `buildToolSet`, which closes over it for every tool's `execute`, so the
  // first caller to hand this function an effective scope AND invoke the
  // resulting set would have had every gateway write refused, with no
  // indication why. The narrowing goes through the actor instead, which is the
  // same rule `buildToolSet` applies to a frame's effective scope, so no frame
  // exists to be entered.
  it("the effective-scope projection builds NO run frame, narrowing the actor instead", async () => {
    const orgId = crypto.randomUUID()
    const actor = userContextFor(orgId, crypto.randomUUID(), ["a:b:read", "a:b:write"])
    const seen: Array<{ scopes: string[] | undefined; runFrame: unknown }> = []
    const spy = spyOn(toolBridgeModule, "buildToolSet").mockImplementation(((
      _orgId: string,
      actorArg: { scopes?: string[] },
      _threadId: unknown,
      _discovered: unknown,
      _audience: unknown,
      runFrame: unknown,
    ) => {
      seen.push({ scopes: actorArg.scopes, runFrame })
      return {}
    }) as never)
    try {
      await listMcpTools({ orgId, actor }, undefined, ["a:b:read"])
    } finally {
      spy.mockRestore()
    }

    expect(seen.length).toBe(1)
    // No frame at all: an accumulator-less one would resolve this turn's taint
    // to "unknown" at every write boundary it reached.
    expect(seen[0]!.runFrame).toBeUndefined()
    // The same narrowing, expressed where it cannot be mistaken for a turn.
    expect(seen[0]!.scopes).toEqual(["a:b:read"])
  })

  it("structural parity with the identical UserContext instance", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const actor = userContextFor(orgId, ownerId, scopes)
    const agentSet = buildToolSet(orgId, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const mcp = (await listMcpTools({ orgId, actor }))
      .filter((t) => !LIAISON_META_TOOLS.has(t.name))
      .map((t) => t.name)
    expect(new Set(mcp)).toEqual(new Set(Object.keys(agentSet)))
  }, 30_000)
})

describe("tools/list agent-bound allow/deny policy", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("listMcpTools excludes a tool on the bound agent's toolDenylist even though the caller's scope covers it", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const actor = userContextFor(orgId, ownerId, scopes)

    const unbound = (await listMcpTools({ orgId, actor })).map((t) => t.name)
    const victim = unbound.find((n) => n.startsWith("test__createItem"))!
    expect(victim).toBeDefined()

    const { agentId } = await seedAgentForOrg(orgId, { toolDenylist: [victim] })
    const bound = (await listMcpTools({ orgId, actor, agentId })).map((t) => t.name)

    expect(bound).not.toContain(victim)
    // Everything else the scopes admit is still there, so this removed one
    // tool rather than collapsing the catalog.
    for (const n of unbound) {
      if (n !== victim) expect(bound).toContain(n)
    }
  }, 30_000)

  it("listMcpTools restricts to toolAllowlist when non-empty", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const actor = userContextFor(orgId, ownerId, scopes)

    const unbound = (await listMcpTools({ orgId, actor }))
      .map((t) => t.name)
      .filter((n) => !LIAISON_META_TOOLS.has(n))
    expect(unbound.length).toBeGreaterThanOrEqual(2)
    const allowed = unbound.slice(0, 2)

    const { agentId } = await seedAgentForOrg(orgId, { toolAllowlist: allowed })
    const bound = (await listMcpTools({ orgId, actor, agentId })).map((t) => t.name)

    // Exactly the two named tools plus the always-appended meta tools.
    expect(new Set(bound)).toEqual(new Set([...allowed, ...LIAISON_META_TOOLS]))
    expect(bound.length).toBe(2 + LIAISON_META_TOOLS.size)
  }, 30_000)

  it("listMcpTools never emits an explanatory field for a tool withheld by the agent policy", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    const actor = userContextFor(orgId, ownerId, scopes)

    const unbound = (await listMcpTools({ orgId, actor })).map((t) => t.name)
    const victim = unbound.find((n) => n.startsWith("test__createItem"))!
    const { agentId } = await seedAgentForOrg(orgId, { toolDenylist: [victim] })

    const bound = await listMcpTools({ orgId, actor, agentId })
    // Silent omission: the withheld tool is simply absent, and NOTHING anywhere
    // in the response names it or explains the omission.
    expect(bound.map((t) => t.name)).not.toContain(victim)
    const serialized = JSON.stringify(bound)
    expect(serialized).not.toContain(victim)
    expect(serialized).not.toContain("withheld")
    expect(serialized).not.toContain("omitted")
    for (const t of bound) {
      expect(Object.keys(t).sort()).toEqual(["description", "inputSchema", "name"])
    }
  }, 30_000)
})

// P3b-T12: the coordination tools reach an agent-bound connection and an in-app
// agent turn, and are absent from a plain user token's catalog (A30 point 1).
// The desktop's local session holds an agent-bound token, so it passes the same
// predicate with no desktop-specific code.
describe("tools/list agent-bound only stage", () => {
  const orgs: string[] = []
  const COORDINATION = ["kernel__agents_ask", "kernel__agents_invite"]

  beforeAll(async () => {
    await initSandboxPool()
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  // A30 point 1 held for `agents_invite`, which seats an agent in the turn's
  // OWN room and has no meaning for a connection that is nobody's agent. It
  // never held for `agents_ask`: a person at a Claude Code prompt asks a named
  // colleague agent exactly as they do in the web app, and the question lands
  // in their own DM with it.
  it("a plain user token catalog omits agents_invite and offers agents_ask", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    await registerKernelAgentTools(orgId)
    const actor = userContextFor(orgId, ownerId, [...scopes, "kernel:threads:write"])
    const names = (await listMcpTools({ orgId, actor })).map((t) => t.name)
    expect(names).not.toContain("kernel__agents_invite")
    expect(names).toContain("kernel__agents_ask")
  }, 30_000)

  it("an agent bound catalog offers agents_ask and agents_invite", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    await registerKernelAgentTools(orgId)
    const actor = userContextFor(orgId, ownerId, [...scopes, "kernel:threads:write"])
    const { agentId } = await seedAgentForOrg(orgId, {})
    const names = (await listMcpTools({ orgId, actor, agentId })).map((t) => t.name)
    for (const n of COORDINATION) expect(names).toContain(n)
  }, 30_000)

  it("the agent bound filter runs after the deny list", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    await registerKernelAgentTools(orgId)
    const actor = userContextFor(orgId, ownerId, [...scopes, "kernel:threads:write"])
    const { agentId } = await seedAgentForOrg(orgId, { toolDenylist: ["kernel:agents_ask"] })
    const names = (await listMcpTools({ orgId, actor, agentId })).map((t) => t.name)
    expect(names).not.toContain("kernel__agents_ask")
    expect(names).toContain("kernel__agents_invite")
  }, 30_000)

  it("no other tool is removed by the new stage", async () => {
    const { orgId, ownerId, scopes } = await seedOrgWithTicketsApp()
    orgs.push(orgId)
    await registerKernelAgentTools(orgId)
    const actor = userContextFor(orgId, ownerId, [
      ...scopes,
      "kernel:threads:write",
      "kernel:threads:read",
    ])
    const { agentId } = await seedAgentForOrg(orgId, {})
    const bound = new Set((await listMcpTools({ orgId, actor, agentId })).map((t) => t.name))
    const plain = new Set((await listMcpTools({ orgId, actor })).map((t) => t.name))
    // The agent-bound tools are the whole difference between the two
    // catalogues: `agents_invite` (seats an agent in its own room) and
    // `run_on_my_computer` (P4 S21: a node job for the acting agent, refused
    // with no_agent without one). A new agentBoundOnly tool is added here on
    // purpose; `agents_ask` is in both.
    // The person's computer: dispatch, and the gated share and clone (review m7).
    const AGENT_BOUND_ONLY = [
      "kernel__agents_invite",
      "kernel__run_on_my_computer",
      "kernel__share_folder_on_my_computer",
      "kernel__clone_repo_on_my_computer",
      // Steering the person's own sessions (stop, message, answer, settings, read).
      "kernel__computer_session_list",
      "kernel__computer_session_read",
      "kernel__computer_session_send",
      "kernel__computer_session_stop",
      "kernel__computer_session_answer",
      "kernel__computer_session_settings",
      // W3 (S40, S41): listing and starting an import of the person's own sessions.
      "kernel__computer_session_import_list",
      "kernel__computer_session_import",
      // S19: finding the repositories on the person's computer and the ones it can reach.
      "kernel__find_repos_on_my_computer",
      "kernel__list_my_remote_repos",
    ]
    expect(plain.has("kernel__agents_ask")).toBe(true)
    expect(bound.has("kernel__agents_ask")).toBe(true)
    for (const n of AGENT_BOUND_ONLY) {
      expect(bound.has(n)).toBe(true)
      expect(plain.has(n)).toBe(false)
      bound.delete(n)
    }
    expect([...plain].sort()).toEqual([...bound].sort())
  }, 30_000)
})
