// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An org's own custom apps on a move (P4P-23). They live in rows, in their own
// schema (`app_<name>`) and in package files, so the import alone cannot carry
// them: during the precopy, after pass 1 created the org (`incoming`) on the
// target, the source sends each app's stored package and the target installs
// it through the ordinary install (`installAppFromTarball`, org-private, the
// same grants), which creates its schema. Pass 1b then brings the app's rows
// (its tables were left out of pass 1) and overwrites the install's registry
// rows with the source's. An abort purges the incoming org, and the org purge
// uninstalls its custom apps, so nothing of them stays on the target.
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { packageKey } from "~/modules/apps/package-store"
import { MAX_PACKAGE_BYTES } from "~/modules/apps/verify-package"
import { query, type TransferSql } from "./closure"
import { type CustomAppRef, orgCustomApps } from "./export"

export interface CustomAppPackage extends CustomAppRef {
  /** The `.liaisonapp` bytes, base64. */
  b64: string
  installedBy: string
  grantedScopes: string[]
  grantedConnections: string[]
  grantedCapabilities: string[]
  grantedCrossAppCalls: string[]
  approveUiFullAccess: boolean
}

/** Source: every custom app of the org with its stored package. */
export async function readCustomAppPackages(
  sql: TransferSql,
  orgId: string,
  read: (key: string) => Promise<Buffer> = (key) =>
    getObjectBuffer(key, undefined, { maxBytes: MAX_PACKAGE_BYTES }),
): Promise<CustomAppPackage[]> {
  const out: CustomAppPackage[] = []
  for (const app of await orgCustomApps(sql, orgId)) {
    const [row] = await query<{
      installed_by: string
      granted_scopes: string[]
      granted_connections: string[]
      granted_capabilities: string[] | null
      granted_cross_app_calls: string[] | null
      ui: boolean
    }>(
      sql,
      `SELECT installed_by::text, granted_scopes, granted_connections, granted_capabilities,
              granted_cross_app_calls, ui_full_access_approved_by IS NOT NULL AS ui
         FROM kernel.apps_installed WHERE name = $1 AND version = $2`,
      [app.name, app.version],
    )
    if (!row)
      throw new Error(`org transfer: custom app ${app.name} ${app.version} has no install row`)
    const bytes = await read(packageKey(app.name, app.version))
    const sha = createHash("sha256").update(bytes).digest("hex")
    if (sha !== app.sha256) {
      throw new Error(
        `org transfer: the stored package of ${app.name} ${app.version} is not the installed one`,
      )
    }
    out.push({
      ...app,
      b64: bytes.toString("base64"),
      installedBy: row.installed_by,
      grantedScopes: row.granted_scopes,
      grantedConnections: row.granted_connections,
      grantedCapabilities: row.granted_capabilities ?? [],
      grantedCrossAppCalls: row.granted_cross_app_calls ?? [],
      approveUiFullAccess: row.ui,
    })
  }
  return out
}

/** Target: install each package for the org (which must already be here, `incoming`). */
export async function installCustomAppPackages(
  orgId: string,
  transferId: string,
  packages: readonly CustomAppPackage[],
  install: typeof installAppFromTarball = installAppFromTarball,
): Promise<Array<{ name: string; version: string }>> {
  if (packages.length === 0) return []
  const dir = mkdtempSync(join(tmpdir(), "org-transfer-apps-"))
  try {
    const out: Array<{ name: string; version: string }> = []
    for (const p of packages) {
      const bytes = Buffer.from(p.b64, "base64")
      if (createHash("sha256").update(bytes).digest("hex") !== p.sha256) {
        throw new Error(`org transfer: the package of ${p.name} arrived damaged`)
      }
      const path = join(dir, `${p.name}-${p.version}.liaisonapp`)
      writeFileSync(path, bytes, { mode: 0o600 })
      const r = await install({
        tarballPath: path,
        installedBy: p.installedBy,
        grantedScopes: p.grantedScopes,
        grantedConnections: p.grantedConnections,
        grantedCapabilities: p.grantedCapabilities,
        grantedCrossAppCalls: p.grantedCrossAppCalls,
        approveUiFullAccess: p.approveUiFullAccess,
        requireSignature: false,
        sourceUrl: `transfer:${transferId}`,
        ownerOrgId: orgId,
      })
      if (r.name !== p.name || r.version !== p.version) {
        throw new Error(
          `org transfer: the package of ${p.name} installed as ${r.name} ${r.version}`,
        )
      }
      out.push(r)
    }
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
