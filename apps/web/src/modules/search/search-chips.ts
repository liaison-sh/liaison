// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * The filter chips of a result set: one per app, one per record type, sorted,
 * with no two that read the same. An app's chip that reads like a type's
 * ("Projects" the app and "Projects" the record type, "Tickets" and "Tickets")
 * is left out: the type chip is the finer filter, and the app's other types
 * keep their own chips. A chip whose filter is on always stays, so it can be
 * turned off.
 */
export function searchFilterChips(
  hits: ReadonlyArray<{ app: string; entity_type: string }>,
  opts: {
    selectedApps: ReadonlySet<string>
    appLabel: (app: string) => string
    typeLabel: (type: string) => string
  },
): { apps: string[]; types: string[] } {
  const apps = new Set<string>()
  const types = new Set<string>()
  for (const h of hits) {
    apps.add(h.app)
    types.add(h.entity_type)
  }
  const typeList = Array.from(types).sort()
  const typeLabels = new Set(typeList.map((t) => opts.typeLabel(t).toLocaleLowerCase()))
  const appList = Array.from(apps)
    .sort()
    .filter(
      (app) =>
        opts.selectedApps.has(app) || !typeLabels.has(opts.appLabel(app).toLocaleLowerCase()),
    )
  return { apps: appList, types: typeList }
}
