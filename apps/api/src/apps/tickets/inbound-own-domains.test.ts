// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A colleague writing from one of the org's own domains.
//
// The org's own domains are the ones it configured for its mailboxes
// (`organizations.settings.allowedMailDomains`) plus the synced mailbox's own
// domain. Mail From one of them is staff (outbound) only on provider evidence:
// the trusted, topmost Authentication-Results verdict is a pass for the From
// domain, or the message came through the org's own Gmail API mailbox with its
// SENT label. Anything else from those domains stays a customer message.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { processInboundMessage } from "~/apps/tickets/inbound"
import { extractRows, sql } from "~/db"
import { withSystemDb } from "~/db/privileged"

const ORG_ID = "00000000-0000-0000-0000-0000000c7100"
const INBOX_ID = "00000000-0000-0000-0000-0000000c7101"
const SUPPORT = "support@owndesk.test"
const OWN_DOMAIN = "owngroup.test"
const COLLEAGUE = `alex@${OWN_DOMAIN}`
const CUSTOMER = "carol@customer.test"

const inboxRow = { id: INBOX_ID, org_id: ORG_ID, email_address: SUPPORT } as const

function gmailPass(domain: string): string {
  return `mx.google.com; dkim=pass header.i=@${domain} header.s=s1; spf=pass smtp.mailfrom=b@${domain}; dmarc=pass (p=REJECT) header.from=${domain}`
}

let seq = 0
function mail(overrides: Record<string, unknown>) {
  seq += 1
  return {
    messageId: `<own-domain-${seq}-${Date.now()}@mail.test>`,
    to: [{ email: CUSTOMER }],
    cc: [],
    subject: `Own domain case ${seq}`,
    textBody: "hello",
    sentAt: new Date().toISOString(),
    headers: {},
    receivedVia: "gmail_api",
    labelIds: ["INBOX"],
    ...overrides,
  } as never
}

/** Ingest one message; the stored kind of that message (`outbound` = staff). */
async function kindOf(raw: never): Promise<string | undefined> {
  const result = await withSystemDb("own-domain-run", async (tx) =>
    processInboundMessage(raw, inboxRow as never, {
      orgId: ORG_ID,
      // As the mailbox sync ingests: on its privileged transaction, handed down.
      db: tx as never,
      privilegedTx: tx,
    }),
  )
  expect("error" in result).toBe(false)
  const messageId = (raw as { messageId: string }).messageId
  return extractRows<{ kind: string }>(
    await sql`SELECT kind FROM app_tickets.messages
              WHERE org_id = ${ORG_ID} AND external_message_id = ${messageId}`,
  )[0]?.kind
}

describe("inbound: mail from the org's own configured domains", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'OwnDomainOrg', 'own-domain-org') ON CONFLICT DO NOTHING`
    const { ticketsSettingsDefaults } = await import("@liaison/shared")
    // gmail.com is configured too: a public provider's domain is never an own
    // domain, whatever the setting says.
    await sql`
      UPDATE kernel.organizations
      SET settings = COALESCE(settings, '{}'::jsonb)
        || jsonb_build_object('tickets', ${JSON.stringify(ticketsSettingsDefaults)}::jsonb)
        || jsonb_build_object('allowedMailDomains', ${JSON.stringify(["owndesk.test", OWN_DOMAIN, "gmail.com"])}::jsonb)
      WHERE id = ${ORG_ID}`
    await sql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address)
      VALUES (${INBOX_ID}, ${ORG_ID}, gen_random_uuid(), 'Own Domain Support', ${SUPPORT})
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM app_tickets.messages WHERE org_id = ${ORG_ID}`
    await sql`UPDATE app_tickets.tickets SET related_ticket_id = NULL WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM app_tickets.tickets WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM app_tickets.inboxes WHERE org_id = ${ORG_ID}`
  })

  it("is staff when the provider's verdict is a pass for that From domain", async () => {
    expect(
      await kindOf(
        mail({ from: { email: COLLEAGUE }, authenticationResults: [gmailPass(OWN_DOMAIN)] }),
      ),
    ).toBe("outbound")
  })

  it("is staff when it came through the org's Gmail API mailbox with the SENT label", async () => {
    expect(await kindOf(mail({ from: { email: COLLEAGUE }, labelIds: ["SENT"] }))).toBe("outbound")
  })

  it("stays a customer message when nothing authenticates it", async () => {
    expect(await kindOf(mail({ from: { email: COLLEAGUE }, to: [{ email: SUPPORT }] }))).toBe(
      "inbound",
    )
  })

  it("is not satisfied by a sender-written Authentication-Results header below the provider's", async () => {
    expect(
      await kindOf(
        mail({
          from: { email: COLLEAGUE },
          to: [{ email: SUPPORT }],
          authenticationResults: [
            `mx.google.com; spf=neutral smtp.mailfrom=x@relay.test; dmarc=none header.from=${OWN_DOMAIN}`,
            gmailPass(OWN_DOMAIN),
          ],
        }),
      ),
    ).toBe("inbound")
  })

  it("treats a configured public provider's domain as a customer domain", async () => {
    expect(
      await kindOf(
        mail({
          from: { email: "someone@gmail.com" },
          to: [{ email: SUPPORT }],
          authenticationResults: [gmailPass("gmail.com")],
        }),
      ),
    ).toBe("inbound")
  })
})
