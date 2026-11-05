// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A GATED TOOL CALL MUST NOT BE ACCEPTED WHEN THE DATA IT NEEDS IS MISSING.
// capture_business_knowledge is gated, so its params are parked on an approval
// card a human decides LATER. Anything checkable up front is checked at staging
// (execute-tool runs `tool.preflight` before createApprovalRequest), so the
// agent is corrected in its own loop instead of the approver being handed a
// card that errors on approve.
import { describe, expect, it } from "bun:test"
import { captureBusinessKnowledgePreflight } from "~/modules/agent/tools/org-config-tools"

describe("capture_business_knowledge preflight", () => {
  it("accepts a complete capture", async () => {
    const r = await captureBusinessKnowledgePreflight({
      title: "Support SLAs",
      body: "8h first response.",
      dimensions: { team: "support", sensitivity: "internal" },
    })
    expect(r).toEqual({})
  })

  it("accepts a capture with no dimensions (the handler supplies the internal default)", async () => {
    expect(await captureBusinessKnowledgePreflight({ title: "T", body: "B" })).toEqual({})
  })

  it("rejects an empty title or body before an approval is parked", async () => {
    expect(
      (await captureBusinessKnowledgePreflight({ title: "   ", body: "B" })) as { error?: string },
    ).toHaveProperty("error")
    expect(
      (await captureBusinessKnowledgePreflight({ title: "T", body: "" })) as { error?: string },
    ).toHaveProperty("error")
  })

  it("rejects an unknown sensitivity value", async () => {
    const r = (await captureBusinessKnowledgePreflight({
      title: "T",
      body: "B",
      dimensions: { sensitivity: "secret" },
    })) as { error?: string }
    expect(r.error).toContain("sensitivity")
  })

  it("rejects confidential/restricted, which this tool cannot share with any role", async () => {
    // The Knowledge create guard rejects a confidential doc with no
    // shareWithRoles, and this tool has no parameter for them: staging it would
    // guarantee a failure on approve. Point the agent at the knowledge create
    // tool instead, at staging time.
    for (const sensitivity of ["confidential", "restricted"]) {
      const r = (await captureBusinessKnowledgePreflight({
        title: "2026 Margin Analysis",
        body: "numbers",
        dimensions: { sensitivity },
      })) as { error?: string }
      expect(r.error).toContain("shareWithRoles")
    }
  })
})
