// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { DurableEventContext } from "~/infra/events/durable-consumers"
import { registerDurableEventConsumer } from "~/infra/events/durable-consumers"
import { registerJobWorker } from "~/infra/jobs/jobs"
import { searchLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { buildSearchDocument } from "~/modules/search/doc-builder"
import { documentId } from "~/modules/search/document-id"
import { writeIndexAndWait } from "~/modules/search/index-writer"
import {
  type LiveIndexItem,
  type LiveIndexResolution,
  recordLiveIndex,
  registerLiveIndexResolver,
  registerLiveIndexWorkers,
} from "~/modules/search/live-index-queue"
import {
  collectSearchableRegistrations,
  rowPassesIndexFilter,
  type SearchableEntityRegistration,
} from "~/modules/search/searchable-entities"

export interface IndexerJobPayload {
  action: "upsert" | "delete"
  orgId: string
  app: string
  entityType: string
  entityId: string
}

const QUEUE_APP = "kernel"
const UPSERT_JOB = "search-index-upsert"
const DELETE_JOB = "search-index-delete"

export { MEILI_TASK_WAIT_MS, waitForMeiliTask } from "~/modules/search/meili-task"

/* -------------------------------------------------------------------------- */
/* Live index jobs go through the coalescing queue                            */
/* -------------------------------------------------------------------------- */
//
// Entity changes are no longer one `app-kernel` job and one Meili task each:
// they are recorded in the coalescing queue (live-index-queue.ts), whose single
// flusher sends one Meili task per batch and whose sweep catches failed tasks.
// The per-entity job names below stay registered only so jobs already queued
// when this shipped are drained cheaply: each one just records its request.

/** Retired: tasks are checked by the live index sweep. Leftover jobs no-op. */
const VERIFY_JOB = "search-task-verify"

/** The coalescing-queue request for one entity change. */
export function entityLiveIndexItem(payload: IndexerJobPayload): LiveIndexItem {
  return {
    t: "entity",
    key: documentId(payload.orgId, payload.app, payload.entityType, payload.entityId),
    payload: {
      action: payload.action,
      orgId: payload.orgId,
      app: payload.app,
      entityType: payload.entityType,
      entityId: payload.entityId,
    },
  }
}

function lookupRegistration(
  orgId: string,
  app: string,
  entityType: string,
): SearchableEntityRegistration | null {
  const regs = collectSearchableRegistrations(orgId)
  return regs.entities.find((e) => e.app === app && e.entityType === entityType) ?? null
}

type IndexerPlan = IndexerJobPayload | IndexerJobPayload[] | null

/**
 * Looks up every ticket id with the given `contact_id` in the org, via the
 * existing `(org_id, contact_id)` index. Used by the `kernel:contact`
 * update/delete/merge derived-reindex rule — bounded by tickets-per-contact
 * (small in prod), never inlined into the event handler itself.
 */
async function ticketIdsForContact(orgId: string, contactId: string): Promise<string[]> {
  const qualified = sql.raw(`${quoteIdent(schemaRef("app_tickets"))}.${quoteIdent("tickets")}`)
  return await withPrivilegedDb(orgId, "indexer:tickets:contact-fanout", async (tx) => {
    const result = await tx.execute(
      sql`SELECT id FROM ${qualified} WHERE org_id = ${orgId} AND contact_id = ${contactId}`,
    )
    const rows =
      (result as { rows?: Record<string, unknown>[] }).rows ?? (result as Record<string, unknown>[])
    return (rows ?? []).map((r) => r.id as string)
  })
}

/**
 * Determines how an event mutates a searchable document. Returns either:
 *   - `{ action, app, entityType, entityId }` — enqueue that work,
 *   - an array of jobs (one event may touch multiple documents), or
 *   - `null` — nothing to do for this event.
 *
 * Async: the `kernel:contact` fan-out rule below queries Postgres to resolve
 * dependent ticket ids, so this can no longer be a pure function of the event.
 */
async function planFromEvent(event: {
  app: string
  entity: string
  action: string
  entityId?: string
  orgId: string
  data?: unknown
}): Promise<IndexerPlan> {
  const data = (event.data ?? {}) as Record<string, unknown>

  // Derived-reindex rule (unified-search §3.3): a ticket message create must
  // re-upsert the PARENT ticket's document (message itself is not a
  // searchable entity, so lookupRegistration('tickets','message') below would
  // return null and silently drop the event without this explicit branch —
  // that gap is exactly what left ticket bodies unsearchable). Both the
  // inbound-append path (inbound.ts) and the agent-reply path (tools.ts) emit
  // this event with `data.ticketId`; accept both 'create' and 'created' as the
  // action verb since this is a NEW event type with no established convention
  // yet in this codebase.
  if (
    event.app === "tickets" &&
    event.entity === "message" &&
    (event.action === "create" || event.action === "created")
  ) {
    const ticketId = (data.ticketId as string | undefined) ?? undefined
    if (!ticketId) return null
    return {
      action: "upsert",
      orgId: event.orgId,
      app: "tickets",
      entityType: "ticket",
      entityId: ticketId,
    }
  }

  // Derived-reindex rule: a contact rename/delete/merge invalidates the
  // enrichment text (contact name + email) baked into every one of that
  // contact's tickets' Meili documents. Re-upsert each — a bounded lookup by
  // the existing (org_id, contact_id) index, one job per ticket through the
  // existing BullMQ dedup path (never inlined). `merge`/`delete` fan out the
  // same way: re-enrichment then either finds the surviving contact or finds
  // none (enrichment skips a dangling contact silently).
  if (
    event.app === "kernel" &&
    event.entity === "contact" &&
    (event.action === "update" || event.action === "delete" || event.action === "merge")
  ) {
    const contactId = (data.contactId as string | undefined) ?? event.entityId
    if (!contactId) return null
    const ticketIds = await ticketIdsForContact(event.orgId, contactId)
    if (ticketIds.length === 0) return null
    return ticketIds.map((ticketId) => ({
      action: "upsert" as const,
      orgId: event.orgId,
      app: "tickets",
      entityType: "ticket",
      entityId: ticketId,
    }))
  }

  // Kernel thread participant mutations rewrite the thread's participant_ids
  // permission field and require a re-upsert of the *thread* document. Kernel
  // emits these as `{entity:'participant', action:'add'|'remove'}` (see
  // modules/threads/participant.ts), with the thread id in `entityId`/`threadId`
  // — NOT as a `thread`/`participant:*` shape. Without this branch a removed
  // user keeps matching the thread in search until some unrelated mutation
  // re-indexes it (a within-org access-control leak).
  if (
    event.app === "kernel" &&
    event.entity === "participant" &&
    (event.action === "add" || event.action === "remove")
  ) {
    const threadId = (data.threadId as string | undefined) ?? event.entityId
    if (!threadId) return null
    return {
      action: "upsert",
      orgId: event.orgId,
      app: "kernel",
      entityType: "thread",
      entityId: threadId,
    }
  }

  if (event.app === "kernel" && event.entity === "thread") {
    if (event.action === "create" || event.action === "update") {
      const threadId = (data.threadId as string | undefined) ?? event.entityId
      if (!threadId) return null
      return {
        action: "upsert",
        orgId: event.orgId,
        app: "kernel",
        entityType: "thread",
        entityId: threadId,
      }
    }
    if (event.action === "delete" || event.action === "archive") {
      const threadId = (data.threadId as string | undefined) ?? event.entityId
      if (!threadId) return null
      return {
        action: "delete",
        orgId: event.orgId,
        app: "kernel",
        entityType: "thread",
        entityId: threadId,
      }
    }
    return null
  }

  // Permission-grant mutations affect the visibility of every document the
  // affected user/role can reach. Without per-user permission caches today, we
  // signal "no document re-index needed" — the query path resolves scopes from
  // the request RLS context on every call, so the next search reflects the
  // grant immediately. A document re-index is only required when a *document
  // field* used by the filter (read_scope or a dimension) changes; the events
  // below do not change document fields, only the requester's grants.
  if (
    event.app === "kernel" &&
    (event.entity === "role_scope" ||
      event.entity === "user_scope" ||
      event.entity === "role_dimension" ||
      event.entity === "user_dimension")
  ) {
    return null
  }

  // Manifest-declared entities: route based on action verb. We also honor the
  // generic `participant:add` / `participant:remove` shape for app entities
  // that copy a participant_ids permission field — re-upsert refreshes it.
  const reg = lookupRegistration(event.orgId, event.app, event.entity)
  if (!reg) return null
  if (!event.entityId) return null

  if (
    event.action === "create" ||
    event.action === "update" ||
    event.action === "restore" ||
    event.action === "registered" ||
    event.action === "participant:add" ||
    event.action === "participant:remove" ||
    // Sharing changes (org_access / document_shares / document_role_shares)
    // mutate the ACL fields (acl_user_ids/acl_role_ids/org_wide) the generic
    // ACL search primitive reads — must reindex or search silently lags a
    // share/unshare the same way a stale participant_ids would.
    event.action === "share" ||
    // User lifecycle: deactivate/reactivate flip `status`, which the user
    // registration's indexFilter reads — the upsert re-reads the row and the
    // filter converts an ineligible row into a document delete.
    event.action === "deactivate" ||
    event.action === "reactivate" ||
    // Past-tense synonyms (PRJ-2): the documented event convention
    // (docs/backend-overview.md) is an imperative verb ("create", "update",
    // "delete"), but the `projects` app emits past-tense verbs throughout
    // (`task:created`, `task:updated`, `project:restored` — see its manifest's
    // `events.emits`). Every other manifest app follows the imperative
    // convention, so `task`/`project` create+update events silently matched
    // NOTHING here and were never queued for indexing, regardless of
    // `indexFields` — the deeper half of the "tasks are absent from global
    // search" bug. Accepted as aliases rather than renaming the projects app's
    // already-shipped event vocabulary (attention translations, webhooks and
    // UI event handlers key off those exact strings).
    event.action === "created" ||
    event.action === "updated" ||
    event.action === "restored"
  ) {
    return {
      action: "upsert",
      orgId: event.orgId,
      app: event.app,
      entityType: event.entity,
      entityId: event.entityId,
    }
  }
  if (
    event.action === "delete" ||
    event.action === "archive" ||
    // See the past-tense note above.
    event.action === "deleted" ||
    event.action === "archived"
  ) {
    return {
      action: "delete",
      orgId: event.orgId,
      app: event.app,
      entityType: event.entity,
      entityId: event.entityId,
    }
  }
  return null
}

async function indexerDurableHandler(ctx: DurableEventContext): Promise<void> {
  const { event } = ctx
  if (event.ephemeral) return

  const plan = await planFromEvent(event)
  if (!plan) return
  const jobs = Array.isArray(plan) ? plan : [plan]
  // Throws on a Redis failure, as the job enqueue it replaces did: the outbox
  // then replays the event rather than lose the index change.
  await recordLiveIndex(jobs.map(entityLiveIndexItem))
}

async function readRowForUpsert(
  payload: IndexerJobPayload,
): Promise<Record<string, unknown> | null> {
  const reg = lookupRegistration(payload.orgId, payload.app, payload.entityType)
  if (!reg?.tableName) return null
  const schemaName =
    (reg as { schemaName?: string }).schemaName ??
    (payload.app === "kernel" ? "kernel" : `app_${payload.app}`)
  // Build the qualified table name as a quoted identifier fragment so the
  // schema/table names cannot break out of identifier context, and bind the
  // app-controlled entityId as a parameter. This runs under withPrivilegedDb
  // (BYPASSRLS), so an unescaped `entityId` interpolated into the SELECT would
  // be a second-order cross-tenant SQL injection (the value flows verbatim
  // from the sandbox emit bridge).
  const qualified = sql.raw(`${quoteIdent(schemaRef(schemaName))}.${quoteIdent(reg.tableName)}`)
  // Include org_id in the WHERE clause even though BYPASSRLS is active: the
  // entityId originates from the sandbox emit bridge (app-controlled) and could
  // be crafted to point at another tenant's row if only filtered by id.
  return await withPrivilegedDb(payload.orgId, `indexer:${payload.app}`, async (tx) => {
    const result = await tx.execute(
      sql`SELECT * FROM ${qualified} WHERE id = ${payload.entityId} AND org_id = ${payload.orgId} LIMIT 1`,
    )
    const rows =
      (result as { rows?: Record<string, unknown>[] }).rows ?? (result as Record<string, unknown>[])
    if (!rows || rows.length === 0) return null
    return rows[0] as Record<string, unknown>
  })
}

/**
 * What one entity request writes: a built document, a document id to delete,
 * or nothing (an entity no registration knows). Shared by the direct path and
 * the coalescing flusher, so both write the same document.
 */
export async function planEntityDocument(
  payload: IndexerJobPayload,
): Promise<{ doc: Record<string, unknown> } | { deleteId: string } | null> {
  const docId = documentId(payload.orgId, payload.app, payload.entityType, payload.entityId)
  if (payload.action === "delete") return { deleteId: docId }

  const reg = lookupRegistration(payload.orgId, payload.app, payload.entityType)
  if (!reg) {
    log.debug(
      { app: payload.app, entityType: payload.entityType },
      "Unknown entity for indexer upsert — dropping",
    )
    return null
  }
  const row = await readRowForUpsert(payload)
  if (!row || !rowPassesIndexFilter(reg, row)) {
    log.debug(
      { app: payload.app, entityType: payload.entityType, entityId: payload.entityId },
      "Row not found or not index-eligible for indexer upsert — treating as delete",
    )
    return { deleteId: docId }
  }
  const doc = await buildSearchDocument(reg, payload.orgId, row)
  return { doc }
}

/**
 * Index one entity NOW and wait for Meili (direct callers: CLIs, tests,
 * webhooks that need the document before they answer). Live changes go
 * through `recordLiveIndex` instead.
 */
export async function processIndexerJob(payload: IndexerJobPayload): Promise<void> {
  const plan = await planEntityDocument(payload)
  if (!plan) return
  const replay = [entityLiveIndexItem(payload)]
  if ("deleteId" in plan) {
    try {
      await writeIndexAndWait({ deleteIds: [plan.deleteId] }, { replay })
    } catch (err) {
      log.warn(
        { err, app: payload.app, entityType: payload.entityType, entityId: payload.entityId },
        "Meili deleteDocument failed (treating as no-op)",
      )
    }
    return
  }
  await writeIndexAndWait({ docs: [plan.doc] }, { replay })
}

registerLiveIndexResolver("entity", async (items) => {
  const out: LiveIndexResolution = { docs: [], deleteIds: [], failed: [] }
  for (const item of items) {
    try {
      const plan = await planEntityDocument(item.payload as unknown as IndexerJobPayload)
      if (!plan) continue
      if ("deleteId" in plan) out.deleteIds.push(plan.deleteId)
      else out.docs.push(plan.doc)
    } catch (err) {
      log.warn({ err, key: item.key }, "Could not build an entity search document")
      out.failed.push(item)
    }
  }
  return out
})

/**
 * Queue a search delete for a single searchable entity. Used by out-of-band
 * paths (e.g. GDPR erasure) that must remove documents from the search index
 * without going through the event pipeline.
 */
export async function enqueueIndexerDelete(
  orgId: string,
  app: string,
  entityType: string,
  entityId: string,
  _eventId: string,
): Promise<void> {
  await recordLiveIndex([
    entityLiveIndexItem({ action: "delete", orgId, app, entityType, entityId }),
  ])
}

/**
 * Queue a search upsert for a single searchable entity, for out-of-band
 * changes no entity event reports (a ticket's display handle changes when the
 * org's id-segment setting does).
 */
export async function enqueueIndexerUpsert(
  orgId: string,
  app: string,
  entityType: string,
  entityId: string,
  _eventId: string,
): Promise<void> {
  await recordLiveIndex([
    entityLiveIndexItem({ action: "upsert", orgId, app, entityType, entityId }),
  ])
}

/**
 * Register the BullMQ job handlers that PROCESS index jobs. Must run in EVERY
 * process that consumes the kernel's bulk-class queue (`kernel-bulk`, plus the
 * legacy `app-kernel` drain) — including a dedicated job-worker process,
 * which competes for these jobs; without it the worker grabs a
 * `search-index-upsert` job, finds no handler, fails, and exhausts retries.
 */
export function registerIndexerJobWorkers(): void {
  // Legacy per-entity jobs (queued before the coalescing queue shipped): each
  // one only records its request, so a backlog drains in seconds.
  registerJobWorker(QUEUE_APP, UPSERT_JOB, async (payload: IndexerJobPayload) =>
    recordLiveIndex([entityLiveIndexItem({ ...payload, action: "upsert" })]),
  )
  registerJobWorker(QUEUE_APP, DELETE_JOB, async (payload: IndexerJobPayload) =>
    recordLiveIndex([entityLiveIndexItem({ ...payload, action: "delete" })]),
  )
  // Retired per-task pollers: complete at once, never re-arm.
  registerJobWorker(QUEUE_APP, VERIFY_JOB, async () => {})
  registerLiveIndexWorkers()
}

/**
 * Full indexer wiring: the durable EVENT consumer (enqueues index jobs from kernel
 * events) PLUS the job handlers. Run in the event-consuming process (the API).
 */
export function registerIndexerConsumer(): void {
  registerDurableEventConsumer("search-indexer", indexerDurableHandler)
  registerIndexerJobWorkers()
}
