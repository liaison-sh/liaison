// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The typed host ctx a core app's handler receives (registry.ts). It is the
// run's bridge, called directly: the same host methods a sandboxed run reaches
// through its bridge, built for the same actor, scopes and transaction, so a
// core handler and the bridge route share one implementation. Each app types
// the methods it uses (`CoreCtx<TicketsMethods>`).

/** The approval a post-approval re-entry runs under; null on a first entry. */
export type CoreApproval = unknown

export type CoreCtx<Methods> = Methods & {
  /** The approval this run re-enters after (the sandbox's `ctx.approval`); null otherwise. */
  readonly approval: CoreApproval | null
  /**
   * Runs `fn` on one database transaction: every ctx call inside it commits or
   * rolls back together, and a throw inside rolls all of them back. A run that
   * already holds a transaction (an approved re-entry, a job, an event) runs
   * `fn` on it.
   */
  transaction<T>(fn: (ctx: CoreCtx<Methods>) => Promise<T>): Promise<T>
}

/** A core handler: `(params, ctx)`, plus a webhook's headers or raw body after them. */
export type CoreHandler<Methods> = (
  params: unknown,
  ctx: CoreCtx<Methods>,
  ...extra: unknown[]
) => Promise<unknown>

/**
 * Where a run's bridge opens a transaction for `ctx.transaction`: set by the
 * site that built a bridge with no transaction of its own (execute-tool.ts,
 * a session bridge). Takes a callback that gets a bridge bound to that
 * transaction.
 */
export const CORE_OPEN_TRANSACTION: unique symbol = Symbol.for("liaison.core.openTransaction")

export type OpenTransaction = <T>(
  fn: (txBridge: Record<string, (...args: any[]) => any>) => Promise<T>,
) => Promise<T>
