// SPDX-License-Identifier: FSL-1.1-ALv2
// What the platform and the operator vouch for, per installed app.
//
// An installed (`.liaisonapp`) app is third-party code. Its backend runs in the
// QuickJS sandbox, but its interface (`ui.js`) is a plain JS module the web client
// imports into the main origin, with the user's session. So the interface may only
// load when somebody accountable has vouched for the exact bytes:
//
//   first-party       the artifact is the image's own catalog tarball, and the
//                     install dir is byte-identical to it
//   publisher-signed  the install carries a cosign bundle that `verifyAppPackage`
//                     verified against the operator's LIAISON_TRUSTED_APP_PUBLISHERS
//   admin-approved    an admin explicitly approved "this app's interface runs with
//                     full access to your session" (recorded on the install row)
//
// Apps shipped in-tree (no `apps_installed` row) are part of the image and are
// not installed apps; they report `installed: false`.
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { isCatalogArtifact, isCatalogInstall } from "~/modules/apps/catalog"
import { getInstallRoot } from "~/modules/apps/discover-apps"

export type UiTrustReason = "first-party" | "publisher-signed" | "admin-approved"

export interface InstallTrust {
  /** False for in-tree apps (no install row): they ship in the image. */
  installed: boolean
  version?: string
  firstParty: boolean
  publisherSigned: boolean
  uiApproved: boolean
  /** Why the interface may load; null when it may not. */
  uiTrust: UiTrustReason | null
  grantedScopes: string[]
  /** null = grandfathered install (pre-dates capability grants): all declared. */
  grantedCapabilities: string[] | null
  /** The outbound domains granted (egress-grants.ts); null = grandfathered (all declared). */
  grantedDomains: string[] | null
}

const TTL_MS = 5_000
const cache = new Map<string, { at: number; value: InstallTrust }>()
// Byte-identity of an install dir against the baked tarball is immutable for a given
// (name, version, sha256): hash the dir once.
const firstPartyMemo = new Map<string, boolean>()

export function resetInstallTrustCache(name?: string): void {
  if (name) cache.delete(name)
  else {
    cache.clear()
    firstPartyMemo.clear()
  }
}

const IN_TREE: InstallTrust = {
  installed: false,
  firstParty: true,
  publisherSigned: false,
  uiApproved: false,
  uiTrust: "first-party",
  grantedScopes: [],
  grantedCapabilities: null,
  grantedDomains: null,
}

export async function getInstallTrust(name: string): Promise<InstallTrust> {
  const hit = cache.get(name)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = await loadInstallTrust(name)
  cache.set(name, { at: Date.now(), value })
  return value
}

async function loadInstallTrust(name: string): Promise<InstallTrust> {
  const found = await withSystemDb("install-trust", async (db) => {
    const [active] = await db
      .select()
      .from(appsActiveVersion)
      .where(eq(appsActiveVersion.name, name))
      .limit(1)
    if (!active) return { active: false as const }
    const installed = await db.select().from(appsInstalled).where(eq(appsInstalled.name, name))
    return {
      active: true as const,
      version: active.version,
      row: installed.find((r) => r.version === active.version) ?? null,
    }
  })
  // No active version: not a runtime-installed app (in-tree apps ship in the image).
  if (!found.active) return IN_TREE
  // An active version with no install record has no voucher and no grant: fail closed.
  if (!found.row) {
    return {
      installed: true,
      version: found.version,
      firstParty: false,
      publisherSigned: false,
      uiApproved: false,
      uiTrust: null,
      grantedScopes: [],
      grantedCapabilities: [],
      grantedDomains: [],
    }
  }
  const row = found.row
  const memoKey = `${row.name}@${row.version}@${row.sha256}`
  let firstParty = firstPartyMemo.get(memoKey)
  if (firstParty === undefined) {
    firstParty =
      isCatalogArtifact(row.name, row.version, row.sha256) &&
      isCatalogInstall(row.name, row.version, join(getInstallRoot(), row.name, row.version))
    firstPartyMemo.set(memoKey, firstParty)
  }
  const publisherSigned = !!row.signatureBundle
  const uiApproved = !!row.uiFullAccessApprovedAt
  const uiTrust: UiTrustReason | null = firstParty
    ? "first-party"
    : publisherSigned
      ? "publisher-signed"
      : uiApproved
        ? "admin-approved"
        : null
  return {
    installed: true,
    version: row.version,
    firstParty,
    publisherSigned,
    uiApproved,
    uiTrust,
    grantedScopes: row.grantedScopes,
    grantedCapabilities: row.grantedCapabilities ?? null,
    grantedDomains: row.grantedDomains ?? null,
  }
}
