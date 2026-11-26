// SPDX-License-Identifier: FSL-1.1-ALv2
//
// LIAISON CLOUD, AS THE NATIVE APPS' FIRST SCREEN.
//
// A first launch of the desktop or the phone app asks for a workspace name
// (`acme`) under one cloud domain and builds the server address from it
// (`https://acme.liaison.sh`). Anybody on their own server takes the "self
// hosted" link to the plain address field, which is unchanged.
//
// ONE DOMAIN, SET AT BUILD TIME. `LIAISON_CLOUD_DOMAIN` in the environment of
// the build (apps/web's Vite build, the mobile boot bundle) replaces
// `__LIAISON_CLOUD_DOMAIN__` below. Left unset, the build uses
// DEFAULT_CLOUD_DOMAIN. Set to an empty string (or to something that is not a
// domain), the Cloud screen is off and the address field is the first screen
// again, which is what a fork without a cloud of its own wants.
//
// Kept free of imports so the mobile boot bundle can take it without the rest
// of this package, like server-address.ts.

/** The cloud a build points at when its environment names none. */
export const DEFAULT_CLOUD_DOMAIN = "liaison.sh"

// Replaced at build time (apps/web/vite.config.ts, apps/mobile/scripts/build-mobile.ts).
// Undeclared at runtime anywhere else, which `typeof` tolerates.
declare const __LIAISON_CLOUD_DOMAIN__: string | null | undefined

/** One DNS label: what a workspace name can be. */
const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** `s` without its trailing dots (and leading ones too), in one pass: no regex to backtrack. */
function trimDots(s: string, leading: boolean): string {
  let start = 0
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 46) end--
  if (leading) while (start < end && s.charCodeAt(start) === 46) start++
  return s.slice(start, end)
}

/**
 * The cloud domain a build value means: null or undefined is the default, an
 * empty string turns the Cloud screen off, and anything that is not a dotted
 * host name also turns it off rather than building addresses under it.
 */
export function resolveCloudDomain(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return DEFAULT_CLOUD_DOMAIN
  const domain = trimDots(raw.trim().toLowerCase(), true)
  if (domain === "") return null
  // Two or more DNS labels, each checked on its own (bounded, so no backtracking).
  const labels = domain.split(".")
  return labels.length >= 2 && labels.every((label) => SLUG_SHAPE.test(label)) ? domain : null
}

/** This build's cloud domain, or null when the Cloud screen is off. */
export function buildCloudDomain(): string | null {
  return resolveCloudDomain(
    typeof __LIAISON_CLOUD_DOMAIN__ === "undefined" ? undefined : __LIAISON_CLOUD_DOMAIN__,
  )
}

/** Whether `slug` is a workspace name as the Cloud screen takes it. */
export function isValidWorkspaceSlug(slug: string): boolean {
  return SLUG_SHAPE.test(slug)
}

/**
 * The workspace name in what a person typed or pasted, or null. Takes `acme`,
 * ` Acme `, `acme.liaison.sh` and `https://acme.liaison.sh/anything`; refuses
 * a host under another domain and anything that is not one DNS label.
 */
export function workspaceSlugFromInput(input: string, domain: string): string | null {
  let value = input.trim().toLowerCase()
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  const end = value.search(/[/?#]/)
  if (end >= 0) value = value.slice(0, end)
  value = trimDots(value, false)
  const suffix = `.${domain}`
  if (value.endsWith(suffix)) value = value.slice(0, -suffix.length)
  return isValidWorkspaceSlug(value) ? value : null
}

/** The server address of a workspace. */
export function workspaceAddress(slug: string, domain: string): string {
  return `https://${slug}.${domain}`
}

/**
 * The workspace a server address names, or null when it is not exactly
 * `https://<slug>.<domain>` (a port, a path or a deeper host is a self hosted
 * address, and stays on the address screen).
 */
export function workspaceSlugFromAddress(address: string, domain: string): string | null {
  let url: URL
  try {
    url = new URL(address.trim())
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return null
  if (url.pathname !== "/" && url.pathname !== "") return null
  if (url.search !== "" || url.hash !== "") return null
  const suffix = `.${domain}`
  const host = url.hostname.toLowerCase()
  if (!host.endsWith(suffix)) return null
  const slug = host.slice(0, -suffix.length)
  return isValidWorkspaceSlug(slug) ? slug : null
}

/** The cloud's own pages the Cloud screen links to, in the system browser. */
export type CloudPage = "login" | "signup"

/** `https://<domain>/<page>`, under `/fr` when the app is in French. */
export function cloudPageUrl(domain: string, page: CloudPage, locale: string): string {
  const prefix = locale.toLowerCase().startsWith("fr") ? "/fr" : ""
  return `https://${domain}${prefix}/${page}`
}
