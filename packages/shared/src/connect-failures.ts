// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Why a connect card's consent did not complete, as the closed set of codes the
 * callback hands back to the card's popup page or to the conversation. Each
 * code has a fixed sentence (server `kernel.auth.connectFailed.<code>`, web
 * `secret-request.connectFailure.<code>`): nothing the provider or the link
 * wrote is ever shown.
 */
export const CONNECT_FAILURE_REASONS = [
  "access_denied",
  "oauth_browser_mismatch",
  "oauth_callback_refused",
  "connection_held_by_other_owner",
  "mail_domain_not_allowed",
  "app_disabled",
  "admin_policy_blocked",
  "failed",
] as const

export type ConnectFailureReason = (typeof CONNECT_FAILURE_REASONS)[number]

function isConnectFailureReason(value: string): value is ConnectFailureReason {
  return (CONNECT_FAILURE_REASONS as readonly string[]).includes(value)
}

/** Provider codes that mean an admin policy of the account's organisation blocked
 *  the app (Google: the Workspace has not marked the client Trusted). */
const ADMIN_POLICY_CODES = new Set(["admin_policy_enforced", "org_internal"])

/** A refusal whose description names an admin policy, not the person's own "no". */
const ADMIN_POLICY_DESCRIPTION = /admin[_ ]policy|administrator|admin has/i

/**
 * A raw error code (and the provider's description, when it has one) as one of
 * the known reasons; anything else is `failed`. The description is only read to
 * tell an admin-policy block from a person's refusal, never shown.
 */
export function connectFailureReason(
  raw: string | null | undefined,
  description?: string | null,
): ConnectFailureReason {
  if (raw && ADMIN_POLICY_CODES.has(raw)) return "admin_policy_blocked"
  if (raw === "access_denied" && description && ADMIN_POLICY_DESCRIPTION.test(description)) {
    return "admin_policy_blocked"
  }
  return raw && isConnectFailureReason(raw) ? raw : "failed"
}
