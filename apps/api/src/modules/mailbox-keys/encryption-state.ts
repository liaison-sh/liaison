// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `app_mail.accounts.encryption_state`: the mailbox encryption state machine.
//
// What it drives: sync suspension (a personal account that is not `ready`
// fetches no mail), the enrollment banner, and the UI.
//
// What it does NOT drive: Invariant P. The database trigger arms on the
// existence of an active `kernel.user_mailbox_identities` row for the account's
// owner, or on the owner having ever enrolled (so a reset mailbox stays armed
// while it has no keys), never on this column, precisely so that `ready -> blocked` (a legal
// transition on any seal failure) cannot disarm the database guarantee with one
// row update. `blocked` and `paused` accounts stay armed. That is the point:
// "something went wrong" is never a licence to write plaintext.
//
// There is deliberately no path back to `none`. `none` means "this mailbox
// predates the feature"; once a mailbox has entered the regime it never leaves
// it, and a transition table that could return to `none` would hand an operator
// a one-row way out.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { quoteIdent } from "~/lib/sql-utils"
import { validateIdentifier } from "~/modules/apps/ddl"

export const ENCRYPTION_STATES = [
  "none",
  "pending_enrollment",
  "ready",
  "blocked",
  "paused",
  // Server-managed encryption: sealed at rest under a per-mailbox data key the
  // server holds (`modules/mailbox-crypto/managed-keys.ts`), so the owner and
  // the owner's agent read it with no browser present. Syncs like `ready`.
  "managed",
] as const

export type EncryptionState = (typeof ENCRYPTION_STATES)[number]

/**
 * What happened, not what to set. Callers name the event; this module owns the
 * resulting state, so no caller can invent a transition by writing the column.
 */
export type EncryptionStateTrigger =
  /** The deploy that introduced the feature reached an existing personal account. */
  | "deploy"
  /** The owner completed enrollment and holds a usable active identity. */
  | "enrolled"
  /** The enrollment grace window elapsed with no enrollment. */
  | "grace_elapsed"
  /** A seal failed, or the owner has no active identity to seal to. */
  | "seal_failed"
  /** Key rotation produced a usable identity for a previously blocked account. */
  | "rotated"
  /**
   * The owner reset their mailbox (forgotten mailbox password): the keyring is
   * gone, so the mailbox is back to waiting for enrollment. It stays in the
   * regime (see `mailbox_invariant_armed`: an owner who ever enrolled stays
   * armed), it only stops fetching until new keys exist.
   */
  | "reset"
  /** The mailbox was put under server-managed encryption (the default mode). */
  | "managed_default"
  /** The owner chose a private (zero-access) mailbox and it was re-sealed. */
  | "made_private"
  /** The owner made a private mailbox transparent and it was re-sealed. */
  | "made_managed"

export interface EncryptionStateTransition {
  from: EncryptionState
  to: EncryptionState
  trigger: EncryptionStateTrigger
}

/**
 * Spec section 4.3, plus the three `reset` edges of the mailbox reset and the
 * five server-managed edges. Nothing else is legal. `reset` leads back to
 * `pending_enrollment`, never to `none`: a reset mailbox is still in the regime.
 */
export const ENCRYPTION_STATE_TRANSITIONS: readonly EncryptionStateTransition[] = [
  { from: "none", to: "pending_enrollment", trigger: "deploy" },
  { from: "pending_enrollment", to: "ready", trigger: "enrolled" },
  { from: "pending_enrollment", to: "paused", trigger: "grace_elapsed" },
  { from: "ready", to: "blocked", trigger: "seal_failed" },
  { from: "blocked", to: "ready", trigger: "rotated" },
  { from: "paused", to: "ready", trigger: "enrolled" },
  { from: "ready", to: "pending_enrollment", trigger: "reset" },
  { from: "blocked", to: "pending_enrollment", trigger: "reset" },
  { from: "paused", to: "pending_enrollment", trigger: "reset" },
  // Server-managed mode. Nothing in this release takes these edges on its own:
  // they exist so a mailbox put in `managed` by the next one is understood.
  { from: "none", to: "managed", trigger: "managed_default" },
  { from: "pending_enrollment", to: "managed", trigger: "managed_default" },
  { from: "paused", to: "managed", trigger: "managed_default" },
  { from: "managed", to: "ready", trigger: "made_private" },
  { from: "ready", to: "managed", trigger: "made_managed" },
]

export class EncryptionStateTransitionError extends Error {
  constructor(
    readonly from: EncryptionState,
    readonly trigger: EncryptionStateTrigger,
  ) {
    super(`Illegal encryption_state transition: "${from}" cannot handle trigger "${trigger}"`)
    this.name = "EncryptionStateTransitionError"
  }
}

/**
 * The next state, or a throw. Never returns the current state unchanged: a
 * trigger that is not legal from `from` is a bug at the call site, not a no-op
 * to swallow, because the states it guards decide whether mail is fetched.
 */
export function nextEncryptionState(
  from: EncryptionState,
  trigger: EncryptionStateTrigger,
): EncryptionState {
  const match = ENCRYPTION_STATE_TRANSITIONS.find((t) => t.from === from && t.trigger === trigger)
  if (!match) throw new EncryptionStateTransitionError(from, trigger)
  return match.to
}

/** True when `value` is one of the declared states. */
export function isEncryptionState(value: unknown): value is EncryptionState {
  return typeof value === "string" && (ENCRYPTION_STATES as readonly string[]).includes(value)
}

/** Anything that can run raw SQL: an RLS request tx, or a privileged handle. */
export interface EncryptionStateExecutor {
  execute(query: unknown): Promise<unknown>
}

/**
 * The persisted half of the state machine: move every personal mail account
 * owned by `userId` along `trigger`.
 *
 * Why this exists at all. The deploy step moves every personal account to
 * `pending_enrollment`, which suspends its sync, and enrolling mints the
 * identity that ARMS the plaintext trigger. Without something that advances the
 * column, an enrolled mailbox is armed AND permanently suspended: no mail ever
 * arrives again, whatever the user does. This is the only writer that lifts it.
 *
 * A row whose current state has no legal edge for this trigger is SKIPPED, not
 * raised on. Re-enrolling is idempotent and common (the enroll route itself
 * returns 200 for an existing identity), and `ready -> ready` is deliberately
 * not a legal pair, so feeding every row through unconditionally would turn a
 * harmless repeat into a 500. `nextEncryptionState` stays strict, which is what
 * makes the single-row call sites catch their own bugs.
 *
 * The UPDATE re-states the old value in its WHERE clause, so a row another
 * session moved in between is left alone rather than clobbered.
 *
 * Returns the ids actually moved.
 */
export async function advanceOwnerEncryptionState(
  tx: EncryptionStateExecutor,
  schemaName: string,
  userId: string,
  trigger: EncryptionStateTrigger,
): Promise<string[]> {
  return (await advanceOwnerEncryptionStateChecked(tx, schemaName, userId, trigger)).moved
}

export interface EncryptionStateAdvance {
  /** Ids actually moved. */
  moved: string[]
  /**
   * Ids that HAD a legal edge for this trigger, were not moved, and are STILL
   * sitting on the state they started from.
   *
   * This is the silent-write case, and it is why the check exists. The UPDATE
   * runs inside the caller's own RLS transaction, so a caller holding
   * `mail:accounts:read` but not `mail:accounts:write` matches no row and gets
   * no error: the write simply does not happen. For enrollment that outcome is
   * the worst one available, because the identity row ARMS the plaintext
   * trigger while the account stays suspended, so the mailbox is armed AND
   * permanently silent and the API answers 200.
   *
   * A row another session moved concurrently is NOT reported here: it is
   * re-read, and a row whose state has changed is somebody else's legitimate
   * transition, not a refused write.
   */
  refused: string[]
}

/** `advanceOwnerEncryptionState`, plus the ids whose write was refused. */
export async function advanceOwnerEncryptionStateChecked(
  tx: EncryptionStateExecutor,
  schemaName: string,
  userId: string,
  trigger: EncryptionStateTrigger,
): Promise<EncryptionStateAdvance> {
  const schema = quoteIdent(validateIdentifier(schemaName))
  const current = extractRows<{ id: string; encryption_state: string }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, encryption_state
        FROM ${drizzleSql.raw(schema)}.accounts
       WHERE owner_type = 'user' AND owner_id = ${userId}::uuid`),
  )
  const moved: string[] = []
  const refused: string[] = []
  for (const row of current) {
    if (!isEncryptionState(row.encryption_state)) continue
    let target: EncryptionState
    try {
      target = nextEncryptionState(row.encryption_state, trigger)
    } catch {
      continue
    }
    const updated = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${drizzleSql.raw(schema)}.accounts
           SET encryption_state = ${target}
         WHERE id = ${row.id}::uuid AND encryption_state = ${row.encryption_state}
        RETURNING id::text AS id`),
    )
    if (updated.length > 0) {
      moved.push(row.id)
      continue
    }
    // Nothing moved. Either RLS filtered the write, or another session already
    // moved the row. Re-read to tell them apart: only the first is a refusal.
    const after = extractRows<{ encryption_state: string }>(
      await tx.execute(drizzleSql`
        SELECT encryption_state FROM ${drizzleSql.raw(schema)}.accounts
         WHERE id = ${row.id}::uuid`),
    )[0]
    if (!after || after.encryption_state === row.encryption_state) refused.push(row.id)
  }
  return { moved, refused }
}
