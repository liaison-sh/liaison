// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What a person reads when a send fails because its connection cannot send:
 * a mailbox with no stored credentials answers 422
 * `connection_credentials_missing` (api connections/credentials-missing.ts),
 * and one whose connected account is gone answers 422
 * `connection_not_connected` (api connections/no-connected-account.ts); both
 * say to reconnect it, in their language. Any other failure keeps the caller's
 * own message.
 */
import { ApiError } from "./api-error"

export const CONNECTION_CREDENTIALS_MISSING = "connection_credentials_missing"
export const CONNECTION_NOT_CONNECTED = "connection_not_connected"

/** The i18n key for a connection failure the person can fix, or null. */
export function connectionErrorKey(
  err: unknown,
): "kernel.connectionCredentialsMissing" | "kernel.connectionNotConnected" | null {
  if (!(err instanceof ApiError)) return null
  if (err.code === CONNECTION_CREDENTIALS_MISSING) return "kernel.connectionCredentialsMissing"
  if (err.code === CONNECTION_NOT_CONNECTED) return "kernel.connectionNotConnected"
  return null
}
