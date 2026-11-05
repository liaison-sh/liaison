// SPDX-License-Identifier: FSL-1.1-ALv2
//
// May this routine tick read its owner's server-managed mailbox?
//
// A routine runs as its owner, but its owner is not always who wrote it: a
// holder of `kernel:routines:delegate` can create a routine that runs as
// someone else, an apps admin or a delegate can rewrite a teammate's SHARED
// routine, and a member with run rights can run a shared routine now. Any of
// those would otherwise make the owner's mailbox read for a prompt someone else
// wrote, with nobody's browser in the loop. "Only you and your agent can read
// it" holds only if the routine is the owner's own work, so a tick reads the
// mailbox server-side only when:
//
//   * the routine's creator is its owner,
//   * its last editor (`routines.edited_by_user_id`, 0230; the creator when it
//     was never edited) is its owner, and an edit by an unknown path counts as
//     someone else's, and
//   * the tick is a schedule or event tick, or a run-now the owner asked for.
//
// Anything else reads as MAILBOX_LOCKED, as a private mailbox does.

export interface RoutineMailboxTrustRow {
  ownerUserId: string
  createdByUserId: string | null
  editedByUserId?: string | null
  editedAt?: Date | string | null
}

/**
 * The person whose server-managed mailbox this tick may read, or undefined.
 * `requestedByUserId` is set only on a run-now tick.
 */
export function routineMailboxReader(
  routine: RoutineMailboxTrustRow,
  requestedByUserId?: string | null,
): string | undefined {
  const owner = routine.ownerUserId
  if (!owner || routine.createdByUserId !== owner) return undefined
  const lastEditor =
    routine.editedAt == null ? routine.createdByUserId : (routine.editedByUserId ?? null)
  if (lastEditor !== owner) return undefined
  if (requestedByUserId != null && requestedByUserId !== owner) return undefined
  return owner
}
