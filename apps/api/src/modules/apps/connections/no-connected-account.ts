// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * The org (or user) has no active connected account for an app's connection:
 * nobody connected it, or it was disconnected. Not a fault to retry, and not a
 * server error: a background job that needs the account has nothing to do
 * until someone connects one (the job runner skips such a run quietly).
 *
 * The message is load-bearing and stays exactly as it was: a sandboxed
 * handler's bridge call carries only its message back across the sandbox, and
 * callers recognise this case from it (`isNoConnectedAccountError`).
 */
export class NoConnectedAccountError extends Error {
  readonly retryable = false
  constructor(readonly connectionName: string) {
    super(`No connected account for connection "${connectionName}"`)
    this.name = "NoConnectedAccountError"
  }
}

const NO_CONNECTED_ACCOUNT_MESSAGE = /No connected account for connection "/

/** True for a `NoConnectedAccountError`, including one whose message crossed the sandbox. */
export function isNoConnectedAccountError(err: unknown): boolean {
  if (err instanceof NoConnectedAccountError) return true
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : ""
  return NO_CONNECTED_ACCOUNT_MESSAGE.test(message)
}
