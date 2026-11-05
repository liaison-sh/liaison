// SPDX-License-Identifier: FSL-1.1-ALv2
export type AuthRefreshFailureKind = "invalid_credentials" | "transient"

export class AuthRefreshError extends Error {
  readonly kind: AuthRefreshFailureKind

  constructor(kind: AuthRefreshFailureKind, message: string) {
    super(message)
    this.name = "AuthRefreshError"
    this.kind = kind
  }
}

export function isInvalidRefreshStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403
}

export function isAuthRefreshError(error: unknown): error is AuthRefreshError {
  return error instanceof AuthRefreshError
}

export interface EnsureFreshTokenOptions {
  /** Refresh a token that is not near expiry (a 401 or a 4010 means its claims are stale). */
  force?: boolean
  /**
   * The access token a request was refused with (null: it carried none). A
   * refresh that is under way, or one that already replaced this token while
   * the request was in flight, is joined instead of starting another: a burst
   * of 401s is ONE refresh, however late each of them comes back.
   */
  rejected?: string | null
}

/** The auth manager's refresh, as every client of it sees it. Single flight. */
export type EnsureFreshToken = (opts?: EnsureFreshTokenOptions) => Promise<void>

/**
 * The refresh in flight when the current token is expired (or about to be),
 * else null: what a request about to be sent waits for.
 */
export type PendingRefresh = () => Promise<unknown> | null
