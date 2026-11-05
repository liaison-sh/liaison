// SPDX-License-Identifier: FSL-1.1-ALv2
import { text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

/**
 * Explicit sharing grants for any shareable resource (migration 0117,
 * modules/sharing). A grant gives a user, a role or a dimension value
 * ("mail:inbox=<account id>") viewer or editor access to one resource.
 */
export const resourceGrants = kernel.table("resource_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: uuid("resource_id").notNull(),
  granteeKind: text("grantee_kind").$type<"user" | "role" | "dimension">().notNull(),
  grantee: text("grantee").notNull(),
  role: text("role").$type<"viewer" | "editor">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
})
