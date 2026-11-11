// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

export const WEBHOOK_INBOX_STATUSES = [
  "processing",
  "pending",
  "held",
  "done",
  "rejected",
  "dropped",
  "dead",
] as const
export type WebhookInboxStatus = (typeof WEBHOOK_INBOX_STATUSES)[number]

/**
 * Every verified app webhook delivery, stored before its handler runs
 * (migration 0288, modules/webhooks/inbox.ts). Reached only through the
 * privileged connection.
 */
export const webhookInbox = kernel.table(
  "webhook_inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appName: text("app_name").notNull(),
    endpointName: text("endpoint_name").notNull(),
    deliveryHash: text("delivery_hash").notNull(),
    dedupUntil: timestamp("dedup_until", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<unknown>(),
    headers: jsonb("headers").$type<Record<string, string>>(),
    scopes: text("scopes").array().notNull().default(sql`'{}'`),
    status: text("status", { enum: WEBHOOK_INBOX_STATUSES }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull().defaultNow(),
    claimToken: uuid("claim_token"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("webhook_inbox_delivery_uq").on(
      table.orgId,
      table.appName,
      table.endpointName,
      table.deliveryHash,
    ),
    index("webhook_inbox_due_idx")
      .on(table.dueAt)
      .where(sql`status IN ('processing', 'pending', 'held')`),
    index("webhook_inbox_settled_idx").on(table.status, table.settledAt),
  ],
)

export type WebhookInboxRow = typeof webhookInbox.$inferSelect
