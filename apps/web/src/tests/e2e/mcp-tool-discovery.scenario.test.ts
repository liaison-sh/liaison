// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 12 S3: the gateway catalog is complete on the first tools/list and
// survives the stateless reconnect, liaison_tool_search finds a deferLoading
// tool cold, and a reconnect reflects a permission change (criterion 10's
// event-driven half; Amendment 1). Does NOT assert in-stream
// notifications/tools/list_changed delivery (unit-only, catalog-notifier).
//
// The gateway audience defers nothing (spec-runtime: "Liaison's MCP gateway
// intentionally defers nothing"; unit guard tool-bridge.deferred-default.test.ts):
// `test-bridge-b__internalCallback` (deferLoading:true, scope
// test-bridge-b:thing:write) is the concrete deferLoading tool that must be
// callable from the first list, with no discovery round.
import { randomUUID } from "node:crypto"
import { createUserWithScopes } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"
import { closeMcpClient, establishMcpConnection, mcpClientFromToken } from "./helpers/mcp-client"

function ks(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

const DEFERRED = "test-bridge-b__internalCallback" // deferLoading:true, agentVisible (scope test-bridge-b:thing:write)

test("deferred discovery survives reconnect; reconnect reflects permission change", async ({
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  // Drive S3 as a DEDICATED, freshly-created user — never a shared QA user.
  // This is a permission-BOUNDARY test: it grants exactly three scopes, then
  // revokes one and asserts the catalog shrinks. A shared user (e.g. amina)
  // silently accumulates role grants from the ~90 test files that run before
  // this one; if any leaves her a tickets:tickets:write-bearing role, this
  // test's revoke — which only touches its own role — cannot reduce her
  // effective scope set and the assertion fails non-deterministically (passes
  // in isolation, fails in the full suite). A user owned entirely by this test
  // has exactly the scopes this test grants, so the revoke is observable and
  // deterministic. (admin/world-admin is also unusable here — his "*"
  // wildcard no scope revoke can reduce.)
  const PW = "QaPass1!"
  const subject = await createUserWithScopes(env.serverUrl, env.db.sql, world.admin.token, orgId, {
    email: `s3-subject-${randomUUID().slice(0, 8)}@e2e.local`,
    password: PW,
    name: "S3 Reconnect Subject",
    scopes: ["tickets:tickets:read", "tickets:tickets:write", "test-bridge-b:thing:write"],
    dimensions: { team: ["*"], sensitivity: ["restricted"] },
    schemaPrefix: env.schemaPrefix,
  })
  const consenter = { email: subject.email, password: PW }

  let conn: Awaited<ReturnType<typeof establishMcpConnection>> | null = null
  let reC: Awaited<ReturnType<typeof mcpClientFromToken>> | null = null
  let conn2: Awaited<ReturnType<typeof establishMcpConnection>> | null = null
  try {
    conn = await establishMcpConnection(env, qa, {
      clientName: "E2E S3",
      as: consenter,
    })

    const namesOf = async (client: {
      listTools: () => Promise<{ tools: Array<{ name: string }> }>
    }): Promise<string[]> => {
      const { tools } = (await client.listTools()) as {
        tools: Array<{ name: string }>
      }
      return tools.map((t) => t.name)
    }

    // ── Steps 1–3: complete first list, cold search, reconnect ─────────────
    const before = await namesOf(conn.client)
    expect(before).toContain("liaison_tool_search")
    expect(
      before,
      `${DEFERRED} (deferLoading) must be in the first tools/list; got ${before.join(",")}`,
    ).toContain(DEFERRED)
    expect(
      before,
      `test-bridge-b__callA (non-deferred, same scope) must be visible; got ${before.join(",")}`,
    ).toContain("test-bridge-b__callA")

    const searchRes = (await conn.client.callTool({
      name: "liaison_tool_search",
      arguments: { query: "internalcallback" },
    })) as {
      isError?: boolean
      structuredContent?: { tools?: Array<{ name: string }> }
    }
    expect(searchRes.isError).toBeFalsy()
    const found = searchRes.structuredContent?.tools ?? []
    expect(
      found.some((t) => t.name === DEFERRED),
      `liaison_tool_search must surface ${DEFERRED}; got ${JSON.stringify(found)}`,
    ).toBe(true)

    // Fresh stateless reconnect, SAME connection (same access token): the
    // catalog is still complete.
    reC = await mcpClientFromToken(env.serverUrl, conn.accessToken)
    const afterDiscovery = await namesOf(reC.client)
    expect(afterDiscovery, `${DEFERRED} must be present after search + reconnect`).toContain(
      DEFERRED,
    )
    expect(afterDiscovery).toContain("liaison_tool_search")

    // ── Steps 4–5: reconnect reflects a permission change (criterion 10) ────
    expect(afterDiscovery).toContain("tickets__create") // scope tickets:tickets:write

    // Revoke tickets:tickets:write from the subject's (sole) role. Deleting by
    // the user's role membership — not a captured role id — stays correct even
    // though createUserWithScopes owns the role internally.
    await env.db.sql.unsafe(
      `DELETE FROM ${ks(env)}.role_scope_grants
       WHERE scope = 'tickets:tickets:write'
         AND role_id IN (SELECT role_id FROM ${ks(env)}.user_roles WHERE user_id = $1)`,
      [subject.id],
    )
    await env.db.sql.unsafe(
      `UPDATE ${ks(env)}.users SET permission_version = permission_version + 1 WHERE id = $1`,
      [subject.id],
    )

    // A fresh reconnect re-mints via a NEW OAuth dance. The new access token
    // carries the reduced scope set DETERMINISTICALLY — no convergence loop:
    // mintAccessToken resolves scopes via loadEffectivePermissions, a plain
    // cache-free privileged DB read (apps/api/src/modules/permissions). The
    // role-scope DELETE above is already committed, so under Postgres
    // read-committed the freshly minted token embeds the reduced scopes with
    // no propagation window. The catalog `listTools` serves is filtered
    // straight from the token's embedded scopes — equally snapshot-exact.
    conn2 = await establishMcpConnection(env, qa, {
      clientName: "E2E S3b",
      as: consenter,
    })
    const afterRevoke = await namesOf(conn2.client)
    expect(afterRevoke).toContain("liaison_tool_search")
    expect(afterRevoke).toContain("liaison_approval_status")
    expect(
      afterRevoke,
      `tickets__create (write-scoped) must be gone after revoke; got ${afterRevoke.join(",")}`,
    ).not.toContain("tickets__create")
    // Read-scoped tickets:search is still visible (read scope retained) —
    // proves the reconnect reflects the CURRENT catalog, not a stale one.
    expect(afterRevoke).toContain("tickets__search")
  } finally {
    await closeMcpClient(conn)
    await closeMcpClient(reC)
    await closeMcpClient(conn2)
  }
})
