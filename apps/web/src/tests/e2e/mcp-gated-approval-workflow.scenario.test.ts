// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 12 S2 — Gated tool → approve via the production decide endpoint →
// pull the decided result via the MCP `liaison_approval_status` meta-tool →
// revoke the connection in the real Settings UI → refresh_token blocked
// immediately (no 15-min wait).
//
// Gated tool = `test:gatedCreateItem` (sdk `test__gatedCreateItem`): the
// canonical gated MUTATION the MCP backend itself validates — gated:true,
// performs a real `items:created` mutation through the RPC bridge (so the
// decided execution's audit row carries actorType:'mcp', spec C7 /
// success-criterion 7), persists a decided `{ id }` result, runs through the
// real executeTool → approval → runApprovedToolHandler →
// approved_handler_executions.result write, with no unrelated tickets-SMTP/
// connected-account dependency. admin (granted test:approve) is an eligible
// approver → selfApproveEligible must be true.
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { freshAccessToken } from "./helpers/fresh-token"
import { closeMcpClient, establishMcpConnection, oauthToken } from "./helpers/mcp-client"
import { grantTicketsScopes } from "./helpers/seed"

function ks(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

test("gated tool: approve -> pull decided result -> revoke -> refresh 401", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const stamp = Date.now()
  // Grant admin the test-app scopes to invoke the gated tool AND to
  // self-approve it (test:approve → eligibleApprovers includes admin →
  // selfApproveEligible:true). Dimensions mirror the proven gated pattern.
  await grantTicketsScopes(
    env,
    orgId,
    qa.admin.id,
    ["test:items:read", "test:items:write", "test:gated:write", "test:approve"],
    { "test:team": ["*"], "test:sensitivity": ["*"] },
  )

  let conn: Awaited<ReturnType<typeof establishMcpConnection>> | null = null
  try {
    conn = await establishMcpConnection(env, qa, { clientName: "E2E S2" })

    const itemTitle = `S2 gated item ${stamp}`
    const start = Date.now()
    const callRes = (await conn.client.callTool({
      name: "test__gatedCreateItem",
      arguments: { title: itemTitle, team: "alpha" },
    })) as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
    }
    const elapsed = Date.now() - start
    // Immediate structured return (sub-second), NOT an error, NOT a long-poll.
    expect(elapsed, `gated callRes=${JSON.stringify(callRes)}`).toBeLessThan(10_000)
    expect(callRes.isError, `gated callRes=${JSON.stringify(callRes)}`).toBeFalsy()

    const sc = callRes.structuredContent ?? {}
    expect(sc.gated, `sc=${JSON.stringify(sc)} full=${JSON.stringify(callRes)}`).toBe(true)
    const scDump = `sc=${JSON.stringify(sc)}`
    expect(sc.executed, scDump).toBe(false)
    expect(typeof sc.approvalRequestId, scDump).toBe("string")
    expect((sc.approvalRequestId as string).length, scDump).toBeGreaterThan(0)
    expect(typeof sc.reason, scDump).toBe("string")
    expect((sc.reason as string).length, scDump).toBeGreaterThan(0)
    // admin holds test:approve → eligible self-approver.
    expect(sc.selfApproveEligible).toBe(true)
    // approvalUrl is API-origin /threads/<id> — assert it is a well-formed URL
    // on serverUrl (do NOT navigate it; the API origin serves no SPA).
    expect(typeof sc.approvalUrl).toBe("string")
    const approvalUrl = new URL(sc.approvalUrl as string)
    expect(`${approvalUrl.protocol}//${approvalUrl.host}`).toBe(new URL(env.serverUrl).origin)
    expect(approvalUrl.pathname).toMatch(/^\/threads\/[0-9a-f-]+$/)

    const approvalRequestId = sc.approvalRequestId as string

    // The approval_requests row exists, pending, anchored to a real thread (C8).
    const arRows = (await env.db.sql.unsafe(
      `SELECT id, status, tool_name, thread_id FROM ${ks(env)}.approval_requests
       WHERE id = $1 AND org_id = $2`,
      [approvalRequestId, orgId],
    )) as Array<{ status: string; tool_name: string; thread_id: string | null }>
    expect(arRows.length).toBe(1)
    expect(arRows[0]!.status).toBe("pending")
    expect(arRows[0]!.tool_name).toBe("test:gatedCreateItem")
    expect(arRows[0]!.thread_id).toBeTruthy()
    const threadRows = (await env.db.sql.unsafe(`SELECT id FROM ${ks(env)}.threads WHERE id = $1`, [
      arRows[0]!.thread_id,
    ])) as Array<{ id: string }>
    expect(threadRows.length).toBe(1)

    // Approve via the production decide endpoint (real runApprovedToolHandler).
    const decideToken = await freshAccessToken(env.serverUrl, qa.admin.email, "12345678")
    // An approve is bound to the payload the person was shown.
    const shown = await api(env.serverUrl, `/api/approvals/${approvalRequestId}`, {
      token: decideToken,
    })
    const decided = await api(env.serverUrl, `/api/approvals/${approvalRequestId}/decide`, {
      method: "POST",
      token: decideToken,
      body: { decision: "approve", payloadHash: shown.body?.data?.payloadHash },
    })
    expect(decided.status, JSON.stringify(decided.body)).toBe(200)

    // Pull the decided outcome via the MCP path (NOT by re-invoking the tool).
    await expect
      .poll(
        async () => {
          const r = (await conn!.client.callTool({
            name: "liaison_approval_status",
            arguments: { approvalRequestId },
          })) as { structuredContent?: Record<string, unknown> }
          return r.structuredContent?.state
        },
        { timeout: 30_000, intervals: [500, 1000, 1500, 2000] },
      )
      .toBe("approved")

    const statusRes = (await conn.client.callTool({
      name: "liaison_approval_status",
      arguments: { approvalRequestId },
    })) as { structuredContent?: Record<string, unknown> }
    const status = statusRes.structuredContent ?? {}
    expect(status.state).toBe("approved")
    // result must deep-contain evidence the tool actually ran (gatedCreateItem
    // returns the created item, incl. its title) — proving the net-new
    // approved_handler_executions.result persistence works end-to-end.
    expect(status.result, JSON.stringify(status)).toBeTruthy()
    expect(JSON.stringify(status.result)).toContain(itemTitle)

    // Audit C7 split: the executed gated mutation = actorType 'mcp' + actor_id
    // = admin; the approval-request CREATE event = actorType 'user'.
    // Audit rows land via the 1s outbox worker (pending_events → audit_log),
    // so poll until the test-app mutation row materializes.
    // Scope the audit read to THIS test's window. Playwright reuses a worker
    // across files and `audit_log` accumulates per-org — an unscoped
    // `WHERE org_id` picks up `test`/`mcp` rows from earlier phase12 tests and
    // makes the `every(actor_id === admin)` assertion flake. `start` is
    // captured just before the gated tool call, so every row this flow
    // produces (approval create, decided mutation) has `timestamp >= start`.
    const auditSince = new Date(start).toISOString()
    const fetchAudit = async () =>
      (await env.db.sql.unsafe(
        `SELECT actor_type, actor_id, app, entity_type, action FROM ${ks(env)}.audit_log
         WHERE org_id = $1 AND timestamp >= $2`,
        [orgId, auditSince],
      )) as Array<{
        actor_type: string
        actor_id: string | null
        app: string | null
        entity_type: string | null
        action: string
      }>
    // Audit rows land via the 1s outbox worker — poll until the decided gated
    // mutation's MCP-attributed row materializes (success criterion 7).
    await expect
      .poll(
        async () =>
          (await fetchAudit()).filter((r) => r.app === "test" && r.actor_type === "mcp").length,
        { timeout: 25_000, intervals: [500, 1000, 1500, 2000] },
      )
      .toBeGreaterThan(0)
    const auditRows = await fetchAudit()
    const mcpMutations = auditRows.filter((r) => r.app === "test" && r.actor_type === "mcp")
    expect(mcpMutations.every((r) => r.actor_id === qa.admin.id)).toBe(true)
    // Spec C7 divergence (the load-bearing assertion): the executed gated
    // mutation is attributed to MCP (asserted above), while the approval
    // LIFECYCLE is never attributed to MCP — every approval_request audit row
    // is actor_type 'user' (action format "${entity}.${action}", see
    // event-subscribers.ts). At least one approval_request row must exist for
    // this decided flow, and none may be 'mcp'.
    const approvalAudit = auditRows.filter((r) => r.entity_type === "approval_request")
    expect(
      approvalAudit.length,
      `expected ≥1 approval_request audit row; audit=${JSON.stringify(auditRows.map((r) => ({ e: r.entity_type, ac: r.action, t: r.actor_type })))}`,
    ).toBeGreaterThan(0)
    expect(approvalAudit.every((r) => r.actor_type === "user")).toBe(true)
    expect(approvalAudit.some((r) => r.actor_type === "mcp")).toBe(false)

    // ── Revoke through the real Settings UI ───────────────────────────────
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/settings/mcp`)
    await page.waitForURL(/\/settings/)
    const row = page.getByTestId(`mcp-connection-row-${conn.connectionId}`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    // The Revoke button is a sibling inside the enclosing mcp-connection-row.
    const container = page
      .getByTestId("mcp-connection-row")
      .filter({ has: page.getByTestId(`mcp-connection-row-${conn.connectionId}`) })
    await container.getByRole("button", { name: "Revoke" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Revoke connection")).toBeVisible()
    await dialog.getByRole("button", { name: "Revoke" }).click()

    // Optimistic removal + the connection is revoked in DB.
    await expect(row).toHaveCount(0, { timeout: 10_000 })
    await expect
      .poll(async () => {
        const r = (await env.db.sql.unsafe(
          `SELECT revoked_at FROM ${ks(env)}.mcp_connections WHERE id = $1`,
          [conn!.connectionId],
        )) as Array<{ revoked_at: Date | null }>
        return r[0]?.revoked_at === null ? "active" : "revoked"
      })
      .toBe("revoked")

    // refresh_token grant must fail IMMEDIATELY (mint re-reads revoked_at; no
    // 15-min wait) → HTTP 400 invalid_grant.
    const refresh = await oauthToken(env.serverUrl, {
      grant_type: "refresh_token",
      refresh_token: conn.refreshToken,
    })
    expect(refresh.status).toBe(400)
    expect(refresh.body.error).toBe("invalid_grant")

    // The Settings page no longer lists the revoked row (active-only, N8).
    await page.reload()
    await page.waitForURL(/\/settings/)
    await expect(page.getByTestId("mcp-connect-section")).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByTestId(`mcp-connection-row-${conn.connectionId}`)).toHaveCount(0)
  } finally {
    await closeMcpClient(conn)
  }
})
