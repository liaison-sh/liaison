// SPDX-License-Identifier: FSL-1.1-ALv2
// The decision is a pure function of the approval row, tested without a database
// or a module mock (a `mock.module` here would replace ~/db for every later file
// sharing the unit process).
import { describe, expect, test } from "bun:test"
import {
  judgeOriginatingApproval,
  ORIGINATING_APPROVAL_TOOLS,
  type OriginatingApprovalRow,
  verifyOriginatingApproval,
} from "./originating-approval"

const args = (approvalId: unknown) => ({ orgId: "o1", callerApp: "invoicing", approvalId })
const judge = (row: OriginatingApprovalRow | undefined, sendParams?: unknown) =>
  judgeOriginatingApproval(row, { callerApp: "invoicing", sendParams })

describe("verifyOriginatingApproval", () => {
  test("mail:composeForApp is covered", () => {
    expect(ORIGINATING_APPROVAL_TOOLS.has("mail:composeForApp")).toBe(true)
  })
  test("no id is the app's own automatic flow", async () => {
    expect((await verifyOriginatingApproval(args(null))).ok).toBe(true)
    expect((await verifyOriginatingApproval(args(""))).ok).toBe(true)
  })
  test("a made-up id is refused", async () => {
    expect((await verifyOriginatingApproval(args("not-a-uuid"))).ok).toBe(false)
    // A well-formed id that names no approval of the org.
    expect(judge(undefined).ok).toBe(false)
  })
  test("pending, denied or another app's approval is refused", () => {
    expect(judge({ tool_name: "invoicing:documents_send_to_customer", status: "pending" }).ok).toBe(
      false,
    )
    expect(judge({ tool_name: "shopify:refunds_create", status: "approved" }).ok).toBe(false)
  })
  test("an approved approval of the calling app passes", () => {
    expect(
      judge({ tool_name: "invoicing:documents_send_to_customer", status: "approving" }).ok,
    ).toBe(true)
  })
  test("an approval decided more than a day ago no longer authorises a send", () => {
    const row = {
      tool_name: "invoicing:documents_send_to_customer",
      status: "approved",
      decided_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    }
    expect(judge(row).ok).toBe(false)
  })
  test("when the approval named recipients, the send may only go to them", () => {
    const row = {
      tool_name: "invoicing:documents_send_to_customer",
      status: "approving",
      decided_at: new Date().toISOString(),
      current_payload: { document_id: "d1", to: "ap@buyer.example" },
    }
    expect(judge(row, { to: ["AP@buyer.example"] }).ok).toBe(true)
    expect(judge(row, { to: ["ap@buyer.example"], bcc: ["x@evil.example"] }).ok).toBe(false)
  })
})
