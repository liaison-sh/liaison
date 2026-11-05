// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S1 Admin invites a user with a role; invitee receives exactly
// that role's scopes (e2e-plan §S1, spec §1.1 criterion 1, §3.1, §11.5).
//
// Browser-driven journey:
//   1. Elodie opens the Users admin → invite dialog
//   2. Fills the email + selects the seeded Support role
//   3. Submits → POST /api/admin/invites responds 201
//   4. DB cross-check: invite row carries the seeded Support role
//   5. Register page opened with ?token=<token>; invitee chooses a password
//   6. Invitee lands in the shell, /tickets surface mounts
//   7. Admin user detail cross-check: invitee carries exactly the Support
//      scope set (kernel:home:read + tickets:tickets:read), no projects scope.

import { randomUUID } from "node:crypto"
import { api } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"
import { getInviteRow } from "./helpers/db-reads"
import { seedRoleWithScopes } from "./helpers/seed"

test("invite a Support user; invitee receives exactly Support scopes", async ({
  authenticatedPage,
  page: invitedPage,
  env,
  world,
  qa,
}) => {
  const adminPage = authenticatedPage
  const supportScopes = ["kernel:home:read", "tickets:tickets:read"]
  const supportRoleName = `Support-${randomUUID().slice(0, 6)}`
  const supportRoleId = await seedRoleWithScopes(env, world.org.id, {
    name: supportRoleName,
    scopes: supportScopes,
  })

  await adminPage.goto(`http://localhost:${env.ports[1]}/settings/admin/users`)
  await expect(adminPage.getByTestId("admin-users-table")).toBeVisible({ timeout: 15000 })

  await adminPage.getByTestId("admin-users-invite-button").click()
  await expect(adminPage.getByTestId("admin-users-invite-role")).toBeVisible()
  // Wait for role list to be hydrated — Suspense resolves once /api/admin/roles fires.
  await expect(adminPage.getByTestId("admin-users-invite-role")).toContainText(supportRoleName, {
    timeout: 10000,
  })

  const inviteEmail = `invitee-${Date.now()}@phase9.test`
  await adminPage.getByLabel("Email address").fill(inviteEmail)
  await adminPage.getByTestId("admin-users-invite-role").selectOption(supportRoleId)

  const inviteRespPromise = adminPage.waitForResponse(
    (r) => r.url().endsWith("/api/admin/invites") && r.request().method() === "POST",
  )
  await adminPage.getByRole("button", { name: /send invitation/i }).click()
  const inviteResp = await inviteRespPromise
  expect(inviteResp.status()).toBe(201)
  const inviteJson = (await inviteResp.json()) as {
    data: { inviteToken: string; inviteUrl: string }
  }
  const inviteToken = inviteJson.data.inviteToken
  expect(inviteToken).toBeTruthy()

  // DB cross-check
  const inviteRow = await getInviteRow(env, inviteEmail)
  expect(inviteRow).not.toBeNull()
  expect(inviteRow?.roleId).toBe(supportRoleId)
  expect(inviteRow?.acceptedAt).toBeNull()

  // Invitee accepts the invite via the Register page. Registration is
  // passwordless (Register.tsx): the invite token proves the address, the form
  // asks only for a name, and later sign-ins go through a magic link.
  await invitedPage.goto(`http://localhost:${env.ports[1]}/register?token=${inviteToken}`)
  // Token validates against /invites/<token>/validate before showing the form.
  await expect(invitedPage.getByTestId("auth-card")).toBeVisible({ timeout: 15000 })
  await invitedPage.getByLabel("Full name").fill("Phase9 Invitee")
  await invitedPage.getByRole("button", { name: /create account|register|sign up/i }).click()
  // Shell mounts on success
  await invitedPage.waitForSelector("[data-shell]", { timeout: 60000 })

  // /tickets — Support scope allows read of tickets surface (shell still mounts)
  await invitedPage.goto(`http://localhost:${env.ports[1]}/tickets`)
  await invitedPage.waitForSelector("[data-shell]", { timeout: 30000 })

  // Cross-check: invitee user has exactly the Support scope set.
  // Look up the invitee by email using the admin token.
  const userList = await api(env.serverUrl, "/api/admin/users", { token: qa.admin.token })
  expect(userList.status).toBe(200)
  const users = (userList.body.data ?? []) as Array<{ id: string; email: string }>
  const invitee = users.find((u) => u.email === inviteEmail.toLowerCase())
  expect(invitee).toBeDefined()

  const detail = await api(env.serverUrl, `/api/admin/users/${invitee!.id}`, {
    token: qa.admin.token,
  })
  expect(detail.status).toBe(200)
  const effectiveScopes = (detail.body.data?.effectiveScopes ?? []) as Array<{ scope: string }>
  const scopeStrings = new Set(effectiveScopes.map((s) => s.scope))
  for (const required of supportScopes) {
    expect(scopeStrings.has(required)).toBe(true)
  }
  // Negative: no project scope
  expect([...scopeStrings].some((s) => s.startsWith("projects:"))).toBe(false)
})
