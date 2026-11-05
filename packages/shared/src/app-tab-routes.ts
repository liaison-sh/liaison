// SPDX-License-Identifier: FSL-1.1-ALv2
import { isReservedWebRouteSegment } from "./reserved-web-routes"

/**
 * Who may own a tab `urlPattern`. A tab type's pattern decides which page URL opens it, and a
 * sandboxed app may navigate to, and receives the entity id of, any path that opens one of its
 * own tab types. Dynamic patterns are tried longest first, so without a rule an app declaring
 * `/mail/:entityIdXXXXXXXX` would take `/mail/<id>` from the mail app, `/settings/:x` a Liaison
 * page, and `/:a/:b` every two-segment deep link.
 *
 * The rule: the first segment of every tab pattern is a fixed name, not a Liaison page route,
 * and not owned by another app (its name, or the first segment of one of its tab patterns).
 * An app's own name is always its own; another prefix (`/kpi-catalogue/...`) is its own while
 * no other app claims it. The install, the upgrade and the boot registration refuse an app that
 * breaks it, and the web registry skips such a tab of an installed app.
 */

/** A tab type's pattern as the shell registers it: the declared one, else `/<app>/<type>/:entityId`. */
export function tabUrlPattern(app: string, type: string, declared: unknown): string {
  return typeof declared === "string" ? declared : `/${app}/${type}/:entityId`
}

/** Every tab pattern a manifest declares (`views.tabTypes.*.urlPattern`, defaults filled in). */
export function manifestTabUrlPatterns(app: string, manifest: unknown): string[] {
  const views = (manifest as { views?: { tabTypes?: unknown } } | null)?.views
  const tabTypes = views?.tabTypes
  if (!tabTypes || typeof tabTypes !== "object") return []
  return Object.entries(tabTypes as Record<string, unknown>).map(([type, reg]) =>
    tabUrlPattern(app, type, (reg as { urlPattern?: unknown } | null)?.urlPattern),
  )
}

/** The first path segment of a pattern (`/kpi-catalogue/:entityId+` gives `kpi-catalogue`). */
export function tabPatternFirstSegment(pattern: string): string {
  return pattern.startsWith("/") ? (pattern.slice(1).split("/", 1)[0] ?? "") : ""
}

/** Another app and the tab patterns it registers. */
export interface TabRouteOwner {
  name: string
  patterns: readonly string[]
}

/**
 * Why `app` may not declare the tab pattern `pattern`, or null when it may. `others` are the
 * other apps the shell registers (the kernel's own tabs are covered by the reserved routes).
 */
export function tabRouteRefusal(
  app: string,
  pattern: string,
  others: readonly TabRouteOwner[],
): string | null {
  const first = tabPatternFirstSegment(pattern)
  if (first === "") {
    return `tab urlPattern '${pattern}' must start with a fixed path segment the app owns (/${app}/...)`
  }
  if (first.startsWith(":") || first.includes("*")) {
    return `tab urlPattern '${pattern}' starts with a parameter: its first segment must be a fixed name the app owns (/${app}/...)`
  }
  if (isReservedWebRouteSegment(first)) {
    return `tab urlPattern '${pattern}' is under '/${first}', a Liaison page route`
  }
  for (const other of others) {
    if (other.name === app) continue
    if (other.name === first || other.patterns.some((p) => tabPatternFirstSegment(p) === first)) {
      return `tab urlPattern '${pattern}' is under '/${first}', which belongs to the app '${other.name}'`
    }
  }
  return null
}

/** The first refusal among a manifest's tab patterns, or null when every one is allowed. */
export function manifestTabRouteRefusal(
  app: string,
  manifest: unknown,
  others: readonly TabRouteOwner[],
): string | null {
  for (const pattern of manifestTabUrlPatterns(app, manifest)) {
    const refusal = tabRouteRefusal(app, pattern, others)
    if (refusal) return refusal
  }
  return null
}
