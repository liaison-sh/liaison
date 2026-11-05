// SPDX-License-Identifier: FSL-1.1-ALv2

import { and, desc, eq, gte, ilike, lte, sql } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { auditLog } from "~/db/schema/kernel"
import { auditLogger as log } from "~/lib/logger"
import { UUID_RE } from "~/lib/uuid"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import {
  isApprovalAuditEntity,
  redactApprovalAuditChanges,
  redactUserAuditChanges,
} from "~/modules/audit/approval-redaction"

const ACTOR_TYPES = new Set<"user" | "agent" | "system" | "mcp">(["user", "agent", "system", "mcp"])

export interface AuditEntry {
  orgId: string
  actorId?: string | null
  actorType: "user" | "agent" | "system" | "mcp"
  app?: string
  entityType?: string
  entityId?: string
  action: string
  changes?: unknown
  metadata?: unknown
  eventId?: string
  /**
   * The agent that acted, independent of `actorId` (the human) and of
   * `actorType`. Null on every non-agent row, and on an agent row whose agent
   * could not be resolved — never a human's id, and never a guess.
   */
  agentId?: string | null
  /**
   * The DISCLOSURE columns (T03). They are null on an ordinary row and set
   * only by the two writers that record one: "Share anyway" and the private
   * withheld card. They live here rather than on a direct insert of their own
   * so every audit row goes through the same stamp (run linkage, the agent
   * shape guard), which is what lets a deleted agent cost the row its name
   * instead of the whole write.
   */
  requesterUserId?: string | null
  roomMemberSnapshot?: string[] | null
  effectiveScope?: string[] | null
  disclosureList?: string[] | null
}

/**
 * The composite foreign key from 0070: `audit_log.agent_id` must name an agent
 * of the ROW'S OWN org.
 *
 * Matched by constraint NAME, never by the bare 23503 class, because
 * `audit_log_org_fk` raises 23503 on this same table: a catch written as
 * `code === "23503"` would quietly blame the agent for a bad ORG and retry a
 * row that must fail loudly. Same discipline as `isUnknownAgentFkError` in
 * `modules/apps/execute-tool.ts`, which reads the constraint name out of the
 * failed-query text for the same reason.
 */
const AGENT_FK_CONSTRAINT = "audit_log_agent_org_fk"

/**
 * True when an audit INSERT was refused because its agent id names no agent of
 * the row's org: the agent was deleted, or it belongs to another org.
 *
 * Drizzle wraps the driver error, so the constraint name may sit on either
 * layer's message.
 */
export function isUnknownAgentFkError(err: unknown): boolean {
  const message = `${String((err as { message?: unknown })?.message ?? "")}|${String(
    (err as { cause?: { message?: unknown } })?.cause?.message ?? "",
  )}`
  return message.includes(AGENT_FK_CONSTRAINT)
}

interface WriteAuditLogOptions {
  /**
   * When true, a failed INSERT rethrows instead of being swallowed, so the
   * surrounding transaction rolls back. Compliance-critical writes (e.g. the
   * GDPR `user.erased` entry, which must exist iff the erasure committed) set
   * this; the best-effort event-subscriber path leaves it false.
   */
  required?: boolean
  /**
   * True when the CALLER catches a propagated `required` failure and reports
   * the outcome itself, instead of letting the throw roll its transaction back.
   *
   * `writeAuditRowInOwnTx` (`infra/events/event-subscribers.ts`) is that
   * caller: it retries the row with a null agent in a NEW transaction, so the
   * row is normally SAVED. Reporting that at error level paged somebody for
   * every RECOVERED row, and "rolling back" was false there twice over -- the
   * retry is about to succeed, and on the outbox-bypass path nothing of the
   * caller's is rolled back at all. The failure is still propagated exactly as
   * before; only the reporting moves to whoever knows how it ended.
   */
  outcomeReportedByCaller?: boolean
}

export async function writeAuditLog(
  db: RlsClient | PrivilegedDb,
  entry: AuditEntry,
  opts: WriteAuditLogOptions = {},
): Promise<void> {
  // Normalize non-UUID actor labels (e.g. "system:mail:gmail-initial-sync")
  // into metadata. The schema's `actor_id` column is uuid-typed; passing a
  // free-form string crashes the INSERT and silently drops the audit row.
  const normalized: AuditEntry = entry
  // An EMPTY actor id means nobody acted: a system flow (an operator CLI run
  // with no admin user, a background job) that had no person to name. It is not
  // a label worth keeping, and "" is not a uuid either, so the insert would
  // refuse it (22P02) and the durable consumer would dead-letter the row.
  if (typeof entry.actorId === "string" && entry.actorId.trim() === "") {
    normalized.actorId = null
    if (normalized.actorType === "user") normalized.actorType = "system"
  }
  if (normalized.actorId && !UUID_RE.test(normalized.actorId)) {
    const existingMeta =
      typeof entry.metadata === "object" && entry.metadata !== null
        ? (entry.metadata as Record<string, unknown>)
        : {}
    normalized.metadata = { ...existingMeta, actorLabel: entry.actorId }
    normalized.actorId = null
  }
  // Identity fails closed; the WRITE does not. This is the SHAPE half only:
  // `agent_id` is uuid-typed, so a value that is not a uuid would abort the
  // INSERT (22P02) and take the whole audit row down with it — backwards, since
  // the record of the action matters more than the name of the actor. Record no
  // agent instead, loudly.
  //
  // A well-formed uuid naming no agent of this org passes this check and can
  // only be refused by the foreign key (23503). That half CANNOT be recovered
  // here: this function is handed an already-open transaction, and postgres
  // aborts a transaction on its first failed statement, so a retry on `db`
  // would return 25P02 and could never commit. Recovery therefore belongs to
  // whoever owns the transaction boundary — see `writeAuditRowInOwnTx` in
  // `infra/events/event-subscribers.ts`, which retries once with a null agent
  // in a NEW transaction using `isUnknownAgentFkError` above.
  if (normalized.agentId && !UUID_RE.test(normalized.agentId)) {
    log.warn(
      { agentId: normalized.agentId, action: normalized.action },
      "Audit entry carried an unusable agent id — recording no agent",
    )
    normalized.agentId = null
  }
  // T9 — Sub-run linkage: if an agent run frame is active, stamp `runId` and
  // `parentRunId` into `metadata` so audit queries can answer "what did sub-run
  // X do?" via `metadata ->> 'runId' = X`. Outside any run frame, no keys are
  // added — this guards against ALS state leaking into background jobs.
  const runFrame = currentRunContext()
  if (runFrame) {
    const existingMeta =
      typeof normalized.metadata === "object" && normalized.metadata !== null
        ? (normalized.metadata as Record<string, unknown>)
        : {}
    normalized.metadata = {
      ...existingMeta,
      runId: runFrame.runId,
      parentRunId: runFrame.parentRunId,
      // A routine's work names the routine (it runs as its owner).
      ...(runFrame.routineId ? { routineId: runFrame.routineId } : {}),
    }
  }
  try {
    if (normalized.eventId) {
      await db.insert(auditLog).values(normalized).onConflictDoNothing()
    } else {
      await db.insert(auditLog).values(normalized)
    }
  } catch (err) {
    if (opts.required) {
      if (opts.outcomeReportedByCaller) {
        // The caller recovers this row in a new transaction and logs whatever
        // it finally reaches, so this side must not page: the row is not lost,
        // and nothing of the caller's is being rolled back.
        log.debug(
          { err, action: normalized.action, agentId: normalized.agentId },
          "Audit log entry failed, propagating so the caller can retry it in a new transaction",
        )
        throw err
      }
      // Compliance-critical write — propagate so the caller's transaction rolls
      // back. PII deletion must not commit without its mandatory audit row.
      log.error(
        { err, entry: normalized },
        "Required audit log entry failed, rolling the caller transaction back",
      )
      throw err
    }
    // Audit is best-effort — never fail the original operation
    log.error({ err, entry: normalized }, "Failed to write audit log entry")
  }
}

interface AuditQueryParams {
  actor?: string
  /**
   * The ACTING AGENT (`audit_log.agent_id`), independent of `actor` (the human)
   * and of `actorType`: an agent turn stamps it on every row it produces
   * whatever the actorType, so this answers "what did the logistics agent do"
   * regardless of which human triggered the turn (A11). Human-only rows, whose
   * agent_id is null, are excluded whenever this is set.
   */
  agentId?: string
  /**
   * Filter by actor type label ("user" | "agent" | "system" | "mcp").
   * Can be combined with `actor` (UUID) to narrow to a specific user/agent,
   * or used alone to retrieve all entries for a given actor category.
   */
  actorType?: string
  app?: string
  entityType?: string
  entityId?: string
  action?: string
  /**
   * Substring (case-insensitive) match on action — for governance reads like
   * "which refunds were approved" where the caller knows a keyword ('refund')
   * but not the exact internal action string. Filters at the DB before the
   * row limit, so it cuts through a high-volume log (unlike a post-fetch scan).
   * `action` (exact) still wins when both are set.
   */
  actionContains?: string
  from?: string
  to?: string
  page?: number
  limit?: number
}

function buildConditions(orgId: string, params: AuditQueryParams) {
  const conditions = [eq(auditLog.orgId, orgId)]
  if (params.actor) conditions.push(eq(auditLog.actorId, params.actor))
  if (params.agentId) conditions.push(eq(auditLog.agentId, params.agentId))
  if (
    params.actorType &&
    ACTOR_TYPES.has(params.actorType as "user" | "agent" | "system" | "mcp")
  ) {
    conditions.push(eq(auditLog.actorType, params.actorType as "user" | "agent" | "system" | "mcp"))
  }
  if (params.app) conditions.push(eq(auditLog.app, params.app))
  if (params.entityType) conditions.push(eq(auditLog.entityType, params.entityType))
  if (params.entityId) conditions.push(eq(auditLog.entityId, params.entityId))
  if (params.action) conditions.push(eq(auditLog.action, params.action))
  else if (params.actionContains)
    conditions.push(ilike(auditLog.action, `%${params.actionContains}%`))
  if (params.from) conditions.push(gte(auditLog.timestamp, new Date(params.from)))
  if (params.to) conditions.push(lte(auditLog.timestamp, new Date(params.to)))
  return conditions
}

export interface AuditLogPage {
  entries: (typeof auditLog.$inferSelect)[]
  total: number
}

/**
 * Single CTE query that returns both the paginated rows and total count in one
 * round-trip, avoiding two sequential queries.
 */
export async function queryAuditLogPage(
  db: RlsClient,
  orgId: string,
  params: AuditQueryParams,
): Promise<AuditLogPage> {
  const conditions = buildConditions(orgId, params)
  const limit = Math.min(params.limit ?? 50, 100)
  const offset = ((params.page ?? 1) - 1) * limit
  const whereClause = and(...conditions)

  const rows = await db
    .select({
      id: auditLog.id,
      orgId: auditLog.orgId,
      actorId: auditLog.actorId,
      actorType: auditLog.actorType,
      // The acting agent, so a returned row NAMES the agent it belongs to
      // (A11). Filtering by agent while returning rows that name none leaves
      // the answer uncheckable and mixed pages unreadable. Null on every
      // non-agent row.
      agentId: auditLog.agentId,
      app: auditLog.app,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      action: auditLog.action,
      changes: auditLog.changes,
      metadata: auditLog.metadata,
      timestamp: auditLog.timestamp,
      total: sql<number>`COUNT(*) OVER ()::int`,
    })
    .from(auditLog)
    .where(whereClause)
    .orderBy(desc(auditLog.timestamp))
    .limit(limit)
    .offset(offset)

  const total = rows[0]?.total ?? 0
  // Rows written before approval events were reduced at ingestion still hold
  // the whole card; reduce them on the way out so the audit read is never a
  // wider door than the approval's own audience.
  const entries = rows.map(({ total: _total, ...rest }) =>
    isApprovalAuditEntity(rest.entityType)
      ? { ...rest, changes: redactApprovalAuditChanges(rest.changes) }
      : rest.app === "kernel" && rest.entityType === "user"
        ? { ...rest, changes: redactUserAuditChanges(rest.changes) }
        : rest,
  ) as (typeof auditLog.$inferSelect)[]
  return { entries, total }
}
