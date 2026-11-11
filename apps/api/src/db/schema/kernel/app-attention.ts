// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The attention items an app's provider lists for one person, stored
// (migration 0288, modules/apps/attention-store.ts): written after the app was
// woken and on the attention minute tick, read by the attention feed, which
// runs no app code. One row per (org, app, person); `items` is the provider's
// whole list, replaced on each run. A person reads their own rows under RLS;
// written through the privileged pool only.

import type { AttentionItem, AttentionProviderError } from "@liaison/shared"
import { jsonb, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

export const appAttentionItems = kernel.table(
  "app_attention_items",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    app: text("app").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    items: jsonb("items").$type<AttentionItem[]>().notNull().default([]),
    /** The last run's failure, or null; `items` then keeps the last good list. */
    error: jsonb("error").$type<Omit<AttentionProviderError, "app">>(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.app, t.userId] })],
)

export type AppAttentionItemsRow = typeof appAttentionItems.$inferSelect
