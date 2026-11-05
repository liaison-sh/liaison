// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Restricted scopes: OAuth scopes Google lets a client ask a personal account for
 * only after the client passed Google's restricted-scope verification (Drive's
 * `drive.readonly`). A connection lists them in `scopes` AND in
 * `restrictedScopes`; the authorize request drops them when the client may not
 * ask for them for this person, so Google shows no unverified-app screen and the
 * person still connects with what is left (Drive: `drive.file`, the files they
 * pick in the Google Picker).
 *
 * The client may ask for them when (the same rule as `googleDriveMode` in
 * `@liaison/shared`, which the agent's setup tool predicts the mode with):
 * - it is the workspace's own client (its owner set it up for its own accounts);
 * - it is the instance's and passed Google's verification
 *   (GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED);
 * - the address being connected is a Google Workspace one: a Workspace admin can
 *   mark the instance client Trusted (the Trusted guide);
 * - the active account with that same address already holds one (a reconnect
 *   never drops a scope), or its grant was never recorded.
 *
 * The address being connected is the one the connect was started for (the
 * connect card's `identifier`, also sent to Google as `login_hint`); a connect
 * started without one falls back to the person's own sign-in address.
 *
 * Connection health never flags a missing restricted scope: a grant without it is
 * the narrower mode the connection was made in, not drift.
 */
import { googleDriveMode, type MailAccountType } from "@liaison/shared"

/** The declared restricted scopes of a connection config (empty when none). */
export function restrictedScopesOf(
  connConfig: { restrictedScopes?: string[] } | undefined,
): readonly string[] {
  return connConfig?.restrictedScopes ?? []
}

export interface RestrictedScopeContext {
  /** Where the flow's client comes from. */
  clientSource: "org" | "instance"
  /** The instance client passed Google's restricted-scope verification. */
  instanceVerified: boolean
  /** The recorded grant of the active account with the address being connected. */
  existingGrant: readonly string[] | "unknown" | null
  /** The account type of the address being connected, when known. */
  personAccountType: MailAccountType | null
}

/** Whether this flow may ask for the connection's restricted scopes. */
export function restrictedScopesAllowed(
  restricted: readonly string[],
  ctx: RestrictedScopeContext,
): boolean {
  if (restricted.length === 0) return true
  if (ctx.existingGrant === "unknown") return true
  if (ctx.existingGrant?.some((s) => restricted.includes(s))) return true
  const client = { source: ctx.clientSource, restrictedVerified: ctx.instanceVerified }
  return googleDriveMode(ctx.personAccountType, client) === "full"
}

/** The scopes to request: `requested` without the restricted ones when they are not allowed. */
export function withoutRestricted(
  requested: readonly string[],
  restricted: readonly string[],
  allowed: boolean,
): string[] {
  return allowed ? [...requested] : requested.filter((s) => !restricted.includes(s))
}
