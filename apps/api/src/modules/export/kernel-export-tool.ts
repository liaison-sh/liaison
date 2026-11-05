// SPDX-License-Identifier: FSL-1.1-ALv2
import { exportRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"

/**
 * `kernel.export` agent-tool handler (Phase 13, E5). Admin-scoped — registered
 * in `registerKernelAgentTools` with `scope: "kernel:users:admin"` so a
 * non-admin caller is denied by scope before this runs.
 *
 * Returns a retrievable download reference: an authenticated GET on
 * `/api/export` (same admin scope, same multi-app orchestrator the Admin
 * "Data Export" view uses — parity) which the agent surfaces to the user.
 *
 * Hard failures are surfaced to the agent immediately by *validating* (not
 * by running the full export — that would double the work for a large org,
 * since the GET re-runs the orchestrator on retrieval): zero apps selected,
 * or a requested app that has no registered export handler, are rejected
 * here. A per-app handler throwing at retrieval time is by-design a
 * non-fatal partial-skip recorded in the export manifest, so it does not
 * need to be pre-flighted.
 */
export interface KernelExportToolCtx {
  orgId: string
  userId: string
}

export interface KernelExportParams {
  appName?: string
  appNames?: string[]
  format?: "json" | "csv"
  dateRange?: { from?: string; to?: string }
}

export async function handleKernelExport(
  params: KernelExportParams,
  ctx: KernelExportToolCtx,
): Promise<
  { downloadRef: string; apps: string[]; format: string; skipped?: string[] } | { error: string }
> {
  const appNames =
    params.appNames && params.appNames.length > 0
      ? params.appNames
      : params.appName
        ? [params.appName]
        : []
  if (appNames.length === 0) {
    return { error: "at least one app must be selected" }
  }
  const format = params.format === "csv" ? "csv" : "json"

  // Pre-flight: split requested apps into those WITH a registered export handler and those without.
  // PARTIAL SUCCESS: an app with no local export handler — a pure live connector that stores no local
  // data (e.g. `shopify`, whose orders are fetched live, not persisted) — is SKIPPED, not a hard error,
  // so the rest still export. Only a request where NOTHING is exportable is rejected. (The orchestrator
  // at retrieval also records per-app skips, but resolving them here lets the agent report honestly —
  // "exported invoicing; shopify is a live connector with no local data to export" — instead of
  // surfacing a download the user can't fully interpret.)
  await ensureAppsForOrg(ctx.orgId)
  const known = appNames.filter((app) => exportRegistry.get([ctx.orgId, app]))
  const skipped = appNames.filter((app) => !exportRegistry.get([ctx.orgId, app]))
  if (known.length === 0) {
    return { error: `no app with a local export handler in: ${appNames.join(", ")}` }
  }

  // The downloadRef exports only the apps WITH handlers (a connector contributes no local file).
  const downloadRef = `/api/export?apps=${encodeURIComponent(known.join(","))}&format=${format}`
  return { downloadRef, apps: known, format, ...(skipped.length > 0 ? { skipped } : {}) }
}
