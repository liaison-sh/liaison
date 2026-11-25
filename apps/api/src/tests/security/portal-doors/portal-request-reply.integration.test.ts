// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A staff reply on a client's portal request stays on the portal: the outbound
// message is what the client reads there, and the only mail is one system notice
// that a reply is waiting, with no word of the reply. Nothing leaves through the
// org's mailbox, even when the request's ticket points at one.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { app } from "~/app"
import * as sendModule from "~/apps/tickets/send"
import { sql } from "~/db"
import type { EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { createPortalSession } from "~/modules/auth/auth"
import { seedContext } from "~/seed/context"
import {
  ensureTicketMailboxAccount,
  ensureTicketMailboxInbox,
} from "~/seed/factories/support/inboxes"
import { asOrgMember } from "~/tests/helpers/org-caller"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  CaptureProvider,
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
  insertShare,
} from "./fixture"
import { dropReadsWorld } from "./reads-world"

const { ticketsReply } = await import("~/apps/tickets/tools")

let w: DoorWorld
let previous: EmailProvider
const capture = new CaptureProvider()
const mailboxSend = spyOn(sendModule, "sendOutbound").mockImplementation(async () => {
  throw new Error("a portal reply must not go through a mailbox")
})
let accountId: string
let inboxId: string

async function portal(path: string, init: RequestInit = {}) {
  const token = (await createPortalSession(w.clientA.userId, w.orgId)).accessToken
  return app.request(`/api/portal${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}

beforeAll(async () => {
  await acquireTestLock()
  w = await createDoorWorld()
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
    WHERE id = ${w.orgId}`
  await insertShare(w, { company_id: w.companyA, kind: "requests" })
  // The org has a mailbox inbox for new tickets, so the request's ticket points at it.
  const seed = seedContext({ orgId: w.orgId, now: new Date() })
  accountId = await ensureTicketMailboxAccount(seed, {
    key: "portal-reply",
    emailAddress: "support@maison-portal.test",
    createdBy: w.admin.userId,
  })
  inboxId = (
    await ensureTicketMailboxInbox(seed, {
      key: "portal-reply",
      name: "Support",
      emailAddress: "support@maison-portal.test",
      fromDisplayName: "Support",
      connectedAccountId: accountId,
      isDefault: { adminUserId: w.admin.userId },
    })
  ).id
  previous = getSystemEmailProvider()
  setSystemEmailProvider(capture)
}, 180_000)

afterAll(async () => {
  setSystemEmailProvider(previous)
  mailboxSend.mockRestore()
  if (w) {
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${w.orgId}`.catch(() => {})
    await dropReadsWorld(w)
    await sql`DELETE FROM app_tickets.inboxes WHERE id = ${inboxId}`.catch(() => {})
    await sql`DELETE FROM kernel.connected_accounts WHERE id = ${accountId}`.catch(() => {})
    await dropDoorWorld(w)
  }
  await sql.unsafe("REVOKE liaison_portal FROM liaison_request GRANTED BY liaison").catch(() => {})
  await releaseTestLock()
})

describe("a staff reply on a portal request", () => {
  it("a staff reply appears on the portal and the notice mail holds no reply text", async () => {
    const created = await portal("/requests", {
      method: "POST",
      body: JSON.stringify({ subject: "Logo files", text: "Where are the final logo files?" }),
    })
    expect(created.status).toBe(200)
    const { id } = ((await created.json()) as { data: { id: string } }).data
    const [ticket] = await sql<{ source_inbox_id: string | null }[]>`
      SELECT source_inbox_id FROM app_tickets.tickets WHERE id = ${id}`
    expect(ticket?.source_inbox_id).toBe(inboxId)
    capture.sent.length = 0

    const replyText = "The folder is shared with you, secret code 4471."
    const result = await asOrgMember(w.orgId, w.member.userId, (tx) =>
      ticketsReply(
        { ticketId: id, textBody: replyText },
        { tx: tx as never, orgId: w.orgId, actor: { actorType: "user", userId: w.member.userId } },
      ),
    )
    expect(result).toMatchObject({ ok: true })
    expect(mailboxSend).not.toHaveBeenCalled()

    const list = await portal("/requests")
    const requests = (
      (await list.json()) as {
        data: Array<{
          id: string
          messages: Array<{ direction?: string; kind?: string; textBody?: string }>
        }>
      }
    ).data
    const mine = requests.find((r) => r.id === id)
    expect(JSON.stringify(mine?.messages ?? [])).toContain(replyText)

    // The notice is sent after the reply's commit, without waiting on it.
    for (let i = 0; i < 50 && capture.sent.length === 0; i++) await Bun.sleep(20)
    expect(capture.sent).toHaveLength(1)
    const [notice] = capture.sent
    expect(notice?.to).toBe(w.clientA.email)
    expect(notice?.template).toBe("portal.request-reply")
    const whole = `${notice?.subject}\n${notice?.text ?? ""}\n${notice?.html ?? ""}`
    expect(whole).toContain("Logo files")
    expect(whole).not.toContain("4471")
    expect(whole).not.toContain("shared with you")
    expect(whole).not.toContain("final logo files")
  })
})
