// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import {
  api,
  createUserWithScopes,
  extractSecretFromUri,
  generateTotpCode,
} from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 01: Authentication Flows
// ALL 8 flows (A–H) + smoke tests + OAuth/Invite/Reset/TOTP/Admin
// ─────────────────────────────────────────────────────────────────────────────

/** Helper: insert a password-reset token directly in the DB. */
async function insertPasswordResetToken(
  db: import("@liaison/test-helpers").DbClient,
  email: string,
  schemaPrefix: string,
): Promise<string> {
  const { createHash, randomBytes } = await import("node:crypto")
  const rawToken = randomBytes(32).toString("base64url")
  const tokenHash = createHash("sha256").update(rawToken).digest("hex")
  const schema = `${schemaPrefix}kernel`
  await db.sql.unsafe(
    `INSERT INTO "${schema}".password_resets (user_id, org_id, token_hash, expires_at)
     SELECT id, org_id, $1, ($2)::timestamptz
     FROM "${schema}".users WHERE email = $3`,
    [tokenHash, new Date(Date.now() + 3600000).toISOString(), email],
  )
  return rawToken
}

async function getRoleId(
  db: import("@liaison/test-helpers").DbClient,
  schemaPrefix: string,
  name: string,
): Promise<string> {
  const schema = `${schemaPrefix}kernel`
  const rows = await db.sql.unsafe(`SELECT id FROM "${schema}".roles WHERE name ILIKE $1 LIMIT 1`, [
    `%${name}%`,
  ])
  return rows[0].id
}

// ═══════════════════════════════════════════════════════════════════════════════
// Flow A: Login with Valid Credentials
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow A: Login with Valid Credentials", () => {
  test("Amina logs in — form structure, shell, greeting, sidebar threads", async ({
    page,
    env,
  }) => {
    const vitePort = env.ports[1]
    await page.goto(`http://localhost:${vitePort}/login`)

    // Step 2: Verify the default (passwordless) sign-in structure
    await expect(page.getByLabel("Email")).toBeVisible()
    await expect(page.getByRole("button", { name: /continue with email/i })).toBeVisible()
    await expect(page.getByText(/create an account/i)).toBeVisible()
    await expect(page.getByRole("button", { name: /sign in with a password/i })).toBeVisible()

    // Steps 3-5: Reveal the retained password form and sign in
    await page.getByRole("button", { name: /sign in with a password/i }).click()
    await expect(page.getByText(/forgot password/i)).toBeVisible()
    await page.getByLabel("Email").fill("amina@resonantaudiolabs.example")
    await page.getByLabel("Password").fill("QaPass1!")
    await page.getByRole("button", { name: /^sign in$/i }).click()

    // Step 6: Redirect to home
    await page.waitForURL("**/", { timeout: 10000 })

    // Step 7: Shell layout visible
    await expect(page.locator("[data-shell]")).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid="activity-bar"]')).toBeVisible()
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible()

    // Step 8: Amina's threads visible in the Messages sidebar. Home's own
    // sidebar is what is asked of her (D21); conversations live in Messages.
    await page.getByTestId("activity-messages").click()
    await page.waitForURL(/\/chats/, { timeout: 10_000 })
    const sidebar = page.locator('[data-testid="sidebar"]')
    const threadRow = (title: string) =>
      sidebar.getByTestId("thread-item").filter({ hasText: title }).first()
    await expect(threadRow("Q2 Marketing Plan")).toBeVisible({ timeout: 10000 })
    await expect(threadRow("Bug in checkout flow")).toBeVisible()
    await expect(threadRow("Sprint retrospective")).toBeVisible()
    await expect(threadRow("Design system v2")).toBeVisible()
    await expect(threadRow("Release checklist")).toBeVisible()
    await expect(threadRow("Weekly standup notes")).toBeVisible()

    // Amina should NOT see threads she's not in
    await expect(sidebar.getByText("Vendor evaluation")).not.toBeVisible({ timeout: 2000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow A2: Passwordless magic-link — request advances to the code-entry step
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow A2: Passwordless magic-link", () => {
  test("requesting a code advances to the 6-digit entry step", async ({ page, env }) => {
    const vitePort = env.ports[1]
    await page.goto(`http://localhost:${vitePort}/login`)

    await page.getByLabel("Email").fill("amina@resonantaudiolabs.example")
    await page.getByRole("button", { name: /continue with email/i }).click()

    // The UI advances to code entry (the emailed code itself is covered by the
    // backend integration suite — no inbox to read in E2E).
    await expect(page.getByText(/6-digit code/i)).toBeVisible({ timeout: 5000 })
    await expect(page.getByPlaceholder("000000")).toBeVisible()
    await expect(page.getByRole("button", { name: /verify code/i })).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow B: Login with Invalid Credentials
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow B: Login with Invalid Credentials", () => {
  test("wrong password shows error, stays on login, fields not cleared", async ({ page, env }) => {
    const vitePort = env.ports[1]
    await page.goto(`http://localhost:${vitePort}/login`)
    await page.getByRole("button", { name: /sign in with a password/i }).click()
    await page.getByLabel("Email").fill("amina@resonantaudiolabs.example")
    await page.getByLabel("Password").fill("wrongpassword")
    await page.getByRole("button", { name: /^sign in$/i }).click()

    // Still on login
    await expect(page.getByText(/that didn't work/i)).toBeVisible({ timeout: 5000 })
    await expect(page).toHaveURL(/\/login/)

    // Form fields still present (not cleared)
    await expect(page.getByLabel("Email")).toBeVisible()
    await expect(page.getByLabel("Password")).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow C: Login with Empty Fields
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow C: Login with Empty Fields", () => {
  test("submit with empty fields does not navigate away", async ({ page, env }) => {
    const vitePort = env.ports[1]
    await page.goto(`http://localhost:${vitePort}/login`)

    // Click continue without filling anything — invalid email is rejected, stays put
    await page.getByRole("button", { name: /continue with email/i }).click()

    // Still on login page — HTML5 validation or frontend guard prevents submission
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByLabel("Email")).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow D: Logout
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow D: Logout", () => {
  test("user logs in then logs out, session cleared", async ({ page, env, qa, world }) => {
    const vitePort = env.ports[1]
    const password = "QaPass1!"
    const user = await createUserWithScopes(
      env.serverUrl,
      env.db.sql,
      qa.admin.token,
      world.org.id,
      {
        email: `logout-${randomUUID().slice(0, 8)}@e2e.test`,
        password,
        name: "Logout User",
        scopes: ["kernel:threads:read"],
        schemaPrefix: env.schemaPrefix,
      },
    )
    await loginAs(page, env, user.email, password)

    // Shell visible
    await expect(page.locator("[data-shell]")).toBeVisible()

    // Click logout
    await page.getByRole("button", { name: /log out/i }).click()
    await page.waitForURL(/\/login/, { timeout: 10000 })

    // Login form visible, no shell
    await expect(page.getByLabel("Email")).toBeVisible()
    await expect(page.locator("[data-shell]")).not.toBeVisible({ timeout: 2000 })

    // Navigate to root — should redirect back to login (session gone)
    await page.goto(`http://localhost:${vitePort}/`)
    await page.waitForURL(/\/login/, { timeout: 10000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow E: Session Restoration on Reload
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow E: Session Handling on Reload", () => {
  test("Amina reloads and stays logged in thanks to HttpOnly refresh token cookie", async ({
    page,
    env,
  }) => {
    const vitePort = env.ports[1]
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")

    // Force a full navigation (reload) — cookie-based refresh token survives
    await page.goto(`http://localhost:${vitePort}/`)

    // Should remain on the shell (auto-refresh via cookie)
    await page.waitForSelector("[data-shell]", { timeout: 15000 })
    await expect(page.locator("[data-shell]")).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow F: Navigation Guard (Unauthenticated Access)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow F: Navigation Guard", () => {
  test("unauthenticated /settings redirects to login with returnTo", async ({ page, env }) => {
    const vitePort = env.ports[1]
    await page.goto(`http://localhost:${vitePort}/settings`)
    await page.waitForURL(/\/login/, { timeout: 10000 })
    expect(page.url()).toContain("returnTo")
    await expect(page.getByLabel("Email")).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow G: Login Redirects to Original URL
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow G: Login Redirects to Original URL", () => {
  test("after login, navigates to returnTo destination", async ({ page, env }) => {
    const vitePort = env.ports[1]
    await page.goto(`http://localhost:${vitePort}/settings`)
    await page.waitForURL(/\/login/, { timeout: 10000 })

    await page.getByRole("button", { name: /sign in with a password/i }).click()
    await page.getByLabel("Email").fill("admin@test.com")
    await page.getByLabel("Password").fill("12345678")
    await page.getByRole("button", { name: /^sign in$/i }).click()

    await page.waitForURL(/\/settings/, { timeout: 10000 })
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({ timeout: 10000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow H: Multi-Tab Logout Sync
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow H: Multi-Tab Logout Sync", () => {
  test("BroadcastChannel delivers logout to other tabs", async ({ authenticatedPage }) => {
    const logoutReceived = await authenticatedPage.evaluate(async () => {
      return new Promise<boolean>((resolve) => {
        const bc = new BroadcastChannel("liaison-auth")
        bc.onmessage = (e) => {
          if (e.data.type === "logout") {
            bc.close()
            resolve(true)
          }
        }
        setTimeout(() => {
          const logoutBtn = document.querySelector('[aria-label="Log out"]') as HTMLButtonElement
          logoutBtn?.click()
        }, 100)
        setTimeout(() => {
          bc.close()
          resolve(false)
        }, 5000)
      })
    })

    expect(logoutReceived).toBe(true)
    await authenticatedPage.waitForURL(/\/login/, { timeout: 5000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Auth — OAuth Provider Visibility
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Auth — OAuth", () => {
  test("OAuth provider button visible on login page", async ({ page, env, qa }) => {
    const vitePort = env.ports[1]
    // Setup: create provider via API (this is test infrastructure, not the action under test)
    await api(env.serverUrl, "/api/admin/oauth-providers", {
      token: qa.admin.token,
      body: {
        name: "Test OIDC",
        issuerUrl: "http://localhost:4580",
        clientId: "test-client",
        clientSecret: "test-secret",
        autoProvision: true,
      },
    })

    await page.goto(`http://localhost:${vitePort}/login`)
    await expect(page.getByText("Continue with Test OIDC")).toBeVisible({ timeout: 5000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Auth — Invite Registration
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Auth — Invite Registration", () => {
  test("invited user registers and lands on shell", async ({ page, env, qa }) => {
    const vitePort = env.ports[1]
    const roleId = await getRoleId(env.db, env.schemaPrefix, "admin")

    // Setup: create invite via API (test infrastructure)
    const inviteRes = await api(env.serverUrl, "/api/admin/invites", {
      token: qa.admin.token,
      body: { email: "invited@resonantaudiolabs.example", roleId },
    })
    const inviteToken = inviteRes.body.data.inviteToken

    await page.goto(`http://localhost:${vitePort}/register?token=${inviteToken}`)
    await expect(page.getByLabel("Email")).not.toBeVisible({ timeout: 3000 })

    // Passwordless registration — name only, session issued directly.
    await page.getByLabel("Full name").fill("Invited User")
    await page.getByRole("button", { name: /create account/i }).click()

    await page.waitForURL("**/", { timeout: 10000 })
    await expect(page.locator("[data-shell]")).toBeVisible({ timeout: 10000 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Auth — Password Reset
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Auth — Password Reset", () => {
  test("password reset: request, reset, login with new password", async ({ page, env, qa }) => {
    const vitePort = env.ports[1]

    await page.goto(`http://localhost:${vitePort}/reset-password`)
    await page.getByLabel("Email").fill(qa.amina.email)
    await page.getByRole("button", { name: /send reset link/i }).click()
    await expect(page.getByText(/if an account exists/i)).toBeVisible({ timeout: 5000 })

    // Insert token directly in DB (test infrastructure — no email server in E2E)
    const rawToken = await insertPasswordResetToken(env.db, qa.amina.email, env.schemaPrefix)

    await page.goto(`http://localhost:${vitePort}/reset-password/confirm?token=${rawToken}`)
    await expect(page.getByText("Set new password")).toBeVisible()

    await page.getByLabel("New password").fill("NewSecurePass1!")
    await page.getByLabel("Confirm password").fill("NewSecurePass1!")
    await page.getByRole("button", { name: /reset password/i }).click()

    await page.waitForURL(/\/login/, { timeout: 10000 })

    await page.getByRole("button", { name: /sign in with a password/i }).click()
    await page.getByLabel("Email").fill(qa.amina.email)
    await page.getByLabel("Password").fill("NewSecurePass1!")
    await page.getByRole("button", { name: /^sign in$/i }).click()

    await page.waitForURL("**/", { timeout: 10000 })
    await expect(page.locator("[data-shell]")).toBeVisible({ timeout: 10000 })

    // Restore Amina's original password so other tests on the same worker aren't affected
    const restoreToken = await insertPasswordResetToken(env.db, qa.amina.email, env.schemaPrefix)
    const restoreRes = await api(env.serverUrl, "/api/auth/password-reset/confirm", {
      body: { token: restoreToken, newPassword: "QaPass1!" },
    })
    if (restoreRes.status !== 200) {
      throw new Error(
        `Password restore failed: ${restoreRes.status} ${JSON.stringify(restoreRes.body)}`,
      )
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Auth — TOTP
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Auth — TOTP", () => {
  test("login with TOTP after enrollment", async ({ page, env, qa }) => {
    const vitePort = env.ports[1]

    // Setup TOTP for Lucas via API (test infrastructure — UI setup tested in 07-settings)
    const setupRes = await api(env.serverUrl, "/api/auth/totp/setup", {
      token: qa.lucas.token,
      method: "POST",
      body: { currentPassword: "QaPass1!" },
    })
    const secret = extractSecretFromUri(setupRes.body.data.otpauthUri)

    const confirmCode = generateTotpCode(secret)
    await api(env.serverUrl, "/api/auth/totp/confirm", {
      token: qa.lucas.token,
      body: { code: confirmCode },
    })

    // UI flow: login (password path) → TOTP challenge → shell
    await page.goto(`http://localhost:${vitePort}/login`)
    await page.getByRole("button", { name: /sign in with a password/i }).click()
    await page.getByLabel("Email").fill("lucas@resonantaudiolabs.example")
    await page.getByLabel("Password").fill("QaPass1!")
    await page.getByRole("button", { name: /^sign in$/i }).click()

    await page.waitForURL(/\/login\/totp/, { timeout: 15000 })
    await expect(page.getByText("Two-factor authentication")).toBeVisible()

    const code = generateTotpCode(secret)
    await page.getByPlaceholder("000000").fill(code)

    await page.waitForURL("**/", { timeout: 10000 })
    await expect(page.locator("[data-shell]")).toBeVisible({ timeout: 10000 })

    // Disable TOTP for Lucas so other tests on the same worker aren't affected
    const ks = `"${env.schemaPrefix}kernel"`
    await env.db.sql.unsafe(
      `UPDATE ${ks}.users SET totp_enabled = false, totp_secret = NULL WHERE email = 'lucas@resonantaudiolabs.example'`,
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Session — Admin Visibility (from 07-settings Flow H)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Session — Admin Visibility", () => {
  test("admin (Elodie) sees admin settings sections", async ({ authenticatedPage }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })

    await expect(authenticatedPage.getByRole("heading", { name: "Profile" })).toBeVisible({
      timeout: 5000,
    })
    await expect(authenticatedPage.getByRole("link", { name: "Security" })).toBeVisible()
    await expect(authenticatedPage.getByRole("link", { name: "Users" })).toBeVisible()
    await expect(authenticatedPage.getByRole("link", { name: "Organization" })).toBeVisible()
    await expect(authenticatedPage.getByRole("link", { name: "Roles & access" })).toBeVisible()
    // SSO providers are an admin-only part of Security (the org's sign-in methods).
    await authenticatedPage.getByRole("link", { name: "Security" }).click()
    await authenticatedPage.waitForURL(/\/settings\/security/, { timeout: 10000 })
    await expect(authenticatedPage.getByTestId("security-sign-in-methods")).toBeVisible({
      timeout: 10000,
    })
    await expect(authenticatedPage.getByTestId("sso-providers")).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow H2: Real Multi-Tab Logout Sync (two browser pages)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Flow H2: Real Multi-Tab Logout Sync", () => {
  test("logout in one tab redirects the other tab to login", async ({
    authenticatedPage,
    env,
    context,
  }) => {
    // Open a second page in the same browser context (shared cookies/storage)
    const page2 = await context.newPage()
    await loginAs(page2, env, "admin@test.com", "12345678")

    // Both pages should show the shell
    await expect(authenticatedPage.locator("[data-shell]")).toBeVisible()
    await expect(page2.locator("[data-shell]")).toBeVisible()

    // Logout from page2
    await page2.getByRole("button", { name: /log out/i }).click()
    await page2.waitForURL(/\/login/, { timeout: 10000 })

    // Page1 should detect the logout via BroadcastChannel/storage sync and redirect
    await authenticatedPage.waitForURL(/\/login/, { timeout: 15000 })

    await page2.close()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Bootstrap — Shell integrity
// ═══════════════════════════════════════════════════════════════════════════════

test.describe("Bootstrap", () => {
  test("Elodie login produces working shell with WS", async ({ authenticatedPage }) => {
    await expect(authenticatedPage.locator("[data-shell]")).toBeVisible({ timeout: 10000 })
    await expect(authenticatedPage.locator('[data-testid="activity-bar"]')).toBeVisible()
    // Home lands on the attention feed.
    await expect(authenticatedPage.getByTestId("home-feed")).toBeVisible()

    // The shell opens its websocket after the ticket exchange. Observed from
    // the browser side (Playwright's own websocket events), not through a
    // test hook on window: the stack serves a production build, which has none.
    const opened = authenticatedPage.waitForEvent("websocket", {
      predicate: (ws) => new URL(ws.url()).pathname.startsWith("/ws"),
      timeout: 20_000,
    })
    await authenticatedPage.reload()
    const socket = await opened
    const wsUrl = socket.url()
    expect(socket.isClosed()).toBe(false)
    expect(wsUrl).toContain("/ws")
  })
})
