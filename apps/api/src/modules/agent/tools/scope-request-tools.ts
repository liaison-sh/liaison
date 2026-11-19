// SPDX-License-Identifier: FSL-1.1-ALv2
import type { RlsClient } from "~/db"
import { captureActingAgentId, currentRunContext } from "~/modules/agent/runtime/run-context"
import { turnToolScopes } from "~/modules/agent/scopes/effective-scope"
import { listLockedCapabilities } from "~/modules/agent/tools/tool-bridge"
import { scoreDeferredTools } from "~/modules/agent/tools/tool-rank"
import { toolSynopsis } from "~/modules/agent/tools/tool-search"
import { createScopeRequest } from "~/modules/scope-requests/service"

/**
 * Kernel-tool ctx is the `AppContext` built by `createAppContext`. We only read
 * `userId`, `orgId`, `scopes`, `db`, and the optional `agentExecutionThreadId`.
 */
interface ScopeToolCtx {
  userId: string
  orgId: string
  scopes?: string[]
  db: RlsClient
  agentExecutionThreadId?: string
}

/** At most this many entries per result: the digest must fit a tool-result cap. */
export const LOCKED_CAPABILITIES_MAX_RESULTS = 40
const LOCKED_SUMMARY_CHARS = 100

export interface LockedCapabilityDigest {
  name: string
  app: string
  scope: string
  /** One line: the tool description flattened and cut. */
  summary: string
}

/**
 * `list_locked_capabilities` — what this agent could do with more scope,
 * intra-org only.
 *
 * A DIGEST, not a catalog dump: the live walk measured 219 entries with full
 * descriptions, ~131 KB, cut by the platform's tool-result cap before the agent
 * could read it. Each entry is the tool name, its app, the scope it needs and a
 * one-line summary, capped in count with the total and a note when cut.
 *
 * The query narrows on the tool NAME, APP and SCOPE (every term must appear,
 * separators ignored). It used to match inside descriptions too, where half the
 * catalog mentions tickets, so "tickets" returned the mail tools. When nothing
 * holds every term by name, app or scope, the locked tools are RANKED by the
 * same keyword scoring tool_search uses, over their names, apps, scopes and
 * descriptions, so a query of several words ("rate invoice price billing")
 * finds the tools that hold some of them instead of none: an empty answer told
 * the agent the capability did not exist.
 */
export async function handleListLockedCapabilities(
  params: { query?: string },
  ctx: ScopeToolCtx,
): Promise<{
  locked: LockedCapabilityDigest[]
  total: number
  note?: string
}> {
  // The turn's scope (ceiling ∩ grants), the same set the catalog and the
  // call-time check use: a tool the agent was just refused because its
  // ceiling lacks the scope is locked HERE too, never an empty list.
  const scopes = turnToolScopes(ctx.scopes ?? [], currentRunContext())
  let locked = listLockedCapabilities(scopes, ctx.orgId, ctx.userId)
  const query = params.query?.trim().toLowerCase()
  if (query) {
    const terms = query.split(/[\s,:./_-]+/).filter(Boolean)
    const matches = (hay: string) => {
      const h = hay.toLowerCase()
      return h.includes(query) || (terms.length > 0 && terms.every((t) => h.includes(t)))
    }
    const byName = locked.filter((t) => matches(`${t.name} ${t.app} ${t.scope}`))
    locked = byName.length > 0 ? byName : rankLockedByWords(locked, query)
  }
  const total = locked.length
  const shown = locked.slice(0, LOCKED_CAPABILITIES_MAX_RESULTS).map((t) => ({
    name: t.name,
    app: t.app,
    scope: t.scope,
    summary: toolSynopsis(t.description, LOCKED_SUMMARY_CHARS),
  }))
  return {
    locked: shown,
    total,
    ...(total > shown.length
      ? {
          note: `${total - shown.length} more locked tools not shown: pass a query (an app or a task word) to narrow the list.`,
        }
      : {}),
  }
}

/**
 * The locked tools that hold some of the query's words, best first, scored as tool_search
 * scores its catalog (tool-rank.ts): the name and app weigh most, the scope's words and the
 * description count too.
 */
function rankLockedByWords<T extends { name: string; app: string; scope: string; description: string }>(
  locked: readonly T[],
  query: string,
): T[] {
  const scorable = locked.map((t) => ({
    entry: t,
    toolName: t.name.startsWith(`${t.app}__`) ? t.name.slice(t.app.length + 2) : t.name,
    appName: t.app,
    description: `${t.description} ${t.scope.replace(/[,:_]+/g, " ")}`,
  }))
  return scoreDeferredTools(scorable, query)
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.tool.entry)
}

/** `request_scope` — file a pending, agent-typed scope request for the actor's identity. */
export async function handleRequestScope(
  params: { scopes: string[]; reason?: string },
  ctx: ScopeToolCtx,
): Promise<{ requested: boolean; requestId: string; scopes: string[] }> {
  // WHO asked. `ctx.userId` is the human whose turn it is and stays the row's
  // identity for RLS; the acting agent is the speaker, and without it the admin
  // row credited the person and named no agent. Same fact, same capture, as the
  // acting agent on an approval request.
  const row = await createScopeRequest(ctx.db, {
    orgId: ctx.orgId,
    requestedBy: ctx.userId,
    requestedByType: "agent",
    agentId: captureActingAgentId(),
    requestedScopes: params.scopes,
    reason: params.reason,
    originatingThreadId: ctx.agentExecutionThreadId,
  })
  return { requested: true, requestId: row.id, scopes: row.requestedScopes }
}
