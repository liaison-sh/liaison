// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The catalog generation of this process: a counter bumped whenever the set of
 * app versions this process registers may have changed (a local activation or
 * install, an activation announced by another process, `reloadInstalledApps`).
 * `getDefaultApps` (init.ts) caches its expensive inputs per generation, so an
 * org's first-touch setup reads no manifest file and hashes no install dir
 * while the catalog is unchanged.
 *
 * Its own module so activation.ts and install code can bump it without
 * importing init.ts (which imports them).
 */
let generation = 0
const listeners = new Set<() => void>()

export function catalogGeneration(): number {
  return generation
}

/** The catalog may have changed: the next `getDefaultApps` call reads it again. */
export function bumpCatalogGeneration(): void {
  generation++
  for (const listener of listeners) listener()
}

/** Run `listener` on every bump (the cache in init.ts drops its entry). */
export function onCatalogGenerationBump(listener: () => void): void {
  listeners.add(listener)
}
