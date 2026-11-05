// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  boolean,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * Per-org approval-TIGHTENING policies (the gate-tightening complement of
 * `autoApprovePolicies`). Each row maps {a tool scope + optional condition}
 * to an ESCALATED approval requirement: a non-gated action becomes gated
 * (`requireApproval`) and/or a 1-approver action becomes N-eyes
 * (`minApprovers`). RLS-scoped to the org. `createdBy` is informational.
 *
 * ⛔ TIGHTEN-ONLY INVARIANT (security): a row can only ADD or RAISE an approval
 * requirement. The evaluator (`evaluateApprovalPolicy`) takes the MAX of the
 * built-in gating and the policy gating — a policy can NEVER make a gated action
 * non-gated, NEVER lower min_approvers below the built-in default. This is the
 * inverse of `autoApprovePolicies` (which LOOSENS a gate). The two are distinct
 * stores so they can never be confused or mutually cancel.
 */
export const approvalPolicies = kernel.table(
  "approval_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Scope/tool this policy tightens, e.g. `shopify:refund`, `invoicing:credit_note`. */
    toolName: text("tool_name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Array of `{ path, op, value }` predicates evaluated against the call params.
     *  Empty array = the policy applies to EVERY call of `toolName` unconditionally
     *  (e.g. "every credit note"). */
    conditions: jsonb("conditions").notNull().default([]),
    /** Escalate a non-gated action → gated (require a human approver). */
    requireApproval: boolean("require_approval").notNull().default(true),
    /** N-eyes: require at least this many DISTINCT approvers. 0/1 = no extra
     *  beyond the built-in single approval; 2 = a second distinct person. */
    minApprovers: integer("min_approvers").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("approval_policies_org_tool_idx").on(t.orgId, t.toolName),
    index("approval_policies_org_enabled_idx").on(t.orgId, t.enabled),
  ],
)

export type ApprovalPolicy = typeof approvalPolicies.$inferSelect
export type NewApprovalPolicy = typeof approvalPolicies.$inferInsert
