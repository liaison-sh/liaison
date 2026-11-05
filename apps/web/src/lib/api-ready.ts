// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "THE LIVE API CLIENT IS REGISTERED" (final walk F3). Boot hydration, a
// sign-in and the shell mounting each register the kernel API client
// (attention-store's `setAttentionApi`). A store whose first read needs that
// client and was asked before it existed loads here instead of never. Its own
// module, so a test that mocks the attention store keeps working.

const listeners = new Set<() => void>()

/** Run `fn` each time a live client is registered. Same function once; returns a disposer. */
export function onApiReady(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Called by whoever registers the client. Failures are isolated. */
export function announceApiReady(): void {
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch (err) {
      console.warn("[api-ready] listener error:", err)
    }
  }
}
