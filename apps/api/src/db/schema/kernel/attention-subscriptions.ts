// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16 Task A2 — per-user attention subscription rules.
import { boolean, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

export const attentionSubscriptions = kernel.table(
  "attention_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    /**
     * Event source. Either an app name (`shopify`, `mail`, …), the kernel
     * (`kernel`), or `*` as a catch-all rule. Matched against the event's
     * `app` (or category) field by the evaluator in `subscriptions.ts`.
     */
    source: text("source").notNull(),
    /**
     * Attention kinds the rule scopes. `*` accepts any kind for `source`.
     * Mixing `*` with other kinds is allowed but semantically `*` wins.
     */
    kinds: text("kinds").array().notNull(),
    /**
     * Axis → allowed values. Empty object means no axis narrowing.
     * Within an axis, multiple values are OR-ed. Multiple axes are AND-ed.
     * Missing axes on the event reject the rule.
     */
    filters: jsonb("filters").$type<Record<string, string[]>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // UNIQUE on (user_id, source): one rule per source per user. The POST route
  // maps a 23505 unique-violation to 409 ("use PUT to update"), and the
  // evaluator's "has any rule for source → narrowing kicks in" semantics
  // assume at most one rule per source. Matches the migration's UNIQUE INDEX
  // (0000_initial.sql) — the prior non-unique `index(...)` was ORM/DB drift.
  (table) => [
    uniqueIndex("attention_subscriptions_user_source_idx").on(table.userId, table.source),
  ],
)
