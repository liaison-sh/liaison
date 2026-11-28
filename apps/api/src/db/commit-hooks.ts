// SPDX-License-Identifier: FSL-1.1-ALv2
import { AsyncLocalStorage } from "node:async_hooks"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "db/commit-hooks" })

/**
 * Work to run once the transaction a caller is inside has ended.
 *
 * The transaction wrappers (withRlsContext, withPrivilegedDb and the privileged
 * pool runner) open a scope around their callback and run its hooks when the
 * transaction promise settles, that is after COMMIT (or ROLLBACK). Savepoints
 * share their outer transaction's scope, since they commit with it; a nested
 * real transaction (another pool connection) opens its own.
 *
 * The hooks are for process-local side effects that must not be observed
 * before the change is visible to other connections, such as dropping a cache
 * entry: dropped too early, a concurrent reader can refill it with the value
 * the commit is about to replace.
 */
export interface CommitScope {
  /** Run when the transaction ends, committed or rolled back. */
  hooks: Array<() => void>
  /** Run only when the transaction committed (dropped on rollback). */
  commitHooks: Array<() => void>
  settled: boolean
}

const scopes = new AsyncLocalStorage<CommitScope>()

export function openCommitScope(): CommitScope {
  return { hooks: [], commitHooks: [], settled: false }
}

/** Run `fn` (a transaction callback body) inside `scope`. */
export function withinCommitScope<T>(scope: CommitScope, fn: () => Promise<T>): Promise<T> {
  return scopes.run(scope, fn)
}

/**
 * Run the scope's hooks once `txPromise` (the whole transaction) settles. The
 * `hooks` run on commit and rollback alike: they are idempotent drops, harmless
 * when the change rolled back. The `commitHooks` run on commit only, and are
 * dropped on rollback. Attached by the wrapper before it hands the promise to
 * its caller, so they run before the caller's code after the await.
 */
export function runCommitHooksAfter(txPromise: Promise<unknown>, scope: CommitScope): void {
  const run = (committed: boolean) => {
    scope.settled = true
    const commitHooks = scope.commitHooks.splice(0)
    const hooks = [...scope.hooks.splice(0), ...(committed ? commitHooks : [])]
    for (const hook of hooks) {
      try {
        hook()
      } catch (err) {
        log.error({ err }, "after-commit hook failed")
      }
    }
  }
  txPromise.then(
    () => run(true),
    () => run(false),
  )
}

/**
 * Queue `hook` to run when the current transaction ends. Answers false when
 * the caller is not inside an open transaction scope (or that transaction has
 * already ended), in which case nothing is queued.
 */
export function afterCurrentCommit(hook: () => void): boolean {
  const scope = scopes.getStore()
  if (!scope || scope.settled) return false
  scope.hooks.push(hook)
  return true
}

/**
 * Queue `hook` to run once the current transaction has COMMITTED; it is dropped
 * if the transaction rolls back. For side effects another process acts on, such
 * as a queued job whose worker reads the rows this transaction writes: added
 * before COMMIT, the worker can run first and find nothing. Answers false when
 * the caller is not inside an open transaction scope, in which case nothing is
 * queued and the caller runs the work itself.
 *
 * A savepoint shares its outer transaction's scope, so work queued inside a
 * savepoint that later rolls back still runs when the outer transaction commits.
 */
export function afterCurrentCommitSucceeds(hook: () => void): boolean {
  const scope = scopes.getStore()
  if (!scope || scope.settled) return false
  scope.commitHooks.push(hook)
  return true
}
