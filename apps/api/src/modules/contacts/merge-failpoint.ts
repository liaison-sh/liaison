// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Fault-injection seam for the contact merge transaction.
 *
 * The atomicity claim of `mergeContactsWithMailReferences` is that a failure
 * AFTER the contact rows have been merged still rolls the mail and invoicing
 * re-points back. Proving it needs a fault at that exact point, which used to
 * be a `failAfterContactMergeForTest` parameter on the service function: a
 * test-only argument in a production signature, on the same public surface the
 * agent tools and the routes call. Any caller could pass it.
 *
 * The seam lives here instead. Nothing arms it in production (`armForTest`
 * refuses outright when NODE_ENV is production), the service function's
 * parameters describe only real merge inputs, and the hook is a single
 * module-local variable a test sets and clears around its own case.
 */

type MergeFailpoint = () => Promise<void> | void

let afterContactMerge: MergeFailpoint | null = null

/**
 * Arm the post-merge failpoint. Returns a disarm function, so a test can do
 * `const disarm = armAfterContactMergeFailpoint(...)` and release it in a
 * `finally` without a second import.
 */
export function armAfterContactMergeFailpoint(fn: MergeFailpoint): () => void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The contact merge failpoint cannot be armed in production")
  }
  afterContactMerge = fn
  return clearAfterContactMergeFailpoint
}

/** Disarm the post-merge failpoint. Idempotent. */
export function clearAfterContactMergeFailpoint(): void {
  afterContactMerge = null
}

/**
 * Run the post-merge failpoint if one is armed. A no-op on every production
 * path, where nothing ever arms it.
 */
export async function runAfterContactMergeFailpoint(): Promise<void> {
  if (afterContactMerge) await afterContactMerge()
}
