// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pins the worker-pool scheduling-class seam: tool-bridge.executeWrapper derives
// `priority` from the ALS RunContext.background flag and threads it into
// executeTool. A background-originated run (sub-agent, routine tick, job-driven
// re-invocation — all of which stamp background:true on their run frame) thus
// tags every tool it dispatches "background", so the SandboxWorkerPool's
// interactive reservation can keep it from starving live foreground tool calls.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { z } from "zod"
import type { ActorContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as executeToolModule from "~/modules/apps/execute-tool"

// Hermetic unit test: executeTool is mocked, so there is no DB / Meili / object-store /
// Redis dependency — deliberately NOT acquiring the integration test lock (which
// would boot docker infra this test does not touch). A distinct ORG_ID keeps the
// in-memory toolRegistry slice isolated from sibling suites.
const ORG_ID = "00000000-0000-0000-0000-0000000cb002"

const actor: ActorContext = {
  actorType: "user",
  userId: "user1",
  orgId: ORG_ID,
  scopes: ["test:items:read"],
  dimensionGrants: {},
}

const frame = (background?: boolean): RunContext => ({
  runId: "r1",
  parentRunId: null,
  rootRunId: "r1",
  nestingDepth: 0,
  background,
})

describe("tool-bridge — worker-pool priority derives from RunContext.background", () => {
  let captured: Array<Record<string, any>> = []
  let spy: ReturnType<typeof spyOn>

  beforeAll(() => {
    toolRegistry.set([ORG_ID, "test", "pingTool"], {
      appName: "test",
      name: "pingTool",
      description: "ping",
      requiredScopes: ["test:items:read"],
      handler: async () => ({ ok: true }),
      params: z.object({}),
    })
    // Intercept executeTool so the assertion is on the priority THREADED to it,
    // not on a real sandbox run (the worker pool's own reservation is covered by
    // worker-pool.test.ts — this proves the agent loop SUPPLIES the tag).
    spy = spyOn(executeToolModule, "executeTool").mockImplementation(async (args: any) => {
      captured.push(args)
      return { data: { ok: true } } as any
    })
  })

  afterEach(() => {
    captured = []
  })

  afterAll(() => {
    spy?.mockRestore()
    toolRegistry.deleteByPrefix([ORG_ID])
  })

  async function invokePing(runFrame?: RunContext) {
    const tools = buildToolSet(
      ORG_ID,
      actor,
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      runFrame,
    )
    await (tools.test__pingTool as { execute: (a: unknown) => Promise<unknown> }).execute({})
  }

  it("tags 'background' when the run frame is background (sub-run / routine / reinvoke)", async () => {
    await invokePing(frame(true))
    expect(captured).toHaveLength(1)
    expect(captured[0]?.priority).toBe("background")
  })

  it("tags 'interactive' when the run frame is foreground (background:false)", async () => {
    await invokePing(frame(false))
    expect(captured).toHaveLength(1)
    expect(captured[0]?.priority).toBe("interactive")
  })

  it("tags 'interactive' when there is no run frame (e.g. MCP gateway projection)", async () => {
    await invokePing(undefined)
    expect(captured).toHaveLength(1)
    expect(captured[0]?.priority).toBe("interactive")
  })
})
