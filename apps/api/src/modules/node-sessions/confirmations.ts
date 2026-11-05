// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Level confirmations (D24, D38, D41, D42): the only way a node level goes up.
 *
 * A confirmation is minted by the owner's own session (`routes-confirm.ts`,
 * never an agent tool, an MCP token, an API key or a node credential), bound
 * to (node, agent or session, level, purpose), and lives 5 minutes unless it
 * is attached first:
 *
 *   - `profile_raise` (agent): attached by a profile save (P1-T18); the node
 *     consumes it at its next claim to raise its pin for that agent.
 *   - `session_start` (agent): attached to one new session (P1-T19,
 *     `attached_session_id`); the node consumes it to admit that session's
 *     start above its pin.
 *   - `session_raise` (session): a level switch of a running session (P3).
 *
 * An attached `profile_raise`, `session_start` or `session_raise` does not expire by age; each
 * row is consumed once. One level rule everywhere: the confirmation's level
 * EQUALS the level being admitted (K28).
 *
 * `insertLevelConfirmation` is the only insert. An import-graph test
 * (confirmations.test.ts) proves no agent or MCP module reaches it.
 */
import { isNodeLevel, levelRank, type NodeLevel } from "@liaison/shared"
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type NodeLevelConfirmationPurpose, nodeLevelConfirmations } from "~/db/schema/kernel"
import type { NodeRow } from "~/modules/nodes/credentials"

export type LevelConfirmationRow = typeof nodeLevelConfirmations.$inferSelect

/** How long an unattached confirmation can be attached or consumed. */
export const CONFIRMATION_TTL_SECONDS = 5 * 60

export type ConfirmationRefusal =
  | "confirmation_not_found"
  | "confirmation_consumed"
  | "confirmation_expired"
  | "confirmation_mismatch"

/**
 * Purposes whose attached rows never expire by age (D41). An attached
 * `session_raise` waits for its session's next run too (P3, G10: a raise on a
 * dormant session is admitted at the next claim).
 */
const ATTACHED_DO_NOT_EXPIRE = new Set<NodeLevelConfirmationPurpose>([
  "profile_raise",
  "session_start",
  "session_raise",
])

function expired(row: LevelConfirmationRow, now = Date.now()): boolean {
  if (row.attachedAt && ATTACHED_DO_NOT_EXPIRE.has(row.purpose)) return false
  return row.expiresAt.getTime() <= now
}

// ── mint ────────────────────────────────────────────────────────────────────

export interface NewLevelConfirmation {
  orgId: string
  ownerUserId: string
  nodeId: string
  agentId?: string | null
  sessionId?: string | null
  level: NodeLevel
  purpose: NodeLevelConfirmationPurpose
}

/**
 * The only insert of a confirmation. Called by the owner's confirm route
 * after it checked the session, the node and the agent or session.
 */
export async function insertLevelConfirmation(
  input: NewLevelConfirmation,
): Promise<LevelConfirmationRow> {
  const [row] = await withPrivilegedDb(input.orgId, "node-sessions:confirm-insert", (tx) =>
    tx
      .insert(nodeLevelConfirmations)
      .values({
        orgId: input.orgId,
        ownerUserId: input.ownerUserId,
        nodeId: input.nodeId,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        level: input.level,
        purpose: input.purpose,
        expiresAt: sql`now() + make_interval(secs => ${CONFIRMATION_TTL_SECONDS})`,
      })
      .returning(),
  )
  return row
}

// ── attach (the owner's save or start, in its own transaction) ─────────────

export interface AttachInput {
  id: string
  orgId: string
  ownerUserId: string
  nodeId: string
  level: NodeLevel
  purpose: NodeLevelConfirmationPurpose
  agentId?: string | null
  sessionId?: string | null
  /** `session_start` only, required there: the session this start admits. */
  attachedSessionId?: string | null
}

export type AttachOutcome =
  | { ok: true; row: LevelConfirmationRow }
  | { ok: false; code: ConfirmationRefusal }

/**
 * Attach a confirmation to the save or start it was minted for. The row must
 * be the owner's, for this node, purpose, agent or session, at exactly this
 * level, not consumed and not expired. Attaching a `profile_raise` supersedes
 * the older unconsumed `profile_raise` rows of the same (node, agent).
 */
export async function attachConfirmation(
  tx: PrivilegedDb,
  input: AttachInput,
): Promise<AttachOutcome> {
  const [row] = await tx
    .select()
    .from(nodeLevelConfirmations)
    .where(
      and(
        eq(nodeLevelConfirmations.id, input.id),
        eq(nodeLevelConfirmations.orgId, input.orgId),
        eq(nodeLevelConfirmations.ownerUserId, input.ownerUserId),
      ),
    )
    .for("update")
  if (!row) return { ok: false, code: "confirmation_not_found" }
  if (row.consumedAt) return { ok: false, code: "confirmation_consumed" }
  if (expired(row)) return { ok: false, code: "confirmation_expired" }
  const bound =
    row.nodeId === input.nodeId &&
    row.purpose === input.purpose &&
    row.level === input.level &&
    (row.purpose === "session_raise"
      ? !!input.sessionId && row.sessionId === input.sessionId
      : !!input.agentId && row.agentId === input.agentId) &&
    (row.purpose !== "session_start" || !!input.attachedSessionId) &&
    // Attached once: a second attach elsewhere is not the same gesture.
    (row.attachedAt === null ||
      (row.purpose === "session_start" && row.attachedSessionId === input.attachedSessionId))
  if (!bound) return { ok: false, code: "confirmation_mismatch" }

  const now = new Date()
  const [attached] = await tx
    .update(nodeLevelConfirmations)
    .set({
      attachedAt: row.attachedAt ?? now,
      ...(row.purpose === "session_start"
        ? { attachedSessionId: input.attachedSessionId ?? null }
        : {}),
    })
    .where(eq(nodeLevelConfirmations.id, row.id))
    .returning()

  if (row.purpose === "profile_raise" && row.agentId) {
    await tx
      .update(nodeLevelConfirmations)
      .set({ consumedAt: now })
      .where(
        and(
          eq(nodeLevelConfirmations.orgId, input.orgId),
          eq(nodeLevelConfirmations.ownerUserId, input.ownerUserId),
          eq(nodeLevelConfirmations.nodeId, row.nodeId),
          eq(nodeLevelConfirmations.agentId, row.agentId),
          eq(nodeLevelConfirmations.purpose, "profile_raise"),
          isNull(nodeLevelConfirmations.consumedAt),
          ne(nodeLevelConfirmations.id, row.id),
          lte(nodeLevelConfirmations.createdAt, row.createdAt),
        ),
      )
  }
  return { ok: true, row: attached }
}

/**
 * A profile was lowered: its unconsumed `profile_raise` rows above the new
 * level are void (marked consumed), on every node.
 */
export async function voidProfileConfirmationsAbove(
  tx: PrivilegedDb,
  input: { orgId: string; ownerUserId: string; agentId: string; level: NodeLevel },
): Promise<number> {
  const above: NodeLevel[] =
    input.level === "strict" ? ["standard", "open"] : input.level === "standard" ? ["open"] : []
  if (above.length === 0) return 0
  const rows = await tx
    .update(nodeLevelConfirmations)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(nodeLevelConfirmations.orgId, input.orgId),
        eq(nodeLevelConfirmations.ownerUserId, input.ownerUserId),
        eq(nodeLevelConfirmations.agentId, input.agentId),
        eq(nodeLevelConfirmations.purpose, "profile_raise"),
        isNull(nodeLevelConfirmations.consumedAt),
        inArray(nodeLevelConfirmations.level, above),
      ),
    )
    .returning({ id: nodeLevelConfirmations.id })
  return rows.length
}

// ── claim (P1-T17) ──────────────────────────────────────────────────────────

/**
 * The confirmations a claim hands the node (D41): the newest attached,
 * unconsumed `profile_raise` for (this node, this agent) at the profile
 * level, and the unconsumed `session_start` attached to THIS session at the
 * session level. The node consumes only what its pin needs.
 */
export async function claimConfirmations(
  tx: PrivilegedDb,
  input: {
    orgId: string
    ownerUserId: string
    nodeId: string
    agentId: string
    sessionId: string
    profileLevel: NodeLevel
    sessionLevel: NodeLevel
  },
): Promise<{ profileConfirmationId?: string; sessionConfirmationId?: string }> {
  const open = and(
    eq(nodeLevelConfirmations.orgId, input.orgId),
    eq(nodeLevelConfirmations.ownerUserId, input.ownerUserId),
    eq(nodeLevelConfirmations.nodeId, input.nodeId),
    isNull(nodeLevelConfirmations.consumedAt),
    isNotNull(nodeLevelConfirmations.attachedAt),
  )
  const [profile] = await tx
    .select({ id: nodeLevelConfirmations.id })
    .from(nodeLevelConfirmations)
    .where(
      and(
        open,
        eq(nodeLevelConfirmations.purpose, "profile_raise"),
        eq(nodeLevelConfirmations.agentId, input.agentId),
        eq(nodeLevelConfirmations.level, input.profileLevel),
      ),
    )
    .orderBy(desc(nodeLevelConfirmations.attachedAt), desc(nodeLevelConfirmations.createdAt))
    .limit(1)
  // This session's own: its start's `session_start`, or (P3, G10) the
  // `session_raise` attached to it while it had no process.
  const [session] = await tx
    .select({ id: nodeLevelConfirmations.id })
    .from(nodeLevelConfirmations)
    .where(
      and(
        open,
        eq(nodeLevelConfirmations.level, input.sessionLevel),
        or(
          and(
            eq(nodeLevelConfirmations.purpose, "session_start"),
            eq(nodeLevelConfirmations.agentId, input.agentId),
            eq(nodeLevelConfirmations.attachedSessionId, input.sessionId),
          ),
          and(
            eq(nodeLevelConfirmations.purpose, "session_raise"),
            eq(nodeLevelConfirmations.sessionId, input.sessionId),
          ),
        ),
      ),
    )
    .orderBy(desc(nodeLevelConfirmations.attachedAt))
    .limit(1)
  return {
    ...(profile ? { profileConfirmationId: profile.id } : {}),
    ...(session ? { sessionConfirmationId: session.id } : {}),
  }
}

// ── consume (the node) ──────────────────────────────────────────────────────

export type ConsumeTarget =
  | { agentId: string; level: NodeLevel }
  | { sessionId: string; level: NodeLevel }

export type ConsumeOutcome =
  | { kind: "consumed"; purpose: NodeLevelConfirmationPurpose; level: NodeLevel }
  | { kind: "not_found" }
  | { kind: "not_your_node" }
  | { kind: "refused"; code: Exclude<ConfirmationRefusal, "confirmation_not_found"> }

/**
 * The node uses up one confirmation. The row must be this node's (403
 * otherwise), not consumed, not expired, and bound to what the node admits:
 * the agent for `profile_raise` (attached only), the attached session for `session_start`,
 * the session for `session_raise`, at exactly that level.
 */
export async function consumeConfirmation(
  node: NodeRow,
  id: string,
  target: ConsumeTarget,
): Promise<ConsumeOutcome> {
  return withPrivilegedDb(node.orgId, "node-sessions:confirm-consume", async (tx) => {
    const [row] = await tx
      .select()
      .from(nodeLevelConfirmations)
      .where(and(eq(nodeLevelConfirmations.id, id), eq(nodeLevelConfirmations.orgId, node.orgId)))
      .for("update")
    if (!row) return { kind: "not_found" } as const
    if (row.nodeId !== node.id || row.ownerUserId !== node.ownerUserId) {
      return { kind: "not_your_node" } as const
    }
    if (row.consumedAt) return { kind: "refused", code: "confirmation_consumed" } as const
    if (expired(row)) return { kind: "refused", code: "confirmation_expired" } as const
    const bound =
      row.level === target.level &&
      (row.purpose === "profile_raise"
        ? // Only once attached (D41): an unattached raise belongs to a
          // profile save that never went through.
          row.attachedAt !== null && "agentId" in target && row.agentId === target.agentId
        : row.purpose === "session_start"
          ? "sessionId" in target && row.attachedSessionId === target.sessionId
          : "sessionId" in target && row.sessionId === target.sessionId)
    if (!bound) return { kind: "refused", code: "confirmation_mismatch" } as const
    const [used] = await tx
      .update(nodeLevelConfirmations)
      .set({ consumedAt: new Date() })
      .where(and(eq(nodeLevelConfirmations.id, row.id), isNull(nodeLevelConfirmations.consumedAt)))
      .returning({ id: nodeLevelConfirmations.id })
    if (!used) return { kind: "refused", code: "confirmation_consumed" } as const
    return { kind: "consumed", purpose: row.purpose, level: row.level } as const
  })
}

/**
 * P1-walk D7: the profile raises an owner confirmed in the app and attached to
 * a save, that a node has not consumed yet (it does at its next claim): node
 * -> agent -> the highest such level. The editor shows them as confirmed.
 */
export async function attachedProfileRaises(
  orgId: string,
  ownerUserId: string,
): Promise<Map<string, Map<string, NodeLevel>>> {
  const rows = await withPrivilegedDb(orgId, "node-confirmations:attached-raises", (tx) =>
    tx
      .select({
        nodeId: nodeLevelConfirmations.nodeId,
        agentId: nodeLevelConfirmations.agentId,
        level: nodeLevelConfirmations.level,
      })
      .from(nodeLevelConfirmations)
      .where(
        and(
          eq(nodeLevelConfirmations.orgId, orgId),
          eq(nodeLevelConfirmations.ownerUserId, ownerUserId),
          eq(nodeLevelConfirmations.purpose, "profile_raise"),
          isNull(nodeLevelConfirmations.consumedAt),
          isNotNull(nodeLevelConfirmations.attachedAt),
          gt(nodeLevelConfirmations.expiresAt, sql`now()`),
        ),
      ),
  )
  const out = new Map<string, Map<string, NodeLevel>>()
  for (const r of rows) {
    if (!r.agentId || !isNodeLevel(r.level)) continue
    const perNode = out.get(r.nodeId) ?? new Map<string, NodeLevel>()
    const known = perNode.get(r.agentId)
    if (!known || levelRank(r.level) > levelRank(known)) perNode.set(r.agentId, r.level)
    out.set(r.nodeId, perNode)
  }
  return out
}
