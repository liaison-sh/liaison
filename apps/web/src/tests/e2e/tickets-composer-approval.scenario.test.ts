// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-composer-approval — S4: composer behavior for internal notes
// (immediate) and replies. A person's own reply runs on the reply tool's own
// scope, so a person without it gets no reply box at all (they can still read
// the ticket); an agent's staged reply parks an approval the ticket shows.
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { callToolAsAgent, ticketApprovalCardBodies } from "./helpers/approvals"
import { freshAccessToken } from "./helpers/fresh-token"
import { grantTicketsScopes, seedInbox, seedTicket } from "./helpers/seed"

function ts(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}

test("[SC8] tickets-composer-approval: internal note posts immediately, no approval card", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const stamp = Date.now()
  await grantTicketsScopes(env, orgId, qa.admin.id, [
    "tickets:tickets:read",
    "tickets:tickets:write",
    "tickets:approve",
  ])
  const login = await api(env.serverUrl, "/api/auth/login", {
    body: { email: qa.admin.email, password: "12345678" },
  })
  expect(login.status, JSON.stringify(login.body)).toBe(200)
  const _token = login.body.data.accessToken as string
  const inbox = await seedInbox(env, orgId, {
    name: `Note inbox ${stamp}`,
    emailAddress: `note-${stamp}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, orgId, {
    subject: `Note ticket ${stamp}`,
    sourceInboxId: inbox.id,
  })

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
  await expect(page.getByTestId("tickets-composer")).toBeVisible({ timeout: 10000 })

  await page.getByTestId("tickets-composer-mode-note").click()
  const noteText = `Internal note ${stamp}`
  await page.getByTestId("tickets-composer-body").fill(noteText)
  const noteResp = page.waitForResponse(
    (r) =>
      r.url().includes("/api/apps/run-tool") &&
      (r.request().postDataJSON() as { toolName?: string } | null)?.toolName === "tickets:addNote",
  )
  await page.getByTestId("tickets-composer-submit").click()
  const noted = await noteResp
  expect(noted.status(), await noted.text()).toBe(200)

  // The note row appears in the conversation stream and the persisted DB row is kind=note.
  await expect(page.getByTestId("tickets-conversation")).toContainText(noteText, {
    timeout: 15000,
  })
  await expect
    .poll(async () => {
      const rows = await env.db.sql.unsafe(
        `SELECT kind FROM ${ts(env)}.messages WHERE ticket_id = $1 AND text_body = $2`,
        [ticket.id, noteText],
      )
      return rows[0]?.kind ?? null
    })
    .toBe("note")
})

test("[SC8][SC15] tickets-composer-approval: a person without the reply scope gets no reply box and parks nothing; an agent's staged reply shows its approval card", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const stamp = Date.now()
  // Amina may read and note but not reply: approvals are for agents, not
  // persons, and the reply tool's own scope decides her click. Without it the
  // composer shows no reply tab.
  await grantTicketsScopes(env, orgId, qa.amina.id, [
    "tickets:tickets:read",
    "tickets:tickets:write",
  ])
  const inbox = await seedInbox(env, orgId, {
    name: `Reply inbox ${stamp}`,
    emailAddress: `reply-${stamp}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, orgId, {
    subject: `Reply ticket ${stamp}`,
    sourceInboxId: inbox.id,
  })
  const replyApprovals = async (): Promise<Array<{ id: string; status: string }>> =>
    (await env.db.sql.unsafe(
      `SELECT id, status FROM "${env.schemaPrefix ?? ""}kernel".approval_requests
        WHERE org_id = $1 AND tool_name = 'tickets:reply'
          AND current_payload->>'ticketId' = $2
        ORDER BY created_at DESC`,
      [orgId, ticket.id],
    )) as Array<{ id: string; status: string }>

  await loginAs(page, env, qa.amina.email, "QaPass1!")
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
  await expect(page.getByTestId("tickets-composer")).toBeVisible({ timeout: 10000 })

  // 1. No reply tab: the composer opens on the internal note, and nothing parks.
  await expect(page.getByTestId("tickets-composer-mode-reply")).toHaveCount(0)
  await expect(page.getByTestId("tickets-composer-mode-note")).toHaveAttribute(
    "data-active",
    "true",
  )
  expect(await replyApprovals()).toEqual([])

  // Her agent needs her reply scope to stage a reply on her behalf.
  await grantTicketsScopes(env, orgId, qa.amina.id, ["tickets:tickets:reply"])

  // 2. Her agent stages the same reply: that call parks the approval, and the
  //    ticket shows its card. Amina, the requester, denies it.
  const aminaToken = await freshAccessToken(env.serverUrl, qa.amina.email, "QaPass1!")
  const agentText = `Agent reply pending approval ${stamp}`
  const staged = await callToolAsAgent(env.serverUrl, aminaToken, "tickets:reply", {
    ticketId: ticket.id,
    textBody: agentText,
    htmlBody: `<p>${agentText}</p>`,
  })
  expect(staged.status, JSON.stringify(staged.body)).toBe(200)
  const approvalId = staged.body?.data?.blocked?.approvalRequestId as string | undefined
  expect(approvalId, JSON.stringify(staged.body)).toBeTruthy()
  expect(await replyApprovals()).toEqual([{ id: approvalId, status: "pending" }])

  await page.reload()
  await expect(page.getByTestId("tickets-detail-approval-card")).toHaveCount(1, { timeout: 15000 })
  await expect.poll(() => ticketApprovalCardBodies(page), { timeout: 15000 }).toEqual([agentText])

  const denied = await api(env.serverUrl, `/api/approvals/${approvalId}/decide`, {
    method: "POST",
    token: aminaToken,
    body: { decision: "deny", reason: "Needs rewrite" },
  })
  expect(denied.status, JSON.stringify(denied.body)).toBe(200)
  expect(await replyApprovals()).toEqual([{ id: approvalId, status: "denied" }])
  await page.reload()
  await expect(page.getByTestId("tickets-detail-approval-card")).toHaveCount(0, {
    timeout: 15000,
  })
})
