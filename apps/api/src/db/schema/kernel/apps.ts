// SPDX-License-Identifier: FSL-1.1-ALv2
import { jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

export const appStatusEnum = kernel.enum("app_status", ["active", "disabled", "error", "removed"])

export const apps = kernel.table(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    status: appStatusEnum("status").notNull().default("active"),
    /** 'everyone' or 'restricted' (S20): who may use the app in this workspace, see org_app_access. */
    accessMode: text("access_mode", { enum: ["everyone", "restricted"] })
      .notNull()
      .default("everyone"),
    /**
     * The manifest's `everyMemberScopes` (migration 0194): scopes of this app every active
     * member of the org holds, whatever their roles. Rewritten at every registration;
     * unioned into effective scopes by `loadEffectivePermissions`.
     */
    everyMemberScopes: text("every_member_scopes").array().notNull().default([]),
    config: jsonb("config"),
    schemaHash: text("schema_hash"),
    /**
     * Why the app failed to load in this org, beside the `error` status (migration
     * 0212): `manifest_invalid` or `registration_failed`, and the reason (at most
     * 1000 characters; the full text is in the server log). Cleared by the next
     * successful registration.
     */
    problemCode: text("problem_code"),
    problemMessage: text("problem_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("apps_org_name_idx").on(table.orgId, table.name)],
)

/**
 * The roles and people who keep a restricted app (S20, migration 0191). RLS by
 * org; read by the kernel's app-state cache (modules/apps/org-apps.ts).
 */
export const orgAppAccess = kernel.table(
  "org_app_access",
  {
    orgId: uuid("org_id").notNull(),
    app: text("app").notNull(),
    principalType: text("principal_type", { enum: ["role", "user"] }).notNull(),
    principalId: uuid("principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.app, table.principalType, table.principalId] }),
  ],
)
