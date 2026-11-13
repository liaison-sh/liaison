// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Apps that used to ship in the server's source tree (`apps/api/src/apps/<name>`)
// and now ship as catalog apps (`bundled-apps/<name>`) under the SAME name.
//
// An instance that ran the in-tree app keeps everything it had, in place:
//   1. The catalog reconcile (catalog.ts) installs the catalog app on an
//      instance that registered the in-tree one (a `kernel.apps` row of that
//      name), even though no org lists it in `enabledApps`. Every row keyed by
//      the app's name stays valid as it is: per-org registrations
//      (`kernel.apps`, status and config kept by the upsert), connected
//      accounts and their encrypted credentials, OAuth client keys, role
//      scopes, the app's schema and its rows, synced knowledge sources and the
//      documents and identities they hold.
//   2. `adoptMovedApps` then runs the app's data steps, for what the in-tree
//      app kept where the catalog app does not read it (a key of the org's
//      settings, a knowledge source synced by in-tree kernel code, an app's
//      adapter tables the platform now holds). Each step is generic,
//      idempotent and never deletes its source: the previous release, still
//      running during a rolling deploy, keeps reading what it read. A step is
//      recorded once done in `kernel.app_adoptions` (migration 0294), except a
//      step that copies rows the previous release may still write: that one
//      runs at every boot.
//
//      This is not a rollback path: an older image is refused by the schema
//      guard (db/schema-guard.ts) once these migrations ran, and what the steps
//      changed is read only by the new code. Rolling back means the release
//      switch (the previous release's executor) or a restore from backup.
//
// Release ordering: an image that no longer carries an in-tree app must carry
// its catalog app. When it does not, the reconcile reports the app as failed,
// so the deploy's strict setup step stops before any new process starts
// (reconcile-catalog-boot.ts), instead of rolling out an image on which the
// app silently disappeared. `moved-apps.test.ts` holds the same rule for the
// repository: every name here has a `bundled-apps/<name>` and no in-tree dir.
//
// Each moved app is declared in a file of its own, `moved-apps.d/<name>.json`
// (`readMovedApps`), and its move's test goes in a file of its own too, so two
// apps that move in parallel pull requests touch no file in common here.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { extractRows } from "~/db"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"

const K = drizzleSql.raw(schemaRef("kernel"))
const KNOWLEDGE = drizzleSql.raw(schemaRef("app_knowledge"))

/** Move one key of the org's settings into the app's own store (`ctx.store`). */
export interface OrgSettingToStoreStep {
  id: string
  kind: "org-setting-to-store"
  /** Path in `kernel.organizations.settings`, e.g. `["database", "domainAccess"]`. */
  settingPath: readonly string[]
  /** Where the catalog app reads it: `ctx.store.get(collection, docId)`, data `{ value }`. */
  collection: string
  docId: string
}

/**
 * Hand the app's synced knowledge sources that in-tree kernel code synced (no
 * `source_kind`) to the app's manifest `knowledgeSources.<sourceKind>` handler.
 * Documents and source identities are keyed by (org, app name, external id),
 * so the handler's first pass updates the same documents in place.
 */
export interface SyncedSourcesToKindStep {
  id: string
  kind: "synced-sources-to-kind"
  sourceKind: string
  /** Only the sources with exactly this `folder_ref` (default: every one with no kind yet). */
  folderRef?: string
  /**
   * Config keys filled from the source's own columns (`folder_ref`,
   * `source_account`), for a kind whose handler reads the folder or the account
   * from its config. A column with no value adds no key.
   */
  configFromColumns?: Readonly<Record<string, "folder_ref" | "source_account">>
}

/**
 * Copy an app's API connection adapters (and their kept versions) from the
 * app's own tables into the platform's (`kernel.api_adapters`, migration 0300),
 * keyed by the app and its API connection. Runs at every boot (never recorded):
 * the previous release writes the app's tables until it drains, so a row it
 * saved after the first copy is copied at the next boot, a newer one replacing
 * the platform's only when it is newer. The source rows are never deleted.
 */
export interface ApiAdaptersToPlatformStep {
  id: string
  kind: "api-adapters-to-platform"
  /** The app's API connection (the one with an `api` block). */
  connection: string
  /** The app's tables, `<schema>` without a prefix: `adapters` and `adapter_versions`. */
  schema: string
}

export type AdoptionStep =
  | OrgSettingToStoreStep
  | SyncedSourcesToKindStep
  | ApiAdaptersToPlatformStep

/** Steps that run at every boot rather than once. */
const REPEATED_STEPS: ReadonlySet<AdoptionStep["kind"]> = new Set(["api-adapters-to-platform"])

export interface MovedApp {
  name: string
  steps: readonly AdoptionStep[]
}

/** Where the moved apps are declared: one `<name>.json` per app (see `readMovedApps`). */
export const MOVED_APPS_DIR = join(import.meta.dir, "moved-apps.d")

const COLUMNS = new Set(["folder_ref", "source_account"])

function parseStep(raw: unknown, where: string): AdoptionStep {
  const fail = (why: string): never => {
    throw new Error(`${where}: ${why}`)
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("a step is an object")
  const s = raw as Record<string, unknown>
  const text = (k: string): string =>
    typeof s[k] === "string" && s[k] !== "" ? (s[k] as string) : fail(`step "${k}" is a string`)
  if (s.kind === "org-setting-to-store") {
    const path = s.settingPath
    if (!Array.isArray(path) || path.length === 0 || !path.every((p) => typeof p === "string")) {
      return fail("settingPath is a list of keys")
    }
    return {
      id: text("id"),
      kind: "org-setting-to-store",
      settingPath: path as string[],
      collection: text("collection"),
      docId: text("docId"),
    }
  }
  if (s.kind === "synced-sources-to-kind") {
    const step: SyncedSourcesToKindStep = {
      id: text("id"),
      kind: "synced-sources-to-kind",
      sourceKind: text("sourceKind"),
    }
    if (s.folderRef !== undefined) step.folderRef = text("folderRef")
    if (s.configFromColumns !== undefined) {
      const cols = s.configFromColumns
      if (!cols || typeof cols !== "object" || Array.isArray(cols)) {
        return fail("configFromColumns maps config keys to columns")
      }
      for (const v of Object.values(cols)) {
        if (typeof v !== "string" || !COLUMNS.has(v)) {
          fail(`configFromColumns names folder_ref or source_account, not ${JSON.stringify(v)}`)
        }
      }
      step.configFromColumns = cols as Record<string, "folder_ref" | "source_account">
    }
    return step
  }
  if (s.kind === "api-adapters-to-platform") {
    return {
      id: text("id"),
      kind: "api-adapters-to-platform",
      connection: text("connection"),
      schema: text("schema"),
    }
  }
  return fail(`unknown step kind ${JSON.stringify(s.kind)}`)
}

/**
 * The moved apps declared in `dir`, one `<name>.json` per app, in name order:
 * `{ "name": "<name>", "why": "<what moves and why the rest stays>", "steps": [...] }`.
 * One file per app, so two apps that move in parallel pull requests never edit the
 * same list. A file whose name differs from its `name`, a step that is not one of
 * the kinds above, or a repeated step id throws: the catalog reconcile then fails
 * loudly instead of skipping an app's data.
 */
export function readMovedApps(dir: string = MOVED_APPS_DIR): MovedApp[] {
  const out: MovedApp[] = []
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const where = `moved-apps.d/${file}`
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>
    const name = file.slice(0, -".json".length)
    if (raw.name !== name) throw new Error(`${where}: "name" must be "${name}"`)
    if (typeof raw.why !== "string" || raw.why.length < 10) {
      throw new Error(`${where}: "why" says what moves and why the rest stays`)
    }
    if (!Array.isArray(raw.steps)) throw new Error(`${where}: "steps" is a list`)
    const steps = raw.steps.map((s, i) => parseStep(s, `${where} step ${i}`))
    const ids = steps.map((s) => s.id)
    if (new Set(ids).size !== ids.length) throw new Error(`${where}: step ids repeat`)
    out.push({ name, steps })
  }
  return out
}

/** Every app that moved from the source tree to the catalog (`moved-apps.d/<name>.json`). */
export const MOVED_APPS: readonly MovedApp[] = readMovedApps()

let movedAppsOverride: readonly MovedApp[] | null = null

export function movedApps(): readonly MovedApp[] {
  return movedAppsOverride ?? MOVED_APPS
}

/** Test seam: a moved-app list of fixture apps (null restores the real one). */
export const MovedAppsTestAccess = {
  set(apps: readonly MovedApp[] | null): void {
    movedAppsOverride = apps
  },
}

/**
 * The moved apps this instance used while they were in-tree: a `kernel.apps`
 * row of the name exists (every org the in-tree app registered for has one).
 * `inTreeNames` excludes an app this image still carries in its source tree
 * (an older image, or the release before the move): it registers from there.
 */
export async function usedMovedApps(
  db: PrivilegedDb,
  inTreeNames: ReadonlySet<string>,
): Promise<string[]> {
  const names = movedApps()
    .map((a) => a.name)
    .filter((n) => !inTreeNames.has(n))
  if (names.length === 0) return []
  const rows = extractRows<{ name: string }>(
    await db.execute(drizzleSql`
      SELECT DISTINCT name FROM ${K}.apps
      WHERE name IN (${drizzleSql.join(
        names.map((n) => drizzleSql`${n}`),
        drizzleSql`, `,
      )})
    `),
  )
  return rows.map((r) => r.name)
}

export type StepOutcome =
  | { state: "done"; report: Record<string, unknown> }
  | { state: "already" }
  | { state: "deferred"; reason: string }
  | { state: "failed"; error: string }

export interface AdoptionResult {
  app: string
  steps: Array<{ id: string } & StepOutcome>
}

async function completedSteps(db: PrivilegedDb, app: string): Promise<Set<string>> {
  const rows = extractRows<{ step_id: string }>(
    await db.execute(drizzleSql`SELECT step_id FROM ${K}.app_adoptions WHERE app_name = ${app}`),
  )
  return new Set(rows.map((r) => r.step_id))
}

async function recordStep(
  db: PrivilegedDb,
  app: string,
  stepId: string,
  report: Record<string, unknown>,
): Promise<void> {
  await db.execute(drizzleSql`
    INSERT INTO ${K}.app_adoptions (app_name, step_id, report)
    VALUES (${app}, ${stepId}, ${JSON.stringify(report)}::jsonb)
    ON CONFLICT (app_name, step_id) DO NOTHING
  `)
}

async function runOrgSettingToStore(
  db: PrivilegedDb,
  app: string,
  step: OrgSettingToStoreStep,
): Promise<Record<string, unknown>> {
  const path = `{${step.settingPath.join(",")}}`
  const orgs = extractRows<{ id: string; value: unknown }>(
    await db.execute(drizzleSql`
      SELECT id, settings #> ${path}::text[] AS value
      FROM ${K}.organizations
      WHERE settings #> ${path}::text[] IS NOT NULL
        AND jsonb_typeof(settings #> ${path}::text[]) <> 'null'
      ORDER BY id
    `),
  )
  const { getDocument, setDocument } = await import("~/modules/data-store/service")
  let copied = 0
  let kept = 0
  for (const org of orgs) {
    const value = typeof org.value === "string" ? JSON.parse(org.value) : org.value
    const caller = { orgId: org.id, app, userId: null }
    const wrote = await withRlsContext(
      { actorType: "system", orgId: org.id, purpose: "job" },
      async (tx) => {
        // A document the app already holds is the app's: never overwritten.
        if (await getDocument(tx, caller, step.collection, step.docId)) return false
        await setDocument(tx, caller, step.collection, step.docId, { value }, { ifVersion: 0 })
        return true
      },
    )
    if (wrote) copied++
    else kept++
  }
  return { orgs: orgs.length, copied, kept }
}

async function columnExists(
  db: PrivilegedDb,
  schema: string,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = extractRows(
    await db.execute(drizzleSql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = ${table} AND column_name = ${column}
    `),
  )
  return rows.length > 0
}

async function runSyncedSourcesToKind(
  db: PrivilegedDb,
  app: string,
  step: SyncedSourcesToKindStep,
): Promise<StepOutcome> {
  // The columns come with the knowledge app's schema (knowledge 1.0.9). On an
  // instance whose knowledge schema is older the step waits for a later boot.
  if (!(await columnExists(db, schemaRef("app_knowledge"), "synced_sources", "source_kind"))) {
    return { state: "deferred", reason: "app_knowledge.synced_sources.source_kind is missing" }
  }
  const fromColumns = Object.entries(step.configFromColumns ?? {})
  const config =
    fromColumns.length === 0
      ? drizzleSql`'{}'::jsonb`
      : drizzleSql`jsonb_strip_nulls(jsonb_build_object(${drizzleSql.join(
          fromColumns.map(
            ([key, column]) =>
              drizzleSql`${key}::text, ${column === "folder_ref" ? drizzleSql`folder_ref` : drizzleSql`source_account`}`,
          ),
          drizzleSql`, `,
        )}))`
  const rows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      UPDATE ${KNOWLEDGE}.synced_sources
      SET source_kind = ${step.sourceKind},
          source_config = COALESCE(source_config, '{}'::jsonb) || ${config},
          updated_at = now()
      WHERE app_name = ${app} AND source_kind IS NULL
        ${step.folderRef !== undefined ? drizzleSql`AND folder_ref = ${step.folderRef}` : drizzleSql``}
      RETURNING id
    `),
  )
  return { state: "done", report: { sources: rows.length } }
}

async function tableExists(db: PrivilegedDb, schema: string, table: string): Promise<boolean> {
  const rows = extractRows(
    await db.execute(drizzleSql`
      SELECT 1 FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = ${table}
    `),
  )
  return rows.length > 0
}

async function runApiAdaptersToPlatform(
  db: PrivilegedDb,
  app: string,
  step: ApiAdaptersToPlatformStep,
): Promise<StepOutcome> {
  const schema = schemaRef(step.schema)
  if (!(await tableExists(db, schema, "adapters"))) {
    return { state: "done", report: { adapters: 0, versions: 0 } }
  }
  const S = drizzleSql.raw(schema)
  const adapters = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO ${K}.api_adapters
        (org_id, app_name, connection_name, identifier, adapter, adapter_version, updated_by,
         created_at, updated_at)
      SELECT org_id, ${app}, ${step.connection}, identifier, adapter, adapter_version, updated_by,
             created_at, updated_at
      FROM ${S}.adapters
      ON CONFLICT (org_id, app_name, connection_name, identifier) DO UPDATE SET
        adapter = EXCLUDED.adapter,
        adapter_version = EXCLUDED.adapter_version,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at
      WHERE ${K}.api_adapters.updated_at < EXCLUDED.updated_at
      RETURNING id
    `),
  )
  let versions = 0
  if (await tableExists(db, schema, "adapter_versions")) {
    versions = extractRows(
      await db.execute(drizzleSql`
        INSERT INTO ${K}.api_adapter_versions
          (id, org_id, app_name, connection_name, identifier, adapter, adapter_version, saved_by,
           saved_at, created_at)
        SELECT id, org_id, ${app}, ${step.connection}, identifier, adapter, adapter_version,
               saved_by, saved_at, created_at
        FROM ${S}.adapter_versions
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `),
    ).length
    // The platform keeps the newest ADAPTER_HISTORY_LIMIT per connection, as a save does.
    await db.execute(drizzleSql`
      DELETE FROM ${K}.api_adapter_versions v
      WHERE v.app_name = ${app} AND v.connection_name = ${step.connection}
        AND v.id IN (
          SELECT id FROM (
            SELECT id, row_number() OVER (
              PARTITION BY org_id, identifier ORDER BY created_at DESC, saved_at DESC) AS n
            FROM ${K}.api_adapter_versions
            WHERE app_name = ${app} AND connection_name = ${step.connection}
          ) ranked WHERE n > ${ADAPTER_HISTORY_LIMIT})
    `)
  }
  return { state: "done", report: { adapters: adapters.length, versions } }
}

/** Kept previous adapter documents per connection (connections/api/store.ts). */
const ADAPTER_HISTORY_LIMIT = 20

async function runStep(db: PrivilegedDb, app: string, step: AdoptionStep): Promise<StepOutcome> {
  switch (step.kind) {
    case "api-adapters-to-platform":
      return runApiAdaptersToPlatform(db, app, step)
    case "org-setting-to-store":
      return { state: "done", report: await runOrgSettingToStore(db, app, step) }
    case "synced-sources-to-kind":
      return runSyncedSourcesToKind(db, app, step)
  }
}

/**
 * Run the data steps of every moved app installed from the catalog (an active
 * version row exists), each step at most once per instance. A failed step is
 * reported and retried at the next boot; the steps after it still run.
 */
export async function adoptMovedApps(db: PrivilegedDb): Promise<AdoptionResult[]> {
  const out: AdoptionResult[] = []
  for (const app of movedApps()) {
    if (app.steps.length === 0) continue
    const active = extractRows(
      await db.execute(drizzleSql`SELECT 1 FROM ${K}.apps_active_version WHERE name = ${app.name}`),
    )
    if (active.length === 0) continue
    const done = await completedSteps(db, app.name)
    const result: AdoptionResult = { app: app.name, steps: [] }
    for (const step of app.steps) {
      const repeated = REPEATED_STEPS.has(step.kind)
      if (!repeated && done.has(step.id)) {
        result.steps.push({ id: step.id, state: "already" })
        continue
      }
      try {
        const outcome = await runStep(db, app.name, step)
        if (outcome.state === "done" && !repeated) {
          await recordStep(db, app.name, step.id, outcome.report)
        }
        result.steps.push({ id: step.id, ...outcome })
        log.info({ app: app.name, step: step.id, outcome }, "Moved app: data step")
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        log.error({ err, app: app.name, step: step.id }, "Moved app: data step failed")
        result.steps.push({ id: step.id, state: "failed", error })
      }
    }
    out.push(result)
  }
  return out
}
