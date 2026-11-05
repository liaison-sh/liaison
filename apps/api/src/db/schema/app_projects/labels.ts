// SPDX-License-Identifier: FSL-1.1-ALv2

import { index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { appProjects } from "./projects"

/**
 * Org-wide task label taxonomy (migration 0242): a group has `parentId` null,
 * a value's `parentId` is its group. A stored node's parent never changes and
 * a value's parent must be a group of the same org (trigger
 * `labels_parent_guard`, SQL only). Archive stamps `archivedAt`; nothing is
 * ever deleted. RLS: read with `projects:projects:read`, insert and update
 * with `projects:labels:admin`, no delete.
 */
export const labels = appProjects.table(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    parentId: uuid("parent_id").references((): any => labels.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_app_projects_labels_parent_id_sort_order").on(t.orgId, t.parentId, t.sortOrder),
  ],
)
