// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Waiting on one Meili task, with a budget sized for a large index. Its own
// module so every search writer can import it without an import cycle through
// the indexers (indexer.ts re-exports it for existing callers).

/** How long an index write waits for its Meili task (see waitForMeiliTask). */
export const MEILI_TASK_WAIT_MS = 10 * 60_000
const MEILI_TASK_POLL_MS = 250

export async function waitForMeiliTask(
  meili: unknown,
  taskUid: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  if (typeof taskUid !== "number") return
  const timeout = opts.timeoutMs ?? MEILI_TASK_WAIT_MS
  // meilisearch v0.50+ moved waitForTask onto the `tasks` sub-client; the
  // top-level MeiliSearch instance no longer exposes it directly. Without this
  // wait, addDocuments returns as soon as the task is enqueued, so callers
  // (and tests that poll `search()` right after) race against Meili's
  // background processing. Under e2e-parallel load that race fails ~30% of
  // runs in search-permissions.
  //
  // The client's default wait is 5 s. On a large index one task routinely takes
  // tens of seconds (measured on production at 680k documents: about 50 s for a
  // two-document batch), so the default turned every slow task into a thrown
  // timeout: a live job retried a write that had not failed, and the full
  // reindex CLI died on its first batch. A task Meili FAILED throws instead, so
  // the job retries rather than reporting a write that never happened.
  type WaitOptions = { timeout: number; interval: number }
  type TaskOutcome = { status?: string; error?: { message?: string } | null } | undefined
  const tasks = (
    meili as {
      tasks?: { waitForTask?: (uid: number, opts?: WaitOptions) => Promise<TaskOutcome> }
    }
  ).tasks
  if (tasks && typeof tasks.waitForTask === "function") {
    const done = await tasks.waitForTask(taskUid, { timeout, interval: MEILI_TASK_POLL_MS })
    if (done?.status === "failed") {
      throw new Error(`search task ${taskUid} failed: ${done.error?.message ?? "no detail"}`)
    }
    return
  }
  // Older client surface (kept as a fallback) — should never fire today.
  const direct = (meili as { waitForTask?: (uid: number, opts?: WaitOptions) => Promise<unknown> })
    .waitForTask
  if (typeof direct === "function") await direct(taskUid, { timeout, interval: MEILI_TASK_POLL_MS })
}
