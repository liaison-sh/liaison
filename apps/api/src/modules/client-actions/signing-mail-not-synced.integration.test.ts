// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Signing mail never enters Mail, and a quoted signing link is cut at the door.
// A synced copy of this org's link mail (or a bounce quoting its header) is not
// stored at all; a reply quoting the link is stored with the link cut, in a
// synced mailbox, on a ticket from mail and on a client's portal request.
import { beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { processInboundMessage } from "~/apps/tickets/inbound"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { ParsedEmail } from "~/lib/email/types"
import { createPortalSession } from "~/modules/auth/auth"
import { seedContext } from "~/seed/context"
import {
  ensureTicketMailboxAccount,
  ensureTicketMailboxInbox,
} from "~/seed/factories/support/inboxes"
import { insertShare } from "~/tests/security/portal-doors/fixture"
import {
  mailboxOf,
  mailboxRows,
  mintTo,
  syncedCopyOf,
  syncPage,
  useClientActionWorld,
} from "../../../test-support/client-actions-kit"
import { SIGNING_LINK_REMOVED } from "./quoted-link"

const kit = useClientActionWorld("syncedmail")

function linkOf(text: string): string {
  const m = text.match(/https?:\/\/[^\s"'<>]*\/a#t=[A-Za-z0-9_-]+/)
  if (!m) throw new Error("no link")
  return m[0]
}

beforeAll(async () => {
  const day: Array<[string, string]> = [["09:00", "17:00"]]
  const sla = {
    targets: { low: 172_800, normal: 86_400, high: 28_800, urgent: 3_600 },
    businessHours: {
      timezone: "UTC",
      weekly: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: [], sun: [] },
      holidays: [],
    },
  }
  await sql`UPDATE kernel.organizations
    SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{tickets}', ${JSON.stringify({ sla })}::jsonb, true)
    WHERE id = ${kit.w.orgId}`
  await insertShare(kit.w, { company_id: kit.w.companyA, kind: "requests" })
}, 180_000)

describe("a synced mailbox and the tickets door", () => {
  it("a reply quoting the link is stored with the link cut, in text, in HTML and as a percent-encoded href", async () => {
    const sent = await mintTo(kit)
    const link = linkOf(sent.mail.text ?? "")
    const encoded = encodeURIComponent(link)
    const box = await mailboxOf(kit, kit.w.admin.userId, kit.w.admin.email)
    const reply = syncedCopyOf(
      {
        to: kit.w.admin.email,
        from: kit.w.clientA.email,
        subject: `Re: ${sent.mail.subject}`,
        text: `Signed, thanks.\n\n> Open it here: ${link}\n> The team`,
        html: `<p>Signed, thanks.</p><blockquote><a href="${link}">Read and sign</a> <a href="https://protect.example/?url=${encoded}&amp;d=1">safe</a></blockquote>`,
      },
      { headers: {} },
    )
    await syncPage(kit, box.accountId, kit.w.admin.userId, [reply])
    const rows = await mailboxRows(box.accountId)
    const row = rows.find((r) => r.external_message_id === reply.externalMessageId)
    expect(row).toBeDefined()
    expect(JSON.stringify(row)).not.toContain(sent.token)
    expect(row?.text_body).toContain(`> Open it here: ${SIGNING_LINK_REMOVED}`)
    expect(row?.html_body).toContain(SIGNING_LINK_REMOVED)
    expect(row?.html_body).toContain("Read and sign")
  }, 60_000)

  it("a bounce quoting the link mail's header is not stored; one quoting an unknown id is", async () => {
    const sent = await mintTo(kit)
    const id = sent.mail.headers?.["X-Liaison-Action-Mail"] as string
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    const box = await mailboxOf(kit, kit.w.admin.userId, kit.w.admin.email)
    const bounceOf = (mailId: string) =>
      syncedCopyOf(
        {
          to: kit.w.admin.email,
          from: "mailer-daemon@mail.example",
          subject: "Undelivered Mail Returned to Sender",
          text: `Delivery failed.\n\nX-Liaison-Action-Mail: ${mailId}\nSubject: ${sent.mail.subject}`,
          html: "<p>Delivery failed.</p>",
        },
        { headers: {} },
      )
    const ours = bounceOf(id)
    const stranger = bounceOf("f".repeat(32))
    await syncPage(kit, box.accountId, kit.w.admin.userId, [ours, stranger])
    const stored = (await mailboxRows(box.accountId)).map((r) => r.external_message_id)
    expect(stored).not.toContain(ours.externalMessageId as string)
    expect(stored).toContain(stranger.externalMessageId as string)
  }, 60_000)

  it("a ticket from mail and a client's portal request and reply store a quoted link cut", async () => {
    const sent = await mintTo(kit)
    const link = linkOf(sent.mail.text ?? "")
    const seed = seedContext({ orgId: kit.w.orgId, now: new Date() })
    const address = `desk-${kit.w.orgId.slice(0, 8)}@maison-signing.test`
    const inbox = await ensureTicketMailboxInbox(seed, {
      key: "signing-desk",
      name: "Desk",
      emailAddress: address,
      connectedAccountId: await ensureTicketMailboxAccount(seed, {
        key: "signing-desk",
        emailAddress: address,
        createdBy: kit.w.admin.userId,
      }),
    })
    const [inboxRow] = await sql`SELECT * FROM app_tickets.inboxes WHERE id = ${inbox.id}`
    const raw = {
      messageId: `<quoted-${crypto.randomUUID()}@customer.example>`,
      from: { email: kit.w.clientA.email, name: kit.w.clientA.name },
      to: [{ email: address }],
      cc: [],
      subject: "About the contract",
      textBody: `I could not open ${link}`,
      htmlBody: `<p>I could not open <a href="${link}">this</a></p>`,
      headers: {},
      sentAt: new Date().toISOString(),
    } as unknown as ParsedEmail
    const made = (await withPrivilegedDb(kit.w.orgId, "quoted-link-inbound", (tx) =>
      processInboundMessage(
        raw,
        { ...(inboxRow as object), org_id: kit.w.orgId } as never,
        { db: tx, privilegedTx: tx, orgId: kit.w.orgId } as never,
      ),
    )) as { ticketId?: string; error?: unknown }
    expect(made.error).toBeUndefined()

    const token = (await createPortalSession(kit.w.clientA.userId, kit.w.orgId)).accessToken
    const portal = (path: string, body: unknown) =>
      app.request(`/api/portal${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    const res = await portal("/requests", { subject: "Link", text: `Here it is: ${link}` })
    expect(res.status).toBe(200)
    const { id } = ((await res.json()) as { data: { id: string } }).data
    const replied = await portal(`/requests/${id}/reply`, { text: `Again: ${link}` })
    expect(replied.status).toBe(200)

    const rows = await sql<Array<{ ticket_id: string; text_body: string | null }>>`
      SELECT ticket_id, text_body, html_body, snippet, subject FROM app_tickets.messages
       WHERE org_id = ${kit.w.orgId} AND ticket_id IN (${made.ticketId as string}, ${id})`
    expect(rows.length).toBe(3)
    expect(JSON.stringify(rows)).not.toContain(sent.token)
    expect(rows.every((r) => (r.text_body ?? "").includes(SIGNING_LINK_REMOVED))).toBe(true)
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${kit.w.orgId}`.catch(() => {})
  }, 120_000)
})
