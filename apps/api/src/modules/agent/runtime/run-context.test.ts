// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  currentRunContext,
  inheritedRunFields,
  type RunContext,
  runAnswersPerson,
  runContextStore,
} from "~/modules/agent/runtime/run-context"

describe("runContextStore — ALS round-trip", () => {
  it("returns undefined outside any agent run", () => {
    expect(currentRunContext()).toBeUndefined()
  })

  it("propagates the parent run id into nested async callbacks", async () => {
    const frame: RunContext = {
      runId: "parent-run-1",
      parentRunId: null,
      rootRunId: "parent-run-1",
      nestingDepth: 0,
    }
    const seen: RunContext | undefined = await runContextStore.run(frame, async () => {
      // Cross an async boundary — ALS must survive it.
      await Promise.resolve()
      return currentRunContext()
    })
    expect(seen).toEqual(frame)
  })

  it("nested run() shadows the outer frame inside its callback only", async () => {
    const outer: RunContext = {
      runId: "outer",
      parentRunId: null,
      rootRunId: "outer",
      nestingDepth: 0,
    }
    const inner: RunContext = {
      runId: "inner",
      parentRunId: "outer",
      rootRunId: "outer",
      nestingDepth: 1,
    }

    const { innerSeen, afterInnerSeen } = await runContextStore.run(outer, async () => {
      const innerSeen = await runContextStore.run(inner, async () => currentRunContext())
      const afterInnerSeen = currentRunContext()
      return { innerSeen, afterInnerSeen }
    })

    expect(innerSeen).toEqual(inner)
    expect(afterInnerSeen).toEqual(outer)
  })

  it("RunContext accepts the optional agent effective-scope fields", async () => {
    const frame: RunContext = {
      runId: "run-1",
      parentRunId: null,
      rootRunId: "run-1",
      nestingDepth: 0,
      agentId: "agent-1",
      agentCeiling: ["tickets:read", "tickets:write"],
      effectiveScope: ["tickets:read"],
    }

    const seen = await runContextStore.run(frame, () => currentRunContext())

    expect(seen).toEqual(frame)
    expect(seen?.effectiveScope).toEqual(["tickets:read"])
  })
})

describe("inheritedRunFields", () => {
  const base: RunContext = { runId: "r", parentRunId: null, rootRunId: "r", nestingDepth: 0 }

  it("carries the run's token account (by reference) into a turn", () => {
    const tokenAccount = { id: "a", tokenBudget: null, hardTokenLimit: 9, used: 0 }
    const got = inheritedRunFields({
      ...base,
      tokenAccount,
      routineId: "not-inherited",
    })
    expect(got).toEqual({ tokenAccount })
    expect(got.tokenAccount).toBe(tokenAccount)
  })

  it("carries nothing from a frame without them, or from no frame", () => {
    expect(inheritedRunFields(base)).toEqual({})
    expect(inheritedRunFields(undefined)).toEqual({})
  })
})

describe("runAnswersPerson", () => {
  const base: RunContext = { runId: "r", parentRunId: null, rootRunId: "r", nestingDepth: 0 }
  it("counts the turn an approved call hands back as the person's ask", () => {
    expect(runAnswersPerson({ ...base, humanTurn: true })).toBe(true)
    expect(runAnswersPerson({ ...base, background: true, answersApprovedCall: true })).toBe(true)
  })
  it("never counts a routine tick, an agent's ask, a sub-run or a plain background turn", () => {
    expect(runAnswersPerson({ ...base, background: true })).toBe(false)
    const handed = { ...base, background: true, answersApprovedCall: true } as const
    expect(runAnswersPerson({ ...handed, routineId: "x" })).toBe(false)
    expect(runAnswersPerson({ ...handed, coordinated: true })).toBe(false)
    expect(runAnswersPerson({ ...handed, nestingDepth: 1 })).toBe(false)
  })
})
