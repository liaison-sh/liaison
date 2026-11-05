// SPDX-License-Identifier: FSL-1.1-ALv2
/** Error code: a connection has no stored credentials (the person reconnects it). */
export const CONNECTION_CREDENTIALS_MISSING = "connection_credentials_missing"

/**
 * A connection with no stored credentials (an IMAP mailbox added without its
 * password, a secret cleared). The person's to fix, not a server fault: a typed
 * 422 that says what to do. The message starts with the code because a
 * sandboxed handler's bridge call carries only its message back across the
 * sandbox (execute-tool `classifyDeliberateSandboxError` reads the code from it;
 * `fromMessage` restores the type on a host path that ran one).
 */
export class ConnectionCredentialsMissingError extends Error {
  readonly status = 422
  readonly code = CONNECTION_CREDENTIALS_MISSING
  readonly retryable = false
  constructor() {
    super(
      `${CONNECTION_CREDENTIALS_MISSING}: No credentials are stored for this connection. Reconnect it in Settings → Connections.`,
    )
    this.name = "ConnectionCredentialsMissingError"
  }

  /** The typed error behind a message that crossed the sandbox, or null. */
  static fromMessage(message: string): ConnectionCredentialsMissingError | null {
    return message.includes(`${CONNECTION_CREDENTIALS_MISSING}:`)
      ? new ConnectionCredentialsMissingError()
      : null
  }
}
