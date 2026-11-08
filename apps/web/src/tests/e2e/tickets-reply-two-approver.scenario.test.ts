// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A person's own ticket reply under an org two-approver policy, through the
// real UI. Approvals are for agents, not persons, except here: the org demands
// two distinct approvers for `tickets:reply`, so Amina's send parks with her
// own sign-off (1 of 2) and her composer says it waits for a second approver.
// Lucas approves it from his approvals screen; the reply goes out once through
// the Gmail fixture, and Amina's open ticket updates live to show it sent.
import { randomUUID } from "node:crypto"
import { createUserWithScopes } from "@liaison/test-helpers"
import { CryptoContext, encryptSecret } from "../../../../api/src/lib/crypto"
import {
  type GmailHttpFixture,
  startGmailHttpFixture,
} from "../../../../api/src/tests/fixtures/email/gmail-http"
import { createProfiledE2ETest } from "./fixtures/profiled-test"
import { expect, loginAs } from "./fixtures/test"
import { seedTicket } from "./helpers/seed"

let gmail: GmailHttpFixture

const test = createProfiledE2ETest({
  workerIdOffset: 70,
  portCount: 2,
  before: async () => {
    gmail = await startGmailHttpFixture()
    return {
      env: { TICKETS_E2E_GMAIL_API_BASE_URL: gmail.apiBaseUrl },
      teardowns: [() => gmail.close()],
    }
  },
})

const schema = (prefix: string | undefined, name: string) => (prefix ? `"${prefix}${name}"` : name)

test("a two-approver reply waits for a second person, then goes out once and shows live", async ({
  page,
  browser,
  env,
  world,
}) => {
  const orgId = world.org.id
  const stamp = Date.now()
  const ks = schema(env.schemaPrefix, "kernel")
  const ts = schema(env.schemaPrefix, "app_tickets")
  const support = [
    "tickets:tickets:read",
    "tickets:tickets:write",
    "tickets:inboxes:read",
    "kernel:threads:read",
    "kernel:threads:write",
    // A standard member's approval scopes: the live approval frames (WS) are
    // gated on kernel:approvals:read.
    "kernel:approvals:read",
    "kernel:approvals:write",
  ]
  const password = "TwoApprovers1!"
  const person = (name: string, scopes: string[]) =>
    createUserWithScopes(env.serverUrl, env.db.sql, world.admin.token, orgId, {
      email: `${name.toLowerCase()}-${stamp}@two-approver.test`,
      password,
      name,
      scopes,
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
  const amina = await person("Amina", [...support, "tickets:tickets:reply", "tickets:approve"])
  const lucas = await person("Lucas", [...support, "tickets:approve"])

  // An inbox on a connected Gmail account whose sends land in the fixture.
  const account = `two-approver-${stamp}@e2e.test`
  const connectedAccountId = randomUUID()
  await env.db.sql.unsafe(
    `INSERT INTO ${ks}.connected_accounts (
       id, org_id, app_name, connection_name, owner_type, owner_id,
       provider_type, identifier, display_name, access_token_encrypted, status, created_by
     ) VALUES ($1, $2, 'tickets', 'gmail', 'org', null, 'oauth2', $3, $3, $4, 'active', $5)`,
    [
      connectedAccountId,
      orgId,
      account,
      encryptSecret(
        "test-access-token",
        env.encryptionKey,
        CryptoContext.connectedAccountAccessToken,
      ),
      world.admin.id,
    ],
  )
  const inboxId = randomUUID()
  await env.db.sql.unsafe(
    `INSERT INTO ${ts}.inboxes (id, org_id, connected_account_id, name, email_address,
       default_sensitivity, is_default_for_create, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'internal', false, now(), now())`,
    [inboxId, orgId, connectedAccountId, `Two approver ${stamp}`, account],
  )
  const ticket = await seedTicket(env, orgId, {
    subject: `Two approver ${stamp}`,
    sourceInboxId: inboxId,
  })
  await env.db.sql.unsafe(
    `INSERT INTO ${ks}.approval_policies
       (org_id, tool_name, enabled, conditions, require_approval, min_approvers, created_by)
     VALUES ($1, 'tickets:reply', true, '[]'::jsonb, true, 2, $2)`,
    [orgId, world.admin.id],
  )
  gmail.reset()
  gmail.queueSendResponse(account, { id: `gm-${stamp}`, threadId: `gt-${stamp}` })

  try {
    // 1. Amina sends from the composer: it waits, nothing goes out.
    await loginAs(page, env, amina.email, password)
    await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
    await expect(page.getByTestId("tickets-composer")).toBeVisible({ timeout: 15000 })
    const replyText = `Two approvals reply ${stamp}`
    await page.getByTestId("tickets-composer-body").fill(replyText)
    const replyResp = page.waitForResponse(
      (r) =>
        r.url().includes("/api/apps/run-tool") &&
        (r.request().postDataJSON() as { toolName?: string } | null)?.toolName === "tickets:reply",
    )
    await page.getByTestId("tickets-composer-submit").click()
    const sent = await replyResp
    expect(sent.status(), await sent.text()).toBe(200)
    const approvalId = (
      (await sent.json()) as { data?: { blocked?: { approvalRequestId?: string } } }
    ).data?.blocked?.approvalRequestId as string
    expect(approvalId).toBeTruthy()
    await expect(page.getByTestId("tickets-composer-awaiting-second-approver")).toContainText(
      "Waiting for a second approver",
    )
    const [row] = (await env.db.sql.unsafe(
      `SELECT status, metadata FROM ${ks}.approval_requests WHERE id = $1`,
      [approvalId],
    )) as Array<{ status: string; metadata: { approvedBy?: string[] } }>
    expect(row?.status).toBe("pending")
    expect(row?.metadata.approvedBy).toEqual([amina.id])
    expect(gmail.requests().filter((r) => r.route === "messages.send")).toHaveLength(0)

    // 2. Lucas approves from his approvals screen.
    const lucasContext = await browser.newContext()
    try {
      const lucasPage = await lucasContext.newPage()
      await loginAs(lucasPage, env, lucas.email, password)
      await lucasPage.goto(`http://localhost:${env.ports[1]}/approvals`)
      const item = lucasPage.getByTestId(`approvals-item-${approvalId}`)
      await expect(item).toBeVisible({ timeout: 15000 })
      await item.getByTestId("approval-card-action-approve").click()
      await expect
        .poll(
          async () =>
            (
              (await env.db.sql.unsafe(`SELECT status FROM ${ks}.approval_requests WHERE id = $1`, [
                approvalId,
              ])) as Array<{ status: string }>
            )[0]?.status,
          { timeout: 20000 },
        )
        .toBe("approved")
    } finally {
      await lucasContext.close()
    }

    // 3. Sent exactly once, and Amina's open ticket shows it without a reload.
    await expect
      .poll(() => gmail.requests().filter((r) => r.route === "messages.send").length, {
        timeout: 15000,
      })
      .toBe(1)
    await expect(page.getByTestId("tickets-conversation")).toContainText(replyText, {
      timeout: 15000,
    })
    await expect(page.getByTestId("tickets-composer-awaiting-second-approver")).toHaveCount(0)
  } finally {
    await env.db.sql.unsafe(
      `DELETE FROM ${ks}.approval_policies WHERE org_id = $1 AND tool_name = 'tickets:reply'`,
      [orgId],
    )
  }
})
