// SPDX-License-Identifier: FSL-1.1-ALv2
import { strToU8, zipSync } from "fflate"
import contactsManifest from "~/apps/contacts/app.manifest.json"
import driveManifest from "~/apps/google-drive/app.manifest.json"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import mailManifest from "~/apps/mail/app.manifest.json"
import projectsManifest from "~/apps/projects/app.manifest.json"
import ticketsManifest from "~/apps/tickets/app.manifest.json"
import type { ActorContext } from "~/db/rls"
import { appsLogger as log } from "~/lib/logger"
import { invokeAppExport } from "~/modules/export/invoke-export"

const APP_VERSIONS: Record<string, string> = {
  tickets: (ticketsManifest as { version: string }).version,
  projects: (projectsManifest as { version: string }).version,
  knowledge: (knowledgeManifest as { version: string }).version,
  mail: (mailManifest as { version: string }).version,
  contacts: (contactsManifest as { version: string }).version,
  "google-drive": (driveManifest as { version: string }).version,
}

export interface ExportManifest {
  apps: string[]
  schemaVersions: Record<string, string>
  files: Record<string, string>
  skipped: Array<{ app: string; reason: string }>
}

export interface ExportAppsArgs {
  orgId: string
  actor: ActorContext
  appNames: string[]
  dateRange?: { from?: string; to?: string }
  format: "json" | "csv"
}

/**
 * Multi-app export orchestrator (Phase 13, E2). Streams each selected app's
 * export (via the shared {@link invokeAppExport} path, so RLS is never
 * escalated) into a single zip plus a `manifest.json` describing apps, schema
 * versions, file mappings, and per-app skip reasons.
 *
 * Partial success: an app with no export handler for the requested format, or
 * whose handler throws, is recorded in `manifest.json` as skipped-with-reason
 * while every other app still exports. Zero apps selected → validation error
 * before any work. An empty result set still yields a valid (empty) file plus
 * the manifest.
 */
export async function exportApps(args: ExportAppsArgs): Promise<Uint8Array> {
  return (await exportAppsWithManifest(args)).zip
}

/**
 * Same orchestration as {@link exportApps} but also returns the parsed
 * `manifest.json` so a caller (the Admin Data Export route) can surface the
 * per-app skip list to the UI without unzipping the download.
 */
export async function exportAppsWithManifest(
  args: ExportAppsArgs,
): Promise<{ zip: Uint8Array; manifest: ExportManifest }> {
  const { orgId, actor, appNames, format, dateRange } = args
  if (!appNames || appNames.length === 0) {
    throw new Error("exportApps: at least one app must be selected")
  }

  const files: Record<string, Uint8Array> = {}
  const manifest: ExportManifest = {
    apps: [],
    schemaVersions: {},
    files: {},
    skipped: [],
  }

  for (const app of appNames) {
    try {
      const result = await invokeAppExport(orgId, app, format, actor, { dateRange })
      const fileName = `${app}.${format}`
      const content = typeof result === "string" ? result : JSON.stringify(result ?? [], null, 2)
      files[fileName] = strToU8(content)
      manifest.apps.push(app)
      manifest.schemaVersions[app] = APP_VERSIONS[app] ?? "unknown"
      manifest.files[app] = fileName
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.warn({ app, reason }, "export orchestrator: app skipped")
      manifest.skipped.push({ app, reason })
    }
  }

  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2))
  return { zip: zipSync(files, { level: 6 }), manifest }
}
