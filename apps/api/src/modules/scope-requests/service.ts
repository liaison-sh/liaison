// SPDX-License-Identifier: FSL-1.1-ALv2
import { APP_DISABLED_MESSAGE, APP_RESTRICTED_MESSAGE } from "@liaison/shared"
import { and, sql as drizzleSql, eq, isNull } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { RlsClient, RlsTx } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { agents, scopeRequests, users } from "~/db/schema/kernel"
import type { AgentKind } from "~/db/schema/kernel/agents"
import {
  assertCeilingScopesKnown,
  assertNoAdminScopesInRoleCeiling,
  scopesMissingFromCeiling,
} from "~/modules/agent/directory/ceiling-guard"
import { installedAppScopes } from "~/modules/agent/directory/installed-scopes"
import { recomputePersonalAgentCeiling } from "~/modules/agent/directory/personal-agent"
import {
  isAppRestrictedAway,
  isOffStatus,
  peekOrgAppState,
  primeOrgApps,
} from "~/modules/apps/org-apps"
import { PermissionDeniedError } from "~/modules/permissions/errors"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"
import { grantUserScope } from "~/modules/permissions/roles"
import type { PermissionMutationContext } from "~/modules/permissions/types"

export class AlreadyDecidedError extends Error {
  readonly status = 409
  readonly code = "already_decided"
  readonly details: { currentStatus: string }
  constructor(currentStatus: string) {
    super(`This request has already been decided (${currentStatus}).`)
    this.name = "AlreadyDecidedError"
    this.details = { currentStatus }
  }
}

export interface ScopeRequestSummary {
  title: string
  lines: string[]
}

export interface CreateScopeRequestArgs {
  orgId: string
  requestedBy: string
  requestedByType: "user" | "agent"
  /** The agent that asked, when an agent turn filed this. */
  agentId?: string | null
  requestedScopes: string[]
  reason?: string
  originatingThreadId?: string
}

/**
 * What the admin row says. It NAMES the capabilities asked for: a title of
 * "Requesting 1 scope" beside an actor line of "Someone" told an admin nothing
 * at all about what they were being asked to decide, and the scopes were
 * already carried in `lines` where no row rendered them.
 *
 * The scope names are safe here, unlike on a withheld-capability card (A14):
 * this surface is the requester's own admin, deciding this very request, not a
 * room artifact that could be diffed for somebody else's grants.
 */
function buildSummary(requestedScopes: string[]): ScopeRequestSummary {
  const NAMED = 3
  const named = requestedScopes.slice(0, NAMED).join(", ")
  const rest = requestedScopes.length - NAMED
  return {
    title: rest > 0 ? `${named} and ${rest} more` : named,
    lines: requestedScopes,
  }
}

/** The requester's own display name, the fallback when no agent asked. */
async function readRequesterName(db: RlsClient | RlsTx, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.name ?? null
}

/** The display name of the agent that asked, for the admin row and the feed. */
async function readAgentName(
  db: RlsClient | RlsTx,
  orgId: string,
  agentId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ displayName: agents.displayName })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .limit(1)
  return row?.displayName ?? null
}

/**
 * File a scope request. Self-targeted (target_user_id = requested_by) so the
 * RLS INSERT policy is satisfied. Dedupes against an existing pending request
 * from the same actor whose requested set is a superset of the new set — so an
 * agent retrying across turns, or a user double-clicking, never spams the inbox.
 *
 * Two layers of dedup: (1) the select-then-return covering check below handles the
 * common non-racing path (incl. supersets); (2) for two concurrent identical
 * requests that both miss that select, the `scope_requests_pending_dedup_idx`
 * partial unique index + ON CONFLICT DO NOTHING ensures exactly one pending row is
 * created — the loser re-reads and returns the winner. Never a duplicate pending row.
 */
export async function createScopeRequest(db: RlsClient | RlsTx, args: CreateScopeRequestArgs) {
  // Canonicalize the scope set: dedupe, drop empties, and SORT. The sort gives a
  // stable on-disk array so set-equal requests (e.g. ["a","b"] vs ["b","a"]) collide
  // on the `scope_requests_pending_dedup_idx` partial unique index regardless of the
  // caller's input order. Display/iteration of requested_scopes is order-insensitive.
  const requestedScopes = [...new Set(args.requestedScopes)].filter((s) => s.length > 0).sort()
  if (requestedScopes.length === 0) {
    throw new HTTPException(400, { message: "At least one scope is required" })
  }
  // No grant brings back an app turned Off for the workspace, or one restricted
  // away from this person (S19, S20, A12): the request is refused in words
  // instead of landing in an admin's queue it cannot resolve.
  await primeOrgApps(args.orgId)
  for (const scope of requestedScopes) {
    const app = scope.split(":")[0] ?? ""
    if (!app || app === "kernel" || app === "*") continue
    const state = peekOrgAppState(args.orgId, app)
    if (isOffStatus(state?.status)) {
      throw new HTTPException(409, { message: APP_DISABLED_MESSAGE })
    }
    if (isAppRestrictedAway(state, args.requestedBy)) {
      throw new HTTPException(403, { message: APP_RESTRICTED_MESSAGE })
    }
  }

  // Per requesting AGENT (0168): approval widens the ceiling of the agent the row
  // names and announces in its conversation, so another agent's pending row for
  // the same scopes never covers this one. A user's own request has no agent.
  const sameRequestingAgent = args.agentId
    ? eq(scopeRequests.agentId, args.agentId)
    : isNull(scopeRequests.agentId)

  // Dedupe (non-racing path): a pending request from this actor that already covers
  // everything being asked for → return it instead of inserting a duplicate. This
  // keeps the superset semantics (an existing ["a","b","c"] pending request covers a
  // new ["a","b"]) the racing backstop below can't express on its own.
  const existing = await db
    .select()
    .from(scopeRequests)
    .where(
      and(
        eq(scopeRequests.orgId, args.orgId),
        eq(scopeRequests.requestedBy, args.requestedBy),
        sameRequestingAgent,
        eq(scopeRequests.status, "pending"),
      ),
    )
  const covering = existing.find((row) =>
    requestedScopes.every((s) => (row.requestedScopes ?? []).includes(s)),
  )
  if (covering) return covering

  // Insert. The select above closes the common non-racing dedup; but two concurrent
  // identical requests can both miss it, so guard the INSERT with the partial unique
  // index (`scope_requests_pending_dedup_idx`): exactly one wins, the loser's
  // ON CONFLICT DO NOTHING returns no row. On a no-row result, re-read the pending
  // row the winner just created and return it — so a racing caller still gets a row,
  // never a duplicate and never an error.
  const summary = buildSummary(requestedScopes)
  const [row] = await db
    .insert(scopeRequests)
    .values({
      orgId: args.orgId,
      requestedBy: args.requestedBy,
      requestedByType: args.requestedByType,
      agentId: args.agentId ?? null,
      targetUserId: args.requestedBy,
      requestedScopes,
      reason: args.reason ?? null,
      originatingThreadId: args.originatingThreadId ?? null,
      status: "pending",
      summary,
    })
    .onConflictDoNothing()
    .returning()

  if (!row) {
    // Lost the insert race: the concurrent winner holds the only pending row for this
    // exact scope set. Re-read this actor's pending rows (RLS-scoped) and return the
    // one whose canonical scope set matches — no event, no duplicate. Matching in
    // memory (set-equality on the sorted arrays) mirrors the covering check above and
    // avoids depending on SQL array-literal equality semantics.
    const after = await db
      .select()
      .from(scopeRequests)
      .where(
        and(
          eq(scopeRequests.orgId, args.orgId),
          eq(scopeRequests.requestedBy, args.requestedBy),
          sameRequestingAgent,
          eq(scopeRequests.status, "pending"),
        ),
      )
    const winner = after.find((r) => {
      const scopes = [...(r.requestedScopes ?? [])].sort()
      return (
        scopes.length === requestedScopes.length && scopes.every((s, i) => s === requestedScopes[i])
      )
    })
    if (winner) return winner
    // Defensive: the winner's row isn't visible (e.g. it rolled back after we read no
    // row). Surface a clear conflict rather than returning undefined downstream.
    throw new HTTPException(409, { message: "Scope request creation conflicted; please retry" })
  }

  // WHO asked, resolved here rather than left to the attention layer's actor
  // lookup: that lookup reads `kernel.users`, and an agent turn's actor is the
  // human whose turn it was, so an agent request rendered as "Someone".
  const agentName = args.agentId ? await readAgentName(db, args.orgId, args.agentId) : null
  const requesterLabel = agentName ?? (await readRequesterName(db, args.requestedBy)) ?? "Someone"
  await db.queueEvent({
    app: "kernel",
    entity: "scope_request",
    action: "create",
    entityId: row.id,
    orgId: args.orgId,
    actorId: args.requestedBy,
    actorType: args.requestedByType,
    data: {
      title: summary.title,
      lines: summary.lines,
      status: "pending",
      requesterLabel,
      // Why it was asked, for the admin's row (Home's Approvals list).
      reason: args.reason ?? null,
      agentId: args.agentId ?? null,
      agentName,
      requestedScopes,
    },
  })

  return row
}

export interface ListScopeRequestsArgs {
  status?: "pending" | "approved" | "denied" | "expired" | "cancelled"
}

/**
 * List scope requests visible to the caller. RLS already narrows the rows:
 * requesters/targets see their own; scope-admins see all. We join `users` once
 * for the requester's display name (target_user_id = requested_by — requests are
 * self-targeted — so the requester name is also the target name) so the inbox
 * can show who asked.
 */
export async function listScopeRequests(db: RlsClient, args: ListScopeRequestsArgs) {
  const requester = users
  const conditions = args.status ? [eq(scopeRequests.status, args.status)] : []

  const rows = await db
    .select({
      id: scopeRequests.id,
      orgId: scopeRequests.orgId,
      requestedBy: scopeRequests.requestedBy,
      requestedByName: requester.name,
      requestedByType: scopeRequests.requestedByType,
      agentId: scopeRequests.agentId,
      agentName: agents.displayName,
      targetUserId: scopeRequests.targetUserId,
      requestedScopes: scopeRequests.requestedScopes,
      grantedScopes: scopeRequests.grantedScopes,
      reason: scopeRequests.reason,
      status: scopeRequests.status,
      summary: scopeRequests.summary,
      decidedBy: scopeRequests.decidedBy,
      decidedAt: scopeRequests.decidedAt,
      decisionReason: scopeRequests.decisionReason,
      createdAt: scopeRequests.createdAt,
      updatedAt: scopeRequests.updatedAt,
    })
    .from(scopeRequests)
    .leftJoin(requester, eq(scopeRequests.requestedBy, requester.id))
    .leftJoin(agents, eq(scopeRequests.agentId, agents.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(drizzleSql`${scopeRequests.createdAt} DESC`)

  return rows
}

export async function getScopeRequest(db: RlsClient, requestId: string) {
  const [row] = await db
    .select()
    .from(scopeRequests)
    .where(eq(scopeRequests.id, requestId))
    .limit(1)
  return row ?? null
}

export interface DecideScopeRequestArgs {
  orgId: string
  requestId: string
  actor: PermissionMutationContext
  decision: "approve" | "deny"
  reason?: string
}

/**
 * Approve or deny a scope request. `db` is the request-scoped `RlsClient`, which
 * is itself an open transaction (from `withRequestRls`/`withRlsContext`), so the
 * whole decision — FOR UPDATE lock, per-scope grants, status update, and the
 * outbox event — is already atomic: an approve that fails the symmetric grant
 * guard (`grantUserScope` throws when the approver doesn't hold the scope) rolls
 * the whole request back. No partial grants, no half-updated status.
 */
export async function decideScopeRequest(db: RlsClient, args: DecideScopeRequestArgs) {
  // Lock the row (FOR UPDATE) via the query builder so the SCHEMA_PREFIX worker
  // isolation is honored. Status must be pending; otherwise 409.
  const [row] = await db
    .select()
    .from(scopeRequests)
    .where(and(eq(scopeRequests.id, args.requestId), eq(scopeRequests.orgId, args.orgId)))
    .limit(1)
    .for("update")
  if (!row) throw new HTTPException(404, { message: "Scope request not found" })
  if (row.status !== "pending") throw new AlreadyDecidedError(String(row.status))

  const targetUserId = row.targetUserId
  const requestedScopes = row.requestedScopes ?? []
  const requestedBy = row.requestedBy

  // The agent that asked, when an agent turn filed this. Read live (an
  // archived agent no longer answers, so there is no ceiling to widen).
  const agent = row.agentId ? await readRequestingAgent(db, args.orgId, row.agentId) : null

  let userGranted: string[] = []
  let agentGranted: string[] = []
  if (args.decision === "approve") {
    // WHICH SIDE LACKS THE SCOPE, from the live grants, not assumed. An agent's
    // turn runs at its ceiling INTERSECTED with the person's grants
    // (effective-scope.ts), so a scope the agent asked for can be missing on
    // either side. Approving used to grant the PERSON only: when the person
    // already held it (an admin talking to a role agent) the approval changed
    // nothing, the tool stayed locked, and the agent kept saying its request
    // was still waiting. Each side now gets exactly what it lacks.
    const held = await withPrivilegedDb(args.orgId, "scope-request-target-grants", (tx) =>
      loadEffectivePermissions(tx, targetUserId, args.orgId),
    )
    userGranted = scopesMissingFromCeiling(requestedScopes, held.scopes)
    for (const scope of userGranted) {
      try {
        await grantUserScope(db, {
          userId: targetUserId,
          scope,
          actorId: args.actor.actorId,
          actorScopes: args.actor.actorScopes,
          actorDimensionGrants: args.actor.actorDimensionGrants,
          orgId: args.orgId,
        })
      } catch (err) {
        // The symmetric grant guard throws HTTPException(403, "Cannot grant a
        // scope you do not hold"). Rethrow as a scope-named PermissionDenied so
        // the approver sees exactly what they lack — and let the tx roll back.
        if (err instanceof HTTPException && err.status === 403) {
          throw new PermissionDeniedError({
            missingScope: scope,
            message: `Cannot approve: you don't hold "${scope}", so you can't grant it. Ask a full admin.`,
          })
        }
        // RLS backstop: granting a privileged kernel scope (`scope_is_privileged`)
        // requires a full kernel admin (`session_is_admin`), which holding only
        // `kernel:scope_requests:admin` does NOT satisfy — Postgres rejects the
        // INSERT with SQLSTATE 42501. Surface it as a clear scope-named denial
        // rather than an opaque 500 (the surrounding tx still rolls back cleanly).
        if ((err as { code?: string } | null)?.code === "42501") {
          throw new PermissionDeniedError({
            missingScope: scope,
            message: `Cannot approve: granting "${scope}" requires a full kernel admin.`,
          })
        }
        throw err
      }
    }

    if (agent) {
      agentGranted = await widenRequestingAgent(db, {
        orgId: args.orgId,
        agent,
        targetUserId,
        requestedScopes,
        actorScopes: args.actor.actorScopes,
      })
    }

    await db
      .update(scopeRequests)
      .set({
        status: "approved",
        decidedBy: args.actor.actorId,
        decidedAt: new Date(),
        grantedScopes: requestedScopes,
        updatedAt: new Date(),
      })
      .where(eq(scopeRequests.id, args.requestId))
  } else {
    await db
      .update(scopeRequests)
      .set({
        status: "denied",
        decidedBy: args.actor.actorId,
        decidedAt: new Date(),
        decisionReason: args.reason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(scopeRequests.id, args.requestId))
  }

  const finalStatus = args.decision === "approve" ? "approved" : "denied"
  await db.queueEvent({
    app: "kernel",
    entity: "scope_request",
    action: "update",
    entityId: args.requestId,
    orgId: args.orgId,
    actorId: args.actor.actorId,
    actorType: "user",
    data: {
      title: buildSummary(requestedScopes).title,
      lines: requestedScopes,
      status: finalStatus,
      requestedBy,
      decidedBy: args.actor.actorId,
      agentId: agent?.id ?? null,
      userGrantedScopes: userGranted,
      agentGrantedScopes: agentGranted,
    },
  })

  return {
    id: args.requestId,
    status: finalStatus as "approved" | "denied",
    decidedBy: args.actor.actorId,
    grantedScopes: args.decision === "approve" ? requestedScopes : [],
    /** What the approval added to the person's own grants (only what they lacked). */
    userGrantedScopes: userGranted,
    /** What it added to the asking agent's ceiling (only what it lacked). */
    agentGrantedScopes: agentGranted,
    requestedScopes,
    targetUserId,
    agentId: agent?.id ?? null,
    agentName: agent?.displayName ?? null,
    originatingThreadId: row.originatingThreadId ?? null,
    requestedByType: row.requestedByType,
    decisionReason: args.decision === "deny" ? (args.reason ?? null) : null,
  }
}

export type ScopeRequestDecision = Awaited<ReturnType<typeof decideScopeRequest>>

interface RequestingAgent {
  id: string
  kind: AgentKind
  ownerUserId: string | null
  displayName: string
  scopeCeiling: string[]
}

async function readRequestingAgent(
  db: RlsClient,
  orgId: string,
  agentId: string,
): Promise<RequestingAgent | null> {
  const [row] = await db
    .select({
      id: agents.id,
      kind: agents.kind,
      ownerUserId: agents.ownerUserId,
      displayName: agents.displayName,
      scopeCeiling: agents.scopeCeiling,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .limit(1)
  return row ?? null
}

/**
 * Widen the asking agent's ceiling by what it lacks of the request, and
 * return what was added. The same authority the agent Settings edit demands
 * (`definition-routes.ts` PATCH): the approver administers agents
 * (`kernel:agents:admin`) and holds every scope they hand over, so approving a
 * request is never a way around the agent editor. A role agent's ceiling
 * additionally refuses an organization-administration scope or a scope this
 * instance does not know (`ceiling-guard.ts`), exactly as a written ceiling
 * does. Any refusal throws, and the whole decision rolls back: no half grant
 * that leaves the person widened and the agent still locked.
 *
 * A PERSONAL agent's ceiling is its owner's own grants, recomputed from them,
 * never hand-widened: when the owner is the person this request targets, the
 * user grant above already covers it and the recompute brings the ceiling
 * along (it is what `grantUserScope` runs for a grant it inserted, and runs
 * here too for a scope the person held but the stored ceiling had not caught
 * up with). Someone else's personal agent is not widened at all.
 */
async function widenRequestingAgent(
  db: RlsClient,
  args: {
    orgId: string
    agent: RequestingAgent
    targetUserId: string
    requestedScopes: string[]
    actorScopes: string[]
  },
): Promise<string[]> {
  const { agent } = args
  const missing = scopesMissingFromCeiling(args.requestedScopes, agent.scopeCeiling)
  if (missing.length === 0) return []

  if (agent.kind === "personal") {
    if (agent.ownerUserId !== args.targetUserId) return []
    await recomputePersonalAgentCeiling(db, { userId: args.targetUserId, orgId: args.orgId })
    return missing
  }

  if (!hasScope("kernel:agents:admin", args.actorScopes)) {
    throw new PermissionDeniedError({
      missingScope: "kernel:agents:admin",
      message: `Cannot approve: ${agent.displayName} itself lacks ${missing.join(", ")}, and widening an agent's access needs "kernel:agents:admin".`,
    })
  }
  for (const scope of missing) {
    if (!hasScope(scope, args.actorScopes)) {
      throw new PermissionDeniedError({
        missingScope: scope,
        message: `Cannot approve: you don't hold "${scope}", so you can't give it to ${agent.displayName}. Ask a full admin.`,
      })
    }
  }
  const installed = await withPrivilegedDb(args.orgId, "scope-request-installed-scopes", (tx) =>
    installedAppScopes(tx),
  )
  try {
    if (agent.kind === "role") assertNoAdminScopesInRoleCeiling("role", missing, installed)
    else assertCeilingScopesKnown(missing, installed)
  } catch (err) {
    throw new HTTPException(422, {
      message: `Cannot approve for ${agent.displayName}: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  // Through the approver's own RLS context: `agents_update` admits a role or
  // system agent's row only for `kernel:agents:admin`, so the database holds
  // the line the check above draws even if that check were ever loosened.
  const [updated] = await db
    .update(agents)
    .set({ scopeCeiling: [...agent.scopeCeiling, ...missing], updatedAt: new Date() })
    .where(and(eq(agents.id, agent.id), eq(agents.orgId, args.orgId)))
    .returning({ id: agents.id })
  if (!updated) {
    throw new PermissionDeniedError({
      missingScope: "kernel:agents:admin",
      message: `Cannot approve: you may not change ${agent.displayName}'s access.`,
    })
  }
  return missing
}
