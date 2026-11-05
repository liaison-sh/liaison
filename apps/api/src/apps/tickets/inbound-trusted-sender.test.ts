// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sender staff marked as trusted (an address, or its domain) counts as verified for the inbound
// rules when its mail carries no provider verdict: the requester's Cc list then adds participants.
// A message the provider says is forged stays untrusted, and a public provider's domain is never
// trusted as a whole.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { processInboundMessage } from "~/apps/tickets/inbound"
import { loadTicketParties } from "~/apps/tickets/participants"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import {
  addTrustedSender,
  senderAuthForRules,
  trustedAmong,
} from "~/modules/contacts/trusted-senders"

const ORG_ID = "00000000-0000-0000-0000-0000000c7100"
const INBOX_ID = "00000000-0000-0000-0000-0000000c7101"
const STAFF = "00000000-0000-0000-0000-0000000c7102"
const SUPPORT = "support@trustedsender.test"
const ALICE = "alice@partner.test"

const inboxRow = { id: INBOX_ID, org_id: ORG_ID, email_address: SUPPORT } as const

let seq = 0
function mail(overrides: Record<string, unknown>) {
  seq += 1
  return {
    messageId: `<trusted-${seq}-${Date.now()}@mail.test>`,
    to: [{ email: SUPPORT }],
    cc: [],
    textBody: "hello",
    sentAt: new Date().toISOString(),
    headers: {},
    receivedVia: "gmail_api",
    labelIds: ["INBOX"],
    ...overrides,
  } as never
}

async function run(raw: never) {
  return withSystemDb("trusted-sender-run", async (tx) =>
    processInboundMessage(raw, inboxRow as never, { orgId: ORG_ID, db: tx as never }),
  )
}

async function parties(ticketId: string) {
  return withSystemDb("trusted-sender-parties", (tx) =>
    loadTicketParties(tx as never, ORG_ID, ticketId),
  )
}

describe("trusted senders in the inbound rules", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'TrustedSenderOrg', 'trusted-sender-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${STAFF}, ${ORG_ID}, 'staff@trustedsender.test', 'Staff') ON CONFLICT DO NOTHING`
    const { ticketsSettingsDefaults } = await import("@liaison/shared")
    await sql`
      UPDATE kernel.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('tickets', ${JSON.stringify(ticketsSettingsDefaults)}::jsonb)
      WHERE id = ${ORG_ID}`
    await sql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address)
      VALUES (${INBOX_ID}, ${ORG_ID}, gen_random_uuid(), 'Trusted Support', ${SUPPORT})
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM app_tickets.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM app_tickets.tickets WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM app_tickets.inboxes WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.trusted_senders WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  })

  it("an unverified requester's Cc adds nobody until the sender is trusted", async () => {
    const created = await run(mail({ from: { email: ALICE }, subject: "Order question" }))
    expect(created).toMatchObject({ outcome: "created" })
    const ticketId = (created as { ticketId: string }).ticketId
    // Join the thread through the ticket's reply token, which any sender may use.
    const token = (await sql`SELECT reply_token FROM app_tickets.tickets WHERE id = ${ticketId}`)[0]
      ?.reply_token as string
    const toToken = SUPPORT.replace("@", `+tkt_${token}@`)
    const viaToken = (cc: string) =>
      run(
        mail({
          from: { email: ALICE },
          subject: "Re: Order question",
          to: [{ email: toToken }],
          cc: [{ email: cc }],
        }),
      )

    expect(await viaToken("bob@partner.test")).toMatchObject({ outcome: "appended", ticketId })
    expect((await parties(ticketId)).participants).not.toContain("bob@partner.test")

    await addTrustedSender(ORG_ID, STAFF, { kind: "domain", value: "partner.test" })
    expect(await viaToken("carol@partner.test")).toMatchObject({ outcome: "appended", ticketId })
    expect((await parties(ticketId)).participants).toContain("carol@partner.test")
  })

  it("a failed verdict stays failed, and a public provider's domain is never trusted whole", async () => {
    await addTrustedSender(ORG_ID, STAFF, { kind: "address", value: "dana@gmail.com" })
    expect(await senderAuthForRules(ORG_ID, "none", "dana@gmail.com")).toBe("pass")
    expect(await senderAuthForRules(ORG_ID, "fail", "dana@gmail.com")).toBe("fail")
    expect(await senderAuthForRules(ORG_ID, "none", "eve@gmail.com")).toBe("none")
    // A domain row for a public provider (not writable through the routes) is ignored on read.
    await sql`INSERT INTO kernel.trusted_senders (org_id, kind, value) VALUES (${ORG_ID}, 'domain', 'gmail.com')`
    expect([...(await trustedAmong(ORG_ID, ["eve@gmail.com", "dana@gmail.com"]))]).toEqual([
      "dana@gmail.com",
    ])
    await expect(
      addTrustedSender(ORG_ID, STAFF, { kind: "domain", value: "gmail.com" }),
    ).rejects.toThrow(/public mail provider/)
  })
})
