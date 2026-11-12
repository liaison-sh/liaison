// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The adapter documents of the platform-held HTTP API connections and their
// kept previous versions (migration 0298, modules/apps/connections/api/store.ts),
// keyed by (org, app, connection, identifier). Privileged pool only (RLS
// forced, no policy).

import { index, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

export const apiAdapters = kernel.table(
  "api_adapters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appName: text("app_name").notNull(),
    connectionName: text("connection_name").notNull(),
    identifier: text("identifier").notNull(),
    adapter: jsonb("adapter").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("api_adapters_connection_uq").on(t.orgId, t.appName, t.connectionName, t.identifier),
  ],
)

export const apiAdapterVersions = kernel.table(
  "api_adapter_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appName: text("app_name").notNull(),
    connectionName: text("connection_name").notNull(),
    identifier: text("identifier").notNull(),
    adapter: jsonb("adapter").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    savedBy: uuid("saved_by"),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("api_adapter_versions_connection_idx").on(
      t.orgId,
      t.appName,
      t.connectionName,
      t.identifier,
    ),
  ],
)
