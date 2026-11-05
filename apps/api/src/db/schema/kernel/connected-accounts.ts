// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

export const connectedAccounts = kernel.table(
  "connected_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // I-DB-4 — org/user referential integrity + cascade.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appName: text("app_name").notNull(),
    connectionName: text("connection_name").notNull(),
    ownerType: text("owner_type").notNull(), // "user" | "org"
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "cascade" }), // null for org-level
    providerType: text("provider_type").notNull(), // "oauth2" | "credentials"
    identifier: text("identifier").notNull(),
    displayName: text("display_name"),
    providerAccountId: text("provider_account_id"),
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    credentialsEncrypted: text("credentials_encrypted"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    // The OAuth client that minted the tokens (migration 0217): "org", "instance"
    // or "legacy" (connected before this was recorded), and that client's id.
    oauthClientSource: text("oauth_client_source"),
    oauthClientId: text("oauth_client_id"),
    status: text("status").notNull().default("active"), // active | error | disconnected
    statusMessage: text("status_message"),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One active row per account and owner type (migration 0239): an org row and
    // a member's row may share an account only where the connection declares
    // `orgAndPersonalCoexist`; elsewhere the OAuth callback keeps one owner.
    uniqueIndex("connected_accounts_unique_active_owner_idx")
      .on(table.orgId, table.appName, table.connectionName, table.identifier, table.ownerType)
      .where(sql`status = 'active'`),
    index("connected_accounts_org_idx").on(table.orgId),
    index("connected_accounts_owner_idx").on(table.orgId, table.ownerType, table.ownerId),
  ],
)
