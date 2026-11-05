// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 12 S5 — Settings → MCP page visual goldens (success criterion 11;
// spec "Visual structure"). Five cropped goldens + interleaved functional
// assertions so a page that *looks* right but is broken still fails. Per-row
// wall-clock meta line is masked (deterministic via fixed far-past timestamps
// AND the mask — belt-and-suspenders).
import { randomUUID } from "node:crypto"
import { expect, loginAs, test } from "./fixtures/test"

function ks(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

async function seedConnection(
  env: {
    db: {
      sql: { unsafe: (q: string, p?: (string | number | boolean | null)[]) => Promise<unknown> }
    }
    schemaPrefix?: string
  },
  orgId: string,
  userId: string,
  opts: { label: string; lastUsedAtSql: string },
): Promise<string> {
  const id = randomUUID()
  await env.db.sql.unsafe(
    `INSERT INTO ${ks(env)}.mcp_connections
       (id, org_id, user_id, client_id, label, refresh_token_hash, discovered_tools,
        created_at, last_used_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, '{}',
        '2023-01-15T10:00:00Z', ${opts.lastUsedAtSql}, NULL)`,
    [id, orgId, userId, `cli-${id.slice(0, 8)}`, opts.label, "deadbeef".repeat(8)],
  )
  return id
}

test("Settings -> MCP page visual goldens", async ({ page, env, qa, world }) => {
  const orgId = world.org.id
  const uid = qa.admin.id

  // S5 owns the connection-list visual states deterministically. Other phase12
  // scenarios (S0/S2/S4) establish admin MCP connections in the same worker
  // schema, so start from a guaranteed clean slate for the empty-state golden.
  await env.db.sql.unsafe(
    `DELETE FROM ${ks(env)}.mcp_connections WHERE user_id = $1 AND org_id = $2`,
    [uid, orgId],
  )

  // ── 1. Empty state ────────────────────────────────────────────────────
  await loginAs(page, env, "admin@test.com", "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/settings/mcp`)
  await page.waitForURL(/\/settings/)
  await expect(page.getByTestId("mcp-connect-section")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("mcp-empty")).toBeVisible()
  await expect(page.getByTestId("settings-content")).toHaveScreenshot("mcp-settings-empty.png", {
    maxDiffPixelRatio: 0.02,
  })

  // ── 3. Connect-section detail (before seeding rows) ───────────────────
  // Functional: the CLI snippet must contain the server-provided base URL,
  // proving /mcp/connect-info rendered (not a hardcoded placeholder).
  await expect(page.getByTestId("mcp-cli-snippet")).toContainText(
    "claude mcp add --transport http liaison",
  )
  await expect(page.getByTestId("mcp-cli-snippet")).toContainText("/mcp")
  await expect(page.getByTestId("mcp-connect-section")).toHaveScreenshot(
    "mcp-settings-connect.png",
    { maxDiffPixelRatio: 0.02 },
  )

  // ── 2. Populated state ────────────────────────────────────────────────
  await seedConnection(env, orgId, uid, {
    label: "Claude Code on a-very-long-workstation-hostname-for-truncation",
    lastUsedAtSql: "'2023-02-01T09:30:00Z'",
  })
  await seedConnection(env, orgId, uid, {
    label: "Claude Desktop",
    lastUsedAtSql: "NULL", // "never"
  })
  await page.reload()
  await page.waitForURL(/\/settings/)
  await expect(page.getByTestId("mcp-connect-section")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("mcp-connection-row")).toHaveCount(2)
  // Functional: the masked meta line still carries real "ago"/"never" text.
  const metas = page.getByTestId("mcp-connection-row-meta")
  await expect(metas.first()).toContainText(/ago|never/)
  await expect(page.getByTestId("settings-content")).toHaveScreenshot(
    "mcp-settings-populated.png",
    {
      maxDiffPixelRatio: 0.02,
      mask: [page.getByTestId("mcp-connection-row-meta")],
    },
  )

  // ── 5. Revoke confirm dialog ──────────────────────────────────────────
  const firstRow = page.getByTestId("mcp-connection-row").first()
  await firstRow.getByRole("button", { name: "Revoke" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("Revoke connection")).toBeVisible()
  await expect(dialog).toHaveScreenshot("mcp-settings-revoke-confirm.png", {
    maxDiffPixelRatio: 0.02,
  })
  // Confirm → optimistic removal; on refetch the row stays gone (revoked in DB).
  await dialog.getByRole("button", { name: "Revoke" }).click()
  await expect(page.getByTestId("mcp-connection-row")).toHaveCount(1, {
    timeout: 10_000,
  })
  await page.reload()
  await page.waitForURL(/\/settings/)
  await expect(page.getByTestId("mcp-connection-row")).toHaveCount(1, {
    timeout: 15_000,
  })

  // ── 4. Connections-error state ────────────────────────────────────────
  // Intercept GET /api/mcp/connections only (NOT /api/mcp/connect-info, so the
  // connect section still renders its server URL). The component sets
  // listFailed(true) and suppresses mcp-empty.
  await page.route("**/api/mcp/connections", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "boom" } }),
        })
      : route.continue(),
  )
  await page.reload()
  await page.waitForURL(/\/settings/)
  await expect(page.getByTestId("mcp-connections-error")).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByTestId("mcp-connections-error")).toContainText(
    "Couldn't load connections. The connect instructions above still work.",
  )
  await expect(page.getByTestId("mcp-connect-section")).toBeVisible()
  await expect(page.getByTestId("mcp-empty")).toHaveCount(0)
  await expect(page.getByTestId("settings-content")).toHaveScreenshot(
    "mcp-settings-list-error.png",
    { maxDiffPixelRatio: 0.02 },
  )
  await page.unroute("**/api/mcp/connections")

  // ── Loading state (functional, race-free via a delayed fulfill) ───────
  await page.route("**/api/mcp/connections", async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    await new Promise((r) => setTimeout(r, 1500))
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    })
  })
  await page.reload()
  await page.waitForURL(/\/settings/)
  // While the list request is still pending, the connect section is visible
  // and the error region is NOT shown.
  await expect(page.getByTestId("mcp-connect-section")).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByTestId("mcp-connections-error")).toHaveCount(0)
  await page.unroute("**/api/mcp/connections")
})
