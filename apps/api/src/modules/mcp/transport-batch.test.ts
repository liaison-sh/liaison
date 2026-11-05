// SPDX-License-Identifier: FSL-1.1-ALv2
// One HTTP request to the MCP transport is one unit of work for the rate
// limiters in front of it (per user, per org). A JSON-RPC batch puts many MCP
// requests into that one HTTP request, so each limiter token buys a batch's
// worth of tool work. The MCP protocol revision 2025-06-18 dropped JSON-RPC
// batching; the transport must answer at most one request per HTTP request.
import { afterAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { createMcpConnection, mintAccessToken } from "~/modules/mcp/connection-service"
import { cleanupSeededOrg, grantScope, seedOrgWithUser } from "~/modules/mcp/test-helpers"

const orgs: string[] = []
afterAll(async () => {
  for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
})

function countResponses(text: string): number {
  // The SDK answers a batch as one JSON array, or as SSE `data:` frames.
  const trimmed = text.trim()
  if (trimmed.startsWith("[")) return (JSON.parse(trimmed) as unknown[]).length
  if (trimmed.startsWith("{")) return 1
  let n = 0
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = JSON.parse(line.slice(5)) as unknown
    n += Array.isArray(payload) ? payload.length : 1
  }
  return n
}

describe("MCP transport: one HTTP request carries one MCP request", () => {
  it("does not execute a 100-message JSON-RPC batch sent in a single request", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    await grantScope(orgId, userId, "kernel:threads:read")
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "batch-probe",
      label: "Batch probe",
    })
    const { token } = await mintAccessToken(connection.id)
    const batch = Array.from({ length: 100 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "tools/list",
      params: {},
    }))
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify(batch),
    })
    const text = await res.text()
    const answered = res.status >= 200 && res.status < 300 ? countResponses(text) : 0
    // Secure behaviour: the batch is refused (4xx), or at most one of its
    // messages is executed. At the audit SHA all 100 run.
    expect(answered).toBeLessThanOrEqual(1)
  }, 60_000)
})
