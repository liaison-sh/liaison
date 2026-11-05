// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App tools are deferred BY DEFAULT (Claude Code-style): the model sees only
// their names (via the system-prompt catalog + tool_search) until it discovers
// them, so the full schema catalog is never serialized into every request.
// Kernel tools stay hot. A manifest tool can opt out with `deferLoading: false`
// (stays hot) or a kernel tool can opt in with `deferLoading: true`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  ALL_DEFERRED_TOOLS_UNLOCKED,
  buildScopedToolSet,
  buildToolSet,
  describeToolParams,
  listDeferredTools,
  listGatewayTools,
} from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"

const ORG = "00000000-0000-0000-0000-000000000d31"

const ACTOR = {
  actorType: "agent" as const,
  userId: "00000000-0000-0000-0000-000000000d32",
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
} as any

beforeAll(() => {
  // App tool with NO deferLoading flag — deferred by default after the flip.
  toolRegistry.set([ORG, "gadgets", "search"], {
    appName: "gadgets",
    name: "search",
    description: "Search gadgets.",
    requiredScopes: ["gadgets:gadgets:read"],
    handler: async () => ({ ok: true }),
  } as any)
  // App tool explicitly opted OUT of deferral — always hot.
  toolRegistry.set([ORG, "gadgets", "hot_action"], {
    appName: "gadgets",
    name: "hot_action",
    description: "A hot-path gadget action.",
    requiredScopes: ["gadgets:gadgets:read"],
    handler: async () => ({ ok: true }),
    deferLoading: false,
  } as any)
  // Kernel tool with NO flag — hot by default.
  toolRegistry.set([ORG, "kernel", "fake_probe"], {
    appName: "kernel",
    name: "fake_probe",
    description: "A fake kernel probe tool.",
    requiredScopes: ["kernel:threads:read"],
    handler: async () => ({ ok: true }),
  } as any)
  // Kernel tool explicitly opted INTO deferral.
  toolRegistry.set([ORG, "kernel", "fake_deferred_probe"], {
    appName: "kernel",
    name: "fake_deferred_probe",
    description: "A rarely-used kernel tool.",
    requiredScopes: ["kernel:threads:read"],
    handler: async () => ({ ok: true }),
    deferLoading: true,
  } as any)
})

afterAll(() => {
  toolRegistry.delete([ORG, "gadgets", "search"])
  toolRegistry.delete([ORG, "gadgets", "hot_action"])
  toolRegistry.delete([ORG, "kernel", "fake_probe"])
  toolRegistry.delete([ORG, "kernel", "fake_deferred_probe"])
})

describe("deferred-by-default tool catalog", () => {
  it("app tools without a flag are DEFERRED: hidden until discovered", () => {
    const tools = buildToolSet(ORG, ACTOR)
    expect(tools.gadgets__search).toBeUndefined()
    // Discovery admits it.
    const discovered = new Set(["gadgets__search"])
    const toolsAfter = buildToolSet(ORG, ACTOR, undefined, discovered)
    expect(toolsAfter.gadgets__search).toBeDefined()
    // The unlock-all sentinel admits it too (sub-agent allowlists).
    const toolsAll = buildToolSet(ORG, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    expect(toolsAll.gadgets__search).toBeDefined()
  })

  it("app tools with deferLoading:false stay hot", () => {
    const tools = buildToolSet(ORG, ACTOR)
    expect(tools.gadgets__hot_action).toBeDefined()
  })

  it("kernel tools stay hot by default; deferLoading:true defers even a kernel tool", () => {
    const tools = buildToolSet(ORG, ACTOR)
    expect(tools.kernel__fake_probe).toBeDefined()
    expect(tools.kernel__fake_deferred_probe).toBeUndefined()
  })

  it("listDeferredTools reflects the same default: app tool listed, hot tools not", () => {
    const deferred = listDeferredTools(ORG, ACTOR)
    const names = deferred.map((t) => t.sdkName)
    expect(names).toContain("gadgets__search")
    expect(names).toContain("kernel__fake_deferred_probe")
    expect(names).not.toContain("gadgets__hot_action")
    expect(names).not.toContain("kernel__fake_probe")
  })

  it("gateway audience defers NOTHING: the first tools/list is the whole callable catalog", () => {
    // No discovery argument at all — this models the very first tools/list of a
    // fresh MCP connection, before any liaison_tool_search could have run.
    const tools = buildToolSet(ORG, ACTOR, undefined, undefined, "gateway")
    expect(tools.gadgets__search).toBeDefined()
    // The regression: `deferLoading: true` used to hide a tool here until a
    // liaison_tool_search added it mid-connection and a tools_list_changed
    // notification told the client to re-list. A client that snapshots its tool
    // table at initialize (Claude Code) never re-lists, so the whole kernel
    // admin surface was permanently uncallable over MCP. Discovery must never be
    // the only door to a capability.
    expect(tools.kernel__fake_deferred_probe).toBeDefined()
    // An empty discovered set must not change that either.
    const coldTools = buildToolSet(ORG, ACTOR, undefined, new Set<string>(), "gateway")
    expect(coldTools.kernel__fake_deferred_probe).toBeDefined()
  })

  it("gateway search ranks the full catalog, so a deferred tool is findable cold", () => {
    // liaison_tool_search scores listGatewayTools. If it scored the deferred
    // subset instead, this would be empty and the tool would read as missing.
    const names = listGatewayTools(ORG, ACTOR).map((t) => t.sdkName)
    expect(names).toContain("kernel__fake_deferred_probe")
    expect(names).toContain("gadgets__search")
    expect(names).toContain("kernel__fake_probe")
  })

  it("sub-agent allowlists still select deferred tools without discovery", () => {
    const tools = buildScopedToolSet(ORG, ACTOR, "00000000-0000-0000-0000-000000000d33", {
      effectiveScopes: ["*"],
      allowlist: ["gadgets:search"],
      denylist: null,
    })
    expect(tools.gadgets__search).toBeDefined()
    expect(tools.gadgets__hot_action).toBeUndefined()
  })
})

describe("blind calls to undiscovered deferred tools", () => {
  const frame = () => ({
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    discoveredTools: new Set<string>(),
    // A real turn frame always carries one (runAgentChat mints it for every
    // turn, sub-runs and approved re-entries build their own). An empty one is
    // the untainted turn these tests are about; omitting it would instead mean
    // "this turn's taint is unknowable", which the write guard refuses.
    turnScopeAccumulator: createTurnScopeAccumulator(),
  })

  beforeAll(() => {
    toolRegistry.set([ORG, "gadgets", "reply"], {
      appName: "gadgets",
      name: "reply",
      description: "Reply to a gadget.",
      requiredScopes: ["gadgets:gadgets:read"],
      params: z.object({ gadgetId: z.string(), body: z.string().optional() }),
      handler: async () => ({ ok: true }),
    } as any)
  })

  afterAll(() => {
    toolRegistry.delete([ORG, "gadgets", "reply"])
  })

  it("a blind call VALIDATES-THEN-EXECUTES: invalid args fail with the schema attached, and unlock the tool", async () => {
    // The prod failure class: the model knows the NAME from the catalog and
    // emits a call the provider never saw a declaration for, guessing the args.
    // The old reject-then-retry gate charged one full-context step per
    // first-touch; now the call runs (executeTool zod-validates first), so
    // invalid args come back as a precise validation error PLUS the parameter
    // list — same schema-teaching value, one step saved on valid guesses.
    const f = frame()
    const tools = buildToolSet(ORG, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", f)
    // Missing the required gadgetId — the guess fails zod validation.
    const res = await tools.gadgets__reply.execute({})
    expect(res.error).toBeTruthy()
    expect(res.error).toContain("LOADED")
    expect(res.error).toContain("gadgetId (required)")
    expect(res.error).toContain("body")
    // The call itself IS the discovery: schema + full app guide arrive next step.
    expect(f.discoveredTools.has("gadgets__reply")).toBe(true)
  })

  it("a blind call with VALID args executes for real (no wasted round-trip)", async () => {
    const f = frame()
    const tools = buildToolSet(ORG, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", f)
    const res = await tools.gadgets__reply.execute({ gadgetId: "g-1", body: "hi" })
    expect(JSON.stringify(res)).not.toContain("NOT EXECUTED")
    expect((res as { error?: string }).error).toBeUndefined()
    expect(f.discoveredTools.has("gadgets__reply")).toBe(true)
  })

  it("once discovered, the same call executes normally", async () => {
    const f = frame()
    f.discoveredTools.add("gadgets__reply")
    const tools = buildToolSet(ORG, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", f)
    const res = await tools.gadgets__reply.execute({ gadgetId: "g-1", body: "hi" })
    expect(JSON.stringify(res)).not.toContain("NOT EXECUTED")
  })

  it("hot tools and frames without a discovery set are unaffected", async () => {
    // Hot tool + discovery frame: callable from step 0, gate must not fire.
    const f = frame()
    const tools = buildToolSet(ORG, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", f)
    const hot = await tools.gadgets__hot_action.execute({})
    expect(JSON.stringify(hot)).not.toContain("NOT EXECUTED")
    // Deferred tool + allowlist-style frame (no discoveredTools): executes directly.
    const bare = {
      runId: crypto.randomUUID(),
      parentRunId: null,
      rootRunId: crypto.randomUUID(),
      nestingDepth: 0,
    }
    const allowTools = buildToolSet(
      ORG,
      ACTOR,
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      bare,
    )
    const res = await allowTools.gadgets__reply.execute({ gadgetId: "g-1", body: "hi" })
    // The blind-call gate did not fire (it would have unlocked the tool and said so). This
    // bare frame carries no turn accumulator, so the dispatch's scope-taint boundary reads
    // its taint as unknown and refuses the undeclared write, and that refusal also begins
    // "NOT EXECUTED" since it names what was read: assert on the gate's own wording.
    expect(JSON.stringify(res)).not.toContain("also LOADED")
  })
})

describe("repeated identical failing calls", () => {
  it("escalates the error wording from the 3rd identical failure on", async () => {
    toolRegistry.set([ORG, "gadgets", "flaky"], {
      appName: "gadgets",
      name: "flaky",
      description: "Always fails.",
      requiredScopes: ["gadgets:gadgets:read"],
      params: z.object({ id: z.string() }),
      // A read, and declared as one. This test is about the repeated-failure
      // escalation, so every call must reach the handler: once the frame has a
      // real accumulator, the first call records this tool's read scope and an
      // UNDECLARED tool would then be refused as a write on the now-tainted
      // turn, which is the ordinary taint rule and not what is under test.
      readOnly: true,
      handler: async () => {
        throw new Error("boom: id not found")
      },
    } as any)
    try {
      const f = {
        runId: crypto.randomUUID(),
        parentRunId: null,
        rootRunId: crypto.randomUUID(),
        nestingDepth: 0,
        discoveredTools: new Set(["gadgets__flaky"]),
        turnScopeAccumulator: createTurnScopeAccumulator(),
      }
      const tools = buildToolSet(ORG, ACTOR, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", f)
      const r1 = await tools.gadgets__flaky.execute({ id: "x" })
      const r2 = await tools.gadgets__flaky.execute({ id: "x" })
      const r3 = await tools.gadgets__flaky.execute({ id: "x" })
      expect(r1.error).toContain("boom")
      expect(r1.error).not.toContain("STOP:")
      expect(r2.error).not.toContain("STOP:")
      expect(r3.error).toContain("STOP:")
      // Different args reset nothing but count separately — no false escalation.
      const other = await tools.gadgets__flaky.execute({ id: "y" })
      expect(other.error).not.toContain("STOP:")
    } finally {
      toolRegistry.delete([ORG, "gadgets", "flaky"])
    }
  })
})

describe("describeToolParams", () => {
  it("renders zod, JSON-schema, and empty params", () => {
    expect(describeToolParams(z.object({ a: z.string(), b: z.number().optional() }))).toBe(
      "a (required); b",
    )
    expect(
      describeToolParams({
        type: "object",
        properties: { ticketId: { type: "string" }, body: { type: "string" } },
        required: ["ticketId"],
      }),
    ).toBe("ticketId (required); body")
    expect(describeToolParams(undefined)).toBe("(no parameters)")
  })
})
