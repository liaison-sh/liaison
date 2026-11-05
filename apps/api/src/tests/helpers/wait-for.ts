// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Poll `predicate` until it holds, with a deadline. For waiting on work that
 * has no completion signal of its own (a fire-and-forget handler, a child
 * process): fast when the condition is reached quickly, and a clear failure
 * instead of a fixed sleep when it never is.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000)
  const interval = opts.intervalMs ?? 10
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: timed out${opts.label ? ` waiting for ${opts.label}` : ""}`)
    }
    await Bun.sleep(interval)
  }
}
