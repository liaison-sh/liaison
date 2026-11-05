// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MCP Manager add flow E2E (S25, prototype S-MCPADD).
//
// Browser-driven journey:
//   1. Log in as Elodie (admin).
//   2. Settings > Connectors, the organization's MCP servers block.
//   3. Add MCP server: enter the per-worker fixture MCP server's URL
//      (`env.mockMcp`, no auth); the probe finds an open server.
//   4. Connect: Liaison saves the connection and dials it; the Tools step
//      lists the `echo` tool the fixture exposes.
//   5. Done opens the new server's page; back on Connectors its row is
//      connected.
//
// The fixture MCP server lives at `apps/api/src/tests/e2e/helpers/mock-mcp.ts`
// and is bound to `127.0.0.1` (per memory `feedback_vite_ipv4_host`). Steps
// capture screenshots throughout per memory `feedback_chaos_screenshots`.

import path from "node:path"
import { expect, test } from "./fixtures/test"

const SHOTS_DIR = path.resolve(__dirname, "../../../logs/playwright-diagnostics/mcp-wizard")

test("admin adds an MCP server through the stepped flow and discovers tools", async ({
  authenticatedPage,
  env,
}) => {
  const page = authenticatedPage
  // 0. Fixture pre-conditions — the per-worker mock MCP server is up.
  if (!env.mockMcp) {
    throw new Error(
      "Per-worker mock-MCP fixture failed to start — see fixture stderr in logs/worker-*-stderr.log",
    )
  }
  const mcpUrl = env.mockMcp.url

  // 1. Settings > Connectors: the org's MCP servers (kernel:org:admin).
  await page.goto(`http://localhost:${env.ports[1]}/settings/connectors`)
  await expect(page.getByTestId("connectors-mcp")).toBeVisible({ timeout: 15000 })
  await page.screenshot({ path: `${SHOTS_DIR}/01-connectors.png`, fullPage: true })

  // 2. Open the add flow.
  await page.getByTestId("connectors-mcp-add").click()
  await expect(page.getByTestId("mcp-add-flow")).toBeVisible({ timeout: 5000 })

  // 3. The address; the probe finds an open server (no sign-in).
  await page.getByTestId("mcp-add-url").fill(mcpUrl)
  await page.getByTestId("mcp-add-check").click()
  await expect(page.getByTestId("mcp-add-mode-none")).toBeVisible({ timeout: 15000 })
  // A worker-unique name, so its handle collides with nothing else in the run.
  const name = `Test Echo ${env.workerId}`
  await page.getByTestId("mcp-add-name").fill(name)
  await page.screenshot({ path: `${SHOTS_DIR}/02-discovery.png`, fullPage: true })

  // 4. Connect: saved, dialled, and the Tools step lists the fixture's `echo`.
  await page.getByTestId("mcp-add-connect").click()
  await expect(page.getByTestId("mcp-add-tools")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId("mcp-tool-row-echo")).toBeVisible()
  await page.screenshot({ path: `${SHOTS_DIR}/03-tools.png`, fullPage: true })

  // 5. Done opens the server's page; its row on Connectors is connected.
  await page.getByTestId("mcp-tools-review-done").click()
  await expect(page.getByTestId("mcp-detail-header")).toContainText(name, { timeout: 10000 })
  await page.goto(`http://localhost:${env.ports[1]}/settings/connectors`)
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("mcp-status-connected").first()).toBeVisible({ timeout: 10000 })
  await page.screenshot({ path: `${SHOTS_DIR}/04-list-with-connection.png`, fullPage: true })
})
