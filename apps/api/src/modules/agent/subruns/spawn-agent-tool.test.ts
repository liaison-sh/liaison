// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import type { UserContext } from "~/db/rls"
import { appsLogger } from "~/lib/logger"
import { handleSpawnAgent, SpawnAgentContextError } from "~/modules/agent/subruns/spawn-agent-tool"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { appCapabilitiesRegistry, toolRegistry } from "~/modules/apps/app-registries"

// Unique org id per file so we don't collide with kernel-tools.test.ts.
const ORG_ID = "00000000-0000-0000-0000-000000da06a1"

function userActor(scopes: string[]): UserContext {
  return {
    actorType: "user",
    userId: "00000000-0000-0000-0000-000000da06a2",
    orgId: ORG_ID,
    scopes,
    dimensionGrants: {},
  }
}

describe("spawn_agent kernel tool — registration & capability gating", () => {
  beforeEach(async () => {
    toolRegistry.deleteByPrefix([ORG_ID])
    appCapabilitiesRegistry.deleteByPrefix([ORG_ID])
    const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
    await registerKernelAgentTools(ORG_ID)
  })

  afterEach(() => {
    toolRegistry.deleteByPrefix([ORG_ID])
    appCapabilitiesRegistry.deleteByPrefix([ORG_ID])
  })

  it("registers `spawn_agent` in toolRegistry with kernel:agents:spawn scope", () => {
    const entry = toolRegistry.get([ORG_ID, "kernel", "spawn_agent"])
    expect(entry).toBeDefined()
    expect(entry!.requiredScopes).toEqual(["kernel:agents:spawn"])
    expect(entry!.appName).toBe("kernel")
    expect(typeof entry!.handler).toBe("function")
    // params validates the spec'd shape (spawn_agent registers a Zod-like schema)
    const spawnParams = entry!.params
    if (!spawnParams || !("safeParse" in spawnParams)) {
      throw new Error("spawn_agent params should expose safeParse")
    }
    const validParse = spawnParams.safeParse({
      subagent_type: "investigator",
      description: "JIRA-1234",
      prompt: "Investigate this ticket carefully.",
    })
    expect(validParse.success).toBe(true)
    const tooShortLabel = spawnParams.safeParse({
      subagent_type: "investigator",
      description: "x",
      prompt: "Investigate this ticket carefully.",
    })
    expect(tooShortLabel.success).toBe(false)
  })

  // `agent.spawn` is now a kernel-universal capability — `spawn_agent` registers
  // and surfaces in EVERY org with no app install required.
  it("buildToolSet INCLUDES kernel__spawn_agent with NO apps installed (kernel-universal)", () => {
    // spawn_agent is deferred: the catalog is built as a turn that discovered it.
    const tools = buildToolSet(
      ORG_ID,
      userActor(["kernel:agents:spawn"]),
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
    )
    expect(tools.kernel__spawn_agent).toBeDefined()
  })

  it("buildToolSet still respects the actor's scope (no kernel:agents:spawn → hidden)", () => {
    // Actor lacks `kernel:agents:spawn` → tool stays hidden by the existing scope filter,
    // even though the capability is universal.
    // Unlocked, so only the scope filter can be what hides it.
    const tools = buildToolSet(
      ORG_ID,
      userActor(["unrelated:scope"]),
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
    )
    expect(tools.kernel__spawn_agent).toBeUndefined()
  })

  // DEFECT 1a — spawn_agent structurally requires ctx.agentExecutionThreadId
  // (spawn-agent-tool.ts's handler chains the new sub-run off the parent's run
  // frame) and can never succeed from an external MCP client, which has no
  // in-process agent execution thread. It must be excluded from the outbound
  // MCP gateway projection so external clients never see (and call) it.
  it("audience:'gateway' EXCLUDES kernel__spawn_agent even with full scope + discovery unlocked", () => {
    const actor = userActor(["kernel:agents:spawn"])
    const agentTools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "agent")
    expect(agentTools.kernel__spawn_agent).toBeDefined()

    const gatewayTools = buildToolSet(
      ORG_ID,
      actor,
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "gateway",
    )
    expect(gatewayTools.kernel__spawn_agent).toBeUndefined()
  })

  it("registers spawn_agent with requiresAgentExecutionThread:true", () => {
    const entry = toolRegistry.get([ORG_ID, "kernel", "spawn_agent"])
    expect(entry!.requiresAgentExecutionThread).toBe(true)
  })
})

// DEFECT 1b — the out-of-context guard itself: calling handleSpawnAgent
// without ctx.agentExecutionThreadId must throw the typed, non-retryable
// SpawnAgentContextError (code "invalid_context") rather than a bare Error,
// and the handler's own log call must be at warn — never error — so a mere
// caller-context mistake does not page the on-call operator (mirrors the
// prod incident of 2026-07-15).
describe("spawn_agent — out-of-context invocation", () => {
  it("throws SpawnAgentContextError with code invalid_context when agentExecutionThreadId is missing", async () => {
    const promise = handleSpawnAgent(
      { subagent_type: "investigator", description: "no thread", prompt: "test prompt body" },
      {
        userId: "00000000-0000-0000-0000-000000da06a2",
        orgId: "00000000-0000-0000-0000-000000da06a1",
        actorType: "agent",
        scopes: ["kernel:agents:spawn"],
        // agentExecutionThreadId intentionally omitted
      },
    )
    await expect(promise).rejects.toThrow(SpawnAgentContextError)
    await expect(promise).rejects.toMatchObject({
      code: "invalid_context",
      retryable: false,
    })
  })

  it("logs at warn, never at error, when called out of context", async () => {
    const errSpy = spyOn(appsLogger, "error")
    // The tool's own module logger (modules/agent/subruns/spawn-agent-tool.ts) is a
    // child of rootLogger — spy on the shared warn implementation it inherits.
    const warnSpy = spyOn(Object.getPrototypeOf(appsLogger), "warn")
    try {
      await handleSpawnAgent(
        { subagent_type: "investigator", description: "no thread", prompt: "test prompt body" },
        {
          userId: "00000000-0000-0000-0000-000000da06a2",
          orgId: "00000000-0000-0000-0000-000000da06a1",
          actorType: "agent",
          scopes: ["kernel:agents:spawn"],
        },
      ).catch(() => {})
      expect(warnSpy).toHaveBeenCalled()
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})
