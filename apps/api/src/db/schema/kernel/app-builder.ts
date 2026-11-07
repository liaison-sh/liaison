// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { bytea } from "./mailbox-keys"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

export type AppDraftStatus = "draft" | "published" | "discarded"
export type AppBuildArtifactKind = "package" | "bundle" | "ui" | "worker"
export type AppLogLevel = "debug" | "info" | "warn" | "error"

/** The outcome of one version's build (stored on the version, migration 0276). */
export interface AppDraftBuild {
  ok: boolean
  packageSha256?: string
  bundleSha256?: string
  uiSha256?: string
  workerSha256?: string
  sizeBytes?: number
  errors?: Array<{ file?: string; line?: number; message: string; code?: string }>
  /** The name and version the bytes carry (forced before the build). */
  appName?: string
  appVersion?: string
  /** `tsc --noEmit` against the SDK types, when the build ran it (apps_build_check). */
  typecheck?: {
    ok: boolean
    errors: Array<{ file?: string; line?: number; message: string; code?: string }>
  }
  /** ISO timestamp. */
  at: string
}

/**
 * An org's app in the making (migration 0276). `base_name` becomes the custom
 * app name `<base>-o<orgKey>`; one live draft per base; `published_app_name` is
 * set at the first publish and immutable (trigger). FORCE RLS: the org reads,
 * holders of kernel:apps:build write.
 */
export const appDrafts = kernel.table(
  "app_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    baseName: text("base_name").notNull(),
    title: text("title").notNull(),
    status: text("status").$type<AppDraftStatus>().notNull().default("draft"),
    publishedAppName: text("published_app_name"),
    latestVersion: integer("latest_version").notNull().default(1),
    /** The version whose preview last wrote the draft's store namespace (0279). */
    previewStoreN: integer("preview_store_n"),
    /** A preview of this draft runs until then (0279): one at a time. */
    previewLeaseUntil: timestamp("preview_lease_until", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "app_drafts_published_check",
      sql`${table.status} <> 'published' OR ${table.publishedAppName} IS NOT NULL`,
    ),
    uniqueIndex("app_drafts_live_base_name_idx")
      .on(table.orgId, table.baseName)
      .where(sql`${table.status} <> 'discarded'`),
    index("app_drafts_org_idx").on(table.orgId, table.updatedAt.desc()),
    index("app_drafts_created_by_fk_idx")
      .on(table.createdBy)
      .where(sql`${table.createdBy} IS NOT NULL`),
    index("app_drafts_updated_by_fk_idx")
      .on(table.updatedBy)
      .where(sql`${table.updatedBy} IS NOT NULL`),
  ],
)

/** One immutable set of a draft's files and its build outcome; the last 20 are kept. */
export const appDraftVersions = kernel.table(
  "app_draft_versions",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => appDrafts.id, { onDelete: "cascade" }),
    n: integer("n").notNull(),
    files: jsonb("files").$type<Record<string, string>>().notNull(),
    message: text("message"),
    build: jsonb("build").$type<AppDraftBuild>(),
    /** What the agent's turns had read when they wrote this version or an earlier one. */
    taintScopes: text("taint_scopes").array().notNull().default(sql`'{}'::text[]`),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.draftId, table.n] }),
    index("app_draft_versions_org_fk_idx").on(table.orgId),
    index("app_draft_versions_created_by_fk_idx")
      .on(table.createdBy)
      .where(sql`${table.createdBy} IS NOT NULL`),
  ],
)

/** Built bytes by sha256, per draft; pruned with the versions that name them. */
export const appBuildArtifacts = kernel.table(
  "app_build_artifacts",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => appDrafts.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    kind: text("kind").$type<AppBuildArtifactKind>().notNull(),
    bytes: bytea("bytes").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.draftId, table.sha256] }),
    index("app_build_artifacts_org_fk_idx").on(table.orgId),
  ],
)

/**
 * A line a custom app or a draft preview logged (ctx.logger), tagged with its
 * run's read scopes. FORCE RLS: written by system actors only, read by holders
 * of kernel:apps:logs covering every tag; draft preview lines by their run's
 * person only.
 */
export const appLogs = kernel.table(
  "app_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    app: text("app").notNull(),
    draftId: uuid("draft_id").references(() => appDrafts.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    scopeTags: text("scope_tags").array().notNull().default(sql`'{}'::text[]`),
    level: text("level").$type<AppLogLevel>().notNull(),
    message: text("message").notNull(),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("app_logs_app_at_idx").on(table.orgId, table.app, table.at.desc()),
    index("app_logs_draft_fk_idx")
      .on(table.draftId, table.at.desc())
      .where(sql`${table.draftId} IS NOT NULL`),
    index("app_logs_actor_user_fk_idx")
      .on(table.actorUserId)
      .where(sql`${table.actorUserId} IS NOT NULL`),
    index("app_logs_at_idx").on(table.at),
  ],
)

export type AppDraftRow = typeof appDrafts.$inferSelect
export type AppDraftVersionRow = typeof appDraftVersions.$inferSelect
export type AppBuildArtifactRow = typeof appBuildArtifacts.$inferSelect
export type AppLogRow = typeof appLogs.$inferSelect
