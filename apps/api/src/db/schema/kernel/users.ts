// SPDX-License-Identifier: FSL-1.1-ALv2
import { boolean, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

// "suspended" is reserved for future use (admin-initiated temporary suspension)
export const userStatusEnum = kernel.enum("user_status", ["active", "suspended", "deactivated"])

export const users = kernel.table(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    totpSecret: text("totp_secret"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    recoveryCodes: jsonb("recovery_codes").$type<string[]>(),
    totpLastUsedAt: timestamp("totp_last_used_at", { withTimezone: true }),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    // Unguessable capability token for the public avatar-serving route
    // (`/api/avatars/<avatar_key>`). Combined with `orgId` it locates the stored
    // object (`orgs/<orgId>/avatars/<avatar_key>.webp`). Rotates on every upload;
    // NULL means no picture (initials fallback). See migration 0030.
    avatarKey: text("avatar_key"),
    timezone: text("timezone"),
    locale: text("locale"),
    authVersion: integer("auth_version").notNull().default(1),
    permissionVersion: integer("permission_version").notNull().default(1),
    status: userStatusEnum("status").notNull().default("active"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    invitedBy: uuid("invited_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_org_email_idx").on(table.orgId, table.email)],
)
