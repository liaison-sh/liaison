// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pins the terminal-failure circuit breaker: a tool that fails with a
// NON-RETRYABLE error (executeTool's `details.retryable === false`) is counted
// per toolName on the run frame, and once it crosses TERMINAL_FAILURE_LIMIT the
// bridge refuses further calls to it WITHOUT executing. This breaks the
// crash-loop-with-varied-args pattern (a weak model re-issuing a doomed write
// with a different id format each step, burning a full-context step per retry —
// the cause is config/state, invariant across args, so the tool+args counter
// never trips). It counts STEPS, not calls: parallel siblings of one step that
// fail alike are one model decision, so they never open it on their own.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { z } from "zod"
import type { ActorContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as executeToolModule from "~/modules/apps/execute-tool"

// Hermetic unit test: executeTool is mocked — no DB / sandbox infra, so no
// integration test lock. A distinct ORG_ID isolates the toolRegistry slice.
const ORG_ID = "00000000-0000-0000-0000-0000000cb003"

const actor: ActorContext = {
  actorType: "user",
  userId: "user1",
  orgId: ORG_ID,
  scopes: ["test:items:write"],
  dimensionGrants: {},
}

const freshFrame = (): RunContext => ({
  runId: crypto.randomUUID(),
  parentRunId: null,
  rootRunId: "root",
  nestingDepth: 0,
})

function terminalError(message: string): Error {
  const err = new Error(message) as Error & {
    status: number
    code: string
    details: { retryable: boolean }
  }
  err.status = 500
  err.code = "tool_error"
  err.details = { retryable: false }
  return err
}

function retryableError(message: string): Error {
  const err = new Error(message) as Error & {
    status: number
    code: string
    details: { retryable: boolean }
  }
  err.status = 400
  err.code = "invalid_params"
  err.details = { retryable: true }
  return err
}

describe("tool-bridge — terminal-failure circuit breaker", () => {
  let executions = 0
  let spy: ReturnType<typeof spyOn>
  let failWith: (() => Error) | null = null

  beforeAll(() => {
    toolRegistry.set([ORG_ID, "test", "doomedWrite"], {
      appName: "test",
      name: "doomedWrite",
      description: "A write that cannot succeed in this org's configuration",
      requiredScopes: ["test:items:write"],
      handler: async () => ({ ok: true }),
      params: z.object({ ref: z.string() }),
    })
    spy = spyOn(executeToolModule, "executeTool").mockImplementation(async () => {
      executions++
      if (failWith) throw failWith()
      return { data: { ok: true } } as any
    })
  })

  afterEach(() => {
    executions = 0
    failWith = null
  })

  afterAll(() => {
    spy.mockRestore()
    toolRegistry.delete([ORG_ID, "test", "doomedWrite"])
  })

  const buildTool = () => {
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const tool = tools.test__doomedWrite as {
      execute: (
        args: unknown,
        opts?: { toolCallId?: string; messages?: unknown[] },
      ) => Promise<unknown>
    }
    expect(tool).toBeDefined()
    return tool
  }

  it("blocks the 4th call after 3 non-retryable failures with VARIED args, without executing", async () => {
    failWith = () => terminalError("no_issuer_profile: configure invoicing settings first")
    const tool = buildTool()
    await runContextStore.run(freshFrame(), async () => {
      // Three attempts with three different arg shapes (the observed prod
      // pattern) — each executes and fails, each response carries the
      // non-retryable directive.
      for (const ref of ["#1846", "1846", "gid://shopify/Order/6295030399307"]) {
        const res = (await tool.execute({ ref })) as { error?: string }
        expect(res.error).toContain("no_issuer_profile")
        expect(res.error).toContain("NOT retryable")
      }
      expect(executions).toBe(3)
      // 4th call: breaker open — refused WITHOUT executing.
      const blocked = (await tool.execute({ ref: "yet-another-format" })) as { error?: string }
      expect(blocked.error).toContain("BLOCKED")
      expect(blocked.error).toContain("test:doomedWrite")
      expect(executions).toBe(3)
    })
  })

  // The AI SDK hands every call of one step the same `messages` (what the model
  // was sent for that step); the next step's list is longer. That is how the
  // bridge tells parallel siblings from a retry.
  const stepOpts = (step: number, call: number) => ({
    toolCallId: `call-${step}-${call}`,
    messages: Array.from({ length: 1 + step * 2 }, () => ({})),
  })

  it("parallel siblings failing alike in ONE step count once: the corrected call next step runs", async () => {
    // Observed live: in one step the agent issued three parallel creates without the
    // field the error names; all three failed the same way within milliseconds. The
    // next step retried correctly and was refused by the breaker, so nothing was made.
    failWith = () =>
      terminalError(
        "project_ambiguous: multiple active projects, and the call named none. A subtask: pass parentTaskId",
      )
    const tool = buildTool()
    await runContextStore.run(freshFrame(), async () => {
      const siblings = await Promise.all(
        ["Draft", "Review", "Publish"].map((ref, i) => tool.execute({ ref }, stepOpts(1, i))),
      )
      for (const res of siblings as Array<{ error?: string }>) {
        expect(res.error).toContain("project_ambiguous")
        expect(res.error).not.toContain("BLOCKED")
        // Three different calls made once each: no "STOP: Nth attempt" escalation.
        expect(res.error).not.toContain("STOP:")
      }
      expect(executions).toBe(3)
      failWith = null
      const retry = (await tool.execute({ ref: "Draft", parentTaskId: "T-1" }, stepOpts(2, 0))) as {
        error?: string
        ok?: boolean
      }
      expect(retry.error).toBeUndefined()
      expect(executions).toBe(4)
    })
  })

  it("identical parallel siblings are not 'repeated attempts' of one call", async () => {
    failWith = () => terminalError("no_issuer_profile: configure invoicing settings first")
    const tool = buildTool()
    await runContextStore.run(freshFrame(), async () => {
      const siblings = (await Promise.all(
        [0, 1, 2, 3].map((i) => tool.execute({ ref: "#1846" }, stepOpts(1, i))),
      )) as Array<{ error?: string }>
      for (const res of siblings) expect(res.error).not.toContain("STOP:")
    })
  })

  it("a genuine loop still trips: the same failing call repeated step after step", async () => {
    failWith = () => terminalError("no_issuer_profile: configure invoicing settings first")
    const tool = buildTool()
    await runContextStore.run(freshFrame(), async () => {
      for (const step of [1, 2, 3]) {
        // Even fanned out in parallel each step, the count is per step.
        await Promise.all([0, 1].map((i) => tool.execute({ ref: "#1846" }, stepOpts(step, i))))
      }
      expect(executions).toBe(6)
      const blocked = (await tool.execute({ ref: "#1846" }, stepOpts(4, 0))) as { error?: string }
      expect(blocked.error).toContain("BLOCKED")
      expect(executions).toBe(6)
    })
  })

  it("retryable failures do NOT trip the breaker", async () => {
    failWith = () => retryableError('"description" is required but was not provided.')
    const tool = buildTool()
    await runContextStore.run(freshFrame(), async () => {
      for (let i = 0; i < 5; i++) {
        const res = (await tool.execute({ ref: `attempt-${i}` })) as { error?: string }
        expect(res.error).not.toContain("BLOCKED")
        expect(res.error).not.toContain("NOT retryable")
      }
      expect(executions).toBe(5)
    })
  })

  it("the breaker is per-run: a fresh frame executes again", async () => {
    failWith = () => terminalError("issuer_not_found: issuer_profile x not found")
    const tool = buildTool()
    await runContextStore.run(freshFrame(), async () => {
      for (let i = 0; i < 3; i++) await tool.execute({ ref: `a${i}` })
      const blocked = (await tool.execute({ ref: "a3" })) as { error?: string }
      expect(blocked.error).toContain("BLOCKED")
    })
    expect(executions).toBe(3)
    // New run, new frame — the tool executes again (config may have been fixed
    // between runs; the breaker must not leak across runs).
    await runContextStore.run(freshFrame(), async () => {
      const res = (await tool.execute({ ref: "b0" })) as { error?: string }
      expect(res.error).toContain("issuer_not_found")
    })
    expect(executions).toBe(4)
  })

  it("without a run frame (no ALS context) calls still execute — breaker is a no-op", async () => {
    failWith = () => terminalError("no_issuer_profile: configure invoicing settings first")
    const tool = buildTool()
    for (let i = 0; i < 4; i++) {
      const res = (await tool.execute({ ref: `n${i}` })) as { error?: string }
      expect(res.error).not.toContain("BLOCKED")
    }
    expect(executions).toBe(4)
  })
})
