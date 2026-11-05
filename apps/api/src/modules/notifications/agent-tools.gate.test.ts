// SPDX-License-Identifier: FSL-1.1-ALv2
// The context gate of the notification tools: reading your OWN settings runs
// wherever you are the caller (a live turn, or your MCP client with no agent
// run around it, or their own question relayed from an external app); changing
// them stays live-turn only. Before 2026-09-29 a read over MCP was refused like
// a write. The refusal copy itself is pinned in agent-tools.refusal.test.ts.
import { describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { type NotificationToolContext, REFUSAL, refuseOutsideInteractiveTurn } from "./agent-tools"

const ctx = {
  userId: crypto.randomUUID(),
  orgId: crypto.randomUUID(),
  db: {} as never,
  actorType: "user",
} as NotificationToolContext

function frame(extra: Partial<RunContext> = {}): RunContext {
  const runId = crypto.randomUUID()
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, ...extra }
}

const inFrame = <T>(f: RunContext | null, fn: () => T): T => (f ? runContextStore.run(f, fn) : fn())

describe("refuseOutsideInteractiveTurn", () => {
  it("lets the person read their own settings with no agent run around the call (MCP)", () => {
    expect(inFrame(null, () => refuseOutsideInteractiveTurn(ctx, "read"))).toBeNull()
  })

  it("lets the person read in their live turn", () => {
    expect(inFrame(frame(), () => refuseOutsideInteractiveTurn(ctx, "read"))).toBeNull()
  })

  it("lets the person read when their own question is relayed from an external app", () => {
    const relayed = frame({ coordinated: true, coordinatedBy: "external-app" })
    expect(inFrame(relayed, () => refuseOutsideInteractiveTurn(ctx, "read"))).toBeNull()
    expect(inFrame(relayed, () => refuseOutsideInteractiveTurn(ctx, "change"))?.error.message).toBe(
      REFUSAL.externalApp,
    )
  })

  it("still refuses a change with no live turn", () => {
    const r = inFrame(null, () => refuseOutsideInteractiveTurn(ctx, "change"))
    expect(r?.error.code).toBe("E_INTERACTIVE_ONLY")
    expect(r?.error.message).toBe(REFUSAL.outsideTurn)
  })

  it("refuses a read where someone else asks, with copy true for a read", () => {
    const cases: Array<[RunContext | null, NotificationToolContext]> = [
      [frame({ routineId: crypto.randomUUID() }), ctx],
      [null, { ...ctx, originRoutineId: crypto.randomUUID() }],
      [frame({ coordinated: true, coordinatedBy: "agent" }), ctx],
      [frame({ background: true }), ctx],
      [frame({ nestingDepth: 1 }), ctx],
    ]
    for (const [f, c] of cases) {
      const r = inFrame(f, () => refuseOutsideInteractiveTurn(c, "read"))
      expect(r?.error.code).toBe("E_INTERACTIVE_ONLY")
      expect(r?.error.message).toContain("can only be read or changed")
    }
  })
})
