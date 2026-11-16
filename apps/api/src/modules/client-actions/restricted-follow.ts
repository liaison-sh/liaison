// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Copies the kernel holds of a restricted record follow its list. When an app tells the kernel
// that who can see one of its records changed (`<app>/<entity>:access_changed`, from the app's
// one writer of that list), in one privileged transaction of that event's org:
//   - the record's client actions (the record itself, or the versions the event names) get the
//     list as `visible_to` while the record is closed, and nothing once it is open, so the
//     kernel lists them, and their links, for those people alone;
//   - the record's discussion drops everyone but the person who changed the list: each one who
//     can still read the record is enrolled again when they next open it.
// Only record kinds with a list function are followed (`restrictedScopeOfEvent`).

import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { AppEvent } from "~/infra/events/event-bus"
import { onEvent } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
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
  await withPrivilegedDb(event.orgId, "restricted-access-follow", async (tx) => {
    await tx.execute(sql`
      UPDATE ${ks}.client_actions SET visible_to = ${visibleTo}
       WHERE org_id = ${event.orgId}::uuid AND target_app = ${event.app}
         AND target_id = ANY(${`{${targets.join(",")}}`}::uuid[])`)
    await pruneEntityDiscussion(
      {
        orgId: event.orgId,
        ref: { app: event.app, entityType: event.entity, entityId: recordId },
        keepUserId: typeof event.actorId === "string" ? event.actorId : null,
      },
      tx as never,
    )
  })
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
