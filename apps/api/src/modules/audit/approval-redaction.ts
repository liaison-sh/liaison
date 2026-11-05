// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Approval events carry the whole approval card: the drafted reply, the refund
 * or order parameters, the human summary, the requester's edit diff. Who may
 * see that is decided by the approval authority rules (audience + deciding
 * scope, and owner-routed approvals are private even to a wildcard admin); the
 * audit log is org-wide readable and must not become a second, wider door.
 *
 * The audit trail of an approval needs identity and lifecycle only: which tool,
 * which state, who decided and when, and the payload hash that proves WHAT was
 * decided without containing it. Everything else is dropped, both when the row
 * is written and, for rows written before this existed, when it is read.
 */
const APPROVAL_AUDIT_ENTITY = "approval_request"

const APPROVAL_AUDIT_KEYS = [
  "id",
  "handle",
  "status",
  "createdAt",
  "expiresAt",
  "toolName",
  "approveScope",
  "payloadHash",
  "threadId",
  "originatingThreadId",
  "requestedBy",
  "decidedBy",
  "decidedAt",
  "bundleId",
  "bundlePosition",
  "dependsOnId",
  "resourceOwnerId",
] as const

/** True when audit rows of this entity must be reduced to the lifecycle fields. */
export function isApprovalAuditEntity(entity: string | null | undefined): boolean {
  return entity === APPROVAL_AUDIT_ENTITY
}

/**
 * Reduce an approval event's data to the lifecycle allowlist. `requestedBy` is
 * `{ id }` on the card; only that id survives. Anything that is not a plain
 * object collapses to null rather than passing through unfiltered.
 */
export function redactApprovalAuditChanges(changes: unknown): Record<string, unknown> | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null
  const source = changes as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  for (const key of APPROVAL_AUDIT_KEYS) {
    if (!(key in source)) continue
    const value = source[key]
    if (key === "requestedBy" && value && typeof value === "object") {
      const id = (value as Record<string, unknown>).id
      if (typeof id === "string") kept.requestedBy = { id }
      continue
    }
    if (value === null || typeof value !== "object") kept[key] = value
  }
  return kept
}

/**
 * `user:updated` ships the whole profile row for the live client. The audit
 * record needs what changed about the person, not their private settings blob
 * or the avatar capability token (whoever holds `avatarKey` can fetch the
 * picture without a session).
 */
const USER_AUDIT_DROPPED_KEYS = ["settings", "avatarKey", "totpLastUsedAt"] as const

export function redactUserAuditChanges(changes: unknown): unknown {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return changes
  const copy = { ...(changes as Record<string, unknown>) }
  for (const key of USER_AUDIT_DROPPED_KEYS) delete copy[key]
  return copy
}
