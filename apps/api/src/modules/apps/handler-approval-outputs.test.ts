// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A conditionally gated tool parks itself (ctx.requestApproval) and returns
// `{ status: "pending_approval", approval_id }` as data. The agent must still get
// the @ref tokens and the chaining recipe, or it cannot chain a later step on it
// (a quote parked by its threshold, then the reply attaching its PDF).
import { describe, expect, it } from "bun:test"
import { buildRefToken } from "@liaison/shared"
import { chainStepAdmits, withHandlerApprovalGuidance } from "~/modules/agent/tools/tool-bridge"
import { withHandlerApprovalOutputs } from "~/modules/apps/execute-tool"

const ID = "6f1c2a8e-3b4d-4c5e-8f9a-0b1c2d3e4f5a"

describe("handler-parked approval outputs", () => {
  it("adds the @ref tokens of every declared output", () => {
    const out = withHandlerApprovalOutputs(
      { referenceableOutputs: ["number", "pdf_file_id"] },
      { status: "pending_approval", approval_id: ID },
    ) as Record<string, unknown>
    expect(out.outputs).toEqual({
      number: buildRefToken(ID, "number"),
      pdf_file_id: buildRefToken(ID, "pdf_file_id"),
    })
    expect(typeof out.hint).toBe("string")
  })

  it("leaves results alone when nothing is parked or nothing is referenceable", () => {
    const done = { status: "completed", number: "Q-1" }
    expect(withHandlerApprovalOutputs({ referenceableOutputs: ["number"] }, done)).toBe(done)
    const parked = { status: "pending_approval", approval_id: ID }
    expect(withHandlerApprovalOutputs({ referenceableOutputs: [] }, parked)).toBe(parked)
    expect(withHandlerApprovalOutputs({}, parked)).toBe(parked)
  })

  it("tells the agent it has not run and how to chain on the tokens", () => {
    const withOutputs = withHandlerApprovalOutputs(
      { referenceableOutputs: ["pdf_file_id"] },
      { status: "pending_approval", approval_id: ID },
    )
    const guided = withHandlerApprovalGuidance(withOutputs) as Record<string, unknown>
    expect(guided.message).toContain("HAS NOT RUN")
    expect(guided.message).toContain(buildRefToken(ID, "pdf_file_id"))
    expect(guided.message).toContain("TO CHAIN A LATER STEP")
    const plain = { status: "completed" }
    expect(withHandlerApprovalGuidance(plain)).toBe(plain)
  })
})

describe("a routine run chaining on a parked call", () => {
  it("runs only calls that park for a decision or cite a token", () => {
    expect(chainStepAdmits("mail:reply", { gated: true }, {})).toBe(true)
    expect(chainStepAdmits("invoicing:quote_create_and_issue", { conditionalGate: true }, {})).toBe(
      true,
    )
    const attachments = [buildRefToken(ID, "pdf_file_id")]
    expect(chainStepAdmits("files:share", {}, { attachments })).toBe(true)
    expect(chainStepAdmits("contacts:update", {}, { name: "Ines" })).toBe(false)
    expect(chainStepAdmits("contacts:update", { gated: false }, {})).toBe(false)
    // The next step's tool is often deferred: looking it up is not refused.
    expect(chainStepAdmits("kernel:tool_search", {}, { query: "select:x" })).toBe(true)
  })
})
