// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Copies the kernel holds of a restricted record follow its list. When an app changes who can
// see one of its records (`<app>/<entity>:access_changed`, from the app's one writer of that
// list, or the claim), the copies move in that writer's own transaction, through one database
// function that reads the list itself (`kernel.restricted_access_follow`, 0332):
//   - the record's client actions (the record itself and its versions) get the list as
//     `visible_to` while the record is closed, and nothing once it is open;
//   - once closed, its pending approvals become the asker's alone (owner-routed) when the asker
//     is on the list, and are cancelled when not.
// After the commit the event's handler runs the same function again (a reconcile: it changes
// nothing when the transaction did its part), announces the cancelled requests with one Home
// line to the list, lets waiting routines carry on, and drops everyone but the person who
// changed the list from the record's discussion (each one who can still read the record is
// enrolled again when they next open it).
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

/** What the follow did: the list read (null once open) and the requests it cancelled. */
export interface RestrictedFollowResult {
  readers: string[] | null
  withdrawn: string[]
}

type ExecTx = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }

/** The record kind and id an access change is about, or null when it is not followed. */
function accessChangeOf(event: {
  app?: string
  entity?: string
  action?: string
  entityId?: unknown
  data?: unknown
}): { kind: string; id: string } | null {
  if (event.action !== "access_changed") return null
  const scope = restrictedScopeOfEvent(event)
  if (!scope) return null
  const m = /^restricted:([a-z0-9_]+\.[a-z0-9_]+):([0-9a-f-]{36})$/i.exec(scope)
  if (!m || typeof event.entityId !== "string" || event.entityId !== m[2]) return null
  return { kind: m[1] as string, id: m[2] as string }
}

/**
 * Bring the kernel's copies of the record to its list, in the caller's transaction (the
 * writer's own, under row-level security, or a privileged one). Null when the event is not an
 * access change of a followed kind.
 */
export async function followRestrictedAccessInTx(
  tx: ExecTx,
  event: { orgId: string; app?: string; entity?: string; action?: string; entityId?: unknown; data?: unknown },
): Promise<RestrictedFollowResult | null> {
  const change = accessChangeOf(event)
  if (!change) return null
  const ks = sql.raw(quoteIdent(schemaRef("kernel")))
  const [row] = extractRows<{ r: { state: string; readers?: string[] | null; withdrawn?: string[] } }>(
    await tx.execute(
      sql`SELECT ${ks}.restricted_access_follow(${event.orgId}::uuid, ${change.kind}, ${change.id}::uuid) AS r`,
    ),
  )
  if (row?.r.state !== "followed") return null
  return { readers: row.r.readers ?? null, withdrawn: uuids(row.r.withdrawn) }
}

/**
 * After the commit of an access change: reconcile the copies, announce the requests the change
 * cancelled (the writer's transaction names them in `withdrawn_request_ids`), and prune the
 * record's discussion.
 */
export async function followRestrictedAccess(event: AppEvent): Promise<boolean> {
  const change = accessChangeOf(event)
  if (!change) return false
  const data =
    event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {}
  const actorId = typeof event.actorId === "string" ? event.actorId : null
  let withdrawn: string[] = []
  await withPrivilegedDb(event.orgId, "restricted-access-follow", async (tx) => {
    const followed = await followRestrictedAccessInTx(tx as never, event)
    withdrawn = [...new Set([...uuids(data.withdrawn_request_ids), ...(followed?.withdrawn ?? [])])]
    for (const id of withdrawn) {
      await tx.queueEvent({
        app: "kernel",
        entity: "approval_request",
        action: "update",
        entityId: id,
        orgId: event.orgId,
        actorId,
        actorType: "system",
        data: await loadApprovalSummary(tx as never, event.orgId, id),
      })
    }
    // The list hears that requests about the record went away, on Home: one line, naming
    // nothing of the record, whoever asked.
    const list = followed?.readers ?? []
    if (withdrawn.length > 0 && list.length > 0) {
      await tx.queueEvent({
        app: "kernel",
        entity: "restricted_record",
        action: "requests_withdrawn",
        entityId: change.id,
        orgId: event.orgId,
        actorId,
        actorType: "system",
        data: { targetUserIds: list, count: withdrawn.length },
      })
    }
    await pruneEntityDiscussion(
      {
        orgId: event.orgId,
        ref: { app: event.app, entityType: event.entity, entityId: change.id },
        keepUserId: actorId,
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
