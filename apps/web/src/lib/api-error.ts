// SPDX-License-Identifier: FSL-1.1-ALv2
export class ApiError extends Error {
  status: number
  code?: string
  retryAfter?: number
  details?: Record<string, unknown>
  /** The server's reference for an unhandled failure (`error.ref` on a 500),
   *  the key to its log line. Shown to the operator so a report can quote it. */
  ref?: string

  constructor(
    message: string,
    status: number,
    code?: string,
    retryAfter?: number,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
    this.details = details
  }

  /**
   * A failure the SAME request could survive if it were made again later: rate
   * limiting (429), a server fault (5xx) and a network failure (status 0).
   *
   * Callers use it to keep a transient failure INSIDE the surface that asked
   * (a retry line in the tab, a stale value left on screen) instead of letting
   * it escape as an unhandled rejection that takes the tree down with it. It
   * is not permission to retry immediately: `retryAfter` is the earliest a 429
   * may be asked again, and a caller with no better idea backs off.
   */
  get retryable(): boolean {
    return this.status === 429 || this.status === 0 || this.status >= 500
  }
}

/**
 * Was the request refused because the viewer can no longer use the app it
 * belongs to? An admin restricted it to other roles and people (403
 * `app_restricted`, S20) or turned it Off or removed it (410 `app_disabled`,
 * S19).
 */
export function isAppAccessLost(status: number, code: string | undefined): boolean {
  return (
    (status === 403 && code === "app_restricted") || (status === 410 && code === "app_disabled")
  )
}

/** `isAppAccessLost` for a thrown error. */
export function isAppAccessLostError(error: unknown): boolean {
  return error instanceof ApiError && isAppAccessLost(error.status, error.code)
}
