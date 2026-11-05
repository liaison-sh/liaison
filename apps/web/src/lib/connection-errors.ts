// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What a person reads when a send fails because its connection cannot send:
 * a mailbox with no stored credentials answers 422
 * `connection_credentials_missing` (api connections/credentials-missing.ts),
 * which says to reconnect it, in their language. Any other failure keeps the
 * caller's own message.
 */
import { ApiError } from "./api-error"

export const CONNECTION_CREDENTIALS_MISSING = "connection_credentials_missing"

/** The i18n key for a connection failure the person can fix, or null. */
export function connectionErrorKey(err: unknown): "kernel.connectionCredentialsMissing" | null {
  return err instanceof ApiError && err.code === CONNECTION_CREDENTIALS_MISSING
    ? "kernel.connectionCredentialsMissing"
    : null
}
