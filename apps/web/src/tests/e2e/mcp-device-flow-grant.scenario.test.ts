// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 12 S4 — Headless device-flow grant establishes an MCP connection with
// no browser on the client (success criterion 2; C1 device grant). The
// device-flow client must be in DEVICE_FLOW_CLIENTS — the fixture serverEnv
// sets it to "*" (S4-only, inert elsewhere).
import { expect, test } from "./fixtures/test"
import {
  closeMcpClient,
  initiateAndApproveDeviceGrant,
  mcpClientFromToken,
  pollDeviceGrant,
} from "./helpers/mcp-client"

function ks(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

test("device-flow grant establishes an MCP connection (no browser on client)", async ({
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const clientId = `e2e-device-${Date.now()}`

  const { deviceCode } = await initiateAndApproveDeviceGrant(env, qa, {
    clientId,
  })

  // Poll until approved (server enforces a 1s per-device-code rate-limit → the
  // expect.poll interval is ≥ 1.1s; bounded timeout, never a bare sleep).
  let accessToken = ""
  let refreshToken = ""
  await expect
    .poll(
      async () => {
        const r = await pollDeviceGrant(env.serverUrl, deviceCode, clientId)
        if (r.status === "approved") {
          accessToken = r.accessToken ?? ""
          refreshToken = r.refreshToken ?? ""
        }
        return r.status
      },
      { timeout: 30_000, intervals: [1100, 1100, 1100, 1100, 1100] },
    )
    .toBe("approved")

  expect(accessToken.length).toBeGreaterThan(20)
  expect(refreshToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/)

  let conn: Awaited<ReturnType<typeof mcpClientFromToken>> | null = null
  try {
    // Positive structural distinction (spec's load-bearing "MCP connection,
    // not a login session"): a mcp_connections row exists for admin whose
    // client_id is the `mcp:`-prefixed device client.
    const rows = (await env.db.sql.unsafe(
      `SELECT id, client_id, revoked_at FROM ${ks(env)}.mcp_connections
       WHERE user_id = $1 AND org_id = $2 AND client_id = $3`,
      [qa.admin.id, orgId, `mcp:${clientId}`],
    )) as Array<{ id: string; client_id: string; revoked_at: Date | null }>
    expect(rows.length, `expected an mcp_connections row with client_id mcp:${clientId}`).toBe(1)
    expect(rows[0]!.client_id).toBe(`mcp:${clientId}`)
    expect(rows[0]!.revoked_at).toBeNull()

    // The device-flow request row was consumed/deleted (single-consume).
    const dfRows = (await env.db.sql.unsafe(
      `SELECT id FROM ${ks(env)}.device_flow_requests WHERE device_code = $1`,
      [deviceCode],
    )) as Array<{ id: string }>
    expect(dfRows.length, "device-flow request must be single-consumed").toBe(0)

    // The device-minted token produces a functionally identical connection to
    // the auth-code path: meta-tools + a known non-gated tool.
    conn = await mcpClientFromToken(env.serverUrl, accessToken)
    const { tools } = (await conn.client.listTools()) as {
      tools: Array<{ name: string }>
    }
    const names = tools.map((t) => t.name)
    expect(names).toContain("liaison_tool_search")
    expect(names).toContain("liaison_approval_status")
  } finally {
    await closeMcpClient(conn)
  }
})
