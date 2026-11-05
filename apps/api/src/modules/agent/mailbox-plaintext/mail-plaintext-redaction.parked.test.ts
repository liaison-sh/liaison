// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A mail send the gate parked for approval answers the model with the pending
// request's envelope: the approval id, its request-N handle and the status.
// Redacted whole (it names no mailbox, so the redaction fails closed), the
// persisted and streamed copy lost the approval id, and the conversation could
// draw no approval card under the agent's answer: after a reload the Mail tour's
// approve step found nothing to approve (walk D69). The envelope is not mail
// content and is kept; everything else in it (the summary of the draft, the
// message to the model, its notes) still goes. Pure: no database.
import { describe, expect, it } from "bun:test"
import { redactMailToolResult } from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"

const ORG = "44444444-4444-4444-4444-444444444444"
const APPROVAL = "8f6c2b1e-1d1f-4a6e-9a43-2c4f0e0b9d11"
const DRAFTED = "Hello Jane, your secret order ships tomorrow"

/** What the tool bridge hands the model for a gated mail send. */
const parked = {
  blocked: true,
  status: "pending_approval",
  reason: "gated",
  approvalRequestId: APPROVAL,
  approvalHandle: "request-7",
  selfApproveEligible: true,
  summary: { title: "Reply to Jane Doe", lines: [DRAFTED] },
  message: `GATED: ${DRAFTED}`,
  outputs: { body: DRAFTED },
  hint: DRAFTED,
}

describe("mail plaintext redaction: a send parked for approval", () => {
  it("keeps the pending request's envelope, so the conversation can draw its card", async () => {
    const out = (await redactMailToolResult(ORG, "mail__reply", parked)) as Record<string, unknown>
    expect(out.blocked).toBe(true)
    expect(out.status).toBe("pending_approval")
    expect(out.approvalRequestId).toBe(APPROVAL)
    expect(out.approvalHandle).toBe("request-7")
    expect(out.redacted).toBe(true)
  })

  it("drops everything that can carry the drafted mail", async () => {
    const out = await redactMailToolResult(ORG, "mail__reply", parked)
    expect(JSON.stringify(out)).not.toContain("secret")
    const keys = Object.keys(out as object)
    for (const key of ["summary", "message", "outputs", "hint"]) expect(keys).not.toContain(key)
  })

  it("keeps no envelope field that is not a plain id, handle or flag", async () => {
    const out = (await redactMailToolResult(ORG, "mail__reply", {
      ...parked,
      approvalRequestId: DRAFTED,
      approvalHandle: { text: DRAFTED },
      status: DRAFTED,
    })) as Record<string, unknown>
    expect(JSON.stringify(out)).not.toContain("secret")
  })

  it("redacts a result that only claims to be parked like any other", async () => {
    const out = (await redactMailToolResult(ORG, "mail__read", {
      blocked: false,
      approvalRequestId: APPROVAL,
      messages: [{ id: "m1", textBody: DRAFTED }],
    })) as Record<string, unknown>
    expect(out.approvalRequestId).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain("secret")
  })
})
