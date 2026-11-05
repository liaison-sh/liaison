// SPDX-License-Identifier: FSL-1.1-ALv2
import { boolean, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

export const oauthProviders = kernel.table("oauth_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  name: text("name").notNull(),
  issuerUrl: text("issuer_url").notNull(),
  authorizationEndpoint: text("authorization_endpoint"),
  tokenEndpoint: text("token_endpoint"),
  userinfoEndpoint: text("userinfo_endpoint"),
  clientId: text("client_id").notNull(),
  clientSecretEncrypted: text("client_secret_encrypted").notNull(),
  scopes: text("scopes"),
  autoProvision: boolean("auto_provision").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const oauthAccounts = kernel.table(
  "oauth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // I-DB-4 — user/org referential integrity + cascade.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => oauthProviders.id, { onDelete: "cascade" }),
    externalSubject: text("external_subject").notNull(),
    externalEmail: text("external_email"),
    externalProfile: jsonb("external_profile"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("oauth_accounts_provider_subject_idx").on(table.providerId, table.externalSubject),
    index("oauth_accounts_org_idx").on(table.orgId),
  ],
)
