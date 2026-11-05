// SPDX-License-Identifier: FSL-1.1-ALv2
import { eq, sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import {
  appVisibleToOrg,
  assertAppVisibleToOrg,
  filterAppsVisibleToOrg,
} from "~/modules/apps/app-org-scope"
import { manifestRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { getOrgAppState } from "~/modules/apps/org-apps"

/**
 * The enabled-app set is surface curation only — `organizations.settings.enabledApps`.
 * No request-path enforcement reads it; security stays scopes + RLS.
 */
export async function getEnabledApps(orgId: string): Promise<string[]> {
  const names = await withSystemDb("enabled-apps-read", async (db) => {
    const [row] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
    const raw = (row?.settings as Record<string, unknown> | undefined)?.enabledApps
    return Array.isArray(raw) ? (raw as string[]) : []
  })
  // Another org's custom app is never enabled here (app-org-scope.ts).
  return filterAppsVisibleToOrg(names, orgId, (n) => n)
}

export async function isAppRegistered(orgId: string, appName: string): Promise<boolean> {
  if (!(await appVisibleToOrg(appName, orgId))) return false
  await ensureAppsForOrg(orgId)
  return manifestRegistry.get([orgId, appName]) !== undefined
}

/**
 * The state an On/Off switch would leave unchanged: "on" for an active app (no
 * row means never turned Off), "off" for a disabled one. An app in `error` or
 * `removed` is neither: switching it does real work.
 */
export async function settledAppState(
  orgId: string,
  appName: string,
): Promise<"on" | "off" | null> {
  const status = (await getOrgAppState(orgId, appName))?.status
  if (status === undefined || status === "active") return "on"
  return status === "disabled" ? "off" : null
}

/**
 * Is the app on for the people of the workspace: registered and active? This
 * is what the person sees (its pages and tools are there), whatever the
 * `enabledApps` curation list says: an app on but missing from that list is
 * still on, and "enabling" it changes nothing anyone sees.
 */
export async function appIsOn(orgId: string, appName: string): Promise<boolean> {
  if (!(await isAppRegistered(orgId, appName))) return false
  return (await settledAppState(orgId, appName)) === "on"
}

/**
 * An app that is already on, recorded in the `enabledApps` curation list when
 * it is missing there (the list keeps a catalog app installed and names the
 * apps whose connections setup_state follows). Changes nothing anyone sees, so
 * a no-change answer may record it without asking anyone.
 */
export async function recordAppOn(orgId: string, appName: string): Promise<void> {
  if ((await getEnabledApps(orgId)).includes(appName)) return
  await enableApp(orgId, appName)
}

/**
 * Idempotently enable `appName` for the org. Returns whether this call actually
 * appended the app (`true` = it was newly enabled this run; `false` = it was
 * already enabled, a no-op). The boolean lets callers (the provisioner) report
 * `changed` vs `unchanged` accurately rather than always reporting a change.
 */
export async function enableApp(orgId: string, appName: string): Promise<boolean> {
  await assertAppVisibleToOrg(appName, orgId)
  // The search settings already cover the whole catalog (the setup step applies
  // them), so enabling an app for one org changes nothing there.
  return writeEnabledApp(orgId, appName)
}

async function writeEnabledApp(orgId: string, appName: string): Promise<boolean> {
  return withSystemDb("enabled-apps-write", async (db) => {
    // Append-if-absent inside one UPDATE; dedupe via DISTINCT over the merged
    // text array (idempotent re-enable). A `prior` CTE snapshots the PRE-update
    // membership (RETURNING sees the NEW row, so the post-UPDATE `settings`
    // already contains the app) — `already_enabled` reflects the state BEFORE the
    // merge so the caller can distinguish a newly-enabled app from a no-op.
    const rows = await db.execute(sql`
      WITH prior AS (
        SELECT (coalesce(settings -> 'enabledApps', '[]'::jsonb) ? ${appName}) AS already_enabled
        FROM ${organizations}
        WHERE id = ${orgId}
      )
      UPDATE ${organizations}
      SET settings = jsonb_set(
        coalesce(settings, '{}'::jsonb),
        '{enabledApps}',
        (
          SELECT to_jsonb(coalesce(array_agg(DISTINCT e), ARRAY[]::text[]))
          FROM jsonb_array_elements_text(
            coalesce(settings -> 'enabledApps', '[]'::jsonb) || to_jsonb(${appName}::text)
          ) AS e
        ),
        true
      ),
      updated_at = now()
      FROM prior
      WHERE id = ${orgId}
      RETURNING prior.already_enabled
    `)
    const [row] = extractRows<{ already_enabled: boolean }>(rows)
    // No row → org not found (caller's invariant violation); treat as no change.
    return row ? row.already_enabled === false : false
  })
}
