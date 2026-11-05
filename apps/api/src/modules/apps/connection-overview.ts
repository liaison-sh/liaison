// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What Settings > Apps shows about an app's connections, in one read.
//
// The page used to fetch each app's connection config in its own request and
// render a bare "Connect" whenever any connection was declared, so an app
// whose only connection is an optional CI webhook (Projects) looked
// uninstalled, and only the FIRST connection was reachable (design audit
// 2026-09-30, finding 11). A connection view now carries:
//
// - the public-safe config the connect form needs (a strict whitelist:
//   secret-config keys, OAuth endpoints, allowedDomains and template internals
//   never reach the browser);
// - `optional` and `purpose` from the manifest, so the page can say what a
//   button connects and demote what the app runs fine without;
// - `accounts`: how many active / broken accounts back it. Counts only, never
//   identities, over the org's own connections plus the caller's personal ones
//   (the same set `listConnectionAccounts` already resolves for any member).
//
// The per-app route and the batched route share this builder, so the two can
// never disagree about what is public.

import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { connectionConfigRegistry, manifestRegistry } from "~/modules/apps/app-registries"
import { connectionAdminScope } from "~/modules/apps/connections/admin-scope"
import { normalizeSetupStep, setupStepMarkdown } from "~/modules/connection-guides/connection-setup"

export interface ConnectionAccountCounts {
  active: number
  error: number
}

export interface AppConnectionView {
  name: string
  type: "oauth2" | "credentials"
  description?: string
  credentialFields?: Array<{ name: string; label: string; type: string; required?: boolean }>
  setupGuide?: { summary?: string; steps?: string[]; docsUrl?: string }
  /** Per-store OAuth template variables (keys only, e.g. `["shop"]`). */
  templateVars?: string[]
  /** The app works without it (a webhook, an alternative account...). */
  optional: boolean
  /** A few words naming what it connects ("CI release-status webhook"). */
  purpose?: string
  /** Several org accounts, each named by an identifier the app defines. */
  multiInstance?: true
  /** The scope that administers it for the organization (connect org-owned, share,
   *  disconnect an org account), resolved: the manifest's or `<app>:accounts:admin`. */
  adminScope: string
  accounts: ConnectionAccountCounts
}

/** The declared connections of the org's apps, grouped by app (config only). */
function declaredConnections(
  orgId: string,
  appName?: string,
): Map<string, Array<Omit<AppConnectionView, "accounts">>> {
  const byApp = new Map<string, Array<Omit<AppConnectionView, "accounts">>>()
  for (const [[, regApp, connName], cfg] of connectionConfigRegistry.entriesOf(orgId)) {
    if (appName !== undefined && regApp !== appName) continue
    if (!manifestRegistry.get([orgId, regApp])) continue
    const templateVarKeys =
      cfg.templateVars && typeof cfg.templateVars === "object"
        ? Object.keys(cfg.templateVars)
        : undefined
    const view: Omit<AppConnectionView, "accounts"> = {
      name: connName,
      type: cfg.type,
      optional: cfg.optional === true,
      adminScope: connectionAdminScope(orgId, regApp, connName),
      ...(cfg.purpose ? { purpose: cfg.purpose } : {}),
      ...(cfg.multiInstance === true ? { multiInstance: true as const } : {}),
      ...(cfg.description ? { description: cfg.description } : {}),
      ...(cfg.credentialFields ? { credentialFields: cfg.credentialFields } : {}),
      // The settings popover shows plain markdown steps: a structured step is
      // rendered with its page and values (connection-setup.ts).
      ...(cfg.setupGuide
        ? {
            setupGuide: {
              ...(cfg.setupGuide.summary ? { summary: cfg.setupGuide.summary } : {}),
              ...(cfg.setupGuide.steps
                ? {
                    steps: cfg.setupGuide.steps.map((s) =>
                      setupStepMarkdown(normalizeSetupStep(s)),
                    ),
                  }
                : {}),
              ...(cfg.setupGuide.docsUrl ? { docsUrl: cfg.setupGuide.docsUrl } : {}),
            },
          }
        : {}),
      ...(templateVarKeys && templateVarKeys.length > 0 ? { templateVars: templateVarKeys } : {}),
    }
    const list = byApp.get(regApp) ?? []
    list.push(view)
    byApp.set(regApp, list)
  }
  return byApp
}

/**
 * Active / error account counts per `app\0connection`, over the org's own
 * connections and the caller's personal ones. One grouped query. Privileged
 * because org-owned app connections are invisible to the RLS policy; the
 * WHERE clause is the whole visibility rule and returns counts only.
 */
async function accountCounts(
  orgId: string,
  userId: string,
  appName?: string,
): Promise<Map<string, ConnectionAccountCounts>> {
  const K = sql.raw(schemaRef("kernel"))
  const rows = await withPrivilegedDb(orgId, "apps-connection-overview", async (tx) =>
    extractRows<{ app_name: string; connection_name: string; status: string; n: number }>(
      await tx.execute(sql`
        SELECT app_name, connection_name, status, count(*)::int AS n
          FROM ${K}.connected_accounts
         WHERE org_id = ${orgId}
           AND status IN ('active', 'error')
           AND (owner_type = 'org' OR owner_id = ${userId})
           ${appName !== undefined ? sql`AND app_name = ${appName}` : sql``}
         GROUP BY app_name, connection_name, status`),
    ),
  )
  const counts = new Map<string, ConnectionAccountCounts>()
  for (const row of rows) {
    const key = `${row.app_name}\u0000${row.connection_name}`
    const entry = counts.get(key) ?? { active: 0, error: 0 }
    if (row.status === "active") entry.active += Number(row.n)
    else entry.error += Number(row.n)
    counts.set(key, entry)
  }
  return counts
}

/**
 * Connection views for every app of the org (or one app), keyed by app name.
 * Apps with no declared connection are absent.
 */
export async function listAppConnectionViews(
  orgId: string,
  userId: string,
  appName?: string,
): Promise<Record<string, AppConnectionView[]>> {
  const declared = declaredConnections(orgId, appName)
  if (declared.size === 0) return {}
  const counts = await accountCounts(orgId, userId, appName)
  const out: Record<string, AppConnectionView[]> = {}
  for (const [app, views] of declared) {
    out[app] = views
      .map((v) => ({
        ...v,
        accounts: counts.get(`${app}\u0000${v.name}`) ?? { active: 0, error: 0 },
      }))
      // Required first, each group in manifest order (the sort is stable).
      .sort((a, b) => Number(a.optional) - Number(b.optional))
  }
  return out
}
