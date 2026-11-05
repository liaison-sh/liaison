// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/** The OS notification permission a desktop app last reported (A6). */
export const DESKTOP_PERMISSIONS = ["granted", "denied", "not_determined"] as const
export type DesktopPermission = (typeof DESKTOP_PERMISSIONS)[number]

/** One desktop app install per (user, device id) (0122). Ownership RLS. */
export const desktopDevices = kernel.table(
  "desktop_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    os: text("os"),
    appVersion: text("app_version"),
    reportedPermission: text("reported_permission", { enum: DESKTOP_PERMISSIONS }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("desktop_devices_user_device_idx").on(t.userId, t.deviceId),
    index("desktop_devices_org_user_idx").on(t.orgId, t.userId),
  ],
)

/**
 * One browser profile per (user, device id), with its Web Push subscription
 * when it has one; `endpoint` NULL is a browser with in-tab notifications only
 * (0122). An endpoint is held by one row at most (0123). Ownership RLS.
 */
export const browserPushSubscriptions = kernel.table(
  "browser_push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    endpoint: text("endpoint"),
    p256dh: text("p256dh"),
    auth: text("auth"),
    userAgent: text("user_agent"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("browser_push_subscriptions_user_device_idx").on(t.userId, t.deviceId),
    index("browser_push_subscriptions_org_user_idx").on(t.orgId, t.userId),
    // One owner per Web Push endpoint (0123, fix2-F1).
    uniqueIndex("browser_push_subscriptions_endpoint_idx")
      .on(t.endpoint)
      .where(sql`${t.endpoint} IS NOT NULL`),
  ],
)

export const CREDENTIAL_SURFACES = ["ios", "android", "desktop", "browser"] as const
export type CredentialSurface = (typeof CREDENTIAL_SURFACES)[number]

/**
 * Receipt-only device credentials (A7, 0122): stored hashed, bound to (user,
 * org, device, server origin), one live per device. Privileged access only.
 */
export const notificationDeviceCredentials = kernel.table(
  "notification_device_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    surface: text("surface", { enum: CREDENTIAL_SURFACES }).notNull(),
    tokenHash: text("token_hash").notNull(),
    serverOrigin: text("server_origin").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("notification_device_credentials_hash_idx").on(t.tokenHash)],
)

export const RECEIPT_OUTCOMES = ["received", "shown", "suppressed"] as const
export type ReceiptOutcome = (typeof RECEIPT_OUTCOMES)[number]

/** One receipt per (notification, device), precedence suppressed > shown > received (A3). */
export const notificationReceipts = kernel.table(
  "notification_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    notificationId: uuid("notification_id").notNull(),
    deviceId: text("device_id").notNull(),
    surface: text("surface"),
    appState: text("app_state"),
    outcome: text("outcome", { enum: RECEIPT_OUTCOMES }).notNull(),
    reason: text("reason"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("notification_receipts_notification_device_idx").on(t.notificationId, t.deviceId),
  ],
)
