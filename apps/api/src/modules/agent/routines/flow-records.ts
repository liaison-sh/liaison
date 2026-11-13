// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Routine flow records (0303): the record an event routine's flow acts on, as its app declares it.
 *
 * The kernel knows no app here. An app entity opts in with `entities.<e>.routineFlow` in its
 * manifest (manifest-schema.ts, contract.ts routineFlowDeclarationErrors); registration
 * (runtime.ts) puts the declaration in `routineFlowRecordRegistry`, keyed by org, app and entity.
 * Everything a flow or an event filter does with its trigger record goes through it:
 *
 * - which of the entity's events take an event filter (`filterEvents`: container, from/to status,
 *   field values) and which fire one run per occurrence, never coalesced (`uncoalescedEvents`);
 * - how the record is read as a given actor (`readRecords`, a handler export of the app's server
 *   module returning `FlowRecord`s) and which candidate holds the fewest open records of a
 *   container (`leastLoaded`);
 * - which of the app's tools implement the flow's actions on the record: `updateTool` takes
 *   `{ [recordParam], assigneeId | statusId | fields }` (assign, set_status, set_field) and
 *   `commentTool` takes `{ [recordParam], body }` (comment);
 * - the scope notifying a teammate about the record takes (`notifyScope`), the tab a link opens
 *   (`tabType`) and the record's web path (`urlPath`, `{id}` filled).
 *
 * The readers are in-process server code, so only a core app (core/registry.ts) can declare one:
 * a sandboxed app's declaration is refused at registration, and an entity with no declaration
 * has no flow record (its conditions read nothing, its record actions fail cleanly).
 */
import type { RlsClient, RlsTx } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { routineFlowRecordRegistry } from "~/modules/apps/app-registries"
import { coreModuleFor } from "~/modules/apps/core/registry"

/** One trigger record, as an actor reads it now. */
export interface FlowRecord {
  id: string
  /** The record's container (a task's project); the event filter's container id. */
  containerId: string
  statusId: string | null
  assigneeId: string | null
  assigneeName: string | null
  title: string
  key: string | null
  fields: Record<string, unknown>
  /** When the record entered its current status (ISO), or null. */
  statusEnteredAt: string | null
}

/** `entities.<e>.routineFlow`, as the manifest declares it. */
export interface RoutineFlowDeclaration {
  filterEvents: string[]
  uncoalescedEvents?: string[]
  /** The record id parameter of `updateTool` and `commentTool`. */
  recordParam: string
  updateTool: string
  commentTool: string
  notifyScope: string
  tabType: string
  /** The record's path under the org's web base, `{id}` replaced by the record id. */
  urlPath: string
  /** Handler export: `(tx, orgId, ids, { includeArchived? }) => FlowRecord[]`. */
  readRecords: string
  /** Handler export: `(tx, orgId, containerId, candidates) => { userId, open }[]`. */
  leastLoaded: string
}

export type FlowRecordReader = (
  tx: RlsClient | RlsTx,
  orgId: string,
  ids: readonly string[],
  opts?: { includeArchived?: boolean },
) => Promise<FlowRecord[]>

export type FlowRecordLoadReader = (
  tx: RlsClient | RlsTx,
  orgId: string,
  containerId: string,
  candidates: readonly string[],
) => Promise<Array<{ userId: string; open: number }>>

/** A declared flow record family: its declaration and where its handlers live. */
export interface FlowRecordSource {
  app: string
  entity: string
  decl: RoutineFlowDeclaration
}

/** The declared flow record of an org's `app:entity`, or null when none is declared. */
export function flowRecordSource(
  orgId: string,
  app: string | undefined | null,
  entity: string | undefined | null,
): FlowRecordSource | null {
  if (!app || !entity) return null
  const reg = routineFlowRecordRegistry.get([orgId, app, entity])
  return reg ? { app, entity, decl: reg.decl } : null
}

/** The flow record family named by a run's trigger label (`<app>.<entity>.<action>`), or null. */
export function flowRecordSourceOfLabel(
  orgId: string,
  label: string | null | undefined,
): FlowRecordSource | null {
  const [app, entity] = (label ?? "").split(".")
  return flowRecordSource(orgId, app, entity)
}

/** Whether `action` of a declared family takes an event filter. */
export function takesRecordFilter(src: FlowRecordSource | null, action: string): boolean {
  return !!src && src.decl.filterEvents.includes(action)
}

/** Whether every occurrence of `action` fires its own run (no coalesce window). */
export function isUncoalescedRecordEvent(src: FlowRecordSource | null, action: string): boolean {
  return !!src && (src.decl.uncoalescedEvents ?? []).includes(action)
}

async function handlerOf<T>(orgId: string, src: FlowRecordSource, exportName: string): Promise<T> {
  const reg = routineFlowRecordRegistry.get([orgId, src.app, src.entity])
  const mod = reg ? coreModuleFor(src.app, reg.bundlePath) : null
  if (!mod) throw new Error(`${src.app}:${src.entity}: no server module declares its flow record`)
  const fn = (await mod.load())[exportName]
  if (typeof fn !== "function") {
    throw new Error(`${src.app}:${src.entity}: routineFlow handler "${exportName}" is not exported`)
  }
  return fn as T
}

/** The records, read as `actor` under their RLS; a hidden record is absent. */
export async function readFlowRecords(
  src: FlowRecordSource,
  actor: UserContext,
  ids: readonly string[],
  opts: { includeArchived?: boolean } = {},
): Promise<FlowRecord[]> {
  const read = await handlerOf<FlowRecordReader>(actor.orgId, src, src.decl.readRecords)
  return withRlsContext(actor, (tx) => read(tx, actor.orgId, ids, opts), { pool: "jobs" })
}

/** How many open records of the container each candidate holds, read as `actor`. */
export async function readFlowRecordLoad(
  src: FlowRecordSource,
  actor: UserContext,
  containerId: string,
  candidates: readonly string[],
): Promise<Map<string, number>> {
  const read = await handlerOf<FlowRecordLoadReader>(actor.orgId, src, src.decl.leastLoaded)
  const rows = await withRlsContext(actor, (tx) => read(tx, actor.orgId, containerId, candidates), {
    pool: "jobs",
  })
  return new Map(rows.map((r) => [r.userId, r.open]))
}

/** The app's tool implementing a record action, qualified (`<app>:<tool>`). */
export function flowRecordTool(src: FlowRecordSource, kind: "update" | "comment"): string {
  return `${src.app}:${kind === "update" ? src.decl.updateTool : src.decl.commentTool}`
}

/** The record's web path, `{id}` filled. */
export function flowRecordPath(src: FlowRecordSource, id: string): string {
  return src.decl.urlPath.replace("{id}", encodeURIComponent(id))
}
