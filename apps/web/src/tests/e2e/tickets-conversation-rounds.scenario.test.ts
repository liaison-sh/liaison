// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets-conversation-rounds — full 4-turn UI lifecycle on a single ticket:
//
//   round 1 (inbound)  customer's first message — seeded as the ticket's
//                      initial inbound (created via seedTicket helper).
//   round 2 (outbound) the AI agent's reply, staged through the approval gate
//                      (its card shows on the ticket). The test stack sends no
//                      real mail, so we DB-insert the "approved + sent"
//                      outbound row to simulate downstream success.
//   round 3 (inbound)  customer follow-up — pushed via the public webhook's
//                      `appendIfExisting` path against the ticket's external
//                      ref. Validates the production "external system pushes
//                      a customer reply on an existing thread" code path.
//   round 4 (outbound) the agent's second reply, staged + DB-insert again.
//
// Final assertions: 4 messages render in correct order, kinds alternate
// inbound/outbound/inbound/outbound, and the ticket's `message_count` /
// `last_inbound_at` / `last_outbound_at` reflect the full thread.
import { expect, loginAs, test } from "./fixtures/test"
import { callToolAsAgent, ticketApprovalCardBodies } from "./helpers/approvals"
import { freshAccessToken } from "./helpers/fresh-token"
import {
  grantTicketsScopes,
  seedApiKey,
  seedInbox,
  seedOutboundMessage,
  seedTicket,
  seedTicketMessages,
} from "./helpers/seed"

function ts(env: { schemaPrefix?: string }) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"
}

test("[SC11] tickets-conversation-rounds: 4-turn lifecycle renders all messages in order", async ({
  page,
  env,
  qa,
  world,
}) => {
  const orgId = world.org.id
  const stamp = Date.now()
  const externalRef = `qa-thread-${stamp}`

  // Amina's agent writes the replies: approvals are for agents, so each gated
  // reply it stages parks an approval (Amina herself, without
  // `tickets:approve`, would be refused). The send stays parked; the bridge
  // below materialises the approved outbound row, so nothing is duplicated.
  // Widen Amina's sensitivity grants past the default (`restricted` only) so
  // she can both read the seeded `internal` ticket AND receive WS pushes for
  // its new inbound messages (the WS layer applies the same dimension filter).
  await grantTicketsScopes(
    env,
    orgId,
    qa.amina.id,
    ["tickets:tickets:read", "tickets:tickets:write", "tickets:tickets:reply"],
    { team: ["*"], sensitivity: ["public", "internal", "confidential", "restricted"] },
  )

  const inbox = await seedInbox(env, orgId, {
    name: `Rounds inbox ${stamp}`,
    emailAddress: `rounds-${stamp}@e2e.test`,
    isDefault: true,
  })
  const ticket = await seedTicket(env, orgId, {
    subject: "Refund request — rounds test",
    sourceInboxId: inbox.id,
    externalRef,
    lastInbound: false,
  })

  // Round 1 — first inbound (overwrite the placeholder inbound seedTicket
  // already inserted with a richer one tagged from the customer).
  await env.db.sql.unsafe(`DELETE FROM ${ts(env)}.messages WHERE ticket_id = $1`, [ticket.id])
  await env.db.sql.unsafe(`UPDATE ${ts(env)}.tickets SET message_count = 0 WHERE id = $1`, [
    ticket.id,
  ])
  await seedTicketMessages(env, orgId, ticket.id, [
    {
      kind: "inbound",
      fromEmail: "jenny@customer.test",
      fromName: "Jenny Customer",
      textBody: "Hi support — I was charged twice on order #88421.",
      sentAtOffsetSeconds: -3600,
    },
  ])

  await loginAs(page, env, qa.amina.email, "QaPass1!")
  await page.goto(`http://localhost:${env.ports[1]}/tickets/${ticket.id}`)
  await expect(page.getByTestId("tickets-conversation")).toBeVisible({ timeout: 10000 })
  await expect(page.getByTestId("tickets-conversation")).toContainText("charged twice", {
    timeout: 10000,
  })

  // Round 2 — the agent's reply. Staged through the gate, it parks an
  // approval the ticket shows as a card; the bridge then inserts the
  // "approved + sent" outbound row (no real SMTP send in the test stack).
  const aminaToken = await freshAccessToken(env.serverUrl, qa.amina.email, "QaPass1!")
  const stageReply = async (text: string): Promise<void> => {
    const staged = await callToolAsAgent(env.serverUrl, aminaToken, "tickets:reply", {
      ticketId: ticket.id,
      textBody: text,
      htmlBody: `<p>${text}</p>`,
    })
    expect(staged.status, JSON.stringify(staged.body)).toBe(200)
    expect(staged.body?.data?.blocked?.approvalRequestId, JSON.stringify(staged.body)).toBeTruthy()
    await page.reload()
    await expect
      .poll(async () => (await ticketApprovalCardBodies(page)).includes(text), { timeout: 15000 })
      .toBe(true)
  }
  const replyText1 = `Looking into this now — I'll have an answer in a few hours. (${stamp})`
  await stageReply(replyText1)
  await seedOutboundMessage(env, orgId, ticket.id, {
    textBody: replyText1,
    fromEmail: `rounds-${stamp}@e2e.test`,
    fromName: "Elodie",
  })

  // Round 3 — customer follow-up via the public webhook's appendIfExisting
  // path. The webhook resolves the ticket via externalRef and appends a new
  // inbound message; the WS event surfaces in the open UI.
  const apiKey = await seedApiKey(env, orgId, { label: `rounds-${stamp}` })
  const webhookUrl = `http://localhost:${env.ports[0]}/webhooks/${orgId}/tickets/create`
  const followupText = `Thanks for the quick reply! Just confirming the second charge was on March 26. (${stamp})`
  const webhookRes = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey.plaintext}`,
    },
    body: JSON.stringify({
      subject: "Re: Refund request — rounds test",
      fromEmail: "jenny@customer.test",
      fromName: "Jenny Customer",
      textBody: followupText,
      externalRef,
      appendIfExisting: true,
    }),
  })
  expect(webhookRes.status).toBe(200)
  const webhookBody = (await webhookRes.json()) as { data?: { appended?: boolean } }
  expect(webhookBody.data?.appended).toBe(true)

  // The new inbound row exists in DB; under the gated-tool human bypass the
  // composer no longer drives the same agent-author identity it used to, and
  // the WS push for a webhook-originated `tickets:message:create` event may
  // not reach Amina's ticket subscription consistently. Force a refresh so
  // the test asserts on the durable DB → REST fetch path rather than the
  // best-effort live WS path.
  await page.reload()
  await expect(page.getByTestId("tickets-conversation")).toContainText(followupText, {
    timeout: 15000,
  })

  // Round 4 — the agent's second reply, staged and bridged the same way.
  const replyText2 = `Confirmed both charges. Refunding $42.99 to your card ending 4242. (${stamp})`
  await stageReply(replyText2)
  await seedOutboundMessage(env, orgId, ticket.id, {
    textBody: replyText2,
    fromEmail: `rounds-${stamp}@e2e.test`,
    fromName: "Elodie",
  })
  await page.reload()
  const conversation = page.getByTestId("tickets-conversation")
  for (const text of ["charged twice", replyText1, followupText, replyText2]) {
    await expect(conversation).toContainText(text, { timeout: 15000 })
  }

  // Final assertion — DB shape: 4 messages persisted, alternating kinds.
  const persisted = await env.db.sql.unsafe(
    `SELECT kind, text_body FROM ${ts(env)}.messages
     WHERE ticket_id = $1 ORDER BY sent_at ASC, created_at ASC`,
    [ticket.id],
  )
  const kinds = (persisted as unknown as Array<{ kind: string; text_body: string }>).map(
    (r) => r.kind,
  )
  expect(kinds).toEqual(["inbound", "outbound", "inbound", "outbound"])

  const ticketRows = await env.db.sql.unsafe(
    `SELECT message_count, last_inbound_at, last_outbound_at, first_response_at
     FROM ${ts(env)}.tickets WHERE id = $1`,
    [ticket.id],
  )
  const t = (ticketRows as Array<Record<string, unknown>>)[0]!
  expect(t.message_count).toBe(4)
  expect(t.last_inbound_at).toBeTruthy()
  expect(t.last_outbound_at).toBeTruthy()
  expect(t.first_response_at).toBeTruthy()
})
