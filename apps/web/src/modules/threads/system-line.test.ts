// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The chat list's last line is plain text: a mention reads `@Name`, not its
// `@[Name](user:<id>)` markup.
import { describe, expect, it } from "vitest"
import { localizeSystemLine, previewLine } from "~/modules/threads/system-line"

const t = ((key: string) => key) as Parameters<typeof previewLine>[1]

describe("previewLine", () => {
  it("renders the message markup as plain text", () => {
    expect(
      previewLine(
        "@[Recipient](user:11111111-1111-4111-8111-111111111111) see **this** [doc](https://x.test) `npm ci`",
        t,
      ),
    ).toBe("@Recipient see this doc npm ci")
  })
})

describe("localizeSystemLine: a withdrawn request", () => {
  const tv = ((key: string, vars?: Record<string, unknown>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key) as Parameters<typeof localizeSystemLine>[1]

  it("names the agent that withdrew it, never the person it acts for", () => {
    const meta = {
      type: "approval-decision",
      decision: "withdrawn",
      actorAgentId: "a1",
      actorAgentName: "Ada Lane's agent",
      reason: "stale",
    }
    expect(localizeSystemLine("Withdrawn by Ada Lane's agent. Reason: stale.", tv, meta)).toBe(
      'kernel.approvalDecisionLine.withdrawnByAgentReason {"agent":"kernel.agents.ownersAgent {\\"name\\":\\"Ada Lane\\"}","reason":"stale"}',
    )
    expect(
      localizeSystemLine("Withdrawn by Ada Lane's agent.", tv, { ...meta, reason: null }),
    ).toBe(
      'kernel.approvalDecisionLine.withdrawnByAgent {"agent":"kernel.agents.ownersAgent {\\"name\\":\\"Ada Lane\\"}"}',
    )
  })

  it("keeps the requester line for a person's own withdraw", () => {
    const meta = { type: "approval-decision", decision: "withdrawn", actorId: "u1", reason: null }
    expect(localizeSystemLine("Withdrawn by the requester.", tv, meta)).toBe(
      "kernel.approvalDecisionLine.withdrawn",
    )
  })
})
