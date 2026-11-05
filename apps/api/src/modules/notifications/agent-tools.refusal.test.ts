// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The interactive-only refusal of the notification settings tools says what is
// TRUE for the turn it refuses, because the agent turns it into the reply.
//
// Pinned by a production DM: a person asked their own agent from an external
// MCP client; the refusal called that "a question from another agent" and told
// them to "ask in their own chat" while the question already sat in it. The
// agent repeated both, then tried to `agents_ask` itself.
import { describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { type NotificationToolContext, REFUSAL, refuseOutsideInteractiveTurn } from "./agent-tools"

const ctx = {
  userId: crypto.randomUUID(),
  orgId: crypto.randomUUID(),
  db: {} as never,
  actorType: "agent",
} satisfies NotificationToolContext

function refusalIn(extra: Partial<RunContext> | null): string | null {
  if (extra === null) return refuseOutsideInteractiveTurn(ctx)?.error.message ?? null
  const runId = crypto.randomUUID()
  const frame: RunContext = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    ...extra,
  }
  return runContextStore.run(frame, () => refuseOutsideInteractiveTurn(ctx)?.error.message ?? null)
}

describe("notification tools interactive-only refusal", () => {
  it("still allows a live turn a person started", () => {
    expect(refusalIn({})).toBeNull()
  })

  it("keeps the guard for a question relayed from an external app, and says so", () => {
    const message = refusalIn({ coordinated: true, coordinatedBy: "external-app" })
    expect(message).toBe(REFUSAL.externalApp)
    expect(message).toContain("external app")
    // Never the false reason, never the advice to go where the person already is.
    expect(message).not.toContain("another agent asked")
    expect(message).not.toContain("their own chat")
    // Actionable: where to look, where to ask, and no self-ask.
    expect(message).toContain("Settings > Notifications")
    expect(message).toContain("Liaison app")
    expect(message).toContain("yourself included")
    expect(message).toContain("language of the person's message")
  })

  it("names a colleague's question only when a colleague asked", () => {
    const message = refusalIn({ coordinated: true, coordinatedBy: "agent" })
    expect(message).toBe(REFUSAL.agentAsk)
    expect(message).toContain("another agent asked you")
  })

  it("says read or changed, since the read tool refuses too", () => {
    for (const extra of [
      { coordinated: true, coordinatedBy: "external-app" as const },
      { routineId: crypto.randomUUID() },
      { background: true },
      null,
    ]) {
      expect(refusalIn(extra)).toContain("read or changed")
    }
  })
})
