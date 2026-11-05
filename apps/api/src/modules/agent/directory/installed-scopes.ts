// SPDX-License-Identifier: FSL-1.1-ALv2
import { inArray } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel"

/**
 * What a hand-written ceiling may name beyond this build's own registry
 * (`ceiling-guard.ts`, `alsoKnown`): the scopes an app installed at runtime
 * declares. Shared by every writer of a role agent's ceiling (the config
 * provisioner, a granted scope request) so "is this scope real here" has one
 * answer. Scopes granted by the active version of every app installed on this
 * instance.
 */
export async function installedAppScopes(tx: PrivilegedDb): Promise<string[]> {
  const active = await tx
    .select({ name: appsActiveVersion.name, version: appsActiveVersion.version })
    .from(appsActiveVersion)
  if (active.length === 0) return []
  const rows = await tx
    .select({
      name: appsInstalled.name,
      version: appsInstalled.version,
      grantedScopes: appsInstalled.grantedScopes,
    })
    .from(appsInstalled)
    .where(
      inArray(
        appsInstalled.name,
        active.map((a) => a.name),
      ),
    )
  const activeVersion = new Map(active.map((a) => [a.name, a.version]))
  return rows
    .filter((r) => activeVersion.get(r.name) === r.version)
    .flatMap((r) => r.grantedScopes ?? [])
}
