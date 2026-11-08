// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-org app usage per UTC day (migration 0282, modules/apps/usage/): one row
// per (org, app, day, executor) with the runs, the bridge calls (Workers only:
// QuickJS runs report none) and the wall milliseconds the cell counted as runs
// settled, plus the CPU milliseconds the Workers loader measured, pulled from
// it every hour (null until then, and always on QuickJS). For reporting (Usage
// in Settings, the daily `apps.usage` to Control): the caps are enforced from
// Redis day counters, never from this table. Readable by the row's org under
// RLS; written through the privileged pool only.

import { bigint, date, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

export type AppUsageExecutor = "workers" | "quickjs" | "inprocess"

export const appUsageDaily = kernel.table(
  "app_usage_daily",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    app: text("app").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    executor: text("executor").$type<AppUsageExecutor>().notNull(),
    runs: bigint("runs", { mode: "number" }).notNull().default(0),
    bridgeCalls: bigint("bridge_calls", { mode: "number" }).notNull().default(0),
    wallMs: bigint("wall_ms", { mode: "number" }).notNull().default(0),
    /** The loader's measure (Workers); null before the pull and on other executors. */
    cpuMs: bigint("cpu_ms", { mode: "number" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.app, t.day, t.executor] })],
)

export type AppUsageDailyRow = typeof appUsageDaily.$inferSelect
