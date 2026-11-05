// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 Task A3 / Code-review I1 — kernel-side reader for
// `manifest.views.detail.<entity>.externalLink`. The manifest schema declares
// the field at install time; this module is the canonical reader so the
// frontend / approval cards / detail panels can resolve a deep link uniformly
// without each app re-implementing template substitution.
//
// `urlTemplate` supports `{{var}}` placeholders. `id` is always available; an
// optional `extraVars` map lets callers inject app-specific variables (e.g.
// the Shopify shop domain). The substitution is intentionally minimal — no
// nested-path resolution, no conditionals. The schema enforces `^https?://`
// at the head of the template, but the same check is re-applied to the
// rendered URL because `extraVars` could in theory point to a non-http
// destination.

import { sql } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { connectionConfigRegistry, viewRegistry } from "~/modules/apps/app-registries"

const K = sql.raw(schemaRef("kernel"))

export interface ResolvedExternalLink {
  url: string
  label: string
}

export interface DetailViewBlock {
  component?: string
  externalLink?: { urlTemplate?: string; label?: string }
}

export interface ViewsBlock {
  detail?: Record<string, DetailViewBlock>
  tabTypes?: Record<string, unknown>
  panels?: Record<string, unknown>
  settings?: unknown
}

const VAR_PATTERN = /\{\{([a-z0-9_]+)\}\}/gi
const URL_SAFE = /^https?:\/\//i

/**
 * Render a template string against `vars`. Unknown variables collapse to an
 * empty string. The renderer is intentionally permissive — invalid renders
 * are caught by the URL-safety check at the call site.
 */
export function renderUrlTemplate(
  template: string,
  vars: Record<string, string | number | undefined>,
): string {
  return template.replace(VAR_PATTERN, (_match, key: string) => {
    const v = vars[key]
    return v === undefined || v === null ? "" : String(v)
  })
}

/**
 * Resolve the externalLink declared on `manifest.views.detail.<entity>` for a
 * given (orgId, appName, entity), substituting `{{id}}` and any `extraVars`.
 * Returns `null` if the app, entity, or externalLink block is not declared.
 *
 * Falls back to org `"*"` lookup so kernel-scoped manifests (cross-org) are
 * honoured, mirroring `resolveReferenceMetadataFromManifests`.
 */
export function getDetailExternalLink(
  orgId: string,
  appName: string,
  entity: string,
  id: string,
  extraVars: Record<string, string | number | undefined> = {},
): ResolvedExternalLink | null {
  const candidates: string[] = orgId ? [orgId, "*"] : ["*"]
  for (const candidate of candidates) {
    const views = viewRegistry.get([candidate, appName]) as ViewsBlock | undefined
    const detail = views?.detail?.[entity]
    const externalLink = detail?.externalLink
    if (!externalLink?.urlTemplate) continue
    const vars: Record<string, string | number | undefined> = { id, ...extraVars }
    const url = renderUrlTemplate(externalLink.urlTemplate, vars)
    if (!URL_SAFE.test(url)) return null
    return {
      url,
      label: externalLink.label ?? "Open in app ↗",
    }
  }
  return null
}

/**
 * Locate an app entity that declares an EXTERNAL-ONLY detail view — a
 * `views.detail.<entity>.externalLink` with no in-app `component` (e.g. a
 * Shopify order, whose in-app detail page was removed in favour of opening the
 * Shopify admin directly). Entities that declare a `component` have an in-app
 * panel and are opened in a tab, not externally, so they return null here.
 * Org-scoped registration wins over the `"*"` wildcard, mirroring
 * `getDetailExternalLink` / `resolveReferenceMetadataFromManifests`.
 */
export function externalOnlyDetail(
  orgId: string,
  app: string,
  entity: string,
): DetailViewBlock | null {
  const candidates: string[] = orgId ? [orgId, "*"] : ["*"]
  for (const candidate of candidates) {
    const views = viewRegistry.get([candidate, app]) as ViewsBlock | undefined
    const detail = views?.detail?.[entity]
    if (!detail) continue
    return detail.externalLink?.urlTemplate && !detail.component ? detail : null
  }
  return null
}

/**
 * Resolve the template variables a detail externalLink needs from the app's
 * active connection — specifically the connection's canonical identifier mapped
 * onto its declared `identifierVar`, normalized back to the bare value the URL
 * template expects (the stored identifier carries the connection's
 * `appendSuffix`, e.g. `acme.myshopify.com`, while the template re-appends it:
 * `https://{{shop}}.myshopify.com/...`). Returns null when no active connection
 * or no identifierVar is known, so the caller degrades to the in-app tab rather
 * than emitting a malformed `https://.myshopify.com/...` link.
 *
 * App (non-kernel) `connected_accounts` rows are RLS-invisible, so callers pass
 * a PRIVILEGED tx (scoped to `orgId`) — a user-RLS tx would never see the row.
 */
export async function resolveConnectionTemplateVars(
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  app: string,
): Promise<Record<string, string> | null> {
  const rows = (await tx.execute(sql`
    SELECT identifier, connection_name
    FROM ${K}.connected_accounts
    WHERE org_id = ${orgId} AND app_name = ${app} AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1`)) as unknown as Array<{ identifier: string; connection_name: string }>
  const row = rows[0]
  if (!row?.identifier) return null

  const connConfig =
    connectionConfigRegistry.get([orgId, app, row.connection_name]) ??
    connectionConfigRegistry.get(["*", app, row.connection_name])
  const identifierVar = connConfig?.identifierVar
  if (!identifierVar) return null

  const suffix = connConfig?.templateVars?.[identifierVar]?.appendSuffix
  let value = row.identifier
  if (suffix && value.toLowerCase().endsWith(suffix.toLowerCase())) {
    value = value.slice(0, value.length - suffix.length)
  }
  return { [identifierVar]: value }
}
