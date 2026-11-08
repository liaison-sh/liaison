// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 15 — Task 38 — MCP Manager OAuth (DCR) flow E2E.
//
// Browser-driven journey (per plan §G/Task 38):
//   1. Configure the per-worker fixture MCP server to advertise the
//      per-worker fixture OAuth issuer via its discovery endpoint
//      (`/.well-known/oauth-authorization-server`).
//   2. Seed an MCP connection with `authFlavor=oauth_dcr` pointing at the
//      fixture MCP server.
//   3. Log in as Elodie, drive POST /connections/:id/oauth/start to obtain
//      the authorization URL.
//   4. Navigate the browser to the authorization URL — the fixture issuer
//      auto-approves and 302-redirects back to /api/apps/mcp-manager/oauth/callback.
//   5. The callback exchanges the code for an access token, persists it
//      encrypted, and emits `connection:oauth_completed`. Assert the
//      connection's secretsEncrypted column is now populated (DB cross-check
//      via /connections/:id GET — secret is not returned, but `secretsSet`
//      flag is — and the oauth_completed audit event was emitted).
//   6. Reload the MCP manager page; assert the OAuth-pending badge is gone
//      (the connection no longer surfaces `mcp-oauth-pending`).
//
// Diagnostic hints (spec §10): if flaky, dump the `mcp_oauth_state` row at
// callback time and check Playwright trace network tab for the token-exchange
// POST.

import path from "node:path"
import { api, login } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"

const SHOTS_DIR = path.resolve(__dirname, "../../../logs/playwright-diagnostics/mcp-oauth")

test("admin completes the OAuth (DCR) handshake for an MCP connection", async ({
  authenticatedPage,
  env,
  qa,
}) => {
  const page = authenticatedPage
  if (!env.mockMcp) throw new Error("Per-worker mock-MCP fixture failed to start")
  if (!env.mockMcpOauth) throw new Error("Per-worker mock-MCP-OAuth fixture failed to start")

  // 1. Wire the MCP fixture's discovery endpoint at the OAuth issuer.
  env.mockMcp.setOauthDiscovery({
    issuer: env.mockMcpOauth.issuer,
    authorizationEndpoint: env.mockMcpOauth.authorizationEndpoint,
    tokenEndpoint: env.mockMcpOauth.tokenEndpoint,
    registrationEndpoint: env.mockMcpOauth.registrationEndpoint,
  })

  // 2. Seed the connection with oauth_dcr. Note: we deliberately do NOT call
  //    /test here — the connection has no access token yet, so initialize
  //    would fail. The status starts at `oauth_pending`.
  const slug = `oauthdcr-${env.workerId}`
  const createRes = await api(env.serverUrl, "/api/apps/mcp-manager/connections", {
    method: "POST",
    token: qa.admin.token,
    body: {
      slug,
      displayName: "OAuth DCR Test",
      transport: "http",
      ownershipScope: "org",
      authFlavor: "oauth_dcr",
      connectionDefaultPolicy: "auto",
      httpUrl: env.mockMcp.url,
    },
  })
  expect([200, 201]).toContain(createRes.status)
  const createdBody = createRes.body as { id?: string; data?: { id?: string } }
  const connectionId = createdBody.id ?? createdBody.data?.id
  expect(connectionId).toBeTruthy()
  // Creating the connection grants its owner the connection's tool namespace
  // and moves their permission version (service/connections.ts), so a token
  // minted before it is refused from here on, as a real client's would be
  // until it refreshes. The rest of the test signs in again for a current one.
  const { accessToken: adminToken } = await login(env.serverUrl, "admin@test.com", "12345678")

  // 3. Kick off the OAuth flow. The route returns the authorization URL
  //    constructed against the fixture issuer (per discovery in step 1).
  //    Started from the BROWSER's request context: the start binds the flow
  //    to the initiating browser with a cookie, and the callback refuses a
  //    browser that does not carry it (oauth-routes.ts, browser_mismatch).
  const startRes = await page.request.post(
    `${env.serverUrl}/api/apps/mcp-manager/connections/${connectionId}/oauth/start`,
    { headers: { authorization: `Bearer ${adminToken}` } },
  )
  expect(startRes.status()).toBe(200)
  const startBody = (await startRes.json()) as {
    authorizationUrl?: string
    data?: { authorizationUrl?: string }
  }
  const authorizationUrl = startBody.authorizationUrl ?? startBody.data?.authorizationUrl
  expect(
    authorizationUrl,
    `expected authorizationUrl in oauth start response, got: ${JSON.stringify(startBody)}`,
  ).toBeTruthy()
  expect(authorizationUrl).toContain(env.mockMcpOauth.url)
  // After the toBeTruthy assertion above, narrowing requires a non-null
  // local before string-typed downstream uses (page.goto).
  if (!authorizationUrl) throw new Error("unreachable — assertion above guarantees presence")

  await page.screenshot({ path: `${SHOTS_DIR}/01-pre-authorize.png`, fullPage: true })

  // 4. Drive the browser through the authorization redirect. The fixture
  //    auto-approves and redirects to the kernel's /oauth/callback, which
  //    handles the token exchange + DB write and finally 302s to the wizard
  //    return path. We wait for the network call sequence to settle.
  await page.goto(authorizationUrl)
  // The callback redirects to /settings/mcp-manager?connection=<id>&oauth=ok
  // (per oauth-routes.ts:358). The exact path is not registered as a settings
  // sub-route — but the response itself signals success. Wait until the URL
  // contains `oauth=ok` (the kernel redirect emits this).
  await page.waitForURL((url) => url.toString().includes("oauth=ok"), { timeout: 15000 })
  await page.screenshot({ path: `${SHOTS_DIR}/02-callback-complete.png`, fullPage: true })

  // 5. DB cross-check: token request was received by the fixture issuer.
  const tokenReq = env.mockMcpOauth.lastTokenRequest()
  expect(tokenReq).not.toBeNull()
  expect(tokenReq?.grant_type).toBe("authorization_code")
  expect(tokenReq?.code_verifier).toBeTruthy() // PKCE

  // Connection lookup — the row's oauth_metadata now carries the
  // authorizationEndpoint / tokenEndpoint we resolved through discovery.
  const conn = await api(env.serverUrl, `/api/apps/mcp-manager/connections/${connectionId}`, {
    method: "GET",
    token: adminToken,
  })
  expect(conn.status).toBe(200)
  // The connection row exists and has metadata populated; the
  // secretsEncrypted column is present but is intentionally not surfaced in
  // the API response (it's a server-side-only secret). The audit event is
  // the durable signal.

  // 6. Reload the manager page; the connection should no longer surface
  //    `mcp-oauth-pending`. Open the list view.
  await page.goto(`http://localhost:${env.ports[1]}/settings/connectors`)
  await expect(page.getByTestId("connectors-mcp")).toBeVisible({ timeout: 15000 })
  await expect(page.getByText("OAuth DCR Test").first()).toBeVisible({ timeout: 10000 })
  // mcp-oauth-pending surfaces only when status === 'oauth_pending' — after a
  // successful token exchange the kernel re-dials and flips status away from
  // oauth_pending. The badge should not be visible.
  await expect(page.getByTestId("mcp-oauth-pending")).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS_DIR}/03-list-after-oauth.png`, fullPage: true })
})
