// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The core of a ticket that arrives from outside the org: the public ticket route
// (a web form or a server key) and a client's request on the portal both create it
// here. It runs as the system actor on the privileged connection, because the
// sender holds no scope or grant; what the caller may set is decided by the route
// before this runs. The ticket lands in the org's default inbox unless the route
// names one, and files the sender staged move onto its first message.
import { sql as drizzleSql } from "drizzle-orm"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { loadOrgSettings, wouldExceedOrgQuota } from "~/modules/files/service"

const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000"

/** The org's inbox for new tickets from outside, or null when none is set. */
export async function defaultCreateInboxId(orgId: string): Promise<string | null> {
  const rows = await withPrivilegedDb(orgId, "tickets-public-default-inbox", async (db) =>
    db.execute(drizzleSql`
      SELECT id FROM ${ticketsRel("inboxes")}
      WHERE org_id = ${orgId} AND is_default_for_create = true AND archived_at IS NULL
      LIMIT 1
    `),
  )
  return extractRows<{ id: string }>(rows)[0]?.id ?? null
}

export interface IngestTicketInput {
  subject: string
  channel: "web_form" | "api"
  team?: string
  sensitivity?: "internal" | "confidential" | "restricted"
  assignedTo?: string
  categoryId?: string
  sourceInboxId?: string
  externalRef?: string
  priority?: "low" | "normal" | "high" | "urgent"
  requesterEmail: string
  relatedTicketId: string | null
  message: {
    fromEmail: string
    fromName: string | null
    htmlBody: string | null
    textBody: string | null
  }
  /** A client's portal request: channel `portal`, stamped with the client's company. */
  portalRequest?: { companyId: string }
}

export type IngestTicketResult =
  | { ticketId: string; ticketHandle: string; replyToken: string; initialMessageId: string | null }
  | { error: { code: string; message: string; retryable: boolean } }

/**
 * Creates the ticket and its first (inbound) message. `contactOf` names the
 * contact inside the same transaction (the public route links an existing one,
 * the portal its person's own).
 */
export async function ingestTicket(
  orgId: string,
  input: IngestTicketInput,
  contactOf: (tx: PrivilegedDb) => Promise<string | null>,
  reason = "tickets-public-create",
): Promise<IngestTicketResult> {
  return withPrivilegedDb(orgId, reason, async (tx) => {
    const { createTicket } = await import("~/apps/tickets/create")
    const contactId = await contactOf(tx)
    return createTicket(
      tx,
      orgId,
      {
        subject: input.subject,
        channel: input.channel,
        team: input.team,
        sensitivity: input.sensitivity,
        assignedTo: input.assignedTo,
        contactId,
        categoryId: input.categoryId,
        sourceInboxId: input.sourceInboxId,
        externalRef: input.externalRef,
        priority: input.priority,
        requesterEmail: input.requesterEmail,
        relatedTicketId: input.relatedTicketId,
        initialMessage: {
          kind: "inbound",
          fromEmail: input.message.fromEmail,
          fromName: input.message.fromName,
          subject: input.subject,
          htmlBody: input.message.htmlBody,
          textBody: input.message.textBody,
        },
      },
      { actorType: "system", userId: SYSTEM_ACTOR } as never,
      { privilegedTx: tx, portalRequest: input.portalRequest },
    )
  })
}

/**
 * Moves staged files onto a message: their parent becomes the message, in the
 * order given. The storage key stays; only the row's parent changes.
 */
export async function reparentStagedFiles(
  orgId: string,
  messageId: string,
  fileIds: readonly string[],
  reason = "tickets-public-attachments-reparent",
): Promise<void> {
  if (fileIds.length === 0) return
  const KS = drizzleSql.raw(schemaRef("kernel"))
  await withPrivilegedDb(orgId, reason, async (tx) => {
    for (let i = 0; i < fileIds.length; i += 1) {
      await tx.execute(drizzleSql`
        UPDATE ${KS}.files
        SET entity_type = 'message', entity_id = ${messageId}, ordinal = ${i}
        WHERE id = ${fileIds[i]}::uuid AND org_id = ${orgId}::uuid
      `)
    }
  })
}

/** A portal attachment: at most this big, and at most this many waiting per person. */
export const PORTAL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const PORTAL_ATTACHMENT_MAX_COUNT = 8

export type StageResult =
  | { fileId: string; filename: string; mimeType: string; sizeBytes: number }
  | {
      error: "too_many" | "storage_quota_exceeded" | "malware_quarantined" | "storage_unavailable"
    }

/**
 * Keeps a file a portal person attaches, until their next request or reply takes
 * it. It passes the virus scanner first: an infected file is kept aside under a
 * quarantine key, reported, and never staged.
 */
export async function stagePortalAttachment(
  orgId: string,
  userId: string,
  file: { filename: string; mimeType: string; bytes: Uint8Array },
): Promise<StageResult> {
  const KS = drizzleSql.raw(schemaRef("kernel"))
  const refused = await withPrivilegedDb(orgId, "portal-attachment-count", async (tx) => {
    const [waiting] = extractRows<{ n: number }>(
      await tx.execute(drizzleSql`
        SELECT count(*)::int AS n FROM ${KS}.files
        WHERE org_id = ${orgId}::uuid AND app = 'tickets'
          AND entity_type = 'portal_staged' AND entity_id = ${userId}`),
    )
    if ((waiting?.n ?? 0) >= PORTAL_ATTACHMENT_MAX_COUNT) return "too_many" as const
    // A client's file counts against the org's storage like any other: a person
    // sends it, so no exemption applies and the full org refuses it.
    const settings = await loadOrgSettings(tx, orgId)
    if (await wouldExceedOrgQuota(tx, orgId, settings, file.bytes.byteLength))
      return "storage_quota_exceeded" as const
    return null
  })
  if (refused) return { error: refused }
  const { putObject, sanitizeFilename } = await import("~/infra/storage/object-storage")
  const { quarantineStorageKey, scanInboundAttachment } = await import("~/lib/clamav")
  const fileId = crypto.randomUUID()
  const filename = sanitizeFilename(file.filename || "attachment")
  const scan = await scanInboundAttachment(
    { filename, mimeType: file.mimeType, bytes: file.bytes },
    { orgId, where: "portal" },
  )
  if (scan.quarantined) {
    try {
      await putObject({
        key: quarantineStorageKey(orgId, fileId, filename),
        body: file.bytes,
        contentType: "application/octet-stream",
      })
    } catch {
      // The report below still goes out; the original is simply not kept.
    }
    const { emitSecurityEvent } = await import("~/modules/security/security-events")
    await emitSecurityEvent({
      kind: "malware_quarantined",
      orgId,
      detail: { where: "portal", fileId, signature: scan.signature },
    })
    return { error: "malware_quarantined" }
  }
  const storageKey = `orgs/${orgId}/tickets/portal-staged/${userId}/${fileId}/${filename}`
  try {
    await putObject({ key: storageKey, body: file.bytes, contentType: file.mimeType })
  } catch {
    return { error: "storage_unavailable" }
  }
  await withPrivilegedDb(orgId, "portal-attachment-stage", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO ${KS}.files
        (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
         storage_key, uploaded_by, disposition, ordinal)
      VALUES (${fileId}, ${orgId}, 'tickets', 'portal_staged', ${userId},
        ${filename}, ${file.mimeType}, ${file.bytes.byteLength}, ${storageKey}, NULL, 'attachment', 0)`)
  })
  return { fileId, filename, mimeType: file.mimeType, sizeBytes: file.bytes.byteLength }
}

/** True when every id is a file this portal person staged and no message took yet. */
export async function portalStagedFilesOk(
  orgId: string,
  userId: string,
  fileIds: readonly string[],
): Promise<boolean> {
  if (fileIds.length === 0) return true
  if (fileIds.length > PORTAL_ATTACHMENT_MAX_COUNT) return false
  const KS = drizzleSql.raw(schemaRef("kernel"))
  const [row] = await withPrivilegedDb(orgId, "portal-attachment-check", async (tx) =>
    extractRows<{ n: number }>(
      await tx.execute(drizzleSql`
        SELECT count(*)::int AS n FROM ${KS}.files
        WHERE org_id = ${orgId}::uuid AND app = 'tickets'
          AND entity_type = 'portal_staged' AND entity_id = ${userId}
          AND id = ANY(${`{${fileIds.join(",")}}`}::uuid[])`),
    ),
  )
  return (row?.n ?? 0) === new Set(fileIds).size
}

/** A portal person's reply on their request: one inbound message, as a customer's mail. */
export async function appendPortalReply(
  orgId: string,
  input: { ticketId: string; fromEmail: string; fromName: string; textBody: string },
): Promise<string> {
  const { recordInboundOnTicket } = await import("~/apps/tickets/inbound-record")
  return withPrivilegedDb(orgId, "portal-request-reply", async (tx) => {
    const sentAt = new Date().toISOString()
    const r = await tx.execute(drizzleSql`
      INSERT INTO ${ticketsRel("messages")} (
        id, org_id, ticket_id, kind, from_email, from_name, to_emails, cc_emails,
        subject, html_body, text_body, snippet, sent_at, header_references, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}, ${input.ticketId}, 'inbound', ${input.fromEmail},
        ${input.fromName}, '[]'::jsonb, '[]'::jsonb, NULL, NULL, ${input.textBody},
        ${input.textBody.slice(0, 200)}, ${sentAt}::timestamptz, '[]'::jsonb, now(), now()
      )
      RETURNING id`)
    const messageId = extractRows<{ id: string }>(r)[0]!.id
    await recordInboundOnTicket(tx, {
      orgId,
      ticketId: input.ticketId,
      sentAt,
      actor: { actorType: "system", userId: SYSTEM_ACTOR, orgId },
      privilegedTx: tx,
    } as never)
    await tx.queueEvent({
      app: "tickets",
      entity: "message",
      action: "create",
      entityId: messageId,
      data: {
        id: messageId,
        ticketId: input.ticketId,
        kind: "inbound",
        textBody: input.textBody,
        fromEmail: input.fromEmail,
        fromName: input.fromName,
        sentAt,
        orgId,
        channel: "portal",
      },
      actorId: SYSTEM_ACTOR,
      actorType: "system",
      orgId,
    })
    return messageId
  })
}
