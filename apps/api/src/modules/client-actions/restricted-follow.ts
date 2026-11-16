// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Copies the kernel holds of a restricted record follow its list. When an app tells the kernel
// that who can see one of its records changed (`<app>/<entity>:access_changed`, from the app's
// one writer of that list), in one privileged transaction of that event's org:
//   - the record's client actions (the record itself, or the versions the event names) get the
//     list as `visible_to` while the record is closed, and nothing once it is open, so the
//     kernel lists them, and their links, for those people alone;
//   - the record's discussion drops everyone but the person who changed the list: each one who
//     can still read the record is enrolled again when they next open it;
//   - once closed, its pending approvals become the asker's alone (owner-routed) when the asker
//     is on the list, and are withdrawn when not, with one Home line to the list.
// Only record kinds with a list function are followed (`restrictedScopeOfEvent`).

import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { AppEvent } from "~/infra/events/event-bus"
import { onEvent } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { loadApprovalSummary } from "~/modules/approvals/event-data"
import { continueRoutinesAfterWithdrawal } from "~/modules/approvals/withdraw-on-events"
import { restrictedScopeOfEvent } from "~/modules/permissions/restricted-scope"
import { pruneEntityDiscussion } from "~/modules/threads/entity-discussion"

const log = rootLogger.child({ module: "restricted-follow" })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && UUID.test(x)) : []
}

/** Apply one access change of a restricted kind's record to the kernel's copies. */
export async function followRestrictedAccess(event: AppEvent): Promise<boolean> {
  if (event.action !== "access_changed" || !restrictedScopeOfEvent(event)) return false
  const recordId =
    typeof event.entityId === "string" && UUID.test(event.entityId) ? event.entityId : null
  if (!recordId) return false
  const data =
    event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {}
  const closed = data.org_access === "none"
  const list = uuids(data.visible_to)
  const targets = [recordId, ...uuids(data.version_ids)]
  const ks = sql.raw(quoteIdent(schemaRef("kernel")))
  const visibleTo =
    closed && list.length > 0 ? sql`${`{${list.join(",")}}`}::uuid[]` : sql`NULL::uuid[]`
  let withdrawn: string[] = []
  await withPrivilegedDb(event.orgId, "restricted-access-follow", async (tx) => {
    await tx.execute(sql`
      UPDATE ${ks}.client_actions SET visible_to = ${visibleTo}
       WHERE org_id = ${event.orgId}::uuid AND target_app = ${event.app}
         AND target_id = ANY(${`{${targets.join(",")}}`}::uuid[])`)
    // Pending approvals about the record: still the asker's to decide when they stay on the list,
    // now owner-routed so nobody else sees them; withdrawn when the asker is off it.
    if (closed) {
      const about = sql`org_id = ${event.orgId}::uuid AND status = 'pending'
        AND tool_name LIKE ${`${event.app}:%`}
        AND (current_payload->>'id' = ANY(${`{${targets.join(",")}}`}::text[])
          OR current_payload->>'version_id' = ANY(${`{${targets.join(",")}}`}::text[]))`
      const onList = `{${list.join(",")}}`
      await tx.execute(sql`
        UPDATE ${ks}.approval_requests SET resource_owner_id = requested_by
         WHERE ${about} AND requested_by = ANY(${onList}::uuid[])`)
      withdrawn = extractRows<{ id: string }>(
        await tx.execute(sql`
          UPDATE ${ks}.approval_requests
             SET status = 'cancelled', decided_at = now(),
                 reason = 'Cancelled: the record became visible to named people only, and the person who asked is not one of them'
           WHERE ${about} AND NOT (requested_by = ANY(${onList}::uuid[]))
          RETURNING id::text AS id`),
      ).map((r) => r.id)
      for (const id of withdrawn) {
        await tx.queueEvent({
          app: "kernel",
          entity: "approval_request",
          action: "update",
          entityId: id,
          orgId: event.orgId,
          actorId: typeof event.actorId === "string" ? event.actorId : null,
          actorType: "system",
          data: await loadApprovalSummary(tx as never, event.orgId, id),
        })
      }
      // The list hears that requests about the record went away, on Home: one line, naming
      // nothing of the record, whoever asked.
      if (withdrawn.length > 0 && list.length > 0) {
        await tx.queueEvent({
          app: "kernel",
          entity: "restricted_record",
          action: "requests_withdrawn",
          entityId: recordId,
          orgId: event.orgId,
          actorId: typeof event.actorId === "string" ? event.actorId : null,
          actorType: "system",
          data: { targetUserIds: list, count: withdrawn.length },
        })
      }
    }
    await pruneEntityDiscussion(
      {
        orgId: event.orgId,
        ref: { app: event.app, entityType: event.entity, entityId: recordId },
        keepUserId: typeof event.actorId === "string" ? event.actorId : null,
      },
      tx as never,
    )
  })
  // The routines waiting on a withdrawn card carry on, after the commit.
  if (withdrawn.length > 0) await continueRoutinesAfterWithdrawal(event.orgId, withdrawn)
  return true
}

let wired = false

/** Follow every restricted record's access change. Idempotent. */
export function wireRestrictedAccessFollow(): void {
  if (wired) return
  wired = true
  onEvent(
    async (event) => {
      try {
        await followRestrictedAccess(event)
      } catch (err) {
        log.error(
          { err, orgId: event.orgId, app: event.app, entity: event.entity },
          "A restricted record's access change was not applied to its client actions and discussion",
        )
      }
    },
    { delivery: "once", name: "restricted-access-follow" },
  )
}
