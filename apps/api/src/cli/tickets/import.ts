// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `tickets import` (Task 15). A generic NDJSON bulk ticket importer — canonical
 * shape only (no provider parsers; the caller transforms to canonical first).
 *
 * Per record (CORRECTION #6): under `withPrivilegedDb` we FIRST
 *   `SELECT id FROM app_tickets.tickets WHERE org_id=$ AND external_ref=$`
 * because `createTicket` does NOT dedup on `external_ref` — the partial unique
 * `uniq_app_tickets_tickets_external_ref` makes a duplicate THROW 23505 (its retry
 * loop only special-cases `external_message_id`, so an external_ref dup exhausts
 * the retry budget and throws). The pre-SELECT is MANDATORY. Present → skipped.
 * Absent → `createTicket(tx, orgId, …, { actorType:'system', userId })` with the
 * FIRST message as `initialMessage`; subsequent messages are appended as inbound
 * rows carrying their own `sentAt`.
 *
 * Dates: message `sent_at` honours the supplied historical timestamp; ticket
 * `created_at` + the SLA clock are backdated to the record's `createdAt` when
 * supplied (createTicket anchors both; without it they bind `now()`), and
 * `firstResponseAt` is honoured the same way.
 *
 * Routing/classification pass-throughs: `team`, `sourceInboxId` and
 * `categoryPath` ("Parent / Child", resolved case-insensitively via the same
 * resolver as the public webhook — an unresolvable path FAILS the record) plus
 * a free-text `language` label (same semantics as the tickets_setLanguage tool).
 *
 * Attachments: each message may carry
 * `attachments: [{filename, mimeType, bytesBase64 | filePath}]` (exactly one
 * byte source; `filePath` keeps multi-GB corpora out of the NDJSON). Bytes are
 * persisted through the inbound-mail path (`persistInboundAttachments`:
 * object storage + `kernel.files` parented to the message row) INSIDE the same
 * per-record transaction. Default is STRICT — any attachment failure (missing
 * file, size cap, storage error) fails the whole record and rolls it back; no
 * half-imported tickets. `--lenient-attachments` instead skips the bad
 * attachment and reports it LOUDLY in `attachmentsSkipped[]`. Note the object
 * PUT itself is outside the DB transaction: a later rollback may leave an
 * orphaned storage object, which is harmless — `kernel.files` rows are the
 * source of truth (same posture as the inbound-mail path).
 *
 * Writes go through the import framework (`runImport`, kind `tickets.ticket`):
 * one privileged transaction per batch, each record in its own savepoint (a
 * record-level failure rolls back just that record and the stream continues),
 * every created row recorded in the run's undo ledger. Each record is
 * validated against a Zod schema; a malformed line is reported in `failed[]` with
 * its line number and does NOT abort the stream.
 *
 * `--dry-run` validates every line and writes NOTHING — including resolving
 * `categoryPath` (read-only) and checking `attachments[].filePath` readability,
 * so a full corpus can be vetted before the real run.
 *
 * `--freshdesk-xml` mode: `args.file` is a Freshdesk "Export Tickets" XML file
 * (`Tickets0.xml` .. `TicketsN.xml`) instead of NDJSON. It runs the shipped
 * Freshdesk reference transform (`modules/imports/reference/freshdesk-xml.js`)
 * through the import framework, in the transform sandbox like any agent-written
 * transform: the full agent and customer conversation, internal notes kept
 * internal, into the same `tickets.ticket` kind with the same bare external
 * refs, so dedup and report semantics are those of the NDJSON mode.
 * `args.freshdeskUsersFile` / `args.freshdeskAgentsFile` are optional
 * `Users*.xml` / `AllAgents*.xml` people directories, read first: with them,
 * message authors get their names and emails; without, messages still import
 * with `fromEmail`/`fromName` left null.
 */
import { createReadStream } from "node:fs"
import { access, constants } from "node:fs/promises"
import { createInterface } from "node:readline"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { resolveCategoryPath } from "~/apps/tickets/create"
import type { TicketRecordReport } from "~/apps/tickets/import-kind"
import { kernelRel } from "~/apps/tickets/schema-refs"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import { readReference } from "~/modules/imports/reference/references"
import { type ImportRecordEvent, runImport } from "~/modules/imports/runner"
import type { SourceItem } from "~/modules/imports/source"
import { shutdownTransformPool } from "~/modules/imports/transforms/pool"

const log = rootLogger.child({ module: "cli-tickets-import" })

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

/**
 * Attachment on an imported message. Exactly ONE byte source:
 * - `bytesBase64` — inline (small corpora / synthetic fixtures);
 * - `filePath` — a path readable by THIS process (mandatory for big corpora so
 *   the NDJSON stays streamable instead of inflating 4/3× with base64).
 */
const importAttachmentSchema = z
  .object({
    filename: z.string().min(1),
    mimeType: z.string().min(1),
    bytesBase64: z.string().min(1).optional(),
    filePath: z.string().min(1).optional(),
  })
  .refine((a) => (a.bytesBase64 === undefined) !== (a.filePath === undefined), {
    message: "exactly one of bytesBase64 or filePath is required",
  })

/** Canonical NDJSON message shape (spec §5.4). */
const importMessageSchema = z.object({
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
  attachments: z.array(importAttachmentSchema).optional(),
})

/** Canonical NDJSON ticket record shape (spec §5.4). */
const importRecordSchema = z.object({
  subject: z.string().min(1),
  externalRef: z.string().min(1),
  contactEmail: z.string().optional().nullable(),
  contactName: z.string().optional().nullable(),
  channel: z.enum(["email", "web_form", "api", "mail_escalation", "manual", "social"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  // Canonical Liaison status (the caller maps the source system's states to these
  // FIRST). Honoured by createTicket so resolved/closed source tickets land correctly
  // instead of being forced to 'open'. `closedReason` only applies when status='closed'.
  status: z.enum(["open", "awaiting_customer", "awaiting_followup", "closed"]).optional(),
  closedReason: z
    .enum(["resolved", "converted_to_mail", "merged", "spam", "duplicate", "no_response"])
    .optional(),
  // Resolved against kernel.users by email within the org; unknown/inactive → left
  // unassigned (never fails the import).
  assigneeEmail: z.string().optional().nullable(),
  // ISO-8601. Backdate the ticket + its SLA clock to the source's real timestamps.
  createdAt: z.string().optional().nullable(),
  firstResponseAt: z.string().optional().nullable(),
  // Pass-throughs to createTicket (which already validates them):
  // free-text team dimension value.
  team: z.string().optional().nullable(),
  // "Parent / Child" category path, resolved case-insensitively against the
  // org's category tree (same resolver as the public webhook). An unresolvable
  // path fails the RECORD loudly — a migration maps categories deliberately.
  categoryPath: z.string().optional().nullable(),
  // Free-text language label (e.g. "French") — tickets_setLanguage semantics.
  language: z.string().optional().nullable(),
  // Target inbox id (UUID). Unknown/archived inbox fails the record.
  sourceInboxId: z.string().uuid().optional().nullable(),
  messages: z.array(importMessageSchema).min(1),
})

type ImportRecord = z.infer<typeof importRecordSchema>

export interface TicketsImportReport {
  created: number
  skipped: number
  failed: Array<{ line: number; error: string }>
  /** Lenient-mode ONLY: attachments deliberately skipped, named loudly (file +
   *  reason + owning record). Always empty in strict mode — a strict attachment
   *  failure fails the whole record into `failed[]` instead. */
  attachmentsSkipped: Array<{ line: number; externalRef: string; filename: string; reason: string }>
}

export interface RunTicketsImportArgs {
  file: string
  orgSlug?: string
  dryRun: boolean
  /** Parse `file` as a Freshdesk "Export Tickets" XML file instead of NDJSON. */
  freshdeskXml?: boolean
  /** Optional `Users*.xml` (customer directory) for author identity resolution. */
  freshdeskUsersFile?: string
  /** Optional `AllAgents*.xml` (agent directory) for author identity resolution. */
  freshdeskAgentsFile?: string
  /** Default STRICT: an attachment failure fails its whole record (transaction
   *  rollback — no half-imported tickets). `true` downgrades attachment
   *  failures to loud entries in `report.attachmentsSkipped` (the record still
   *  imports; skips do NOT affect the exit code — they were explicitly
   *  tolerated). Use for corpora where a few oversized/broken files must not
   *  block the run. */
  lenientAttachments?: boolean
}

export interface RunTicketsImportResult {
  exitCode: number
  report: TicketsImportReport
}

/** Resolve a real admin/owner user id for the org so contact `created_by` and the
 *  create event carry a meaningful actor; falls back to the NIL system user. */
async function resolveActorUserId(orgId: string): Promise<string> {
  return withPrivilegedDb(orgId, "cli-tickets-import-resolve-actor", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${kernelRel("users")}
        WHERE org_id = ${orgId}::uuid AND status = 'active'
        ORDER BY created_at ASC LIMIT 1
      `),
    )
    return rows[0]?.id ?? NIL_UUID
  })
}

/** Per-run context of the NDJSON line loop. */
interface ImportRunCtx {
  dryRun: boolean
  lenientAttachments: boolean
  resolveCategory: (path: string) => Promise<{ categoryId: string } | { error: string }>
  report: TicketsImportReport
}

/**
 * Validate one already-parsed NDJSON record, including categoryPath resolution (read-only,
 * so it runs in dry-run too) and, in dry-run, attachment readability. Returns
 * the record to import, or null when it failed (already reported) or the run
 * is a dry run.
 */
async function validateRecord(
  parsed: unknown,
  lineNo: number,
  ctx: ImportRunCtx,
): Promise<ImportRecord | null> {
  const { dryRun, lenientAttachments, report } = ctx
  const validated = importRecordSchema.safeParse(parsed)
  if (!validated.success) {
    const message = validated.error.issues
      .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ")
    report.failed.push({ line: lineNo, error: `invalid record: ${message}` })
    return null
  }

  const record = validated.data

  // categoryPath resolves in dry-run too (read-only) — an unmapped category
  // must surface during corpus vetting, not midway through the real run.
  if (record.categoryPath) {
    const cat = await ctx.resolveCategory(record.categoryPath)
    if ("error" in cat) {
      report.failed.push({ line: lineNo, error: cat.error })
      return null
    }
  }

  if (dryRun) {
    // Validate only — write nothing. Attachment filePaths are still checked
    // for readability (strict mode: a missing file is a record failure the
    // real run would hit; lenient mode tolerates it by definition).
    if (!lenientAttachments) {
      for (const m of record.messages) {
        for (const att of m.attachments ?? []) {
          if (att.filePath === undefined) continue
          try {
            await access(att.filePath, constants.R_OK)
          } catch {
            report.failed.push({
              line: lineNo,
              error: `attachment "${att.filename}": filePath not readable: "${att.filePath}"`,
            })
            return null
          }
        }
      }
    }
    return null
  }
  return record
}

/**
 * Run the NDJSON ticket import. Streams the file line-by-line (never loads it
 * all into memory). A malformed/invalid line is reported in `failed[]` with its
 * line number and the stream continues. `--dry-run` validates only.
 *
 * Valid records are written by the import framework (`runImport`, kind
 * `tickets.ticket`, modules/imports) as the privileged operator, with no source
 * label so external refs stay exactly as given: dedup, append, attachments and
 * the undo ledger are the kind's.
 *
 * When `args.freshdeskXml` is set, `args.file` is a Freshdesk XML export, run
 * through the Freshdesk reference transform (see module docstring).
 */
export async function runTicketsImport(
  args: RunTicketsImportArgs,
): Promise<RunTicketsImportResult> {
  const report: TicketsImportReport = {
    created: 0,
    skipped: 0,
    failed: [],
    attachmentsSkipped: [],
  }
  const lenientAttachments = args.lenientAttachments ?? false

  const resolved = await resolveOrgId(
    args.orgSlug,
    "multiple orgs exist — pass --org <slug> to disambiguate",
  )
  if (!resolved.ok) {
    process.stderr.write(`tickets import: ${resolved.message}\n`)
    return { exitCode: 2, report }
  }
  const orgId = resolved.orgId
  const actorUserId = args.dryRun ? NIL_UUID : await resolveActorUserId(orgId)

  // categoryPath → categoryId, memoized per run: a bulk corpus repeats the same
  // handful of paths thousands of times; each resolution walks the tree with
  // one read per segment. Resolution errors are memoized too (fail every line
  // carrying the bad path, resolve it once).
  const categoryCache = new Map<string, { categoryId: string } | { error: string }>()
  const resolveCategory = async (
    path: string,
  ): Promise<{ categoryId: string } | { error: string }> => {
    const key = path.trim().toLowerCase()
    const cached = categoryCache.get(key)
    if (cached) return cached
    const result = await resolveCategoryPath(orgId, path)
    const entry =
      "error" in result ? { error: result.error.message } : { categoryId: result.categoryId }
    categoryCache.set(key, entry)
    return entry
  }

  const ctx: ImportRunCtx = {
    dryRun: args.dryRun,
    lenientAttachments,
    resolveCategory,
    report,
  }

  const operator = {
    actorType: "user" as const,
    userId: actorUserId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
  const onRecord = (e: ImportRecordEvent) => {
    if (e.status === "created") report.created++
    else if (e.status === "skipped") report.skipped++
    else {
      log.error({ line: e.line, externalRef: e.dedupKey, error: e.error }, "ticket import failed")
      report.failed.push({ line: e.line, error: e.error ?? "import failed" })
    }
    const skips = (e.report as TicketRecordReport | undefined)?.attachmentsSkipped ?? []
    for (const s of skips) {
      log.warn(
        { line: e.line, externalRef: e.dedupKey, filename: s.filename, reason: s.reason },
        "attachment skipped (lenient mode)",
      )
      report.attachmentsSkipped.push({
        line: e.line,
        externalRef: e.dedupKey,
        filename: s.filename,
        reason: s.reason,
      })
    }
  }

  if (args.freshdeskXml) {
    // The shipped reference transform, through the runner: directories first,
    // then the tickets. A dry run validates and writes no ticket.
    const ref = readReference("freshdesk-xml")
    const paths = [args.freshdeskUsersFile, args.freshdeskAgentsFile, args.file].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    )
    try {
      await runImport({
        orgId,
        actor: { ...operator, userId: args.dryRun ? await resolveActorUserId(orgId) : actorUserId },
        kinds: ref.kinds,
        source: {
          type: "transform",
          transform: { inline: ref.code, name: ref.name },
          input: { type: "paths", paths },
        },
        sourceLabel: "",
        mode: "cli",
        dryRun: args.dryRun,
        kindOptions: { "tickets.ticket": { lenientAttachments } },
        onRecord: (e) => {
          if (args.dryRun && e.status !== "failed") return
          onRecord(e)
        },
      })
    } catch (err) {
      process.stderr.write(`tickets import: ${err instanceof Error ? err.message : String(err)}\n`)
      return { exitCode: 2, report }
    } finally {
      await shutdownTransformPool()
    }
    report.failed.sort((a, b) => a.line - b.line)
    return { exitCode: report.failed.length > 0 ? 1 : 0, report }
  }

  // Parsed NDJSON records, in source order.
  async function* parsedRecords(): AsyncGenerator<{ line: number; parsed: unknown }> {
    const rl = createInterface({
      input: createReadStream(args.file, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    })
    let lineNo = 0
    for await (const raw of rl) {
      lineNo++
      const line = raw.trim()
      if (line.length === 0) continue // skip blank lines (NDJSON tolerant)
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (err) {
        report.failed.push({
          line: lineNo,
          error: `malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
        })
        continue
      }
      yield { line: lineNo, parsed }
    }
  }

  async function* validRecords(): AsyncGenerator<SourceItem> {
    for await (const { line, parsed } of parsedRecords()) {
      const record = await validateRecord(parsed, line, ctx)
      if (record) yield { line, record }
    }
  }

  if (args.dryRun) {
    for await (const _ of validRecords()) {
      // validateRecord writes nothing and reports into `report` in dry-run.
    }
  } else {
    await runImport({
      orgId,
      actor: operator,
      kinds: ["tickets.ticket"],
      source: { type: "records", records: validRecords() },
      sourceLabel: "",
      mode: "cli",
      prevalidated: true,
      kindOptions: { "tickets.ticket": { lenientAttachments } },
      onRecord,
    })
  }
  // Records are written in batches after later lines were validated: list
  // failures in line order, as a line-by-line run reports them.
  report.failed.sort((a, b) => a.line - b.line)

  // Exit 1 if any record-level failure occurred; 0 otherwise (a dry-run with only
  // validation failures also surfaces a non-zero exit so a bad file is caught).
  const exitCode = report.failed.length > 0 ? 1 : 0
  return { exitCode, report }
}
