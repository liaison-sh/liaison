// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Host handlers of the kernel kinds `chat.thread` and `chat.message`
 * (declared in modules/imports/kernel-kinds.ts): channels and their history,
 * imported the way a chat export read.
 *
 * - A channel is a discoverable chat thread whose handle is
 *   `<source>-<externalRef>` (unique per org): an existing handle is skipped,
 *   never updated. Members that resolve to people of the org take part
 *   (the creator as admin); an archived channel is archived for each of them.
 * - A message lands in a channel the importing person can see (their RLS) that
 *   an import created (this run or an earlier one, by the import ledger), or
 *   that a CLI import names in `options.existingChannels` (its threadRefs):
 *   never a channel people created in the app, where history would post as
 *   any member, backdated, with no event. A write into a channel this run did
 *   not create records one audit row per channel. It is deduplicated by its
 *   `external_ref` (`<source>:<key>`, unique per thread) and, for rows an
 *   earlier tool imported, by `metadata.<source>.ts`.
 * - Written with direct SQL, never `sendMessage()`: no outbox events, so no
 *   attention, push, email or live fan-out for history. Search indexing is a
 *   separate step (`afterCommit`, or the client's own backfill).
 * - A reply names its root by `replyToRef`. A root the run brings later is
 *   linked after the kind's last batch (`afterKind`, a roll-up the run reports
 *   as touched); a root that never comes leaves the reply in the channel,
 *   marked `orphanReply`. `afterKind` also derives the reply threads'
 *   followers and the members' read state, as the live send path would.
 * - Authors and reactors are people of the org by email (exactly, then
 *   case-insensitively); with placeholders an unknown person, or a bot
 *   (`botKey`), becomes a deactivated placeholder user. Anyone else is the
 *   importing person, and the source's name is kept in the metadata.
 * - Attachments: an uploaded file the person can see (`fileId`, copied), or
 *   from the CLI a local `filePath`; strict unless `options.lenientAttachments`,
 *   which notes a skipped file in the message.
 */
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  importPlaceholderEmail,
  isImportPlaceholderEmail,
  normalizeChannelTitle,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { extractRows, type PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import {
  copyObject as defaultCopyObject,
  putObject as defaultPutObject,
} from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { parseMentions } from "~/lib/mentions"
import { writeAuditLog } from "~/modules/audit/service"
import { buildStorageKey } from "~/modules/files/service"
import {
  dedupCandidates,
  type HostImportContext,
  type HostImportHandler,
  type ImportRecordResult,
  type ImportRowRef,
} from "~/modules/imports/types"

const log = rootLogger.child({ module: "imports-chat" })

function kernelRel(name: string): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("kernel")}.${name}`)
}

const email = z.string().max(320)

export const threadImportRecordSchema = z
  .object({
    externalRef: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    topic: z.string().max(250).optional(),
    description: z.string().max(2000).optional(),
    createdAt: z.string().min(1).optional(),
    creatorEmail: email.optional(),
    memberEmails: z.array(email).max(5000).optional(),
    archived: z.boolean().optional(),
    /** A private channel: not discoverable, seen by its members only. */
    private: z.boolean().optional(),
  })
  .strict()

const attachmentSchema = z
  .object({
    fileId: z.string().min(1).optional(),
    filePath: z.string().min(1).optional(),
    filename: z.string().min(1).max(255).optional(),
    mimeType: z.string().min(1).max(255).optional(),
  })
  .strict()
  .refine((a) => (a.fileId === undefined) !== (a.filePath === undefined), {
    message: "exactly one of fileId or filePath is required",
  })

export const messageImportRecordSchema = z
  .object({
    externalRef: z.string().min(1).max(200),
    threadRef: z.string().min(1).max(200),
    authorEmail: email.optional(),
    authorName: z.string().max(200).optional(),
    botKey: z.string().min(1).max(200).optional(),
    system: z.boolean().optional(),
    content: z.string().max(200_000),
    createdAt: z.string().min(1),
    replyToRef: z.string().min(1).max(200).optional(),
    alsoInChannel: z.boolean().optional(),
    editedAt: z.string().min(1).optional(),
    deleted: z.boolean().optional(),
    reactions: z
      .array(z.object({ emoji: z.string().min(1).max(64), userEmails: z.array(email).max(1000) }))
      .max(200)
      .optional(),
    attachments: z.array(attachmentSchema).max(50).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

/** The source namespace: the run's label, or `import` for an unlabelled run. */
function sourceOf(ctx: HostImportContext): string {
  return ctx.sourceLabel || "import"
}

/** A channel's handle: `<source>-<externalRef>`, handle-safe. */
export function threadHandle(sourceLabel: string, externalRef: string): string {
  const slug = externalRef
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .slice(0, 80)
  return `${sourceLabel || "import"}-${slug}`
}

function isoOrNow(value: string | undefined): string {
  if (!value) return new Date().toISOString()
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date "${value}"`)
  return d.toISOString()
}

// ── People ────────────────────────────────────────────────────────────────

/**
 * A person of the org by email: exactly as stored first (a placeholder a
 * client created), then case-insensitively, the active and oldest first.
 * Cached per run.
 */
async function personByEmail(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: string,
): Promise<string | null> {
  const value = raw.trim()
  if (!value) return null
  const key = `person:${value}`
  if (ctx.cache.has(key)) return (ctx.cache.get(key) as string | null) ?? null
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${kernelRel("users")}
      WHERE org_id = ${ctx.orgId}::uuid AND (email = ${value} OR lower(email) = ${value.toLowerCase()})
      ORDER BY (email = ${value}) DESC, (status = 'active') DESC, created_at ASC, id ASC
      LIMIT 1
    `),
  )
  const id = rows[0]?.id ?? null
  // Only a found person is cached: a placeholder created later in the record
  // must not be remembered if the record's savepoint rolls back.
  if (id) ctx.cache.set(key, id)
  return id
}

/** A deactivated placeholder user (no login), created once per email. */
async function placeholder(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  placeholderEmail: string,
  name: string,
  rows: ImportRowRef[],
): Promise<string> {
  const found = await personByEmail(tx, ctx, placeholderEmail)
  if (found) return found
  const id = randomUUID()
  await tx.execute(drizzleSql`
    INSERT INTO ${kernelRel("users")} (id, org_id, email, name, status)
    VALUES (${id}::uuid, ${ctx.orgId}::uuid, ${placeholderEmail.toLowerCase()}, ${name}, 'deactivated')
  `)
  rows.push({ table: "kernel.users", id })
  return id
}

// ── Threads ───────────────────────────────────────────────────────────────

async function importThread(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
) {
  const record = threadImportRecordSchema.parse(raw)
  const handle = threadHandle(ctx.sourceLabel, record.externalRef)
  const existing = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${kernelRel("threads")} WHERE org_id = ${ctx.orgId}::uuid AND handle = ${handle}
    `),
  )
  if (existing.length > 0) return { status: "skipped" as const, rows: [] }

  const creatorId = record.creatorEmail ? await personByEmail(tx, ctx, record.creatorEmail) : null
  const createdBy = creatorId ?? ctx.actorUserId
  const members: string[] = []
  for (const m of record.memberEmails ?? []) {
    if (isImportPlaceholderEmail(m)) continue
    const id = await personByEmail(tx, ctx, m)
    if (id && !members.includes(id)) members.push(id)
  }
  // A private channel's creator is one of its members, so it never ends up
  // with nobody able to see it.
  if (record.private === true && !members.includes(createdBy)) members.unshift(createdBy)
  const createdAt = isoOrNow(record.createdAt)
  const threadId = randomUUID()
  await tx.execute(drizzleSql`
    INSERT INTO ${kernelRel("threads")}
      (id, org_id, handle, title, type, discoverable, topic, description, created_from,
       created_by, created_at, updated_at)
    VALUES (${threadId}::uuid, ${ctx.orgId}::uuid, ${handle}, ${normalizeChannelTitle(record.name) || record.name}, 'thread',
            ${record.private !== true},
            ${record.topic?.trim() || null}, ${record.description?.trim() || null},
            ${JSON.stringify({ app: sourceOf(ctx), entityType: "channel", entityId: record.externalRef })}::jsonb,
            ${createdBy}::uuid, ${createdAt}::timestamptz, ${createdAt}::timestamptz)
  `)
  const rows: ImportRowRef[] = [{ table: "kernel.threads", id: threadId }]
  if (members.length > 0) {
    const admin = creatorId ?? (record.private === true ? createdBy : null)
    const seats = members.map((u) => ({ user_id: u, role: u === admin ? "admin" : "member" }))
    for (const p of extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${kernelRel("thread_participants")} (thread_id, user_id, org_id, role)
        SELECT ${threadId}::uuid, r.user_id, ${ctx.orgId}::uuid, r.role
        FROM jsonb_to_recordset(${JSON.stringify(seats)}::jsonb) AS r(user_id uuid, role text)
        ON CONFLICT (thread_id, user_id) WHERE user_id IS NOT NULL DO NOTHING
        RETURNING id
      `),
    )) {
      rows.push({ table: "kernel.thread_participants", id: p.id })
    }
    if (record.archived === true) {
      // Derived state: archived for each member, as the channel was at the source.
      await tx.execute(drizzleSql`
        INSERT INTO ${kernelRel("user_thread_state")} (user_id, thread_id, org_id, is_archived)
        SELECT r.user_id, ${threadId}::uuid, ${ctx.orgId}::uuid, true
        FROM jsonb_to_recordset(${JSON.stringify(members.map((u) => ({ user_id: u })))}::jsonb)
          AS r(user_id uuid)
        ON CONFLICT (user_id, thread_id) DO NOTHING
      `)
    }
  }
  return {
    status: "created" as const,
    rows,
    report: { membersAdded: members.length },
  }
}

// ── Messages ──────────────────────────────────────────────────────────────

interface KnownMessage {
  id: string
  /** The root of its reply thread (null for a channel message). */
  root: string | null
}

interface ThreadState {
  id: string
  /** Messages of the thread by key (prefixed and bare external refs, legacy ts). */
  byKey: Map<string, KnownMessage>
}

interface DeferredReply {
  threadId: string
  messageId: string
  replyToRef: string
  alsoInChannel: boolean
}

interface ChatCache {
  threads: Map<string, ThreadState>
  deferred: DeferredReply[]
  touchedThreads: Set<string>
}

function chatCache(ctx: HostImportContext): ChatCache {
  const hit = ctx.cache.get("chat")
  if (hit) return hit as ChatCache
  const fresh: ChatCache = { threads: new Map(), deferred: [], touchedThreads: new Set() }
  ctx.cache.set("chat", fresh)
  return fresh
}

/** The threadRefs a CLI import names as existing channels to write into. */
function explicitlyTargeted(ctx: HostImportContext, ref: string): boolean {
  const named = ctx.options.existingChannels
  return ctx.mode === "cli" && Array.isArray(named) && named.includes(ref)
}

/**
 * The thread a message names: one this run created (its ledger), or one the
 * importing person can see that an earlier import created or that a CLI
 * import names explicitly. Its known messages are loaded once.
 */
async function threadFor(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  ref: string,
): Promise<ThreadState | null> {
  const cache = chatCache(ctx)
  const hit = cache.threads.get(ref)
  if (hit) return hit
  const handle = threadHandle(ctx.sourceLabel, ref)
  const own = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT t.id FROM ${kernelRel("threads")} t
      JOIN ${kernelRel("import_ledger")} l
        ON l.row_id = t.id AND l.table_name = 'kernel.threads'
       AND l.run_id = ${ctx.runId}::uuid AND l.org_id = ${ctx.orgId}::uuid
      WHERE t.org_id = ${ctx.orgId}::uuid AND t.handle = ${handle}
    `),
  )[0]
  const id =
    own?.id ??
    (await ctx.withActorRls(async (rls) => {
      const seen = extractRows<{ id: string }>(
        await rls.execute(drizzleSql`
          SELECT id FROM ${kernelRel("threads")}
          WHERE org_id = ${ctx.orgId}::uuid AND handle = ${handle}
        `),
      )[0]
      return seen?.id ?? null
    }))
  if (!id) return null
  if (!own) {
    const imported = extractRows<{ one: number }>(
      await tx.execute(drizzleSql`
        SELECT 1 AS one FROM ${kernelRel("import_ledger")}
        WHERE org_id = ${ctx.orgId}::uuid AND table_name = 'kernel.threads' AND row_id = ${id}::uuid
        LIMIT 1
      `),
    )[0]
    if (!imported && !explicitlyTargeted(ctx, ref)) {
      throw new Error(
        `threadRef "${ref}" names a channel that was not created by an import; chat history goes only into channels an import created`,
      )
    }
    await writeAuditLog(tx, {
      orgId: ctx.orgId,
      actorId: ctx.actorUserId,
      actorType: "user",
      entityType: "thread",
      entityId: id,
      action: "import.chat_history_into_existing_channel",
      metadata: {
        runId: ctx.runId,
        handle,
        source: ctx.sourceLabel,
        createdByImport: Boolean(imported),
      },
    })
  }
  const ns = sourceOf(ctx)
  const byKey = new Map<string, KnownMessage>()
  for (const r of extractRows<{
    id: string
    reply_root_id: string | null
    external_ref: string | null
    legacy: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT id, reply_root_id, external_ref, metadata -> ${ns} ->> 'ts' AS legacy
      FROM ${kernelRel("messages")}
      WHERE org_id = ${ctx.orgId}::uuid AND thread_id = ${id}::uuid
        AND (external_ref IS NOT NULL OR metadata -> ${ns} ->> 'ts' IS NOT NULL)
    `),
  )) {
    const known = { id: r.id, root: r.reply_root_id }
    if (r.external_ref) byKey.set(r.external_ref, known)
    if (r.legacy) byKey.set(r.legacy, known)
  }
  const state = { id, byKey }
  cache.threads.set(ref, state)
  return state
}

function knownMessage(
  ctx: HostImportContext,
  thread: ThreadState,
  key: string,
): KnownMessage | null {
  for (const c of dedupCandidates(ctx.sourceLabel, key)) {
    const hit = thread.byKey.get(c)
    if (hit) return hit
  }
  return null
}

/** One attachment stored for the message (bytes copied into the org's storage). */
async function prepareAttachment(
  ctx: HostImportContext,
  messageId: string,
  att: z.infer<typeof attachmentSchema>,
): Promise<{
  filename: string
  mimeType: string
  sizeBytes: number
  storageKey: string
  /** Writes the bytes; called once the rows naming them are in. */
  write: () => Promise<void>
}> {
  if (att.fileId !== undefined) {
    // A9: an uploaded file the importing person can see.
    const file = await ctx.resolveFile(att.fileId)
    const filename = (att.filename ?? file.filename).replaceAll("\u0000", "")
    const storageKey = buildStorageKey({
      orgId: ctx.orgId,
      app: "kernel",
      entityType: "message",
      entityId: messageId,
      filename,
    })
    return {
      filename,
      mimeType: att.mimeType ?? file.mimeType,
      sizeBytes: file.sizeBytes,
      storageKey,
      write: () => defaultCopyObject({ sourceKey: file.storageKey, destKey: storageKey }),
    }
  }
  if (ctx.mode !== "cli") throw new Error("filePath is accepted only from the CLI")
  const path = att.filePath as string
  const body = await readFile(path)
  const filename = (att.filename ?? path.split("/").pop() ?? "file").replaceAll("\u0000", "")
  const mimeType = att.mimeType ?? "application/octet-stream"
  const storageKey = buildStorageKey({
    orgId: ctx.orgId,
    app: "kernel",
    entityType: "message",
    entityId: messageId,
    filename,
  })
  const put =
    typeof ctx.options.putObject === "function"
      ? (ctx.options.putObject as typeof defaultPutObject)
      : defaultPutObject
  return {
    filename,
    mimeType,
    sizeBytes: body.byteLength,
    storageKey,
    write: async () => {
      await put({ key: storageKey, body, contentType: mimeType })
    },
  }
}

async function importMessage(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
  dedupValue: string,
) {
  const record = messageImportRecordSchema.parse(raw)
  const thread = await threadFor(tx, ctx, record.threadRef)
  if (!thread) {
    throw new Error(
      `threadRef "${record.threadRef}" is not a channel this run created or one you can see`,
    )
  }
  if (knownMessage(ctx, thread, record.externalRef)) {
    return { status: "skipped" as const, rows: [] }
  }

  const rows: ImportRowRef[] = []
  const report: Record<string, number> = {}
  const ns = sourceOf(ctx)
  const metadata: Record<string, unknown> = {}
  if (record.metadata) metadata[ns] = record.metadata

  // Author. A bot post keeps the bot's name whoever authors it.
  let authorId: string | null = null
  if (record.botKey) metadata.agentAuthorLabel = record.authorName || record.botKey
  if (record.authorEmail) authorId = await personByEmail(tx, ctx, record.authorEmail)
  if (!authorId && record.botKey) {
    const label = record.authorName || record.botKey
    authorId = ctx.placeholders
      ? await placeholder(
          tx,
          ctx,
          importPlaceholderEmail(`${ns}-import`, `bot-${record.botKey}`),
          `${label} (bot)`,
          rows,
        )
      : null
  } else if (!authorId && record.authorEmail && ctx.placeholders) {
    if (!isImportPlaceholderEmail(record.authorEmail)) {
      authorId = await placeholder(
        tx,
        ctx,
        record.authorEmail,
        record.authorName || (record.authorEmail.split("@")[0] ?? record.authorEmail),
        rows,
      )
    }
  }
  if (!authorId) {
    authorId = ctx.actorUserId
    if (record.authorEmail || record.authorName) {
      metadata.importAuthorName = record.authorName ?? record.authorEmail
      report.authorsUnresolved = 1
    }
  }

  // Reply placement.
  let replyRootId: string | null = null
  let deferredReply: DeferredReply | null = null
  const messageId = randomUUID()
  if (record.replyToRef) {
    const root = knownMessage(ctx, thread, record.replyToRef)
    if (root) replyRootId = root.root ?? root.id
    else {
      deferredReply = {
        threadId: thread.id,
        messageId,
        replyToRef: record.replyToRef,
        alsoInChannel: record.alsoInChannel === true,
      }
    }
  }

  // Attachments: checked and read first (a lenient run notes one it cannot
  // read); the bytes are written once the rows naming them are in.
  let content = record.content.replaceAll("\u0000", "")
  const stored: Array<Awaited<ReturnType<typeof prepareAttachment>>> = []
  for (const att of record.attachments ?? []) {
    try {
      stored.push(await prepareAttachment(ctx, messageId, att))
    } catch (err) {
      if (ctx.options.lenientAttachments !== true) throw err
      const label = att.filename ?? att.fileId ?? "file"
      log.warn({ err, orgId: ctx.orgId, runId: ctx.runId }, "chat import: attachment skipped")
      content += `\n\n_[file unavailable: ${label}]_`
      report.attachmentsSkipped = (report.attachmentsSkipped ?? 0) + 1
    }
  }
  const fileIds = stored.map(() => randomUUID())
  if (fileIds.length > 0) metadata.attachment_file_ids = fileIds

  const mentions = parseMentions(content)
  const createdAt = isoOrNow(record.createdAt)
  await tx.execute(drizzleSql`
    INSERT INTO ${kernelRel("messages")}
      (id, thread_id, org_id, author_id, author_type, content, mentions, metadata,
       required_scopes, reply_root_id, also_in_channel, edited_at, deleted_at, created_at,
       external_ref)
    VALUES (
      ${messageId}::uuid, ${thread.id}::uuid, ${ctx.orgId}::uuid, ${authorId}::uuid,
      ${record.system === true ? "system" : "user"}, ${content},
      ${mentions.length > 0 ? JSON.stringify(mentions) : null}::jsonb,
      ${JSON.stringify(metadata)}::jsonb, '{}'::text[], ${replyRootId}::uuid,
      ${replyRootId !== null && record.alsoInChannel === true},
      ${record.editedAt ? isoOrNow(record.editedAt) : null}::timestamptz,
      ${record.deleted === true ? createdAt : null}::timestamptz,
      ${createdAt}::timestamptz, ${dedupValue}
    )
  `)
  rows.push({ table: "kernel.messages", id: messageId })

  for (const [i, f] of stored.entries()) {
    await tx.execute(drizzleSql`
      INSERT INTO ${kernelRel("files")}
        (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
         storage_key, uploaded_by, disposition, ordinal)
      VALUES (${fileIds[i]}::uuid, ${ctx.orgId}::uuid, 'kernel', 'message', ${messageId},
              ${f.filename}, ${f.mimeType}, ${f.sizeBytes}, ${f.storageKey}, ${authorId}::uuid,
              'attachment', ${i})
    `)
    rows.push({ table: "kernel.files", id: fileIds[i] as string })
  }
  for (const f of stored) await f.write()
  if (stored.length > 0) report.attachmentsStored = stored.length

  // Reactions, by the people of the org they name.
  for (const r of record.reactions ?? []) {
    for (const e of new Set(r.userEmails)) {
      const userId = await personByEmail(tx, ctx, e)
      if (!userId) {
        report.reactionsUnresolved = (report.reactionsUnresolved ?? 0) + 1
        continue
      }
      const inserted = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO ${kernelRel("message_reactions")} (message_id, user_id, org_id, emoji)
          VALUES (${messageId}::uuid, ${userId}::uuid, ${ctx.orgId}::uuid, ${r.emoji})
          ON CONFLICT DO NOTHING
          RETURNING id
        `),
      )[0]
      if (inserted) {
        rows.push({ table: "kernel.message_reactions", id: inserted.id })
        report.reactionsImported = (report.reactionsImported ?? 0) + 1
      }
    }
  }
  if (replyRootId) report.repliesImported = 1

  // The run cache learns the message once its savepoint released.
  const known = { id: messageId, root: replyRootId }
  thread.byKey.set(dedupValue, known)
  chatCache(ctx).touchedThreads.add(thread.id)
  if (deferredReply) chatCache(ctx).deferred.push(deferredReply)
  return { status: "created" as const, rows, report: { ...report, messageId } }
}

/**
 * After the kind: link the replies whose root came later (or mark them
 * orphans), then derive the reply threads' followers and the members' read
 * state for every channel the run added messages to.
 */
async function afterMessages(tx: PrivilegedDb, ctx: HostImportContext) {
  const cache = chatCache(ctx)
  const touched: ImportRowRef[] = []
  let linked = 0
  let orphans = 0
  const threadById = new Map([...cache.threads.values()].map((t) => [t.id, t]))
  for (const d of cache.deferred.splice(0)) {
    const thread = threadById.get(d.threadId)
    const root = thread ? knownMessage(ctx, thread, d.replyToRef) : null
    if (root && (root.root ?? root.id) !== d.messageId) {
      await tx.execute(drizzleSql`
        UPDATE ${kernelRel("messages")}
        SET reply_root_id = ${root.root ?? root.id}::uuid, also_in_channel = ${d.alsoInChannel}
        WHERE id = ${d.messageId}::uuid AND org_id = ${ctx.orgId}::uuid
      `)
      linked++
    } else {
      await tx.execute(drizzleSql`
        UPDATE ${kernelRel("messages")}
        SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"orphanReply": true}'::jsonb
        WHERE id = ${d.messageId}::uuid AND org_id = ${ctx.orgId}::uuid
      `)
      orphans++
    }
    touched.push({ table: "kernel.messages", id: d.messageId })
  }

  let followers = 0
  for (const threadId of cache.touchedThreads) {
    // The live send path's followers: the root's author, every replier and
    // every member mentioned in a reply, restricted to the channel's members,
    // read up to the root's last reply.
    const inserted = extractRows<{ n: number }>(
      await tx.execute(drizzleSql`
        WITH replies AS (
          SELECT r.reply_root_id AS root, r.author_id, r.author_type, r.mentions, r.created_at
          FROM ${kernelRel("messages")} r
          WHERE r.org_id = ${ctx.orgId}::uuid AND r.thread_id = ${threadId}::uuid
            AND r.reply_root_id IS NOT NULL
        ),
        last_reply AS (SELECT root, max(created_at) AS at FROM replies GROUP BY root),
        candidates AS (
          SELECT root, author_id AS user_id FROM replies WHERE author_type = 'user'
          UNION
          SELECT lr.root, m.author_id FROM last_reply lr
            JOIN ${kernelRel("messages")} m ON m.id = lr.root
          UNION
          SELECT r.root, (mn->>'id')::uuid FROM replies r,
            jsonb_array_elements(COALESCE(r.mentions, '[]'::jsonb)) mn
          WHERE mn->>'type' = 'user'
        ),
        ins AS (
          INSERT INTO ${kernelRel("reply_thread_followers")}
            (root_message_id, thread_id, user_id, org_id, last_read_at)
          SELECT c.root, ${threadId}::uuid, c.user_id, ${ctx.orgId}::uuid, lr.at
          FROM candidates c
          JOIN last_reply lr ON lr.root = c.root
          JOIN ${kernelRel("thread_participants")} tp
            ON tp.thread_id = ${threadId}::uuid AND tp.user_id = c.user_id
          ON CONFLICT (root_message_id, user_id) DO NOTHING
          RETURNING 1
        )
        SELECT count(*)::int AS n FROM ins
      `),
    )
    followers += inserted[0]?.n ?? 0
    // Read state: the members of an IMPORTED channel have read its history.
    await tx.execute(drizzleSql`
      INSERT INTO ${kernelRel("user_thread_state")}
        (user_id, thread_id, org_id, is_archived, last_read_message_id, last_read_at)
      SELECT tp.user_id, ${threadId}::uuid, ${ctx.orgId}::uuid, false,
             (SELECT m.id FROM ${kernelRel("messages")} m
               WHERE m.org_id = ${ctx.orgId}::uuid AND m.thread_id = ${threadId}::uuid
                 AND (m.reply_root_id IS NULL OR m.also_in_channel)
               ORDER BY m.created_at DESC, m.id DESC LIMIT 1),
             now()
      FROM ${kernelRel("thread_participants")} tp
      WHERE tp.thread_id = ${threadId}::uuid AND tp.user_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ${kernelRel("import_ledger")} l
          WHERE l.org_id = ${ctx.orgId}::uuid AND l.table_name = 'kernel.threads'
            AND l.row_id = ${threadId}::uuid
        )
      ON CONFLICT (user_id, thread_id) DO UPDATE SET
        last_read_message_id = COALESCE(EXCLUDED.last_read_message_id,
                                        ${kernelRel("user_thread_state")}.last_read_message_id)
    `)
  }
  return {
    rows: [],
    touched,
    report: {
      ...(linked > 0 ? { repliesLinkedAfter: linked } : {}),
      ...(orphans > 0 ? { orphanReplies: orphans } : {}),
      ...(followers > 0 ? { followers } : {}),
    },
  }
}

export const threadImportHandler: HostImportHandler = {
  importRecord: (tx, ctx, record) => importThread(tx, ctx, record),
}

export const messageImportHandler: HostImportHandler = {
  importRecord: importMessage,
  afterKind: afterMessages,
  /**
   * Index the batch's messages for search after commit, unless the client
   * backfills once per run (`options.deferIndexing`, the Slack CLI).
   */
  async afterCommit(ctx: HostImportContext, results: ImportRecordResult[]) {
    if (ctx.options.deferIndexing === true) return undefined
    const ids = results.flatMap((r) =>
      r.status === "created" && typeof r.report?.messageId === "string" ? [r.report.messageId] : [],
    )
    if (ids.length === 0) return undefined
    try {
      const { indexMessagesBulk } = await import("~/modules/search/message-indexer")
      const { failures } = await indexMessagesBulk(ctx.orgId, ids)
      return failures.length > 0 ? { indexFailures: failures.length } : undefined
    } catch (err) {
      log.warn({ err, orgId: ctx.orgId }, "imported messages could not be indexed")
      return { indexFailures: ids.length }
    }
  },
}
