// SPDX-License-Identifier: FSL-1.1-ALv2
// The UI exports a manifest names, which an installed app's bundle must carry.
// Two lists, because a missing export costs different things: a view, panel or
// card component the app cannot work without keeps the whole app out (the
// bootstrap warns and skips it); a settings page's `custom` block costs that
// block only, which shows an admin an error card in its place (P2-20).

/**
 * Every component export the manifest's view tree and entities reference.
 * Recursive: `views.<key>` is a view entry or a nested record of them
 * (`views.detail.<entity>.component`), so a flat walk would miss some.
 */
export function collectDeclaredComponentNames(manifest: any): string[] {
  const names = new Set<string>()
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return
    if (typeof node.component === "string") names.add(node.component)
    for (const child of Object.values(node)) walk(child)
  }
  walk(manifest?.views)
  for (const e of Object.values<any>(manifest?.entities ?? {})) {
    if (typeof e?.cardComponent === "string") names.add(e.cardComponent)
  }
  return [...names]
}

/** Every `custom` block component the manifest's settings page names (`settings.sections[].blocks[]`). */
export function collectSettingsBlockComponentNames(manifest: any): string[] {
  const names = new Set<string>()
  for (const section of manifest?.settings?.sections ?? []) {
    for (const block of section?.blocks ?? []) {
      if (typeof block?.component === "string") names.add(block.component)
    }
  }
  return [...names]
}
