// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { index, jsonb, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { bytea } from "./mailbox-keys"
import { kernel } from "./organizations"

/**
 * Persisted snapshot of an app's PDF template inventory. One entry per
 * `pdf_templates[]` from the manifest. `source` is the emitted SANDBOX BUNDLE
 * text — the `templates/<safeName>.js` artifact freeze-app writes
 * (`safeName = kind.replace(/[^A-Za-z0-9._-]+/g, "__")`), a self-contained
 * module that sets `globalThis.renderTemplate`. At render time the kernel
 * evaluates this bundle INSIDE the QuickJS app sandbox (never as host code);
 * the template returns a validated JSON draw-command list which the host
 * replays against pdf-lib (see modules/pdf/replay.ts). It is NOT the manifest's
 * `pdf_templates[].source`, which is a relative `.ts` *path*, not executable
 * content.
 *
 * Persisting these on the install row lets the API process rehydrate the
 * in-memory PDF registry (see modules/pdf/registry-rehydrate.ts) on every
 * boot without re-reading the on-disk .liaisonapp tarball.
 */
export interface InstalledPdfTemplate {
  kind: string
  source: string
}

// Runtime-installed apps (`.liaisonapp` packages). Instance-wide (`orgId` NULL),
// except an org-private custom app of the managed edition, whose rows carry the
// one org that may see and run it (modules/apps/app-org-scope.ts, 0267).
//
// The composite (name, version) primary key lets multiple versions of one app
// coexist in the table. This is required for atomic upgrade swap: the install
// service writes the new version's row, repoints `apps_active_version`, then
// removes the old on-disk version — all without ever leaving the app
// unregistered. It also enables clean rollback (repoint the pointer back).
export const appsInstalled = kernel.table(
  "apps_installed",
  {
    name: text("name").notNull(),
    version: text("version").notNull(),
    // Exact artifact URL this version was installed/upgraded from
    // (may be version-pinned).
    sourceUrl: text("source_url").notNull(),
    // Stable release-channel URL copied out of the manifest's `updateUrl` at
    // install time. `liaison app upgrade` re-fetches THIS, not `sourceUrl`.
    // Null → the app is install-only (no automatic update channel).
    updateUrl: text("update_url"),
    sha256: text("sha256").notNull(),
    signatureBundle: text("signature_bundle"),
    grantedScopes: text("granted_scopes").array().notNull().default([]),
    grantedConnections: text("granted_connections").array().notNull().default([]),
    // Platform capabilities the admin approved. NULL = installed before the
    // column existed: grandfathered with every capability the manifest declares.
    grantedCapabilities: text("granted_capabilities").array(),
    // The cross_app_calls targets (`app:tool`) the admin approved. NULL = grandfathered.
    grantedCrossAppCalls: text("granted_cross_app_calls").array(),
    // The admin's recorded approval that this app's interface (ui.js) runs in the
    // web origin with the user's full session. Not needed for first-party or
    // trusted-publisher-signed installs.
    uiFullAccessApprovedBy: uuid("ui_full_access_approved_by"),
    uiFullAccessApprovedAt: timestamp("ui_full_access_approved_at", { withTimezone: true }),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    installedBy: uuid("installed_by").notNull(),
    // Phase 17 C2 — transpiled PDF template bodies persisted alongside the
    // install row so registry-rehydrate can warm the in-memory map on boot
    // without re-reading the tarball.
    pdfTemplates: jsonb("pdf_templates").$type<InstalledPdfTemplate[]>().notNull().default([]),
    /**
     * The `schema` the version's manifest declared, recorded at install
     * (`{ schema: null }` when it declared none). The additive data rule checks
     * the next version against it when the version's files are gone from the
     * install root. NULL on rows installed before it was recorded.
     */
    manifestSchema: jsonb("manifest_schema").$type<{ schema: unknown }>(),
    /** The org an org-private custom app belongs to; NULL = an instance app (0267). */
    orgId: uuid("org_id"),
    // The operator disabled this custom app (0268, modules/cloud/custom-app-disable.ts):
    // nothing runs it until the operator enables it again. NULL = not disabled.
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    /**
     * An org's custom app version built by the app builder: the sha256 and the
     * bytes of its Workers module, from the build the publish pinned (0278).
     * The Workers executor names this sha in /run (sandbox/run-app.ts) and the
     * cell serves the bytes to the loader (workers/bundle-route.ts). NULL on
     * every other row.
     */
    workerSha256: text("worker_sha256"),
    workerModule: bytea("worker_module"),
  },
  (table) => [
    primaryKey({ columns: [table.name, table.version] }),
    index("apps_installed_org_id_idx").on(table.orgId).where(sql`org_id IS NOT NULL`),
  ],
)

// One row per app names the currently-active (registered) version and the one
// that ran before it. The server keeps both versions' files and `apps_installed`
// rows (older ones are pruned), so a failed activation switches back to
// `previousVersion` and an operator can roll back to it. Written only by the
// activation service (activation.ts). `orgId` is copied from the active
// version's `apps_installed` row: NULL for an instance app, the owning org for
// an org-private custom app (0267).
export const appsActiveVersion = kernel.table("apps_active_version", {
  name: text("name").primaryKey(),
  version: text("version").notNull(),
  previousVersion: text("previous_version"),
  orgId: uuid("org_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Every activation of an app version (migration 0212): the version it left, the
 * one it tried, and whether it ran, switched back after failing its health gate,
 * or was refused. The reason is a code and a redacted message (at most 500
 * characters); the full detail is in the server log. Privileged connection only.
 */
export const appActivationEvents = kernel.table(
  "app_activation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    app: text("app").notNull(),
    fromVersion: text("from_version"),
    toVersion: text("to_version").notNull(),
    outcome: text("outcome", { enum: ["activated", "switched_back", "refused"] }).notNull(),
    reasonCode: text("reason_code"),
    reasonMessage: text("reason_message"),
    actorId: uuid("actor_id"),
    actorKind: text("actor_kind", { enum: ["operator", "system"] }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("app_activation_events_app_at_idx").on(table.app, table.at)],
)
