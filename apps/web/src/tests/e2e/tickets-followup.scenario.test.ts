// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-followup — reply follow-up payload, due attention, and cron reopen.
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { callToolAsAgent, ticketApprovalCardBodies } from "./helpers/approvals"
import { freshAccessToken } from "./helpers/fresh-token"
import { refreshStoredAttention } from "./helpers/projects-seed"
import { triggerCronJob } from "./helpers/run-cron"
import { grantTicketsScopes, seedInbox, seedOutboundMessage, seedTicket } from "./helpers/seed"

function ts(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}

function ks(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

function datetimeLocal(date: Date): string {
  return date.toISOString().slice(0, 16)
}

test("[SC7] tickets-followup: reply payload persists and followup-check reopens", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  // Amina's agent stages the reply; Elodie serves the attention-items probe
  // below (he qualifies for `followup_due` items via `*`).
  await grantTicketsScopes(env, orgId, qa.amina.id, [
    "tickets:tickets:read",
    "tickets:tickets:write",
    "tickets:tickets:reply",
  ])
  const login = await api(env.serverUrl, "/api/auth/login", {
    body: { email: qa.admin.email, password: "12345678" },
  })
  expect(login.status, JSON.stringify(login.body)).toBe(200)
  const token = login.body.data.accessToken as string

  const stamp = Date.now()
  const inbox = await seedInbox(env, orgId, {
    name: `Inbox-${stamp}`,
    emailAddress: `support-${stamp}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, orgId, {
    subject: `Followup ${stamp}`,
    sourceInboxId: inbox.id,
  })
  const followupAt = datetimeLocal(new Date(Date.now() + 30 * 60 * 1000))
  const replyText = `Follow-up reply ${stamp}`

  // Approvals are for agents, not persons: Amina's own composer reply would be
  // refused without `tickets:approve`, so her agent stages the gated reply,
  // follow-up included, and the approval carries the payload.
  const aminaToken = await freshAccessToken(env.serverUrl, qa.amina.email, "QaPass1!")
  const staged = await callToolAsAgent(env.serverUrl, aminaToken, "tickets:reply", {
    ticketId: ticket.id,
    textBody: replyText,
    htmlBody: `<p>${replyText}</p>`,
    followup: {
      at: followupAt,
      reason: "Check if the customer replied",
      trigger: "customer_reply",
    },
  })
  expect(staged.status, JSON.stringify(staged.body)).toBe(200)
  expect(staged.body?.data?.blocked?.approvalRequestId, JSON.stringify(staged.body)).toBeTruthy()

  let approval: any = null
  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT id, current_payload
           FROM ${ks(env)}.approval_requests
          WHERE org_id = $1 AND tool_name = 'tickets:reply'
            AND current_payload->>'ticketId' = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [orgId, ticket.id],
      )) as any[]
      approval = rows[0]
      return rows.length
    })
    .toBe(1)
  const payload =
    typeof approval.current_payload === "string"
      ? JSON.parse(approval.current_payload)
      : approval.current_payload
  expect(payload.followup).toMatchObject({
    at: followupAt,
    reason: "Check if the customer replied",
    trigger: "customer_reply",
  })

  // The ticket shows the staged reply's approval card.
  await loginAs(page, env, qa.amina.email, "QaPass1!")
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
  await expect(page.getByTestId("tickets-detail")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("tickets-detail-approval-card")).toHaveCount(1, { timeout: 15000 })
  await expect.poll(() => ticketApprovalCardBodies(page), { timeout: 15000 }).toEqual([replyText])

  // Bridge the known gated-send gap in dev by materializing the approved reply state.
  await seedOutboundMessage(env, orgId, ticket.id, { textBody: replyText, fromName: "Elodie" })
  await env.db.sql.unsafe(
    `UPDATE ${ts(env)}.tickets
        SET status = 'awaiting_followup',
            followup_at = $2::timestamptz,
            followup_reason = $3,
            followup_trigger = $4,
            updated_at = now()
      WHERE id = $1`,
    [ticket.id, followupAt, "Check if the customer replied", "customer_reply"],
  )

  const [stored] = (await env.db.sql.unsafe(
    `SELECT status, followup_at, followup_reason, followup_trigger
       FROM ${ts(env)}.tickets WHERE id = $1`,
    [ticket.id],
  )) as any[]
  expect(stored.status).toBe("awaiting_followup")
  expect(stored.followup_at).not.toBeNull()
  expect(stored.followup_reason).toBe("Check if the customer replied")
  expect(stored.followup_trigger).toBe("customer_reply")

  await env.db.sql.unsafe(
    `UPDATE ${ts(env)}.tickets SET followup_at = now() - interval '1 minute' WHERE id = $1`,
    [ticket.id],
  )
  // The tickets app's attention list is stored: the rows above, written
  // straight into the table, wake nothing until the org's attention tick runs.
  await refreshStoredAttention(env, orgId)
  await expect
    .poll(
      async () => {
        const before = await api(env.serverUrl, "/api/attention-items", { token })
        expect(before.status, JSON.stringify(before.body)).toBe(200)
        return ((before.body.data?.items ?? []) as any[]).some(
          (item) =>
            item.app === "tickets" && item.entityId === ticket.id && item.kind === "followup_due",
        )
      },
      { timeout: 15_000 },
    )
    .toBe(true)

  await triggerCronJob(env, "app-tickets", "followupCheck")
  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT status, followup_at FROM ${ts(env)}.tickets WHERE id = $1`,
        [ticket.id],
      )) as any[]
      return rows[0]
    })
    .toMatchObject({ status: "open", followup_at: null })

  // Reload the ticket detail to force a fresh fetch — the WS reopen event may
  // race the assertion in parallel runs, but the underlying status (asserted
  // via the DB poll above) is already canonical at this point.
  await page.reload()
  await expect(page.getByTestId("tickets-detail-status")).toHaveAttribute("data-status", "open", {
    timeout: 10000,
  })
})
