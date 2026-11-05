// SPDX-License-Identifier: FSL-1.1-ALv2
import type { RlsClient } from "~/db"
import { timelineEntries } from "~/db/schema/kernel"
import { timelineLogger as log } from "~/lib/logger"
import { timelineDeclarations } from "~/modules/apps/app-registries"
import { isMailContentField } from "~/modules/mailbox-crypto/content-suppression"

const KERNEL_TIMELINE_ENTITIES: Array<{ entity: string; fields: string[] }> = [
  { entity: "thread", fields: ["title", "status"] },
  { entity: "message", fields: ["body"] },
  { entity: "contact", fields: ["name", "email"] },
  { entity: "user", fields: ["name", "email", "status"] },
  // Files — `create` / `delete` carry provenance (incl. `copiedFromId` for
  // agent attachments) so every file movement is in the audit trail.
  { entity: "file", fields: ["filename"] },
]

/**
 * Registers kernel entities (thread, message, contact, user) into timelineDeclarations
 * so that kernel events are picked up by the timeline generation pipeline.
 * Key format: `{orgId}:kernel:{entity}`
 */
export function registerKernelTimelineDeclarations(orgId: string): void {
  for (const { entity, fields } of KERNEL_TIMELINE_ENTITIES) {
    timelineDeclarations.set([orgId, "kernel", entity], { app: "kernel", entity, fields })
  }
}

/**
 * Field names whose VALUE never belongs in a timeline entry, whatever app owns
 * them. These are the historical five: identity and credential material.
 */
const GLOBAL_SENSITIVE_FIELDS = new Set([
  "email",
  "phone",
  "passwordHash",
  "totpSecret",
  "recoveryCodes",
])

/**
 * Should this field's VALUE be withheld from the timeline?
 *
 * A predicate rather than a bare `Set<string>`, deliberately. The mail encryption
 * regime needs `subject` and `snippet` withheld (Invariant K: a timeline entry is
 * durable, is indexed, and the Phase 12 purge cannot reach it), but `subject` is
 * also a real, timeline-declared field on `app_tickets.tickets`, where the value
 * is the whole point of the entry. A flat set cannot tell those apart, so adding
 * the mail names to one would silently blank ticket timelines product-wide.
 *
 * The `_ciphertext` suffix rule is global on purpose: a sealed blob is not
 * readable, but "changed body_ciphertext from <base64> to <base64>" is noise in
 * any app that grows such a column.
 *
 * This is the SECOND line of defence. The first is the mail manifest, which no
 * longer declares `subject` in `conversations.timeline` at all, so the renderer
 * is normally never asked. Keep both.
 */
export function isSensitiveField(app: string, entity: string, field: string): boolean {
  if (GLOBAL_SENSITIVE_FIELDS.has(field)) return true
  return isMailContentField(app, entity, field)
}

interface TimelineEvent {
  orgId: string
  app: string
  entity: string
  action: string
  entityId: string
  userId: string | null
  actorType?: "user" | "agent" | "system" | "mcp"
  data: any
  eventId?: string
  actionLabel?: string
  details?: Record<string, unknown>
}

interface GenerateTimelineOptions {
  /**
   * When true, a failed timeline INSERT rethrows instead of being swallowed.
   * The durable event consumer (I-EVT-1) sets this so a transient failure
   * leaves the outbox row unprocessed and the event is retried — turning
   * timeline generation into an at-least-once guarantee. Default false keeps
   * the legacy best-effort behavior for any direct callers.
   */
  propagateErrors?: boolean
}

export async function generateTimelineEntries(
  db: RlsClient,
  event: TimelineEvent,
  opts: GenerateTimelineOptions = {},
): Promise<void> {
  const declaration = timelineDeclarations.get([event.orgId, event.app, event.entity])

  if (!declaration) return // No timeline declaration

  // Bind the propagation flag once so every insert below honors it.
  const insert = (entry: Parameters<typeof insertEntry>[1]) =>
    insertEntry(db, entry, opts.propagateErrors ?? false)

  // `timeline_entries.actor_id` is a uuid column, but system / cross-app actors
  // carry a non-uuid sentinel userId (e.g. "system"). Coerce any non-uuid id to
  // NULL so the insert never throws 22P02 and silently drops the entry — the
  // actor is still recorded via actor_type. Mirrors the nil-uuid coercion in
  // `withRlsContext`.
  const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  const actorId = event.userId && UUID_RE.test(event.userId) ? event.userId : null
  const actorType: "user" | "agent" | "system" | "mcp" =
    event.actorType ?? (actorId ? "user" : "system")

  // Action-label events: domain-specific transitions (e.g., "manual_reopen", "merged_into").
  if (event.actionLabel) {
    await insert({
      orgId: event.orgId,
      app: event.app,
      entityType: event.entity,
      entityId: event.entityId,
      actorId,
      actorType,
      action: event.actionLabel,
      summary: event.actionLabel,
      actionLabel: event.actionLabel,
      fieldChanges: event.details ? { details: event.details } : null,
      eventId: event.eventId,
    })
    return
  }

  // Normalize action verbs — publishers use present tense ("create", "update", "delete"),
  // but timeline entries store past tense ("created", "updated", "deleted")
  const action = event.action

  if (action === "created" || action === "create") {
    await insert({
      orgId: event.orgId,
      app: event.app,
      entityType: event.entity,
      entityId: event.entityId,
      actorId,
      actorType,
      action: "created",
      summary: `created ${event.entity}`,
      // `file:create` events carry provenance (`copiedFromId`, source
      // `(app, entityType, entityId)`) — preserve it so an agent attaching a
      // file is fully recorded. Other entities keep the existing `null`.
      fieldChanges: event.entity === "file" ? (event.data ?? null) : null,
      eventId: event.eventId,
    })
    return
  }

  if (action === "deleted" || action === "delete") {
    await insert({
      orgId: event.orgId,
      app: event.app,
      entityType: event.entity,
      entityId: event.entityId,
      actorId,
      actorType,
      action: "deleted",
      summary: `deleted ${event.entity}`,
      fieldChanges: null,
      eventId: event.eventId,
    })
    return
  }

  if (action === "updated" || action === "update") {
    const isSensitive = (field: string) => isSensitiveField(event.app, event.entity, field)

    if (event.data?.before && event.data?.after) {
      const before = event.data.before
      const after = event.data.after

      for (const field of declaration.fields) {
        if (field in before && field in after && before[field] !== after[field]) {
          const summary = isSensitive(field)
            ? `changed ${field}`
            : `changed ${field} from ${before[field]} to ${after[field]}`
          await insert({
            orgId: event.orgId,
            app: event.app,
            entityType: event.entity,
            entityId: event.entityId,
            actorId,
            actorType,
            action: "field_changed",
            summary,
            fieldChanges: isSensitive(field)
              ? { [field]: { before: "[redacted]", after: "[redacted]" } }
              : { [field]: { before: before[field], after: after[field] } },
            eventId: event.eventId,
          })
        }
      }
    } else if (event.data?.changes && typeof event.data.changes === "object") {
      // Fallback: publisher supplied a flat changes object (field → new value) without before/after
      for (const [field, newValue] of Object.entries(event.data.changes)) {
        if (declaration.fields.includes(field)) {
          // This branch previously consulted no denylist at all, so a sensitive
          // field supplied as a flat change rendered its value verbatim while
          // the before/after branch redacted the very same field. Both branches
          // now ask the same predicate.
          const sensitive = isSensitive(field)
          const summary = sensitive ? `changed ${field}` : `changed ${field} to ${newValue}`
          await insert({
            orgId: event.orgId,
            app: event.app,
            entityType: event.entity,
            entityId: event.entityId,
            actorId,
            actorType,
            action: "field_changed",
            summary,
            fieldChanges: sensitive
              ? { [field]: { after: "[redacted]" } }
              : { [field]: { after: newValue } },
            eventId: event.eventId,
          })
        }
      }
    }
    return
  }

  // Handle add/remove actions (e.g., participant add/remove)
  if (action === "add" || action === "remove") {
    await insert({
      orgId: event.orgId,
      app: event.app,
      entityType: event.entity,
      entityId: event.entityId,
      actorId,
      actorType,
      action: action === "add" ? "added" : "removed",
      summary: `${action === "add" ? "added" : "removed"} ${event.entity}`,
      fieldChanges: event.data ?? null,
      eventId: event.eventId,
    })
  }
}

async function insertEntry(
  db: RlsClient,
  entry: {
    orgId: string
    app: string
    entityType: string
    entityId: string
    actorId: string | null
    actorType: "user" | "agent" | "system" | "mcp"
    action: string
    summary: string
    fieldChanges: unknown
    eventId?: string
    actionLabel?: string
  },
  propagateErrors = false,
): Promise<void> {
  try {
    if (entry.eventId) {
      await db.insert(timelineEntries).values(entry).onConflictDoNothing()
    } else {
      await db.insert(timelineEntries).values(entry)
    }
  } catch (err) {
    log.error({ err, entry }, "Failed to insert timeline entry")
    // Durable consumer path: rethrow so the outbox retries the event rather
    // than silently dropping the timeline entry (I-EVT-1).
    if (propagateErrors) throw err
  }
}
