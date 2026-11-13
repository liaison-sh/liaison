// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Picking the record a link cell points at (A18), as the person sees it. Two generic paths:
//  - an entity whose manifest declares `pick: {tool, queryParam, idField, labelField,
//    itemsPath?}` is searched by running that app's own read tool as the person (an entity of an
//    outside service, which the search index does not hold);
//  - any other entity is searched in the search index (the mention search, permission-filtered).
// Nothing here is specific to one app: an app opts in through its manifest.

import type { UserContext } from "~/db/rls"
import { rootLogger } from "~/lib/logger"
import { entityRegistry, type PickDeclaration } from "~/modules/apps/app-registries"
import type { RestToolCall } from "~/modules/apps/rest-tool-call"
import { TableError } from "~/modules/dashboards/tables/service"

const log = rootLogger.child({ module: "dashboards/tables/link-search" })

export const LINK_SEARCH_LIMIT = 20

export interface LinkTarget {
  id: string
  label: string
  app: string
  entityType: string
}

function at(value: unknown, path: string | undefined): unknown {
  if (!path) return value
  let v: unknown = value
  for (const part of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined
    v = (v as Record<string, unknown>)[part]
  }
  return v
}

/** The list a tool result holds: at itemsPath, the result itself, or its only array. */
export function itemsOf(data: unknown, itemsPath?: string): unknown[] {
  const v = at(data, itemsPath)
  if (Array.isArray(v)) return v
  if (!itemsPath && v && typeof v === "object") {
    const arrays = Object.values(v as Record<string, unknown>).filter(Array.isArray)
    if (arrays.length === 1) return arrays[0] as unknown[]
  }
  return []
}

/**
 * The dispatch of a pick tool: the person's own read (their actor and grants, the request's
 * provenance from `restToolCall`), never the webhook/job provenance, and a read-only run, so a
 * manifest that names a writing tool as its picker cannot write.
 */
export function pickToolCall(
  viewer: UserContext,
  app: string,
  pick: PickDeclaration,
  q: string,
  call: RestToolCall,
) {
  return {
    toolName: `${app}:${pick.tool}`,
    orgId: viewer.orgId,
    actor: viewer,
    params: { ...(pick.params ?? {}), ...(q ? { [pick.queryParam]: q } : {}) },
    origin: call.origin,
    ...(call.threadId ? { threadId: call.threadId } : {}),
    readOnlyRun: true,
  }
}

async function viaTool(
  viewer: UserContext,
  app: string,
  entityType: string,
  pick: PickDeclaration,
  q: string,
  call: RestToolCall,
): Promise<LinkTarget[]> {
  const { executeTool } = await import("~/modules/apps/execute-tool")
  let result: Awaited<ReturnType<typeof executeTool>>
  try {
    result = await executeTool(pickToolCall(viewer, app, pick, q, call))
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string }
    log.error({ err, app, entityType, tool: pick.tool }, "link search: the pick tool failed")
    if (e.status === 403) throw new TableError("forbidden", `you cannot read ${app} records`)
    throw new TableError(
      "invalid_request",
      `${app}:${pick.tool} failed: ${e.code ?? ""} ${e.message ?? "unknown error"}`.trim(),
    )
  }
  if (result.blocked) {
    throw new TableError("invalid_request", `${app}:${pick.tool} asked for an approval`)
  }
  const out: LinkTarget[] = []
  for (const item of itemsOf(result.data, pick.itemsPath)) {
    if (!item || typeof item !== "object") continue
    const id = at(item, pick.idField)
    const label = at(item, pick.labelField)
    if ((typeof id !== "string" && typeof id !== "number") || id === "") continue
    out.push({
      id: String(id),
      label: label == null || label === "" ? String(id) : String(label).slice(0, 200),
      app,
      entityType,
    })
    if (out.length >= LINK_SEARCH_LIMIT) break
  }
  return out
}

async function viaIndex(
  viewer: UserContext,
  app: string | undefined,
  entityType: string | undefined,
  q: string,
): Promise<LinkTarget[]> {
  if (!q.trim()) return []
  const { mentionSearch } = await import("~/modules/search/service")
  const hits = await mentionSearch({
    orgId: viewer.orgId,
    userId: viewer.userId,
    scopes: viewer.scopes,
    dimensionGrants: viewer.dimensionGrants,
    roleIds: viewer.roles ?? [],
    q,
    limit: 50,
    // Narrowed in the engine: filtering a mixed top-N here let a word common
    // in other records crowd every row of this app out of the picker.
    app,
    entityType,
  })
  const out: LinkTarget[] = []
  for (const h of hits) {
    // A link cell names its app: a hit without one cannot be linked.
    if (!h.app || (app && h.app !== app)) continue
    const type = h.entityType ?? h.type
    if (entityType && type !== entityType) continue
    out.push({ id: h.id, label: h.label.slice(0, 200), app: h.app, entityType: type })
    if (out.length >= LINK_SEARCH_LIMIT) break
  }
  return out
}

/**
 * The records of `app` (one entity type, or all of them) matching `q`, as the person sees them.
 * Without an app (a link column with no `linkTo`), the search index across every app: an outside
 * service's pick tool is searched only when its app is named.
 */
export async function searchLinkTargets(
  viewer: UserContext,
  input: { app?: string; entityType?: string; q: string },
  call: RestToolCall,
): Promise<LinkTarget[]> {
  if (!input.app) return viaIndex(viewer, undefined, input.entityType, input.q)
  const app = input.app
  const { awaitOrgApps } = await import("~/modules/apps/init")
  await awaitOrgApps(viewer.orgId)
  const entities: Array<[string, { pick?: PickDeclaration }]> = []
  for (const [[orgId, appName, entity], decl] of entityRegistry.entriesOf(viewer.orgId)) {
    if (orgId !== viewer.orgId || appName !== app) continue
    if (input.entityType && entity !== input.entityType) continue
    entities.push([entity, decl as { pick?: PickDeclaration }])
  }
  const picked = entities.filter(([, d]) => d.pick)
  if (picked.length === 0) return viaIndex(viewer, app, input.entityType, input.q)
  const out: LinkTarget[] = []
  for (const [entity, decl] of picked) {
    out.push(...(await viaTool(viewer, app, entity, decl.pick!, input.q, call)))
    if (out.length >= LINK_SEARCH_LIMIT) break
  }
  return out.slice(0, LINK_SEARCH_LIMIT)
}
