// SPDX-License-Identifier: FSL-1.1-ALv2
import { boolean, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

/**
 * Per-org, per-scope disclosure switch (spec-security.md D4, S7).
 *
 * "Share anyway" re-runs a withheld turn at `ceiling ∩ requester` and discloses
 * the result to the room. An admin can take that option away for a given scope
 * by marking it non-disclosable; the requester is then only offered "Continue
 * in a DM".
 *
 * DEFAULT DISCLOSABLE: absence of a row means disclosable, and a row created
 * without an explicit value is `disclosable = true`. A scope is only ever
 * restricted by a deliberate write.
 *
 * ⛔ TIGHTEN-ONLY INVARIANT (S7, mirroring `approvalPolicies`): once a scope is
 * marked non-disclosable it can never be marked disclosable again. The
 * transition rule compares the old and the new value, which a column CHECK
 * cannot express (a CHECK sees only the candidate row), so it is enforced in
 * two places that do not overlap:
 *
 *   1. `assertDisclosurePolicyTightenOnly` (P2b-T09) is the authority every
 *      caller is meant to meet. It refuses the loosening in code, before any
 *      SQL, with the friendly typed `E_DISCLOSURE_POLICY_LOOSENING`.
 *   2. `0069_scope_disclosure_policy_tighten_only.sql` is the backstop
 *      underneath it, for callers that write their own SQL. A BEFORE UPDATE
 *      trigger refuses `false -> true` (and refuses renaming or re-homing a
 *      tightened row, which would loosen the original scope by leaving it with
 *      no row) with SQLSTATE `LI001`, a code T09 never produces. A BEFORE
 *      DELETE trigger keeps a tightened row alive against every handle,
 *      including the BYPASSRLS ones that skip RLS but never skip triggers; it
 *      suppresses the delete the same way `liaison_rls` already sees it, as 0
 *      rows affected. An organization cascade is the one delete allowed
 *      through, since the row then governs nothing.
 *
 * `liaison_rls` also has no DELETE policy at all, so for an ordinary caller the
 * row cannot be dropped and re-created to fall back to the disclosable default.
 *
 * RLS: SELECT to any member of the org (the Share-anyway check reads it at turn
 * time for every requester, not just admins); INSERT and UPDATE require
 * `kernel:agents:admin`, the same admin scope A15 uses for agent-adjacent
 * policy tables; no DELETE for `liaison_rls` at all.
 */
export const scopeDisclosurePolicy = kernel.table(
  "scope_disclosure_policy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The capability this row governs, e.g. `finance:invoices:read`. */
    scope: text("scope").notNull(),
    /** false = "Share anyway" is unavailable for this scope. Tighten-only. */
    disclosable: boolean("disclosable").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("scope_disclosure_policy_org_scope_idx").on(t.orgId, t.scope)],
)

export type ScopeDisclosurePolicy = typeof scopeDisclosurePolicy.$inferSelect
export type NewScopeDisclosurePolicy = typeof scopeDisclosurePolicy.$inferInsert
