// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ephemeral, non-persistable mailbox context of one turn (blueprint Task
// 9.2, spec section 5.3b "Injection and lifetime").
//
// Decrypted mail reaches the model as a context block appended to the in-memory
// message list for the remainder of the turn, and as nothing else. It is NOT a
// tool result, which is the whole point: `extractToolCalls` writes tool results
// into `kernel.messages.metadata` through a privileged update, and the stream
// loop broadcasts them. A context block goes into the provider request and
// nowhere else, so there is no persist site to redact and no broadcast to strip.
//
// Keyed by runId, dropped when the turn ends. A process holding a block for a
// turn that died is a leak of exactly the thing this feature exists to protect,
// so the sweep is unconditional rather than best effort.

const blocks = new Map<string, { parts: string[]; createdAt: number }>()

/** Comfortably past the longest turn, so an unclosed turn cannot pin plaintext. */
const STALE_AFTER_MS = 660_000

function sweepStale(now: number): void {
  for (const [runId, entry] of blocks) {
    if (now - entry.createdAt > STALE_AFTER_MS) blocks.delete(runId)
  }
}

export function addEphemeralMailboxContext(runId: string, block: string): void {
  const now = Date.now()
  sweepStale(now)
  const entry = blocks.get(runId)
  if (entry) entry.parts.push(block)
  else blocks.set(runId, { parts: [block], createdAt: now })
}

/** Every block this turn has been given so far, oldest first. */
export function getEphemeralMailboxContext(runId: string): string[] {
  return blocks.get(runId)?.parts ?? []
}

/** Drop this turn's plaintext. Called on every terminal path of the turn. */
export function clearEphemeralMailboxContext(runId: string): void {
  blocks.delete(runId)
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const MailboxPlaintextContextTestAccess = {
  /** Drop every run's ephemeral plaintext block. */
  reset(): void {
    blocks.clear()
  },
}
