// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A one-line bus so a locked placeholder anywhere in the mail surface can ask
// for the unlock modal without importing it (and without dragging the crypto
// client into every renderer's module graph).
//
// The request says which screen the modal opens on. `view: "reset"` is for a
// surface that already knows the user needs a reset rather than an unlock (a
// mailbox whose mail stopped arriving, the security settings), which may be
// asked while the mailbox is UNLOCKED: the modal then opens straight on the
// reset confirmation, and the reset leads on into choosing a new password.

export const MAILBOX_UNLOCK_EVENT = "mailbox:unlock-requested"

export type MailboxUnlockView = "unlock" | "reset"

export interface MailboxUnlockRequest {
  /** Which screen the modal opens on. Absent means "unlock". */
  view: MailboxUnlockView
}

function normalise(detail: unknown): MailboxUnlockRequest {
  const view = (detail as { view?: unknown } | null | undefined)?.view
  return { view: view === "reset" ? "reset" : "unlock" }
}

export function requestMailboxUnlock(request?: Partial<MailboxUnlockRequest>): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(MAILBOX_UNLOCK_EVENT, { detail: normalise(request) }))
}

/** Open the modal on the reset confirmation, locked or not. */
export function requestMailboxReset(): void {
  requestMailboxUnlock({ view: "reset" })
}

export function onMailboxUnlockRequested(
  handler: (request: MailboxUnlockRequest) => void,
): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => handler(normalise((event as CustomEvent).detail))
  window.addEventListener(MAILBOX_UNLOCK_EVENT, listener)
  return () => window.removeEventListener(MAILBOX_UNLOCK_EVENT, listener)
}
