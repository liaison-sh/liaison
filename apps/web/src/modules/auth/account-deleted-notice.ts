// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Your account was deleted", said once, on the sign-in screen the app lands on
// after "Delete my account". The deletion signs out (in the mobile shell the
// page starts again), so the sign-in screen cannot be told directly: the
// dialog leaves this mark in sessionStorage and the sign-in takes it.
//
// Not under the "liaison:" prefix: the browser sign out clears every key under
// it (lib/storage.ts), and this one has to outlive that sign out.

const KEY = "liaison.accountDeleted"

export function markAccountDeleted(): void {
  try {
    sessionStorage.setItem(KEY, "1")
  } catch {
    // A storage that refuses only costs the sentence.
  }
}

/** Whether an account deletion just ended the session; forgets it as it answers. */
export function takeAccountDeletedNotice(): boolean {
  try {
    const marked = sessionStorage.getItem(KEY) === "1"
    sessionStorage.removeItem(KEY)
    return marked
  } catch {
    return false
  }
}
