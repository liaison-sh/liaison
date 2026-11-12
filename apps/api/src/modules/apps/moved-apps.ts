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
//      settings, a knowledge source synced by in-tree kernel code). Each step
//      is generic, idempotent, never deletes its source (an older image that
//      still carries the in-tree app keeps working after a rollback) and is
//      recorded once done in `kernel.app_adoptions` (migration 0293).
//
// Release ordering: an image that no longer carries an in-tree app must carry
// its catalog app. When it does not, the reconcile reports the app as failed,
// so the deploy's strict setup step stops before any new process starts
// (reconcile-catalog-boot.ts), instead of rolling out an image on which the
// app silently disappeared. `moved-apps.test.ts` holds the same rule for the
// repository: every name here has a `bundled-apps/<name>` and no in-tree dir.

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
}

export type AdoptionStep = OrgSettingToStoreStep | SyncedSourcesToKindStep

export interface MovedApp {
  name: string
  steps: readonly AdoptionStep[]
}

/** Every app that moved from the source tree to the catalog, oldest first. */
export const MOVED_APPS: readonly MovedApp[] = []

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
  const rows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      UPDATE ${KNOWLEDGE}.synced_sources
      SET source_kind = ${step.sourceKind},
          source_config = COALESCE(source_config, '{}'::jsonb),
          updated_at = now()
      WHERE app_name = ${app} AND source_kind IS NULL
      RETURNING id
    `),
  )
  return { state: "done", report: { sources: rows.length } }
}

async function runStep(db: PrivilegedDb, app: string, step: AdoptionStep): Promise<StepOutcome> {
  switch (step.kind) {
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
      if (done.has(step.id)) {
        result.steps.push({ id: step.id, state: "already" })
        continue
      }
      try {
        const outcome = await runStep(db, app.name, step)
        if (outcome.state === "done") await recordStep(db, app.name, step.id, outcome.report)
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
