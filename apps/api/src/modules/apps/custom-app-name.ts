// SPDX-License-Identifier: FSL-1.1-ALv2
// The name shape of an org-private custom app (every edition): `<base>-o<orgKey>`,
// orgKey = the first 8 hex of sha256(org id). Pure, so the sandbox worker pool can
// tell a tenant's code apart without a database read (app-org-scope.ts has the rest).
const CUSTOM_SUFFIX = /-o([0-9a-f]{8})$/

/** The org key a custom-app-shaped name carries, or null for any other name. */
export function customAppNameKey(name: string): string | null {
  return CUSTOM_SUFFIX.exec(name)?.[1] ?? null
}

/** The base of a custom-app-shaped name (the name without its org suffix). */
export function customAppBase(name: string): string {
  return name.replace(CUSTOM_SUFFIX, "")
}

/**
 * The tenant whose budget a sandbox execution of app `name` counts against:
 * `org:<orgKey>` for an org's custom app, undefined for every other app
 * (catalog, in-tree and instance apps keep the shared pool rules). The name
 * alone decides: no instance app can carry the custom shape (the install
 * refuses it, on every edition).
 */
export function sandboxTenantKey(name: string | undefined): string | undefined {
  if (!name) return undefined
  const key = customAppNameKey(name)
  return key === null ? undefined : `org:${key}`
}
