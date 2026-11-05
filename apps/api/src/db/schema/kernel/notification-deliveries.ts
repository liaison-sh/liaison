// SPDX-License-Identifier: FSL-1.1-ALv2
import { index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/** Where a delivery attempt went (A10). `android` covers an FCM token row. */
export const DELIVERY_SURFACES = [
  "ios",
  "android",
  "desktop",
  "browser_tab",
  "browser_push",
] as const
export type DeliverySurface = (typeof DELIVERY_SURFACES)[number]

/** What happened to one decision or one attempt (S1, A10). */
export const DELIVERY_RESULTS = [
  "accepted",
  "rejected",
  "no_connection",
  "no_device",
  "no_target",
  "suppressed",
] as const
export type DeliveryResult = (typeof DELIVERY_RESULTS)[number]

/**
 * One router decision that held a live channel back, or one delivery attempt
 * to one device (0121). Written by background workers on the privileged
 * connection; read by the owner (and org admins) through RLS. Purged after
 * 30 days, payload included.
 */
export const notificationDeliveries = kernel.table(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    notificationId: uuid("notification_id").notNull(),
    deviceId: text("device_id"),
    surface: text("surface", { enum: DELIVERY_SURFACES }),
    channel: text("channel").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    result: text("result", { enum: DELIVERY_RESULTS }).notNull(),
    reason: text("reason"),
    providerStatus: integer("provider_status"),
    payload: jsonb("payload"),
  },
  (t) => [
    index("notification_deliveries_notification_device_idx").on(t.notificationId, t.deviceId),
    index("notification_deliveries_attempted_idx").on(t.attemptedAt),
  ],
)

export type NotificationDelivery = typeof notificationDeliveries.$inferSelect
