// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A staff reply sent from the ticket composer with a file picked in it
// (attachmentSessionId) must carry that file ON THE EMAIL the customer gets,
// not only on the Liaison message row, and an attachment-only reply (no text)
// still sends. The same reply may copy other people (cc).
//
// `sendOutbound` is mocked to capture the outgoing email (same HERMETICITY
// pattern as reply-supersedes-pending-draft.test.ts): mock.module leaks past
// this file under bun's flat test process, so the REAL module is spread and
// restored in afterAll.

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import * as realSend from "~/apps/tickets/send"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { files } from "~/db/schema/kernel/files"
import { putObject } from "~/infra/storage/object-storage"
import type { StructuredEmail } from "~/lib/email/types"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { asOrgMember } from "~/tests/helpers/org-caller"

const realSendModule = { ...realSend }

const sent: StructuredEmail[] = []
let sendCounter = 0
mock.module("~/apps/tickets/send", () => ({
  ...realSendModule,
  sendOutbound: async (email: StructuredEmail) => {
    sent.push(email)
    return {
      externalMessageId: `<staged-${++sendCounter}@test>`,
      deliveryState: "delivered" as const,
      rfc2822: "",
    }
  },
}))

afterAll(() => {
  mock.module("~/apps/tickets/send", () => realSendModule)
})

const { ticketsReply } = await import("./tools")

const rows = (r: unknown): any[] => (r as any).rows ?? r

let orgId: string
let userId: string
let accountId: string
let inboxId: string

const PDF_BYTES = Buffer.from("%PDF-1.4\n% proforma test bytes\n%%EOF\n")

beforeAll(async () => {
  const slug = `reply-staged-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("reply-staged-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Reply Staged Test', ${slug}) RETURNING id`),
    )[0].id
    userId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id`),
    )[0].id
    accountId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by, access_token_encrypted)
        VALUES (gen_random_uuid(), ${orgId}, 'tickets', 'gmail', 'org', null, 'oauth2', 'support@fabrikam.test', 'active', ${userId}, 'enc')
        RETURNING id`),
    )[0].id
    inboxId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes
          (id, org_id, kind, connected_account_id, name, email_address, from_display_name, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'mailbox', ${accountId}, 'Support', 'support@fabrikam.test', 'Fabrikam Support', true, now(), now())
        RETURNING id`),
    )[0].id
    // A second inbox of the same org: its address is ours too and is never copied.
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.inboxes
        (id, org_id, kind, connected_account_id, name, email_address, from_display_name, is_default_for_create, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, 'mailbox', ${accountId}, 'Sales', 'sales@fabrikam.test', 'Fabrikam Sales', false, now(), now())`)
  })
  await ensureAppsForOrg(orgId, {})
})

async function createTicketWithInbound(): Promise<string> {
  return withPrivilegedDb(orgId, "reply-staged-create", async (tx) => {
    const handle = `ticket_${Math.random().toString(36).slice(2, 8)}`
    const ticketId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          reply_token, source_inbox_id, source_account_id,
          sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
          message_count, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${handle}, 'Need a proforma', 'open', 'normal', 'email', 'internal',
          ${Math.random().toString(36).slice(2, 12)}, ${inboxId}, ${accountId},
          3600, now() + interval '1 hour', now(), 0,
          0, now(), now()
        )
        RETURNING id
      `),
    )[0]!.id
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (
        id, org_id, ticket_id, kind, from_email, from_name, cc_emails, sent_at, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}, ${ticketId}, 'inbound', 'customer@example.com', 'Cust',
        '["boss@example.com"]'::jsonb, now(), now(), now()
      )
    `)
    return ticketId
  })
}

/** Stage one PDF on an upload session. By default bound to `ticketId` the way
 *  the ticket composer creates it; `target` stages it anywhere else. */
async function stagePdf(
  filename: string,
  ticketId: string | null,
  target: { app: string; entityType: string } = { app: "tickets", entityType: "ticket" },
): Promise<{ sessionId: string; fileId: string }> {
  return withPrivilegedDb(orgId, "reply-staged-stage", async (tx) => {
    const sessionId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.file_upload_sessions (org_id, created_by, target_app, target_entity_type, target_entity_id)
        VALUES (${orgId}, ${userId}, ${target.app}, ${target.entityType}, ${ticketId})
        RETURNING id`),
    )[0]!.id
    const storageKey = `orgs/${orgId}/k/file_upload_session/${sessionId}/${crypto.randomUUID()}/${filename}`
    await putObject({ key: storageKey, body: PDF_BYTES, contentType: "application/pdf" })
    const [f] = await tx
      .insert(files)
      .values({
        orgId,
        app: "kernel",
        entityType: "file_upload_session",
        entityId: sessionId,
        filename,
        mimeType: "application/pdf",
        sizeBytes: PDF_BYTES.byteLength,
        storageKey,
        uploadedBy: userId,
      })
      .returning({ id: files.id })
    return { sessionId, fileId: f!.id }
  })
}

async function reply(params: Record<string, unknown>) {
  return asOrgMember(orgId, userId, async (tx) => {
    const ctx = {
      tx: tx as never,
      orgId,
      actor: { actorType: "user" as const, userId, scopes: ["tickets:tickets:write"] },
    }
    return ticketsReply(params as never, ctx)
  })
}

describe("ticketsReply: composer staged files ride the customer email", () => {
  it("puts a staged PDF on the outgoing email and on the message row", async () => {
    const ticketId = await createTicketWithInbound()
    const { sessionId, fileId } = await stagePdf("proforma.pdf", ticketId)
    sent.length = 0

    const result = await reply({
      ticketId,
      textBody: "Please find the proforma attached.",
      attachmentSessionId: sessionId,
    })
    expect("ok" in result && result.ok).toBe(true)

    // FALSIFIABLE: before the fix only agent `attachments` ids reached the
    // email; the composer's session files were moved onto the message row
    // after the send, so the customer received no attachment.
    expect(sent).toHaveLength(1)
    const parts = sent[0]!.attachments ?? []
    expect(parts.map((a) => a.filename)).toEqual(["proforma.pdf"])
    expect(Buffer.from(parts[0]!.content as string, "base64").equals(PDF_BYTES)).toBe(true)

    const parent = await withPrivilegedDb(orgId, "reply-staged-parent", (tx) =>
      tx.execute(
        drizzleSql`SELECT app, entity_type, entity_id FROM kernel.files WHERE id = ${fileId}`,
      ),
    )
    const row = extractRows<{ app: string; entity_type: string; entity_id: string }>(parent)[0]!
    expect(row.app).toBe("tickets")
    expect(row.entity_type).toBe("message")
    expect(row.entity_id).toBe((result as { messageId: string }).messageId)

    // An open ticket learns about the files live: a message update event
    // carries them, since the create event was queued before they landed.
    // FALSIFIABLE: nothing announced them, the card showed no PDF until a reload.
    const messageId = (result as { messageId: string }).messageId
    const events = await withPrivilegedDb(orgId, "reply-staged-events", (tx) =>
      tx.execute(drizzleSql`
        SELECT payload FROM kernel.pending_events
        WHERE org_id = ${orgId} AND payload->>'entity' = 'message'
          AND payload->>'action' = 'update' AND payload->>'entityId' = ${messageId}`),
    )
    const update = extractRows<{ payload: any }>(events)[0]?.payload
    expect(update?.data?.attachments?.map((a: { filename: string }) => a.filename)).toEqual([
      "proforma.pdf",
    ])
    expect(update?.data?.attachments?.[0]?.id).toBe(fileId)
  })

  it("sends an attachment only reply (no text) with the file on it", async () => {
    const ticketId = await createTicketWithInbound()
    const { sessionId } = await stagePdf("label.pdf", ticketId)
    sent.length = 0

    const result = await reply({ ticketId, textBody: "", attachmentSessionId: sessionId })
    expect("ok" in result && result.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect((sent[0]!.attachments ?? []).map((a) => a.filename)).toEqual(["label.pdf"])
  })

  async function stillStaged(fileId: string): Promise<boolean> {
    const r = await withPrivilegedDb(orgId, "reply-staged-still", (tx) =>
      tx.execute(drizzleSql`SELECT entity_type FROM kernel.files WHERE id = ${fileId}`),
    )
    return extractRows<{ entity_type: string }>(r)[0]?.entity_type === "file_upload_session"
  }

  it("refuses files staged on ANOTHER ticket before sending anything", async () => {
    const ticketId = await createTicketWithInbound()
    const otherTicketId = await createTicketWithInbound()
    const { sessionId, fileId } = await stagePdf("other-customer.pdf", otherTicketId)
    sent.length = 0

    const result = await reply({ ticketId, textBody: "hi", attachmentSessionId: sessionId })
    // FALSIFIABLE: any session the caller owned was sent whole, wherever it was
    // started, so another customer's file went out with this reply.
    expect("error" in result && result.error.code).toBe("attachment_session_other_ticket")
    expect(sent).toHaveLength(0)
    expect(await stillStaged(fileId)).toBe(true)
  })

  it("refuses a session started outside the ticket composer (a Drive import, an unbound upload)", async () => {
    const ticketId = await createTicketWithInbound()
    for (const target of [
      { app: "google-drive", entityType: "file" },
      { app: "tickets", entityType: "message" },
    ]) {
      const { sessionId } = await stagePdf("imported.pdf", null, target)
      sent.length = 0
      const result = await reply({ ticketId, textBody: "hi", attachmentSessionId: sessionId })
      expect("error" in result && result.error.code).toBe("attachment_session_other_ticket")
      expect(sent).toHaveLength(0)
    }
  })

  it("the approval card lists every staged file that will be sent", async () => {
    const ticketId = await createTicketWithInbound()
    const { sessionId } = await stagePdf("first.pdf", ticketId)
    // A second file on the same session.
    await withPrivilegedDb(orgId, "reply-staged-second", async (tx) => {
      await tx.insert(files).values({
        orgId,
        app: "kernel",
        entityType: "file_upload_session",
        entityId: sessionId,
        filename: "second.pdf",
        mimeType: "application/pdf",
        sizeBytes: PDF_BYTES.byteLength,
        storageKey: `orgs/${orgId}/k/file_upload_session/${sessionId}/x/second.pdf`,
        uploadedBy: userId,
      })
    })
    const { summarizeTicketReply } = await import("./summarizers")
    const summary = await asOrgMember(orgId, userId, (tx) =>
      summarizeTicketReply(
        { ticketId, textBody: "hi", attachmentSessionId: sessionId },
        { tx: tx as never, orgId, userId },
      ),
    )
    const text = summary.lines.join("\n")
    // FALSIFIABLE: the card only resolved a single folded file id, so a
    // composer session showed no attachment at all.
    expect(text).toContain("first.pdf")
    expect(text).toContain("second.pdf")
    expect(text).not.toContain("not attached on this ticket")
  })

  it("the approval card warns when the staged files belong to another ticket", async () => {
    const ticketId = await createTicketWithInbound()
    const otherTicketId = await createTicketWithInbound()
    const { sessionId } = await stagePdf("other.pdf", otherTicketId)
    const { summarizeTicketReply } = await import("./summarizers")
    const summary = await asOrgMember(orgId, userId, (tx) =>
      summarizeTicketReply(
        { ticketId, textBody: "hi", attachmentSessionId: sessionId },
        { tx: tx as never, orgId, userId },
      ),
    )
    expect(summary.lines.join("\n")).toContain("other.pdf")
    expect(summary.lines.some((l) => l.includes("not attached on this ticket"))).toBe(true)
  })

  it("a note takes the files staged on its own ticket", async () => {
    const ticketId = await createTicketWithInbound()
    const { sessionId, fileId } = await stagePdf("note.pdf", ticketId)
    const { runAdminOp } = await import("./admin")
    const res = (await asOrgMember(orgId, userId, (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "addNote",
        { ticketId, text: "see file", attachmentSessionId: sessionId },
        { actorType: "user", userId, scopes: ["tickets:tickets:write"] } as never,
      ),
    )) as { messageId?: string }
    expect(res.messageId).toBeTruthy()
    const r = await withPrivilegedDb(orgId, "reply-staged-note-file", (tx) =>
      tx.execute(drizzleSql`SELECT entity_type, entity_id FROM kernel.files WHERE id = ${fileId}`),
    )
    expect(extractRows<{ entity_type: string; entity_id: string }>(r)[0]).toEqual({
      entity_type: "message",
      entity_id: res.messageId!,
    })
  })
})

describe("ticketsReply: cc", () => {
  it("copies the requested addresses, never the customer or any inbox of ours, and records them", async () => {
    const ticketId = await createTicketWithInbound()
    sent.length = 0

    const result = await reply({
      ticketId,
      textBody: "Looping in the team.",
      cc: [
        "boss@example.com",
        "Boss@Example.com",
        "customer@example.com",
        "support@fabrikam.test",
        "SALES@fabrikam.test",
      ],
    })
    expect("ok" in result && result.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.cc).toEqual(["boss@example.com"])

    const stored = await withPrivilegedDb(orgId, "reply-staged-cc-row", (tx) =>
      tx.execute(
        drizzleSql`SELECT to_emails, cc_emails FROM app_tickets.messages
                   WHERE id = ${(result as { messageId: string }).messageId}`,
      ),
    )
    const msg = extractRows<{ to_emails: string[]; cc_emails: string[] }>(stored)[0]!
    expect(msg.to_emails).toEqual(["customer@example.com"])
    expect(msg.cc_emails).toEqual(["boss@example.com"])
  })

  it("sends no Cc when none is requested", async () => {
    const ticketId = await createTicketWithInbound()
    sent.length = 0
    const result = await reply({ ticketId, textBody: "Just you." })
    expect("ok" in result && result.ok).toBe(true)
    expect(sent[0]!.cc ?? []).toEqual([])
  })

  it("refuses an invalid cc address before sending anything", async () => {
    const ticketId = await createTicketWithInbound()
    sent.length = 0
    const result = await reply({ ticketId, textBody: "hi", cc: ["not-an-address"] })
    expect("error" in result && result.error.code).toBe("invalid_params")
    expect(sent).toHaveLength(0)
  })
})
