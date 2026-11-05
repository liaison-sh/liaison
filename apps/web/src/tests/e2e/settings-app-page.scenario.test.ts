// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * An app's one settings page and the Connectors page (settings overhaul P2/P4),
 * end to end in the browser.
 *
 * Tickets: the signature saves on its own and is there after a reload, with
 * one audit row for the write; the categories tree takes a drag and keeps it
 * after Save and a reload; a member sees only their own section.
 * Connectors: `?open=gitlab` opens the GitLab card with its token form in it.
 * MCP: the stepped add flow against the e2e OAuth MCP server, once through
 * dynamic client registration and once with a pre-registered client.
 */

import { api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { freshAccessToken } from "./helpers/fresh-token"
import { grantSupportAgent } from "./helpers/settings-roles"

const QA_PASSWORD = "QaPass1!"
const SHOT = { maxDiffPixelRatio: 0.02 } as const
const PIXEL_BASELINES = process.platform === "darwin"

function ts(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}
function ks(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

test.describe("the Tickets settings page", () => {
  test("the signature saves on its own, survives a reload, and leaves one audit row", async ({
    authenticatedPage,
    env,
    world,
    qa,
  }) => {
    const page = authenticatedPage
    const text = `Best regards, Elodie ${Date.now()}`
    await page.goto(`http://localhost:${env.ports[1]}/settings/apps/tickets`)
    const input = page.getByTestId("settings-input-signature.text")
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.fill(text)
    await input.blur()
    await expect
      .poll(async () => {
        const r = await api(env.serverUrl, "/api/apps/tickets/settings/user", {
          token: qa.admin.token,
        })
        return (r.body as { data?: { values?: Record<string, unknown> } }).data?.values?.[
          "signature.text"
        ]
      })
      .toBe(text)
    await page.reload()
    await expect(page.getByTestId("settings-input-signature.text")).toHaveValue(text, {
      timeout: 15_000,
    })
    // One write, one audit row (the durable audit consumer runs off the outbox).
    await expect
      .poll(
        async () => {
          const [row] = (await env.db.sql.unsafe(
            `SELECT count(*)::int AS n FROM ${ks(env)}.audit_log
              WHERE org_id = $1 AND entity_type = 'app_setting'
                AND changes::text LIKE '%signature.text%'`,
            [world.org.id],
          )) as unknown as Array<{ n: number }>
          return row?.n ?? 0
        },
        { timeout: 15_000 },
      )
      .toBe(1)
  })

  test("a category dragged under another keeps its place after Save and a reload", async ({
    authenticatedPage,
    env,
    world,
  }) => {
    const stamp = Date.now()
    const [a] = (await env.db.sql.unsafe(
      `INSERT INTO ${ts(env)}.categories (id, org_id, parent_id, name, sort_order, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, NULL, $2, 0, now(), now()) RETURNING id`,
      [world.org.id, `Parent ${stamp}`],
    )) as unknown as Array<{ id: string }>
    const [b] = (await env.db.sql.unsafe(
      `INSERT INTO ${ts(env)}.categories (id, org_id, parent_id, name, sort_order, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, NULL, $2, 1, now(), now()) RETURNING id`,
      [world.org.id, `Child ${stamp}`],
    )) as unknown as Array<{ id: string }>
    if (!a || !b) throw new Error("categories not seeded")

    const page = authenticatedPage
    await page.goto(`http://localhost:${env.ports[1]}/settings/apps/tickets`)
    const section = page.getByTestId("settings-section-categories")
    const rowA = section.getByTestId(`tree-row-${a.id}`)
    const rowB = section.getByTestId(`tree-row-${b.id}`)
    await expect(rowB).toBeVisible({ timeout: 15_000 })
    await rowB.dragTo(rowA)
    await expect(section.getByTestId(`tree-row-${b.id}`)).toHaveAttribute("data-depth", "2")
    await expect(section.getByTestId("tree-dirty-bar")).toBeVisible()
    await section.getByTestId("tree-save").click()
    await expect(section.getByTestId("tree-dirty-bar")).toHaveCount(0, { timeout: 15_000 })
    await expect
      .poll(async () => {
        const rows = (await env.db.sql.unsafe(
          `SELECT parent_id::text AS parent FROM ${ts(env)}.categories WHERE id = $1`,
          [b.id],
        )) as unknown as Array<{ parent: string | null }>
        return rows[0]?.parent ?? null
      })
      .toBe(a.id)
    await page.reload()
    await expect(
      page.getByTestId("settings-section-categories").getByTestId(`tree-row-${b.id}`),
    ).toHaveAttribute("data-depth", "2", { timeout: 15_000 })
  })

  test("a member sees only their own section", async ({ page, env, world, qa }) => {
    await grantSupportAgent(env, world.org.id, qa.tobias.id)
    await loginAs(page, env, qa.tobias.email, QA_PASSWORD)
    await page.goto(`http://localhost:${env.ports[1]}/settings/apps/tickets`)
    await expect(page.getByTestId("settings-section-signature")).toBeVisible({ timeout: 15_000 })
    for (const id of ["inboxes", "categories", "response-times", "id-segments", "api-keys"]) {
      await expect(page.getByTestId(`settings-section-${id}`)).toHaveCount(0)
    }
    // The Tickets page as a support agent sees it: the header and their signature.
    if (PIXEL_BASELINES) {
      await expect(page.getByTestId("settings-content")).toHaveScreenshot(
        "settings-tickets-member.png",
        SHOT,
      )
    }
  })
})

test("Connectors ?open=gitlab opens the GitLab card with its token form", async ({
  authenticatedPage,
  env,
}) => {
  const page = authenticatedPage
  await page.goto(`http://localhost:${env.ports[1]}/settings/connectors?open=gitlab`)
  const body = page.getByTestId("connector-body-gitlab")
  await expect(body).toBeVisible({ timeout: 15_000 })
  // The token is asked for right there: no dialog, no other page.
  const connect = body.getByTestId("connections-connect-gitlab")
  await expect(connect).toBeVisible({ timeout: 15_000 })
  await connect.click()
  const inline = body.getByTestId("gitlab-inline-connect")
  await expect(inline).toBeVisible({ timeout: 10_000 })
  await expect(inline.getByTestId("connect-submit")).toBeVisible()
  await expect(page).toHaveURL(/\/settings\/connectors\?open=gitlab/)
  // The GitLab card open on its token form.
  if (PIXEL_BASELINES) {
    await expect(page.getByTestId("connector-card-gitlab")).toHaveScreenshot(
      "settings-connectors-gitlab-open.png",
      SHOT,
    )
  }
})

async function addMcpServer(page: Page, url: string, mode: "dcr" | "preregistered"): Promise<void> {
  await page.getByTestId("connectors-mcp-add").click()
  const flow = page.getByTestId("mcp-add-flow")
  await expect(flow).toBeVisible({ timeout: 15_000 })
  await flow.getByTestId("mcp-add-url").fill(url)
  await flow.getByTestId("mcp-add-check").click()
  await expect(flow.getByTestId(`mcp-add-mode-${mode}`)).toBeVisible({ timeout: 20_000 })
  if (mode === "preregistered") {
    await flow.getByTestId("mcp-add-client-id").fill("e2e-preregistered-client")
    const secret = flow.getByTestId("mcp-add-client-secret")
    if (await secret.count()) await secret.fill("e2e-preregistered-secret")
  }
  // The provider's sign-in opens in its own tab; the fixture issuer approves at once.
  const popup = page.context().waitForEvent("page")
  await flow.getByTestId("mcp-add-signin").click()
  const signIn = await popup
  await signIn.waitForURL(
    (u) => u.toString().includes("oauth=ok") || u.pathname.includes("/settings"),
    {
      timeout: 20_000,
    },
  )
  await signIn.close()
  await page.bringToFront()
  const tools = flow.getByTestId("mcp-add-tools")
  if (!(await tools.isVisible())) await flow.getByTestId("mcp-add-signed-in").click()
  await expect(tools).toBeVisible({ timeout: 20_000 })
  await page.getByTestId("mcp-tools-review-done").click()
}

test.describe("MCP add flow against the OAuth MCP server", () => {
  // The worker's mock MCP server is shared: leave it open for the next test.
  test.afterEach(({ env }) => {
    env.mockMcp?.clearOauthDiscovery()
    env.mockMcpOauth?.setRegistration(true)
  })

  test("dynamic client registration", async ({ authenticatedPage, env }) => {
    if (!env.mockMcp || !env.mockMcpOauth) throw new Error("mock MCP fixtures failed to start")
    env.mockMcp.setOauthDiscovery({
      issuer: env.mockMcpOauth.issuer,
      authorizationEndpoint: env.mockMcpOauth.authorizationEndpoint,
      tokenEndpoint: env.mockMcpOauth.tokenEndpoint,
      registrationEndpoint: env.mockMcpOauth.registrationEndpoint,
      requireBearer: true,
    })
    const page = authenticatedPage
    await page.goto(`http://localhost:${env.ports[1]}/settings/connectors`)
    await expect(page.getByTestId("connectors-mcp")).toBeVisible({ timeout: 15_000 })
    await addMcpServer(page, env.mockMcp.url, "dcr")
    expect(env.mockMcpOauth.lastTokenRequest()?.grant_type).toBe("authorization_code")
    // Adding the connection grants the admin its tool namespace and bumps their
    // permission_version, so the token minted before the test is stale (the
    // browser refreshes its own on the next call): read with a token minted now.
    const token = await freshAccessToken(env.serverUrl, "admin@test.com", "12345678")
    const list = await api(env.serverUrl, "/api/apps/mcp-manager/connections", { token })
    expect(list.status).toBe(200)
    const rows = ((list.body as { data?: unknown[] }).data ?? list.body) as Array<{
      httpUrl?: string
      status?: string
    }>
    expect(rows.some((r) => r.httpUrl === env.mockMcp?.url && r.status !== "oauth_pending")).toBe(
      true,
    )
  })

  test("a pre-registered client", async ({ authenticatedPage, env }) => {
    if (!env.mockMcp || !env.mockMcpOauth) throw new Error("mock MCP fixtures failed to start")
    // No registration endpoint: the server's own client must be entered.
    env.mockMcpOauth.setRegistration(false)
    env.mockMcp.setOauthDiscovery({
      issuer: env.mockMcpOauth.issuer,
      authorizationEndpoint: env.mockMcpOauth.authorizationEndpoint,
      tokenEndpoint: env.mockMcpOauth.tokenEndpoint,
      requireBearer: true,
    })
    const page = authenticatedPage
    await page.goto(`http://localhost:${env.ports[1]}/settings/connectors`)
    await expect(page.getByTestId("connectors-mcp")).toBeVisible({ timeout: 15_000 })
    await addMcpServer(page, env.mockMcp.url, "preregistered")
    expect(env.mockMcpOauth.lastTokenRequest()?.grant_type).toBe("authorization_code")
  })
})
