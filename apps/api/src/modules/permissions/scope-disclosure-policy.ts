// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tighten-only enforcement and the disclosure read for
// `kernel.scope_disclosure_policy` (spec-security.md S7, D4).
//
// An admin marks a capability non-disclosable per org, which takes "Share
// anyway" away for it: the requester is then only offered "Continue in a DM".
//
// TIGHTEN-ONLY INVARIANT (mirrors `approval-policy.ts`, which can only ever
// RAISE an approval requirement): once a scope is non-disclosable it can never
// be made disclosable again. The rule compares the OLD value to the new one,
// which a column CHECK cannot see (a CHECK sees only the candidate row), so it
// lives here, in code.
//
// TWO AUTHORITIES, WITH DIFFERENT JOBS. This module is the one every caller is
// meant to meet: it refuses the loosening BEFORE any SQL, with the friendly
// typed `E_DISCLOSURE_POLICY_LOOSENING`, and it never writes `true` at all.
// Underneath it, migration 0069 makes the same invariant a database fact
// through one plpgsql function on two triggers, which run for the BYPASSRLS
// roles too (those skip row security, never triggers):
//   * BEFORE UPDATE refuses `false -> true`, and equally refuses renaming the
//     scope or moving the row to another org on a tightened row, which would
//     leave the original scope with no row and so back at the disclosable
//     default: the same loosening, differently spelled. It raises SQLSTATE
//     LI001, a distinct shape a handler can tell from this module's error
//     without string matching.
//   * BEFORE DELETE keeps a tightened row alive against every handle, including
//     a privileged one, by suppressing the delete to 0 rows rather than raising
//     (the shape 0068 already gave `liaison_rls`, which has no DELETE policy).
//     The `org_id` FK cascade is the one delete allowed through: once the
//     organization is gone the row governs nothing.
// So the trigger is a BACKSTOP, not the path: no correct caller can reach it,
// and it firing means something bypassed this module.
//
// Consequently the only value this module ever writes is `disclosable = false`.
// A request to set it true is either refused (the row is already false) or a
// no-op (absence and `true` both already mean disclosable), so no code path
// here can loosen a row even if its caller asks for it.
//
// FAIL CLOSED: a read that errors reports the scope as NON-disclosable. Losing
// the policy row must never be what makes a withheld capability shareable.

import { and, eq, inArray } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { scopeDisclosurePolicy } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { hasScope } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "scope-disclosure-policy" })

export type ScopeDisclosurePolicyErrorCode =
  | "E_DISCLOSURE_POLICY_LOOSENING"
  | "E_DISCLOSURE_POLICY_WRITE_DENIED"

export class ScopeDisclosurePolicyError extends Error {
  readonly code: ScopeDisclosurePolicyErrorCode
  constructor(code: ScopeDisclosurePolicyErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = "ScopeDisclosurePolicyError"
    this.code = code
  }
}

/**
 * The transition rule: `false -> true` is the one move S7 forbids. Every other
 * transition is either a tightening or a no-op.
 */
export function assertDisclosurePolicyTightenOnly(current: boolean, next: boolean): void {
  if (current === false && next === true) {
    throw new ScopeDisclosurePolicyError(
      "E_DISCLOSURE_POLICY_LOOSENING",
      "a scope marked non-disclosable can never be made disclosable again",
    )
  }
}

/**
 * The scopes of `scopes` this org has marked non-disclosable, in the order they
 * were given. The read the rest of the slice consumes: "Share anyway" checks
 * its withheld-capability set against this and refuses the ones named.
 *
 * A scope with no row is disclosable (the default). A failed read reports EVERY
 * scope asked about as non-disclosable, so an unreachable or unreadable policy
 * table withholds rather than discloses.
 */
export async function listNonDisclosableScopes(
  db: RlsClient,
  orgId: string,
  scopes: string[],
): Promise<string[]> {
  if (scopes.length === 0) return []
  try {
    const rows = await db
      .select({
        scope: scopeDisclosurePolicy.scope,
        disclosable: scopeDisclosurePolicy.disclosable,
      })
      .from(scopeDisclosurePolicy)
      .where(
        and(eq(scopeDisclosurePolicy.orgId, orgId), inArray(scopeDisclosurePolicy.scope, scopes)),
      )
    const withheld = new Set(rows.filter((r) => !r.disclosable).map((r) => r.scope))
    return scopes.filter((s) => withheld.has(s))
  } catch (err) {
    log.error(
      { err, orgId, scopes },
      "scope disclosure policy read failed: treating every scope as non-disclosable",
    )
    return [...scopes]
  }
}

/**
 * The withheld scopes this org's policy BLOCKS from disclosure, in the order
 * they were given: the scope-AWARE sibling of `listNonDisclosableScopes`, and
 * the one "Share anyway" consults.
 *
 * The exact read above compares strings, and the two sides are never written the
 * same way. A withheld entry is a raw agent-CEILING string, routinely a glob
 * (`finance:*`), while an admin closes a concrete capability
 * (`finance:payouts:read`). Literally, those never matched, so a glob ceiling
 * stayed shareable however much of the closed family it covered, and only a
 * policy row naming the glob verbatim blocked anything.
 *
 * So the match is scope-aware in BOTH directions, through the repo's
 * wildcard-aware `hasScope` (the same semantics as `isMessageVisible` and the
 * messages RLS clause, never a third rule):
 *   - the withheld entry COVERS a non-disclosable scope (`finance:*` covers
 *     `finance:payouts:read`), or
 *   - a non-disclosable entry COVERS the withheld scope (a row on `finance:*`
 *     closes a ceiling naming `finance:payouts:read`).
 * Exact equality satisfies both, so everything the exact read refused is still
 * refused.
 *
 * The read is the org's closed scopes rather than a filter on the withheld set:
 * a glob on either side cannot be expressed as an `IN` list. Same fail-closed
 * rule as its sibling: a read that errors reports EVERY withheld scope as
 * blocked, so losing the policy table refuses rather than discloses.
 */
export async function listBlockingNonDisclosableScopes(
  db: RlsClient,
  orgId: string,
  withheldScopes: string[],
): Promise<string[]> {
  if (withheldScopes.length === 0) return []
  let closedScopes: string[]
  try {
    const rows = await db
      .select({ scope: scopeDisclosurePolicy.scope })
      .from(scopeDisclosurePolicy)
      .where(
        and(eq(scopeDisclosurePolicy.orgId, orgId), eq(scopeDisclosurePolicy.disclosable, false)),
      )
    closedScopes = rows.map((r) => r.scope)
  } catch (err) {
    log.error(
      { err, orgId, withheldScopes },
      "scope disclosure policy read failed: treating every withheld scope as non-disclosable",
    )
    return [...withheldScopes]
  }
  return withheldScopes.filter((withheld) =>
    closedScopes.some((closed) => hasScope(closed, [withheld]) || hasScope(withheld, [closed])),
  )
}

/** Whether this org still allows the scope to be disclosed. Fails closed. */
export async function isScopeDisclosable(
  db: RlsClient,
  orgId: string,
  scope: string,
): Promise<boolean> {
  return (await listNonDisclosableScopes(db, orgId, [scope])).length === 0
}

export interface UpdateScopeDisclosurePolicyParams {
  orgId: string
  scope: string
  disclosable: boolean
}

/**
 * The single write path for a scope's disclosability, guarded by the
 * tighten-only rule.
 *
 * The admin gate itself is 0068's INSERT/UPDATE policy, not a check here: the
 * caller's own `RlsClient` carries the scopes, and a caller without
 * `kernel:agents:admin` (or `*`) is refused by the database. An UPDATE that
 * matches no row under the policy returns nothing, which is reported as
 * `E_DISCLOSURE_POLICY_WRITE_DENIED` rather than passing for success.
 */
export async function updateScopeDisclosurePolicy(
  db: RlsClient,
  params: UpdateScopeDisclosurePolicyParams,
): Promise<{ scope: string; disclosable: boolean }> {
  const { orgId, scope, disclosable } = params
  assertDisclosurePolicyTightenOnly(await isScopeDisclosable(db, orgId, scope), disclosable)

  // Reaching here with `disclosable: true` means the scope is already
  // disclosable, which is exactly what absence and `true` both encode. There is
  // nothing to write, and writing anything would be the loosening path.
  if (disclosable) return { scope, disclosable: true }

  const [row] = await db
    .insert(scopeDisclosurePolicy)
    .values({ orgId, scope, disclosable: false })
    .onConflictDoUpdate({
      target: [scopeDisclosurePolicy.orgId, scopeDisclosurePolicy.scope],
      set: { disclosable: false, updatedAt: new Date() },
    })
    .returning({
      scope: scopeDisclosurePolicy.scope,
      disclosable: scopeDisclosurePolicy.disclosable,
    })

  if (!row) {
    throw new ScopeDisclosurePolicyError(
      "E_DISCLOSURE_POLICY_WRITE_DENIED",
      `no scope_disclosure_policy row was written for ${scope}`,
    )
  }
  return row
}
