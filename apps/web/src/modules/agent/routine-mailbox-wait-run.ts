// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Starting a run that waits for its owner's private mailbox, from this window:
// what one row's Run now and the group's Run all both do, run by run. Each run
// gets its own turn scope, opened in THIS browser (the same nonce a typed turn
// gets), and the server's handoff is answered right away, inside the same bounds
// as any turn's read. Nothing here decrypts anything itself.

import type { RoutineMailboxWait } from "~/modules/agent/routine-mailbox-wait-item"
import { startMailboxCryptoWorker } from "~/modules/mailbox/crypto-worker-boot"
import {
  answerMailboxHandoff,
  beginMailboxAgentTurn,
  endMailboxAgentTurn,
  type MailboxHandoffRequest,
} from "~/modules/mailbox/mailbox-agent-runtime"
import {
  loadMailboxKeyring,
  type MailboxStatus,
  mailboxStore,
} from "~/modules/mailbox/mailbox-store"
import type { ApiClient } from "~/modules/shell/ApiContext"

/** How long this window keeps the run's turn scope open: past the routine lock. */
export const MAILBOX_WAIT_TURN_OPEN_MS = 12 * 60 * 1000

/** How long the toast saying it runs stays: a few seconds. */
export const MAILBOX_WAIT_TOAST_MS = 6_000

const mailboxWaitPath = (wait: RoutineMailboxWait, verb: "run" | "dismiss") =>
  `/agent/routines/${encodeURIComponent(wait.routineId)}/mailbox-waits/${encodeURIComponent(wait.runId)}/${verb}`

export const mailboxWaitRunPath = (wait: RoutineMailboxWait) => mailboxWaitPath(wait, "run")
export const mailboxWaitDismissPath = (wait: RoutineMailboxWait) => mailboxWaitPath(wait, "dismiss")

/** What Run now answers (routines-routes.ts). */
export interface MailboxWaitRunResponse {
  started?: boolean
  runId?: string
  queued?: boolean
  handoff?: MailboxHandoffRequest | null
}

/**
 * The lock state once it is KNOWN. "unknown" is not locked: a mailbox this
 * device unlocked earlier in the login re-opens from its persisted handles at
 * startup, and that may still be under way. Run the same boot-and-restore
 * (both are shared, so an in-flight one is waited for, not repeated).
 */
export async function knownMailboxStatus(api: ApiClient): Promise<MailboxStatus> {
  if (mailboxStore.status !== "unknown") return mailboxStore.status
  try {
    if (await startMailboxCryptoWorker()) await loadMailboxKeyring(api)
  } catch {
    // Still unknown: the caller says so, never shown as locked.
  }
  return mailboxStore.status
}

/**
 * Start one waiting run. Null when this window has no mailbox session yet;
 * throws what the server refused with (the scope is closed again). On success
 * the scope closes after the run can have ended, for any read it asks this
 * window while it stays open.
 */
export async function startMailboxWaitRun(
  api: ApiClient,
  wait: RoutineMailboxWait,
): Promise<{ queued: boolean; handedOff: boolean } | null> {
  const nonce = beginMailboxAgentTurn()
  if (!nonce) return null
  try {
    const response = await api.post<MailboxWaitRunResponse | undefined>(mailboxWaitRunPath(wait), {
      turnNonce: nonce,
    })
    // The email that started the run, opened here in this click: the run then
    // needs no browser for it.
    const handoff = response?.handoff ?? null
    const answered = handoff ? await answerMailboxHandoff(nonce, handoff).catch(() => null) : null
    setTimeout(() => endMailboxAgentTurn(nonce), MAILBOX_WAIT_TURN_OPEN_MS)
    return { queued: response?.queued === true, handedOff: answered?.accepted === true }
  } catch (error) {
    endMailboxAgentTurn(nonce)
    throw error
  }
}
