// SPDX-License-Identifier: FSL-1.1-ALv2
import { index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { actorTypeEnum } from "./audit-log"
import { kernel } from "./organizations"

export const timelineEntries = kernel.table(
  "timeline_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    app: text("app").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    actorId: uuid("actor_id"),
    actorType: actorTypeEnum("actor_type").notNull(),
    action: text("action").notNull(),
    summary: text("summary").notNull(),
    actionLabel: text("action_label"),
    fieldChanges: jsonb("field_changes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    eventId: uuid("event_id"),
  },
  (table) => [
    index("timeline_org_entity_idx").on(table.orgId, table.app, table.entityType, table.entityId),
    uniqueIndex("timeline_event_id_idx")
      .on(table.eventId)
      .where("event_id IS NOT NULL" as any),
  ],
)
