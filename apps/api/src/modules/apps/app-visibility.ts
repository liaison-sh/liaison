// SPDX-License-Identifier: FSL-1.1-ALv2
// Whether a person may see an app at all: the per-USER layer of app access.
// An app is visible when it declares no scopes (nothing to gate on, and
// historically every app was visible to every member) or when the person holds
// at least one scope it declares (a `*` holder satisfies any, so admins always
// pass). `/api/apps/manifests` filters on it, so an app hidden here has no
// icon, nav or settings page; a read that serves one app's surface uses it too.
import { hasScope } from "~/modules/permissions/permissions"
import { getScopeCatalog } from "~/modules/permissions/scope-catalog"

/** A visibility check for one org, built once from its scope catalog. */
export function appVisibilityFor(
  orgId: string,
  userScopes: readonly string[],
): (appName: string) => boolean {
  // App → its declared scopes (kernel + manifest-contributed, each already
  // tagged with its owning app by the scope catalog).
  const appScopes = new Map<string, string[]>()
  for (const entry of getScopeCatalog(orgId)) {
    const list = appScopes.get(entry.app)
    if (list) list.push(entry.scope)
    else appScopes.set(entry.app, [entry.scope])
  }
  const scopes = [...userScopes]
  return (appName) => {
    const declared = appScopes.get(appName)
    if (!declared || declared.length === 0) return true
    return declared.some((s) => hasScope(s, scopes))
  }
}
