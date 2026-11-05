// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  boolean,
  index,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel } from "./organizations"
import { users } from "./users"

export const roles = kernel.table(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // System-managed roles are reconciled by the app-registration path (e.g. the
    // auto-maintained "Full Member" role) rather than by admins. The reconciler
    // owns only rows it created or adopted; the UI may flag these as not freely
    // editable. See migration 0006 + extendFullMemberRole in modules/apps/runtime.
    systemManaged: boolean("system_managed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("roles_org_name_idx").on(table.orgId, table.name)],
)

export const roleScopeGrants = kernel.table(
  "role_scope_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
  },
  (table) => [
    index("role_scope_grants_role_idx").on(table.roleId),
    uniqueIndex("role_scope_grants_role_scope_idx").on(table.roleId, table.scope),
  ],
)

export const roleDimensionGrants = kernel.table(
  "role_dimension_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    dimensionKey: text("dimension_key").notNull(),
    dimensionValues: jsonb("dimension_values").$type<string[]>().notNull(),
  },
  (table) => [
    index("role_dim_grants_role_idx").on(table.roleId),
    uniqueIndex("role_dim_grants_role_dim_idx").on(table.roleId, table.dimensionKey),
  ],
)

export const userRoles = kernel.table(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.roleId] }),
    index("user_roles_org_idx").on(table.orgId),
  ],
)

export const userScopeGrants = kernel.table(
  "user_scope_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    orgId: uuid("org_id").notNull(),
    scope: text("scope").notNull(),
  },
  (table) => [
    index("user_scope_grants_user_idx").on(table.userId),
    index("user_scope_grants_org_idx").on(table.orgId),
    uniqueIndex("user_scope_grants_user_org_scope_idx").on(table.userId, table.orgId, table.scope),
  ],
)

export const userDimensionGrants = kernel.table(
  "user_dimension_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    orgId: uuid("org_id").notNull(),
    dimensionKey: text("dimension_key").notNull(),
    dimensionValues: jsonb("dimension_values").$type<string[]>().notNull(),
  },
  (table) => [
    index("user_dim_grants_user_idx").on(table.userId),
    index("user_dim_grants_org_idx").on(table.orgId),
    uniqueIndex("user_dim_grants_user_org_dim_idx").on(
      table.userId,
      table.orgId,
      table.dimensionKey,
    ),
  ],
)

// Phase 16 Task A1 — audit trail for app-issued user-scope grants.
// `kernel.permissions.setUserScopes()` (the bridge-gated primitive that lets an
// installed app grant Liaison-side scopes within its own `<appName>:*`
// namespace) writes one row per call here. Bounded cardinality + queryable
// columns let admins answer "which app granted Marie 'shopify:refunds:create'
// at what time?" without parsing JSON.
export const appScopeGrantAudit = kernel.table(
  "app_scope_grant_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    appName: text("app_name").notNull(),
    targetUserId: uuid("target_user_id").notNull(),
    scopesSet: text("scopes_set").array().notNull(),
    scopesAdded: text("scopes_added").array().notNull(),
    scopesRemoved: text("scopes_removed").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("app_scope_grant_audit_user_idx").on(table.orgId, table.targetUserId, table.createdAt),
    index("app_scope_grant_audit_app_idx").on(table.orgId, table.appName, table.createdAt),
  ],
)
