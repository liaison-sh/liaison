// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 12 S0 — Smoke: real Vite app + real API + real Postgres.
// OAuth Authorization-Code (+PKCE) via the sole (authenticated) consent path →
// MCP `initialize` over the live Streamable-HTTP transport → `tools/list`.
//
// This is THE smoke test: it wires the cross-package SDK shim once, exercises
// the production consent handler once, and pins that the gateway defers
// nothing: a deferLoading tool is in the FIRST tools/list. Gates S1–S5.
import { expect, test } from "./fixtures/test"
import { closeMcpClient, establishMcpConnection } from "./helpers/mcp-client"
import { grantTicketsScopes } from "./helpers/seed"

function ks(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

test("smoke: OAuth auth-code -> MCP initialize -> tools/list", async ({ env, qa, world }) => {
  // Grant tickets:read (tickets__search owner-visible) AND
  // test-bridge-b:thing:write so `test-bridge-b__internalCallback`
  // (deferLoading:true) is in scope: the concrete proof that the gateway
  // audience defers nothing.
  await grantTicketsScopes(env, world.org.id, qa.admin.id, [
    "tickets:tickets:read",
    "test-bridge-b:thing:write",
  ])

  let conn: Awaited<ReturnType<typeof establishMcpConnection>> | null = null
  try {
    conn = await establishMcpConnection(env, qa, { clientName: "E2E Smoke" })

    // Refresh-token shape: `<uuid>.<secret>`.
    expect(typeof conn.accessToken).toBe("string")
    expect(conn.accessToken.length).toBeGreaterThan(20)
    expect(conn.refreshToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/)

    const { tools } = (await conn.client.listTools()) as {
      tools: Array<{ name: string; inputSchema?: unknown }>
    }
    const names = tools.map((t) => t.name)

    // Both synthesized meta-tools present by exact name.
    expect(names).toContain("liaison_tool_search")
    expect(names).toContain("liaison_approval_status")

    // A seeded non-gated tool with a real input schema — proves the projection
    // ran buildToolSet for THIS owner, not a static list.
    const search = tools.find((t) => t.name === "tickets__search")
    expect(search, `tickets__search missing; got: ${names.join(",")}`).toBeTruthy()
    expect(search?.inputSchema && typeof search.inputSchema === "object").toBe(true)
    expect(Object.keys(search?.inputSchema as object).length).toBeGreaterThan(0)

    // ── The gateway defers nothing ──────────────────────────────────────────
    // `test-bridge-b__internalCallback` is deferLoading:true, and its scope is
    // granted above. Over MCP it must be in the FIRST tools/list: a client that
    // snapshots the catalog at initialize and ignores
    // notifications/tools_list_changed (Claude Code does) would otherwise never
    // reach it. deferLoading is a context-budget device for the in-app agent
    // only (spec-runtime: "Liaison's MCP gateway intentionally defers nothing";
    // unit guard: tool-bridge.deferred-default.test.ts).
    const KNOWN_DEFERRED = "test-bridge-b__internalCallback"
    expect(
      names,
      `deferLoading tool ${KNOWN_DEFERRED} must be in the first tools/list; got ${names.join(",")}`,
    ).toContain(KNOWN_DEFERRED)

    // mcp_connections row exists for the owner, active, last_used stamped.
    const rows = (await env.db.sql.unsafe(
      `SELECT id, revoked_at, last_used_at FROM ${ks(env)}.mcp_connections
       WHERE user_id = $1 AND org_id = $2`,
      [qa.admin.id, world.org.id],
    )) as Array<{ id: string; revoked_at: Date | null; last_used_at: Date | null }>
    expect(rows.length).toBeGreaterThan(0)
    const active = rows.find((r) => r.revoked_at === null)
    expect(active, "an active (revoked_at IS NULL) connection row must exist").toBeTruthy()
    expect(active?.last_used_at).not.toBeNull()
  } finally {
    await closeMcpClient(conn)
  }
})
