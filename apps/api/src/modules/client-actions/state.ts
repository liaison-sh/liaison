// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A client action's state, derived from its row and the database's clock, never
// stored: the one function every reader of kernel.client_actions uses.

export type ClientActionDecision = "signed" | "accepted" | "approved" | "declined"

export type ClientActionState =
  | "revoked"
  | ClientActionDecision
  | "expired"
  | "locked"
  | "waiting_turn"
  | "open"

/** The columns the state reads. A member's read has every one (no token hash needed). */
export interface ClientActionStateRow {
  revokedAt: Date | null
  decidedAt: Date | null
  decision: ClientActionDecision | null
  expiresAt: Date
  codeLockedAt: Date | null
  /** Whether the row has a live token: false while the person waits for their turn. */
  hasToken: boolean
}

/**
 * In order: revoked; else the decision; else expired once `expiresAt` is at or
 * before `now`; else locked; else waiting for its turn while it has no token;
 * else open. `now` is the database's `now()` where a request decides on it.
 */
export function clientActionState(row: ClientActionStateRow, now: Date): ClientActionState {
  if (row.revokedAt) return "revoked"
  if (row.decidedAt) {
    if (!row.decision) throw new Error("a decided client action has no decision")
    return row.decision
  }
  if (row.expiresAt.getTime() <= now.getTime()) return "expired"
  if (row.codeLockedAt) return "locked"
  if (!row.hasToken) return "waiting_turn"
  return "open"
}
