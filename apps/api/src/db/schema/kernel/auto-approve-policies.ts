// SPDX-License-Identifier: FSL-1.1-ALv2
import { boolean, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * Per-org auto-approve policies (Module B). Each row scopes ONE gated tool to a
 * bounded autonomy budget: when an agent calls `toolName` and the call's params
 * satisfy every `condition` AND a Redis sliding-window `limit` has headroom AND
 * the actor holds `requiresScope`, the kernel gate auto-approves instead of
 * raising a human approval. Org-scoped (not owner-scoped) — `createdBy` is
 * informational. Fail-closed: absence of a row never opens a gate.
 */
export const autoApprovePolicies = kernel.table(
  "auto_approve_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Array of `{ path, op, value }` predicates evaluated against the call params. */
    conditions: jsonb("conditions").notNull().default([]),
    /** `{ perCallMax?, windowSeconds?, windowMax? }` — the sliding-window spend cap. */
    limits: jsonb("limits").notNull().default({}),
    /** Scope the actor must hold for the policy to fire (decision-audience guard). */
    requiresScope: text("requires_scope"),
    /** The policy also approves a call that leaves the org from a turn that read outside text
     *  (migration 0148). Off by default: such a call then parks for a person. */
    allowAfterUntrustedContent: boolean("allow_after_untrusted_content").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auto_approve_policies_org_tool_idx").on(t.orgId, t.toolName),
    index("auto_approve_policies_org_enabled_idx").on(t.orgId, t.enabled),
  ],
)

export type AutoApprovePolicy = typeof autoApprovePolicies.$inferSelect
export type NewAutoApprovePolicy = typeof autoApprovePolicies.$inferInsert
