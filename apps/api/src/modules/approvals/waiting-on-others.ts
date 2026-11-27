// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Requests waiting on someone else, as a person may know of them.
//
// A person's approvals read lists what they decide and what they asked for. A request another
// person (or their agent) staged, decided by others, is in neither list, so a colleague asking
// "is a refund waiting for this customer?" was told no while one was pending. This read names
// such a request, and who decides it, to a person who could have made the same call: they hold
// every scope the tool requires, and every read scope the request's turn had read
// (`metadata.taintAudienceMustHold`). It gives the request's handle, its card title, its age, its
// deadline and its deciders, never its payload, its lines or its thread. An owner-routed request
// (someone's own mailbox, their own record) stays private to its owner and requester. Who decides
// is unchanged: this read decides nothing and offers no Approve.
import { type ApprovalSummary, isOwnerRouted } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import {
  apiViewer,
  authorityFacts,
  canSeeInList,
  decidingScope,
} from "~/modules/approvals/authority"
import { splitToolName } from "~/modules/approvals/event-data"
import { toolRegistry } from "~/modules/apps/app-registries"
import { hasScope } from "~/modules/permissions/permissions"
import { scopeHoldersInTx } from "~/modules/permissions/scope-holders"

const K = drizzleSql.raw(schemaRef("kernel"))

/** The most a read names, oldest first. */
const LIMIT = 25

export interface WaitingOnOthers {
  /** The `request-N` label the card prints: what the person can cite to a decider. */
  handle: string
  app: string
  toolName: string
  /** The card's title, as its deciders read it. */
  title: string
  ageDays: number
  expiresAt: string
  /** The scope that decides it. */
  decidedBy: string
  /** The people it waits on, by name: those it was sent to who hold the deciding scope. */
  deciders: string[]
}

interface Row {
  handle: string
  tool_name: string
  approve_scope: string | null
  summary: ApprovalSummary | null
  metadata: Record<string, unknown> | null
  requested_by: string
  notify_user_ids: string[] | null
  resource_owner_id: string | null
  created_at: Date | string
  expires_at: Date | string
}

function taintOf(metadata: Record<string, unknown> | null): string[] {
  const raw = metadata?.taintAudienceMustHold
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : []
}

/** Whether the viewer may know the request exists: they could have made the same call. */
function mayKnowOf(orgId: string, r: Row, scopes: string[]): boolean {
  const { appName, toolShortName } = splitToolName(r.tool_name)
  const tool = toolRegistry.get([orgId, appName, toolShortName]) as
    | { requiredScopes?: unknown }
    | undefined
  // An unknown tool (its app not set up here) tells nothing about who may know: name nothing.
  const required = Array.isArray(tool?.requiredScopes) ? (tool.requiredScopes as string[]) : null
  if (!required || required.length === 0) return false
  return [...required, ...taintOf(r.metadata)].every((s) => hasScope(s, scopes))
}

/**
 * The approvals RLS lets a person read only the requests they asked for or are sent to decide, so
 * the org's pending rows are read privileged, pinned to the org, and filtered and projected here
 * before anything leaves: `mayKnowOf` per row, and only the fields of `WaitingOnOthers`.
 */
export async function listWaitingOnOthers(args: {
  orgId: string
  userId: string
  scopes: string[]
}): Promise<WaitingOnOthers[]> {
  return withPrivilegedDb(args.orgId, "approvals:waiting-on-others", (db) => read(db, args))
}

async function read(
  db: PrivilegedDb,
  args: { orgId: string; userId: string; scopes: string[] },
): Promise<WaitingOnOthers[]> {
  const rows = extractRows<Row>(
    await db.execute(drizzleSql`
      SELECT handle, tool_name, approve_scope, summary, metadata, requested_by, notify_user_ids,
             resource_owner_id, created_at, expires_at
      FROM ${K}.approval_requests
      WHERE org_id = ${args.orgId} AND status = 'pending' AND expires_at > now()
      ORDER BY created_at ASC
      LIMIT 200
    `),
  )
  const viewer = apiViewer(args.userId, args.scopes)
  const named = rows
    .filter((r) => {
      const f = authorityFacts(r)
      // The person's own queue and requests are listed already; an owner's request is theirs.
      if (isOwnerRouted(f) || canSeeInList(f, viewer)) return false
      return mayKnowOf(args.orgId, r, args.scopes)
    })
    .slice(0, LIMIT)
  if (named.length === 0) return []

  // The deciders: those the request was sent to who hold its deciding scope.
  const holders = new Map<string, Set<string>>()
  for (const scope of new Set(named.map((r) => decidingScope(authorityFacts(r))))) {
    holders.set(scope, new Set(await scopeHoldersInTx(db, args.orgId, scope)))
  }
  const ids = [...new Set(named.flatMap((r) => r.notify_user_ids ?? []))]
  const names =
    ids.length === 0
      ? new Map<string, string>()
      : new Map(
          extractRows<{ id: string; name: string }>(
            await db.execute(drizzleSql`
              SELECT id, name FROM ${K}.users
              WHERE org_id = ${args.orgId} AND status = 'active' AND id IN (${drizzleSql.join(
                ids.map((id) => drizzleSql`${id}::uuid`),
                drizzleSql`, `,
              )})
            `),
          ).map((u) => [u.id, u.name]),
        )
  const now = Date.now()
  return named.map((r) => {
    const scope = decidingScope(authorityFacts(r))
    const decides = holders.get(scope) ?? new Set<string>()
    const deciders = (r.notify_user_ids ?? [])
      .filter((id) => decides.has(id) && names.has(id))
      .map((id) => names.get(id) as string)
    return {
      handle: r.handle,
      app: splitToolName(r.tool_name).appName,
      toolName: r.tool_name,
      title: String(r.summary?.title ?? r.tool_name).slice(0, 200),
      ageDays: Math.floor((now - new Date(r.created_at).getTime()) / 86_400_000),
      expiresAt: new Date(r.expires_at).toISOString(),
      decidedBy: scope,
      deciders,
    }
  })
}
