// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org cap refusals (modules/org/caps.ts on the server: 409
// SEAT_LIMIT_REACHED, MAILBOX_LIMIT_REACHED and, in the managed edition,
// PERSONAL_MAILBOX_LIMIT_REACHED, CUSTOM_APP_LIMIT_REACHED and
// AUDIT_DAYS_LIMIT_REACHED, and the OAuth callback's
// `oauth_error` of the same codes) in the reader's language. The server's
// message is English; its code is what the web translates.

import { billingMode } from "./BillingState"

// In the managed edition the plan sets these limits and the customer runs no server.
const MANAGED_KEY_OF_CODE: Record<string, string> = {
  SEAT_LIMIT_REACHED: "cloud-limits.caps.seatLimitReached",
  MAILBOX_LIMIT_REACHED: "cloud-limits.caps.mailboxLimitReached",
}

const KEY_OF_CODE: Record<string, string> = {
  SEAT_LIMIT_REACHED: "kernel.orgUsage.seatLimitReached",
  MAILBOX_LIMIT_REACHED: "kernel.orgUsage.mailboxLimitReached",
  PERSONAL_MAILBOX_LIMIT_REACHED: "kernel.orgUsage.personalMailboxLimitReached",
  CUSTOM_APP_LIMIT_REACHED: "cloud-limits.caps.customAppLimitReached",
  AUDIT_DAYS_LIMIT_REACHED: "cloud-limits.caps.auditDaysLimitReached",
}

/** The localized refusal for a cap code, or null for any other code. */
export function capLimitMessage(t: (key: string) => string, code: unknown): string | null {
  if (typeof code !== "string") return null
  const key =
    (billingMode() === "managed" ? MANAGED_KEY_OF_CODE[code] : undefined) ?? KEY_OF_CODE[code]
  return key ? t(key) : null
}
