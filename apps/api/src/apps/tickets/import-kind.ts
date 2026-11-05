// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import kinds of the tickets app (modules/imports). `tickets.ticket`: one
 * canonical ticket record (subject, contact, routing, messages with
 * attachments) per line; `tickets.category` and `tickets.reply-template`
 * (at the end of this file): the support configuration.
 *
 * Per record, inside its savepoint of the run's privileged batch transaction:
 *   1. MANDATORY dedup precheck on `external_ref` (`<source>:<key>` or the bare
 *      key of a row an earlier CLI run imported): `createTicket` does NOT dedup
 *      and the partial unique `uniq_app_tickets_tickets_external_ref` makes a
 *      duplicate throw 23505. Present → skipped.
 *   2. `createTicket` with the FIRST message as the initial message (dates
 *      backdated to the record's), then each further message appended with its
 *      own `sentAt`.
 *   3. Attachments through the inbound-mail persist path (object storage +
 *      `kernel.files` parented to the message row), strict by default: one
 *      failure fails the record. Lenient mode (`options.lenientAttachments`)
 *      skips the bad attachment and reports it. Byte sources: `bytesBase64`, an
 *      uploaded file (`fileId`, resolved under the person's RLS) or, from the
 *      CLI only, a local `filePath`.
 *
 * Every row the record creates is returned in creation order for the undo
 * ledger: a contact `createTicket` created for the requester, the ticket, its
 * messages, their files.
 */
import { readFile } from "node:fs/promises"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { CATEGORY_MAX_DEPTH, CATEGORY_NAME_MAX } from "~/apps/tickets/admin"
import { createTicket, resolveCategoryPath } from "~/apps/tickets/create"
import { persistInboundAttachments } from "~/apps/tickets/inbound"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows, type PrivilegedDb } from "~/db"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import {
  dedupMatchSql,
  type HostImportContext,
  type HostImportHandler,
  type ImportRowRef,
} from "~/modules/imports/types"

/** Attachment on an imported message. Exactly one byte source: inline
 *  base64, an uploaded file, or (CLI runs only) a local path. */
const attachmentSchema = z
  .object({
    filename: z.string().min(1),
    mimeType: z.string().min(1),
    bytesBase64: z.string().min(1).optional(),
    fileId: z.string().uuid().optional(),
    filePath: z.string().min(1).optional(),
  })
  .refine(
    (a) => [a.bytesBase64, a.fileId, a.filePath].filter((v) => v !== undefined).length === 1,
    { message: "exactly one of bytesBase64, fileId or filePath is required" },
  )

const messageSchema = z.object({
  kind: z.enum(["inbound", "outbound", "note"]).optional(),
  fromEmail: z.string().optional().nullable(),
  fromName: z.string().optional().nullable(),
  toEmails: z.array(z.string()).optional(),
  ccEmails: z.array(z.string()).optional(),
  subject: z.string().optional().nullable(),
  htmlBody: z.string().optional().nullable(),
  textBody: z.string().optional().nullable(),
  snippet: z.string().optional().nullable(),
  externalMessageId: z.string().optional().nullable(),
  sentAt: z.string().optional().nullable(),
  attachments: z.array(attachmentSchema).optional(),
})

/** The canonical ticket record (the manifest's JSON Schema mirrors it for API runs). */
export const ticketImportRecordSchema = z.object({
  subject: z.string().min(1),
  externalRef: z.string().min(1),
  contactEmail: z.string().optional().nullable(),
  contactName: z.string().optional().nullable(),
  channel: z.enum(["email", "web_form", "api", "mail_escalation", "manual", "social"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  status: z.enum(["open", "awaiting_customer", "awaiting_followup", "closed"]).optional(),
  closedReason: z
    .enum(["resolved", "converted_to_mail", "merged", "spam", "duplicate", "no_response"])
    .optional(),
  assigneeEmail: z.string().optional().nullable(),
  createdAt: z.string().optional().nullable(),
  firstResponseAt: z.string().optional().nullable(),
  team: z.string().optional().nullable(),
  categoryPath: z.string().optional().nullable(),
  language: z.string().optional().nullable(),
  sourceInboxId: z.string().uuid().optional().nullable(),
  messages: z.array(messageSchema).min(1),
})

export type TicketImportAttachment = z.infer<typeof attachmentSchema>
export type TicketImportMessage = z.infer<typeof messageSchema>
export type TicketImportRecord = z.infer<typeof ticketImportRecordSchema>

export type AttachmentSkip = { filename: string; reason: string }

/** The `tickets.ticket` handler's per-record report (the CLI maps it to its own). */
export interface TicketRecordReport {
  attachmentsSkipped?: AttachmentSkip[]
}

/**
 * Resolve an assignee email to an ACTIVE user id within the org. Migration
 * sources carry agent EMAILS; an unknown/inactive email imports UNASSIGNED.
 */
async function resolveAssigneeId(
  tx: PrivilegedDb,
  orgId: string,
  email: string,
): Promise<string | null> {
  const e = email.trim().toLowerCase()
  if (!e) return null
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${kernelRel("users")}
      WHERE org_id = ${orgId}::uuid AND lower(email) = ${e} AND status = 'active'
      LIMIT 1
    `),
  )
  return rows[0]?.id ?? null
}

/** Append a non-initial message honouring its `sentAt`; returns its id. */
async function appendMessage(
  tx: PrivilegedDb,
  orgId: string,
  ticketId: string,
  m: TicketImportMessage,
): Promise<string> {
  const kind = m.kind ?? "inbound"
  const sentAt = m.sentAt ?? new Date().toISOString()
  const inserted = await tx.execute(drizzleSql`
    INSERT INTO ${ticketsRel("messages")} (
      id, org_id, ticket_id, kind,
      from_email, from_name, to_emails, cc_emails,
      subject, html_body, text_body, snippet,
      external_message_id, sent_at, created_by, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), ${orgId}::uuid, ${ticketId}::uuid, ${kind},
      ${m.fromEmail ?? null}, ${m.fromName ?? null},
      ${JSON.stringify(m.toEmails ?? [])}::jsonb, ${JSON.stringify(m.ccEmails ?? [])}::jsonb,
      ${m.subject ?? null}, ${m.htmlBody ?? null}, ${m.textBody ?? null}, ${m.snippet ?? null},
      ${m.externalMessageId ?? null}, ${sentAt}::timestamptz, NULL, now(), now()
    )
    RETURNING id
  `)
  const messageId = extractRows<{ id: string }>(inserted)[0]!.id
  const inboundUpdate =
    kind === "inbound"
      ? drizzleSql`, last_inbound_at = ${sentAt}::timestamptz`
      : kind === "outbound"
        ? drizzleSql`, last_outbound_at = ${sentAt}::timestamptz`
        : drizzleSql``
  await tx.execute(drizzleSql`
    UPDATE ${ticketsRel("tickets")}
    SET message_count = message_count + 1, last_message_at = ${sentAt}::timestamptz${inboundUpdate}
    WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
  `)
  return messageId
}

/**
 * Load an attachment's bytes. An unreadable source THROWS a named error
 * (strict semantics; the lenient caller catches per attachment).
 */
async function loadAttachment(
  ctx: HostImportContext,
  att: TicketImportAttachment,
): Promise<{
  filename: string
  mimeType: string
  bytesBase64: string
  disposition: "attachment"
}> {
  let bytesBase64 = att.bytesBase64
  if (bytesBase64 === undefined && att.fileId !== undefined) {
    const file = await ctx.resolveFile(att.fileId).catch(() => {
      throw new Error(`attachment "${att.filename}": file ${att.fileId} not found`)
    })
    bytesBase64 = (await getObjectBuffer(file.storageKey)).toString("base64")
  }
  if (bytesBase64 === undefined && att.filePath !== undefined) {
    if (ctx.mode !== "cli") {
      throw new Error(`attachment "${att.filename}": filePath is accepted only from the CLI`)
    }
    try {
      bytesBase64 = (await readFile(att.filePath)).toString("base64")
    } catch (err) {
      throw new Error(
        `attachment "${att.filename}": cannot read filePath "${att.filePath}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
  if (bytesBase64 === undefined) {
    throw new Error(`attachment "${att.filename}": no byte source`)
  }
  return { filename: att.filename, mimeType: att.mimeType, bytesBase64, disposition: "attachment" }
}

/** Persist one message's attachments inside the record's savepoint. */
async function persistImportAttachments(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  messageId: string,
  attachments: TicketImportAttachment[],
  lenient: boolean,
): Promise<AttachmentSkip[]> {
  const skips: AttachmentSkip[] = []
  const loaded: Array<Awaited<ReturnType<typeof loadAttachment>>> = []
  for (const att of attachments) {
    try {
      loaded.push(await loadAttachment(ctx, att))
    } catch (err) {
      if (!lenient) throw err
      skips.push({
        filename: att.filename,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // `persistInboundAttachments` only touches ctx.db.execute/queueEvent +
  // ctx.orgId; the privileged savepoint satisfies that surface, keeping the
  // attachment rows atomic with the ticket and its messages.
  const report = await persistInboundAttachments(
    { db: tx, orgId: ctx.orgId },
    { messageId, attachments: loaded, strict: !lenient },
  )
  for (const s of report.skipped) skips.push(s)
  return skips
}

/** categoryPath → categoryId, memoised per run (errors too). */
async function resolveCategory(
  ctx: HostImportContext,
  path: string,
): Promise<{ categoryId: string } | { error: string }> {
  const key = `category:${path.trim().toLowerCase()}`
  const cached = ctx.cache.get(key)
  if (cached) return cached as { categoryId: string } | { error: string }
  const result = await resolveCategoryPath(ctx.orgId, path)
  const entry =
    "error" in result ? { error: result.error.message } : { categoryId: result.categoryId }
  ctx.cache.set(key, entry)
  return entry
}

/** The tickets this run's source already imported under `externalRef`. */
async function importedTicketIds(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  externalRef: string,
): Promise<Array<{ id: string }>> {
  return extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${ticketsRel("tickets")}
      WHERE org_id = ${ctx.orgId}::uuid
        AND ${dedupMatchSql(drizzleSql`external_ref`, ctx.sourceLabel, externalRef)}
      LIMIT 1
    `),
  )
}

/**
 * The refusals a ticket record meets before anything is written: a category
 * path that does not resolve, a team outside the person's grant, an
 * attachment a strict run cannot read (a local path outside the CLI). The run
 * (importTicket) and the preview (checkTicket) both ask here, so a preview
 * refuses what the run would. Returns the category the run files it under.
 */
async function ticketRecordChecks(
  ctx: HostImportContext,
  record: TicketImportRecord,
  previewed?: ReadonlySet<string>,
): Promise<{ categoryId: string | null } | { refusal: string }> {
  let categoryId: string | null = null
  if (record.categoryPath) {
    const cat = await resolveCategory(ctx, record.categoryPath)
    if ("error" in cat) {
      // A preview writes no category: one an earlier record of it would create resolves.
      const named = categoryKey(categorySegments(record.categoryPath))
      if (!previewed?.has(named)) return { refusal: cat.error }
    } else {
      categoryId = cat.categoryId
    }
  }
  if (record.team && !ctx.checkDimension("tickets:team", record.team)) {
    return { refusal: `out_of_scope: team "${record.team}" is outside your grant` }
  }
  if (ctx.options.lenientAttachments !== true && ctx.mode !== "cli") {
    for (const message of record.messages) {
      for (const att of message.attachments ?? []) {
        if (att.filePath !== undefined) {
          return {
            refusal: `attachment "${att.filename}": filePath is accepted only from the CLI`,
          }
        }
      }
    }
  }
  return { categoryId }
}

/** A preview's check of one ticket record: what the run would do, nothing written. */
async function checkTicket(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
): Promise<"created" | "skipped"> {
  const record = ticketImportRecordSchema.parse(raw)
  if ((await importedTicketIds(tx, ctx, record.externalRef)).length > 0) return "skipped"
  const checked = await ticketRecordChecks(ctx, record, previewCategories(ctx))
  if ("refusal" in checked) throw new Error(checked.refusal)
  return "created"
}

async function importTicket(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
  dedupValue: string,
) {
  const record = ticketImportRecordSchema.parse(raw)
  const { orgId } = ctx
  const existing = await importedTicketIds(tx, ctx, record.externalRef)
  if (existing.length > 0) return { status: "skipped" as const, rows: [] }

  // The checks a preview runs too, before anything is written.
  const checked = await ticketRecordChecks(ctx, record)
  if ("refusal" in checked) throw new Error(checked.refusal)
  const categoryId = checked.categoryId
  const assignedTo = record.assigneeEmail
    ? await resolveAssigneeId(tx, orgId, record.assigneeEmail)
    : null
  const lenient = ctx.options.lenientAttachments === true

  const [first, ...rest] = record.messages
  const result = await createTicket(
    tx,
    orgId,
    {
      subject: record.subject,
      externalRef: dedupValue,
      contactEmail: record.contactEmail ?? null,
      contactName: record.contactName ?? null,
      channel: record.channel ?? "api",
      priority: record.priority,
      status: record.status,
      closedReason: record.closedReason ?? null,
      assignedTo,
      createdAt: record.createdAt ?? null,
      firstResponseAt: record.firstResponseAt ?? null,
      team: record.team ?? null,
      language: record.language ?? null,
      categoryId,
      sourceInboxId: record.sourceInboxId ?? null,
      initialMessage: first
        ? {
            kind: first.kind ?? "inbound",
            fromEmail: first.fromEmail ?? null,
            fromName: first.fromName ?? null,
            toEmails: first.toEmails,
            ccEmails: first.ccEmails,
            subject: first.subject ?? null,
            htmlBody: first.htmlBody ?? null,
            textBody: first.textBody ?? null,
            snippet: first.snippet ?? null,
            externalMessageId: first.externalMessageId ?? null,
            sentAt: first.sentAt ?? null,
          }
        : undefined,
    },
    { actorType: "system", userId: ctx.actorUserId },
    // Its privileged reads run on this transaction, not a second connection
    // that would wait behind the batch's own locks. An import is history, not news.
    { privilegedTx: tx, notNews: true },
  )
  if ("error" in result) {
    throw new Error(`createTicket failed: ${result.error.code} — ${result.error.message}`)
  }
  // The team the ticket landed in (the record's, or its inbox's default):
  // a person may import only into teams they are granted.
  const landed = extractRows<{ team: string | null }>(
    await tx.execute(drizzleSql`
      SELECT team FROM ${ticketsRel("tickets")}
      WHERE id = ${result.ticketId}::uuid AND org_id = ${orgId}::uuid
    `),
  )[0]
  if (landed?.team && !ctx.checkDimension("tickets:team", landed.team)) {
    throw new Error(`out_of_scope: team "${landed.team}" is outside your grant`)
  }
  const attachmentsSkipped: AttachmentSkip[] = []
  const messageIds: string[] = []
  if (result.initialMessageId) messageIds.push(result.initialMessageId)
  if (first?.attachments?.length) {
    if (!result.initialMessageId) {
      // Cannot happen (a record has at least one message), but a silent drop
      // would lose files: fail the record instead.
      throw new Error("initial message has attachments but no message row was created")
    }
    attachmentsSkipped.push(
      ...(await persistImportAttachments(
        tx,
        ctx,
        result.initialMessageId,
        first.attachments,
        lenient,
      )),
    )
  }
  for (const m of rest) {
    const messageId = await appendMessage(tx, orgId, result.ticketId, m)
    messageIds.push(messageId)
    if (m.attachments?.length) {
      attachmentsSkipped.push(
        ...(await persistImportAttachments(tx, ctx, messageId, m.attachments, lenient)),
      )
    }
  }

  // Ledger rows, in creation order. A contact createTicket created for the
  // requester carries this transaction's timestamp (`now()` is fixed per
  // transaction); one an earlier record of the same batch created is already
  // on the ledger (duplicates are ignored).
  const rows: ImportRowRef[] = []
  const contact = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT c.id FROM ${kernelRel("contacts")} c
      JOIN ${ticketsRel("tickets")} t ON t.contact_id = c.id
      WHERE t.id = ${result.ticketId}::uuid AND c.org_id = ${orgId}::uuid
        AND c.created_at = now()
    `),
  )[0]
  if (contact) {
    rows.push({ table: "kernel.contacts", id: contact.id })
    // The audience grant ensure_audience_contact wrote for it (no FK: undo
    // deletes it with the contact).
    for (const g of extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${kernelRel("resource_grants")}
        WHERE org_id = ${orgId}::uuid AND resource_type = 'contact'
          AND resource_id = ${contact.id}::uuid AND created_at = now()
      `),
    )) {
      rows.push({ table: "kernel.resource_grants", id: g.id })
    }
  }
  rows.push({ table: "app_tickets.tickets", id: result.ticketId })
  for (const id of messageIds) rows.push({ table: "app_tickets.messages", id })
  if (messageIds.length > 0) {
    const files = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${kernelRel("files")}
        WHERE org_id = ${orgId}::uuid AND app = 'tickets' AND entity_type = 'message'
          AND entity_id IN (${drizzleSql.join(
            messageIds.map((id) => drizzleSql`${id}`),
            drizzleSql`, `,
          )})
        ORDER BY ordinal, id
      `),
    )
    for (const f of files) rows.push({ table: "kernel.files", id: f.id })
  }
  const report: TicketRecordReport = attachmentsSkipped.length > 0 ? { attachmentsSkipped } : {}
  return { status: "created" as const, rows, report: { ...report } }
}

export const ticketImportHandler: HostImportHandler = {
  importRecord: importTicket,
  checkRecord: checkTicket,
}

// ---------------------------------------------------------------------------
// tickets.category and tickets.reply-template: the support configuration an
// export carries alongside its tickets. Create-only (A14): an existing row is
// reused or skipped, never updated.
// ---------------------------------------------------------------------------

/** The canonical category record: a `"Parent / Child"` path. */
export const categoryImportRecordSchema = z.object({
  path: z.string().min(1),
  sortOrder: z.number().int().optional(),
  archived: z.boolean().optional(),
})

/** Path segments as `resolveCategoryPath` reads them (trimmed, empty dropped). */
function categorySegments(path: string): string[] {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * One category path. Walks the tree from the root, matching each segment by
 * name (case-insensitive, like `resolveCategoryPath`) under its parent:
 * an existing segment is reused untouched, a missing one is created (and
 * ledgered). The record's `sortOrder` and `archived` apply to the leaf it
 * creates; a path that already exists in full is skipped.
 */
/** A category path the run refuses before writing (shared with the preview). */
function categoryPathRefusal(segments: string[]): string | null {
  if (segments.length === 0) return "invalid_params: path is empty"
  if (segments.length > CATEGORY_MAX_DEPTH) {
    return `category_depth_limit: categories nest at most ${CATEGORY_MAX_DEPTH} levels`
  }
  if (segments.some((s) => s.length > CATEGORY_NAME_MAX)) {
    return `invalid_params: a category name is at most ${CATEGORY_NAME_MAX} characters`
  }
  return null
}

/** The category paths a preview passed (each prefix too), shared by the run's kinds. */
function previewCategories(ctx: HostImportContext): Set<string> {
  const shared = ctx.runCache ?? ctx.cache
  const existing = shared.get("tickets:preview-categories")
  if (existing instanceof Set) return existing as Set<string>
  const fresh = new Set<string>()
  shared.set("tickets:preview-categories", fresh)
  return fresh
}

function categoryKey(segments: string[]): string {
  return segments.map((s) => s.toLowerCase()).join(" / ")
}

/**
 * A preview's check of one category record: refused as the run refuses it,
 * skipped when every level exists, and remembered so a ticket of the same
 * preview may name it.
 */
async function checkCategory(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
): Promise<"created" | "skipped"> {
  const record = categoryImportRecordSchema.parse(raw)
  const segments = categorySegments(record.path)
  const refusal = categoryPathRefusal(segments)
  if (refusal) throw new Error(refusal)
  const seen = previewCategories(ctx)
  let parentId: string | null = null
  let missing = false
  for (const [i, segment] of segments.entries()) {
    seen.add(categoryKey(segments.slice(0, i + 1)))
    if (missing) continue
    const existing: { id: string } | undefined = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${ticketsRel("categories")}
        WHERE org_id = ${ctx.orgId}::uuid AND lower(name) = lower(${segment})
          AND ${parentId === null ? drizzleSql`parent_id IS NULL` : drizzleSql`parent_id = ${parentId}::uuid`}
        ORDER BY archived_at NULLS FIRST, created_at
        LIMIT 1
      `),
    )[0]
    if (existing) parentId = existing.id
    else missing = true
  }
  return missing ? "created" : "skipped"
}

async function importCategory(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
) {
  const record = categoryImportRecordSchema.parse(raw)
  const segments = categorySegments(record.path)
  const refusal = categoryPathRefusal(segments)
  if (refusal) throw new Error(refusal)
  const rows: ImportRowRef[] = []
  let parentId: string | null = null
  for (const [i, segment] of segments.entries()) {
    const existing: { id: string } | undefined = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${ticketsRel("categories")}
        WHERE org_id = ${ctx.orgId}::uuid AND lower(name) = lower(${segment})
          AND ${parentId === null ? drizzleSql`parent_id IS NULL` : drizzleSql`parent_id = ${parentId}::uuid`}
        ORDER BY archived_at NULLS FIRST, created_at
        LIMIT 1
      `),
    )[0]
    if (existing) {
      parentId = existing.id
      continue
    }
    const leaf = i === segments.length - 1
    const inserted: { id: string } = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${ticketsRel("categories")} (org_id, name, parent_id, sort_order, archived_at)
        VALUES (
          ${ctx.orgId}::uuid, ${segment}, ${parentId}::uuid,
          ${leaf ? (record.sortOrder ?? 0) : 0},
          ${leaf && record.archived === true ? drizzleSql`now()` : drizzleSql`NULL`}
        )
        RETURNING id
      `),
    )[0]!
    rows.push({ table: "app_tickets.categories", id: inserted.id })
    parentId = inserted.id
  }
  return rows.length === 0
    ? { status: "skipped" as const, rows: [] }
    : { status: "created" as const, rows }
}

/** The canonical reply-template record. */
export const replyTemplateImportRecordSchema = z.object({
  name: z.string().trim().min(1),
  bodyText: z.string().min(1),
  category: z.string().min(1).optional(),
})

/** One reply template; an existing name in the org is skipped untouched. */
async function importReplyTemplate(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
) {
  const record = replyTemplateImportRecordSchema.parse(raw)
  const inserted = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      INSERT INTO ${ticketsRel("reply_templates")} (org_id, name, category, body_text, created_by)
      VALUES (
        ${ctx.orgId}::uuid, ${record.name}, ${record.category ?? null}, ${record.bodyText},
        ${ctx.actorUserId}::uuid
      )
      ON CONFLICT (org_id, name) DO NOTHING
      RETURNING id
    `),
  )[0]
  return inserted
    ? {
        status: "created" as const,
        rows: [{ table: "app_tickets.reply_templates", id: inserted.id }],
      }
    : { status: "skipped" as const, rows: [] }
}

export const categoryImportHandler: HostImportHandler = {
  importRecord: (tx, ctx, record) => importCategory(tx, ctx, record),
  checkRecord: (tx, ctx, record) => checkCategory(tx, ctx, record),
}

export const replyTemplateImportHandler: HostImportHandler = {
  importRecord: (tx, ctx, record) => importReplyTemplate(tx, ctx, record),
}
