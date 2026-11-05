// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `projects import`. A generic NDJSON bulk task importer — canonical shape only
 * (no provider parsers; the caller transforms to canonical first). Mirror of
 * `tickets import` (cli/tickets/import.ts): streaming, per-record privileged
 * transaction, external_ref idempotency, --dry-run.
 *
 * Valid records are written by the import framework (`runImport`, kind
 * `projects.task`, apps/projects/import-kind.ts): one privileged transaction
 * per batch, each record in its own savepoint, every created row recorded in
 * the run's undo ledger. Per record:
 *   1. MANDATORY pre-SELECT on `(org_id, external_ref)` — `createTask` does NOT
 *      dedup on `external_ref`; the partial unique index
 *      `uniq_app_projects_tasks_external_ref` (migration 0009) makes a
 *      duplicate THROW. Present → `skipped`.
 *   2. Project ensured BY NAME (exact match; absent → `createProject`, which
 *      seeds the 5 default statuses). Ensure-by-name is idempotent across
 *      records and runs.
 *   3. Status ensured BY LABEL (case-insensitive match against the project's
 *      statuses; absent → `addStatus`, the service-level API — there is no
 *      agent tool for status creation). `statusTerminal` applies ONLY when the
 *      status is created; an existing label's terminal flag is never mutated.
 *      No `status` → the project's default (first-order) status.
 *   4. `parentExternalRef` resolves against ALREADY-IMPORTED tasks (an earlier
 *      line of this file or a previous run) — order parents before children in
 *      the NDJSON (the natural output of a tree walk). An unresolvable parent
 *      FAILS the record loudly; it never imports detached silently.
 *   5. `assigneeEmail` resolves against active `kernel.users` in-org; an
 *      unknown/inactive email imports the task UNASSIGNED and adds a loud
 *      per-record line to `assigneesUnresolved[]` (mirror of tickets) —
 *      EXCEPT with `--placeholder-unknown-users` (step 7), where an inactive
 *      user is matched and assigned and an unknown email becomes a
 *      deactivated placeholder assignee.
 *   6. `createTask` with `createdAt` backdating (anchors `created_at`; see
 *      CreateTaskInput in apps/projects/service/tasks.ts for what is
 *      deliberately NOT backdated).
 *
 *   7. People: `reporterEmail`, `assigneeEmail` and every comment's
 *      `authorEmail` resolve through ONE case-insensitive resolver. The
 *      reporter becomes the task's `created_by`; `completedAt` becomes
 *      `completed_at` on a terminal status. `--placeholder-unknown-users`
 *      turns an unknown email into a DEACTIVATED org user (exact attribution,
 *      no login); without it an unknown reporter/assignee is reported loudly.
 *      A real account always wins: an `@import.invalid` placeholder (the
 *      Slack importer's) never matches, names are never matched, and among
 *      case variants of one address the active or ever-logged-in account wins
 *      over a placeholder; a placeholder is created only when no user holds
 *      the email, and then reused for that person across records and runs.
 *      A placeholder OCCUPIES the (org, email) slot (users_org_email_idx): to
 *      onboard that person later an admin must REACTIVATE the placeholder
 *      (and grant it a role) — re-inviting the email fails with "Email already
 *      registered".
 *   8. Participants + read state: the record's ACTIVE people (reporter,
 *      assignee, resolved comment authors) are enrolled on the task thread
 *      and marked read up to the newest imported message, for EVERY record.
 *      The import actor keeps the seat `createTask` gives it only when it is
 *      the task's creator (no reporter resolved) or one of those people:
 *      participants receive reply attention rows and daily digest mail, and
 *      the actor (the org's oldest user) took no part in that history. A
 *      deactivated person (placeholder or leaver) is NEVER a participant, for
 *      the same reason, yet stays the exact author (created_by / author_id).
 *
 * Comments: a comment whose author resolves to an org user becomes a REAL
 * message of the task's kernel thread, under that author, at its original
 * `createdAt`. The kernel message surface (`sendMessage` / `postAppMessage`)
 * has no author or `created_at` override and fans every post out live
 * (attention, digest, push, websocket, audit, routines), which is wrong for
 * history. So, exactly like the Slack importer (cli/slack/import.ts), rows are
 * INSERTed directly into `kernel.messages` inside the record's privileged
 * transaction with `required_scopes '{}'` and NO event; the record's active
 * people are enrolled and marked read (step 8), so historical threads do not
 * light up as unread. An undated comment is dated to the record's createdAt
 * (else one now() per record) plus its input index in ms, so undated
 * comments keep input order.
 * The inserted messages are indexed for search AFTER the whole run, in bulk
 * (`indexMessagesBulk`: one Meili task per batch; the indexer re-reads the
 * committed rows on its own connection). Indexing each message inline waited
 * for one Meili task apiece, tens of seconds each on a large index, so a few
 * hundred comments took hours. Best-effort: a failure is reported in
 * `indexFailures[]`, never fails the record.
 *
 * Comments whose author does NOT resolve (bots such as "Gitlab", no email, an
 * unknown email without the flag) are FOLDED into the task description as an
 * "## Imported comments" block (attributed + dated, input order): a thread
 * message needs an org-user author, and misattributing them to the import
 * actor would falsify the history.
 *
 * `--dry-run` validates every line and writes NOTHING (no placeholder user
 * either) — including checking `createdAt`, `completedAt` and every
 * `comments[].createdAt` for parseability and resolving `parentExternalRef`
 * (against earlier lines of the same file, then read-only against the DB), so
 * a full corpus can be vetted before the real run.
 */
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import {
  findTaskIdByExternalRef,
  invalidCommentDate,
  type TaskRecordReport,
} from "~/apps/projects/import-kind"
import { kernelRel } from "~/apps/projects/schema-refs"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import { runImport } from "~/modules/imports/runner"
import type { SourceItem } from "~/modules/imports/source"
import { indexMessagesBulk } from "~/modules/search/message-indexer"

const log = rootLogger.child({ module: "cli-projects-import" })

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

/** A historical comment: a thread message when its author resolves, else
 *  folded into the task description (see header). */
const importCommentSchema = z.object({
  authorName: z.string().optional().nullable(),
  authorEmail: z.string().optional().nullable(),
  body: z.string().min(1),
  // ISO-8601. The message's created_at (absent → the record's createdAt);
  // rendered verbatim in the folded block. Unparsable → the record fails.
  createdAt: z.string().optional().nullable(),
})

/** Canonical NDJSON task record shape. */
const importRecordSchema = z.object({
  // Source system's stable id — the idempotency key (e.g. a Jira issue key).
  externalRef: z.string().min(1),
  // Target project, ensured by exact name (created with default statuses if absent).
  project: z.object({ name: z.string().min(1) }),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  // Status LABEL. Matched case-insensitively against the project's statuses;
  // unknown labels are created via addStatus (service-level API).
  status: z.string().optional().nullable(),
  // Only used when `status` triggers a CREATE — marks the new status terminal
  // (completed-like). Existing statuses are never mutated by the importer.
  statusTerminal: z.boolean().optional(),
  // Resolved against active kernel.users by email; unknown → imported
  // unassigned + a loud assigneesUnresolved[] report line (never fails).
  assigneeEmail: z.string().optional().nullable(),
  // Only labels a placeholder user (--placeholder-unknown-users).
  assigneeName: z.string().optional().nullable(),
  // The source's reporter. Resolved like the assignee; becomes the task's
  // created_by. Unknown → the import actor + a loud reportersUnresolved[] line.
  reporterEmail: z.string().optional().nullable(),
  reporterName: z.string().optional().nullable(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  // DATE (YYYY-MM-DD) — the tasks columns are DATE-typed.
  dueDate: z.string().optional().nullable(),
  startDate: z.string().optional().nullable(),
  blocked: z.boolean().optional(),
  // ISO-8601. Backdates the task's created_at (see CreateTaskInput).
  createdAt: z.string().optional().nullable(),
  // ISO-8601 resolution time. Stored as completed_at only when the status is
  // terminal (see CreateTaskInput.completedAt); unparsable → the record fails.
  completedAt: z.string().optional().nullable(),
  // Subtask link: the externalRef of an ALREADY-IMPORTED task (earlier line or
  // previous run). Unresolvable → the record fails loudly.
  parentExternalRef: z.string().optional().nullable(),
  comments: z.array(importCommentSchema).optional(),
})

type ImportRecord = z.infer<typeof importRecordSchema>

export interface ProjectsImportReport {
  createdProjects: number
  createdStatuses: number
  createdTasks: number
  skipped: number
  failed: Array<{ line: number; error: string }>
  /** Tasks imported UNASSIGNED because their assigneeEmail did not resolve to
   *  an active org user — named loudly per record, never a failure. */
  assigneesUnresolved: Array<{ line: number; externalRef: string; email: string }>
  /** Tasks whose reporterEmail did not resolve: imported with the import actor
   *  as creator — named loudly per record, never a failure. */
  reportersUnresolved: Array<{ line: number; externalRef: string; email: string }>
  /** Deactivated users created by --placeholder-unknown-users (once per email). */
  placeholdersCreated: Array<{ email: string }>
  /** Comments imported as real thread messages (committed records only). */
  commentsImported: number
  /** Comments folded into a task description (author did not resolve). */
  commentsFolded: number
  /** Messages that committed but could not be indexed for search (best-effort). */
  indexFailures: Array<{ externalRef: string; messageId: string; error: string }>
}

export interface RunProjectsImportArgs {
  file: string
  orgSlug?: string
  dryRun: boolean
  /** Unknown reporter / assignee emails become deactivated org users (exact
   *  attribution, no login) instead of being dropped. Off by default: it
   *  creates identities, so it must be asked for. */
  placeholderUnknownUsers?: boolean
  /** Search indexing of the run's imported messages, called ONCE after the
   *  run with every committed message id; returns the ones that could not be
   *  indexed. Defaults to the bulk indexer. A seam for tests (a failing index
   *  must not fail the import). */
  indexMessages?: (
    orgId: string,
    messageIds: string[],
  ) => Promise<Array<{ messageId: string; error: string }>>
}

export interface RunProjectsImportResult {
  exitCode: number
  report: ProjectsImportReport
}

/** Resolve a real admin/owner user id for the org so project ownership and the
 *  create events carry a meaningful actor; falls back to the NIL system user. */
async function resolveActorUserId(orgId: string): Promise<string> {
  return withPrivilegedDb(orgId, "cli-projects-import-resolve-actor", async (tx) => {
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

/** Read-only parent check for --dry-run (no writes anywhere on this path). */
async function parentExistsInDb(orgId: string, externalRef: string): Promise<boolean> {
  return withPrivilegedDb(orgId, "cli-projects-import-dryrun-parent", async (tx) => {
    return (await findTaskIdByExternalRef(tx, orgId, "", externalRef)) !== null
  })
}

/**
 * Run the NDJSON projects import. Streams the file line-by-line (never loads it
 * all into memory). A malformed/invalid line is reported in `failed[]` with its
 * line number and the stream continues. `--dry-run` validates only.
 */
export async function runProjectsImport(
  args: RunProjectsImportArgs,
): Promise<RunProjectsImportResult> {
  const report: ProjectsImportReport = {
    createdProjects: 0,
    createdStatuses: 0,
    createdTasks: 0,
    skipped: 0,
    failed: [],
    assigneesUnresolved: [],
    reportersUnresolved: [],
    placeholdersCreated: [],
    commentsImported: 0,
    commentsFolded: 0,
    indexFailures: [],
  }
  const placeholders = args.placeholderUnknownUsers === true
  const indexMessages =
    args.indexMessages ??
    (async (org: string, ids: string[]) => (await indexMessagesBulk(org, ids)).failures)
  // Committed messages awaiting search indexing, in insert order.
  const toIndex: Array<{ externalRef: string; messageId: string }> = []

  const resolved = await resolveOrgId(
    args.orgSlug,
    "multiple orgs exist — pass --org <slug> to disambiguate",
  )
  if (!resolved.ok) {
    process.stderr.write(`projects import: ${resolved.message}\n`)
    return { exitCode: 2, report }
  }
  const orgId = resolved.orgId
  const actorUserId = args.dryRun ? NIL_UUID : await resolveActorUserId(orgId)
  // Dry-run: externalRefs seen earlier in THIS file (they would exist by the
  // time a later child imports for real).
  const seenRefs = new Set<string>()

  // Validated records in file order; failures go straight to the report.
  async function* validRecords(): AsyncGenerator<SourceItem> {
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

      const validated = importRecordSchema.safeParse(parsed)
      if (!validated.success) {
        const message = validated.error.issues
          .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
          .join("; ")
        report.failed.push({ line: lineNo, error: `invalid record: ${message}` })
        continue
      }

      const record: ImportRecord = validated.data

      if (args.dryRun) {
        // Validate only — write nothing. A bad createdAt or an unresolvable
        // parent must surface during corpus vetting, not midway through the run.
        if (record.createdAt && Number.isNaN(new Date(record.createdAt).getTime())) {
          report.failed.push({
            line: lineNo,
            error: `createdAt is not a valid ISO-8601 timestamp: "${record.createdAt}"`,
          })
          continue
        }
        if (record.completedAt && Number.isNaN(new Date(record.completedAt).getTime())) {
          report.failed.push({
            line: lineNo,
            error: `completedAt is not a valid ISO-8601 timestamp: "${record.completedAt}"`,
          })
          continue
        }
        const badCommentDate = invalidCommentDate(record.comments)
        if (badCommentDate) {
          report.failed.push({ line: lineNo, error: badCommentDate })
          continue
        }
        if (record.parentExternalRef && !seenRefs.has(record.parentExternalRef)) {
          const inDb = await parentExistsInDb(orgId, record.parentExternalRef)
          if (!inDb) {
            report.failed.push({
              line: lineNo,
              error:
                `parentExternalRef "${record.parentExternalRef}" does not resolve to an imported ` +
                `task or an earlier line of this file — order parents before children`,
            })
            continue
          }
        }
        seenRefs.add(record.externalRef)
        continue
      }
      yield { line: lineNo, record }
    }
  }

  if (args.dryRun) {
    for await (const _ of validRecords()) {
      // Dry-run: validRecords reports and yields nothing.
    }
  } else {
    // Valid records are written by the import framework (`runImport`, kind
    // `projects.task`, modules/imports) as the privileged operator: the
    // actor is the org's first admin (project ownership + events need a real
    // user — owner_id/created_by are NOT NULL FKs to kernel.users). No source
    // label: external refs stay exactly as given. Indexing is deferred to ONE
    // bulk call after the run (below).
    await runImport({
      orgId,
      actor: {
        actorType: "user",
        userId: actorUserId,
        orgId,
        scopes: ["*"],
        dimensionGrants: { "*": ["*"] },
      },
      kinds: ["projects.task"],
      source: { type: "records", records: validRecords() },
      sourceLabel: "",
      mode: "cli",
      placeholders,
      prevalidated: true,
      kindOptions: { "projects.task": { deferIndexing: true } },
      onRecord: (e) => {
        if (e.status === "skipped") {
          report.skipped++
          return
        }
        if (e.status === "failed") {
          log.error({ line: e.line, externalRef: e.dedupKey, error: e.error }, "task import failed")
          report.failed.push({ line: e.line, error: e.error ?? "import failed" })
          return
        }
        const outcome = e.report as TaskRecordReport | undefined
        report.createdTasks++
        if (!outcome) return
        if (outcome.projectCreated) report.createdProjects++
        if (outcome.statusCreated) report.createdStatuses++
        if (outcome.assigneeUnresolved) {
          log.warn(
            { line: e.line, externalRef: e.dedupKey, email: outcome.assigneeUnresolved },
            "assignee email did not resolve — task imported unassigned",
          )
          report.assigneesUnresolved.push({
            line: e.line,
            externalRef: e.dedupKey,
            email: outcome.assigneeUnresolved,
          })
        }
        if (outcome.reporterUnresolved) {
          log.warn(
            { line: e.line, externalRef: e.dedupKey, email: outcome.reporterUnresolved },
            "reporter email did not resolve — task imported with the import actor as creator",
          )
          report.reportersUnresolved.push({
            line: e.line,
            externalRef: e.dedupKey,
            email: outcome.reporterUnresolved,
          })
        }
        for (const email of outcome.placeholdersCreated) report.placeholdersCreated.push({ email })
        report.commentsImported += outcome.messageIds.length
        report.commentsFolded += outcome.commentsFolded
        for (const messageId of outcome.messageIds) {
          toIndex.push({ externalRef: e.dedupKey, messageId })
        }
      },
    })
  }
  // Records are written in batches after later lines were validated: list
  // failures in line order, as a line-by-line run reports them.
  report.failed.sort((a, b) => a.line - b.line)

  if (toIndex.length > 0) {
    let failures: Array<{ messageId: string; error: string }>
    try {
      failures = await indexMessages(
        orgId,
        toIndex.map((m) => m.messageId),
      )
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      failures = toIndex.map((m) => ({ messageId: m.messageId, error }))
    }
    const errorById = new Map(failures.map((f) => [f.messageId, f.error]))
    for (const { externalRef, messageId } of toIndex) {
      const error = errorById.get(messageId)
      if (error === undefined) continue
      log.warn(
        { externalRef, messageId, error },
        "imported message could not be indexed — it is stored, search will miss it until a reindex",
      )
      report.indexFailures.push({ externalRef, messageId, error })
    }
  }

  // Exit 1 if any record-level failure occurred; 0 otherwise (a dry-run with only
  // validation failures also surfaces a non-zero exit so a bad file is caught).
  const exitCode = report.failed.length > 0 ? 1 : 0
  return { exitCode, report }
}
