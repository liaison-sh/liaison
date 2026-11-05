// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { runRoutineSupervisor } from "~/modules/agent/routines/routine-supervisor"

function scriptedInvoker(reasons: string[]) {
  let i = 0
  const calls: Array<{ budget: { maxSteps: number; timeoutMs: number } }> = []
  const invoke = async (a: { perTurnBudget: { maxSteps: number; timeoutMs: number } }) => {
    calls.push({ budget: a.perTurnBudget })
    const reason = reasons[Math.min(i, reasons.length - 1)]
    i += 1
    return { finishReason: reason, turnsAdded: 1 }
  }
  return { invoke, calls }
}

describe("runRoutineSupervisor", () => {
  test("continues while finishReason==='length', stops on 'stop', sums turnsAdded", async () => {
    const s = scriptedInvoker(["length", "length", "stop"])
    const res = await runRoutineSupervisor({
      invokeTurn: s.invoke,
      policy: {
        maxTurns: 8,
        perTurnBudget: { maxSteps: 25, timeoutMs: 120_000 },
        deadlineMs: 540_000,
      },
      checkCredits: async () => null,
      now: () => Date.now(),
    })
    expect(s.calls.length).toBe(3)
    expect(res.turnsAdded).toBe(3)
    expect(res.finalFinishReason).toBe("stop")
    expect(res.stoppedBy).toBe("completion")
  })
  test("stops at maxTurns even if the model never says 'stop' (non-terminating guard)", async () => {
    const s = scriptedInvoker(["length"])
    const res = await runRoutineSupervisor({
      invokeTurn: s.invoke,
      policy: {
        maxTurns: 3,
        perTurnBudget: { maxSteps: 10, timeoutMs: 60_000 },
        deadlineMs: 540_000,
      },
      checkCredits: async () => null,
      now: () => Date.now(),
    })
    expect(s.calls.length).toBe(3)
    expect(res.stoppedBy).toBe("maxTurns")
  })
  test("stops at deadline before maxTurns (wall-clock safety bound ≤ 540s)", async () => {
    const s = scriptedInvoker(["length"])
    let t = 0
    const res = await runRoutineSupervisor({
      invokeTurn: s.invoke,
      policy: {
        maxTurns: 100,
        perTurnBudget: { maxSteps: 10, timeoutMs: 60_000 },
        deadlineMs: 540_000,
      },
      checkCredits: async () => null,
      now: () => {
        t += 200_000
        return t
      },
    })
    expect(res.stoppedBy).toBe("deadline")
    expect(s.calls.length).toBeLessThanOrEqual(3)
  })
  test("re-checks credit BETWEEN turns and stops on exhaustion (credit-drain guard)", async () => {
    const s = scriptedInvoker(["length", "length", "length"])
    let n = 0
    const res = await runRoutineSupervisor({
      invokeTurn: s.invoke,
      policy: {
        maxTurns: 8,
        perTurnBudget: { maxSteps: 10, timeoutMs: 60_000 },
        deadlineMs: 540_000,
      },
      checkCredits: async () => (++n >= 2 ? "no_credits" : null),
      now: () => Date.now(),
    })
    expect(res.stoppedBy).toBe("credits")
    expect(s.calls.length).toBe(1)
  })
})
