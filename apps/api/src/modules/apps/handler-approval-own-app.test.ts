// SPDX-License-Identifier: FSL-1.1-ALv2
// ctx.requestApproval parks an approval for one of the calling app's own tools.
// Naming another app's tool is refused before anything is written.
import { describe, expect, it } from "bun:test"
import { createHandlerApprovalRequest } from "~/modules/apps/execute-tool"

const ORG = "00000000-0000-0000-0000-0000000f0001"
const USER = "00000000-0000-0000-0000-0000000f0002"

function request(toolName: string) {
  return createHandlerApprovalRequest({
    orgId: ORG,
    requestedBy: USER,
    actorScopes: ["*"],
    defaultAppName: "widgets",
    input: {
      tool_name: toolName,
      summary: "Archive three widgets",
      current_payload: { amount: 1 },
    },
  })
}

describe("createHandlerApprovalRequest", () => {
  it("refuses a tool of another app", async () => {
    await expect(request("invoicing:invoice_issue")).rejects.toThrow(/own app's tools/)
    await expect(request("kernel:apiKeys_create")).rejects.toThrow(/own app's tools/)
  })
})
