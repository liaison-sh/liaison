// SPDX-License-Identifier: FSL-1.1-ALv2
//
// RESTRICTED SESSIONS: what a device-flow token may carry, and what it may not
// mint.
//
// A device-flow client (a CLI, a headless tool) declares the scopes it needs at
// /device-flow/initiate. The approving human's session is then restricted to
// that set: the ceiling is stored on the session row (migration 0114) and
// every access token minted from it, at login and at each refresh, is
// intersected with it (`applyScopeCeiling`), and carries `restricted: true`.
//
// ONE RULE for everything else a session can mint: a restricted session mints
// NO new credential. It cannot approve a device flow (which would create a new,
// unrestricted or differently restricted session), consent to an MCP client
// (whose connection tokens carry the grantor's live grants), or open a desktop
// MCP connection. Propagating the ceiling into each of those would need a
// ceiling on every credential kind, and a missed kind would be a silent
// widening; refusing is one check at each mint site and fails closed.
// `assertUnrestrictedSession` is that check. Changing the password mints a new
// unrestricted session too, and changing the account's sign-in factors (two
// factor setup or removal, account deletion) is no business of a capped client:
// refused as well, so a capped token plus a known password never becomes a full
// session that skipped the second factor.
//
// The same rule covers the request paths that authorize on the user's STORED
// grants rather than the token's scopes, where a restricted token would act
// past its cap: deciding or editing an approval (decide.ts / edit.ts; the
// resource-owner branch needs no scope at all) and registering a push device
// (which then receives notifications at the stored grants). Refused too.
// The other request paths that read stored grants were audited (2026-09-30)
// and are safe as they are: the agent turn, share-anyway and the scope
// override intersect the live grants with the token's scopes before use;
// agent tools re-derive grants only after the tool registry gated the call on
// the turn's (token-derived) scopes; the sub-run drill-down now narrows the
// live grants by the session's scopes (threads/message.ts); the rest are jobs,
// consumers and audience checks about OTHER users, not the caller's token.
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { SECOND_FACTOR_REQUIRED_MESSAGE } from "~/modules/auth/admin-second-factor"
import { hasScope } from "~/modules/permissions/permissions"
import { getScopeCatalog } from "~/modules/permissions/scope-catalog"

/** The most scopes a client may declare, and their shape (no wildcard grants). */
export const MAX_DECLARED_SCOPES = 50
export const DECLARED_SCOPE_PATTERN = /^[a-z][a-z0-9_-]*(:[a-z0-9_-]+)*$/

/**
 * The scopes a restricted session's token carries: never more than the user
 * holds, never more than the ceiling. Hierarchical on both sides (a ceiling of
 * `threads:read` against a user holding `threads` yields `threads:read`; a user
 * holding `threads:read` under a ceiling of `threads` keeps `threads:read`), so
 * the result is covered by the user's grants AND by the ceiling. `null` or
 * `undefined` = no ceiling (an interactive login).
 */
export function applyScopeCeiling(
  scopes: string[],
  ceiling: readonly string[] | null | undefined,
): string[] {
  if (ceiling == null) return scopes
  const out = new Set<string>()
  for (const s of scopes) if (hasScope(s, [...ceiling])) out.add(s)
  for (const c of ceiling) if (hasScope(c, scopes)) out.add(c)
  return [...out]
}

/** Refuse a credential mint from a restricted (device-flow) session. */
export function assertUnrestrictedSession(
  c: Context<AppEnv>,
  what: string,
  opts: { secondFactorEnrollment?: boolean } = {},
): void {
  if (c.get("secondFactorRequired") === true) {
    // An administrator still to set up the second factor the org requires:
    // the enrollment routes are the only ones that accept this session.
    if (opts.secondFactorEnrollment === true) return
    throw new HTTPException(403, { message: SECOND_FACTOR_REQUIRED_MESSAGE })
  }
  if (c.get("sessionRestricted") === true) {
    throw new HTTPException(403, {
      message: `A restricted device session cannot ${what}. Sign in to do it.`,
    })
  }
}

/**
 * Declared scopes that the org's scope catalog does not know (empty = all
 * known). Checked at approval, where the org is known; initiate only checks
 * their shape.
 */
export function unknownDeclaredScopes(orgId: string, declared: readonly string[]): string[] {
  const known = new Set(getScopeCatalog(orgId).map((e) => e.scope))
  return declared.filter((s) => !known.has(s))
}
