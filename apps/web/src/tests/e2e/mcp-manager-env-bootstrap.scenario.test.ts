// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 15 — Task 39 — MCP env-bootstrap E2E.
//
// Browser-driven journey (per plan §G/Task 39):
//   1. Restart the worker's API process with `LIAISON_MCP_E2EFIX_*` env vars
//      pointing at the per-worker fixture MCP server and the just-seeded test
//      world's org id. (The world's org id is unknown at first boot — hence
//      the restart-with-env path, added to `WorkerEnv.restart()` for this test.)
//   2. The kernel's `runEnvBootstrap` parses the vars and upserts a row into
//      `mcp_connections` with `managed_by='env'`.
//   3. Log in as Elodie, open the MCP servers settings page.
//   4. Assert the env-managed connection surfaces with the
//      `mcp-managed-by-env-chip` badge visible (per plan: base-config fields
//      disabled; policy fields editable).

import path from "node:path"
import { api } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"

const SHOTS_DIR = path.resolve(__dirname, "../../../logs/playwright-diagnostics/mcp-envboot")

test("env-bootstrapped MCP connection surfaces as managed-by-env in UI", async ({
  authenticatedPage,
  env,
  world,
  qa,
}) => {
  const page = authenticatedPage
  if (!env.mockMcp) throw new Error("Per-worker mock-MCP fixture failed to start")

  // 1. Restart the API with the env-bootstrap vars carrying the seeded org id.
  //    The slug suffix `_E2EFIX` becomes `e2efix` after lowercase normalization.
  const orgId = world.org.id
  await env.restart({
    env: {
      LIAISON_MCP_E2EFIX_TRANSPORT: "http",
      LIAISON_MCP_E2EFIX_DISPLAY_NAME: "Fixture (env)",
      LIAISON_MCP_E2EFIX_ORG: orgId,
      LIAISON_MCP_E2EFIX_URL: env.mockMcp.url,
      LIAISON_MCP_E2EFIX_AUTH: "none",
      LIAISON_MCP_E2EFIX_DEFAULT_POLICY: "auto",
    },
    timeoutMs: 45_000,
  })

  // 2. DB cross-check — the env-bootstrap path upserted the row with
  //    managed_by='env'. We list via the kernel API (admin token).
  const listRes = await api(env.serverUrl, "/api/apps/mcp-manager/connections", {
    method: "GET",
    token: qa.admin.token,
  })
  expect(listRes.status).toBe(200)
  const rows = (listRes.body as { data: Array<{ slug: string; managedBy: string }> }).data
  const envRow = rows.find((r) => r.slug === "e2efix")
  expect(
    envRow,
    `e2efix row not found in connections list; got slugs: ${rows.map((r) => r.slug).join(", ")}`,
  ).toBeDefined()
  expect(envRow?.managedBy).toBe("env")

  // 3. Load the settings page; the env-managed connection row is in the list.
  await page.goto(`http://localhost:${env.ports[1]}/settings/connectors`)
  await expect(page.getByTestId("connectors-mcp")).toBeVisible({ timeout: 15000 })
  await expect(page.getByText("Fixture (env)").first()).toBeVisible({ timeout: 10000 })
  await page.screenshot({ path: `${SHOTS_DIR}/01-env-bootstrapped.png`, fullPage: true })

  // 4. Open the server's page — the env-managed chip is rendered in its
  //    Configuration section per the spec's UI contract.
  await page.getByTestId("mcp-open-e2efix").click()
  await expect(page.getByTestId("mcp-detail-header")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("mcp-managed-by-env-chip")).toBeVisible({ timeout: 10000 })
  await page.screenshot({ path: `${SHOTS_DIR}/02-env-chip-visible.png`, fullPage: true })
})
