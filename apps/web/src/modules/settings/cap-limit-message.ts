// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org cap refusals (modules/org/caps.ts on the server: 409
// SEAT_LIMIT_REACHED and MAILBOX_LIMIT_REACHED, and the OAuth callback's
// `oauth_error` of the same codes) in the reader's language. The server's
// message is English; its code is what the web translates.

const KEY_OF_CODE: Record<string, string> = {
  SEAT_LIMIT_REACHED: "kernel.orgUsage.seatLimitReached",
  MAILBOX_LIMIT_REACHED: "kernel.orgUsage.mailboxLimitReached",
}

/** The localized refusal for a cap code, or null for any other code. */
export function capLimitMessage(t: (key: string) => string, code: unknown): string | null {
  const key = typeof code === "string" ? KEY_OF_CODE[code] : undefined
  return key ? t(key) : null
}
