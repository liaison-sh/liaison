// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Routine-tick tool pre-seed (cache discipline).
//
// A routine declares its domain via `routines.scopes` (`app:resource:action`
// capability strings). Before the tick's first step, every UNLOCKED deferred
// tool belonging to those apps is seeded into the tick's discovery set, so the
// provider-visible tool catalog (`activeTools`) is complete at step 1 and never
// grows mid-run. Rationale: implicit prompt caching rebates a byte-identical
// prefix from position 0, and the tool catalog serializes at the FRONT of the
// payload — each mid-run `tool_search` discovery therefore re-bills the entire
// prefix (system + app guides + history) as uncached, precisely when context is
// fattest. A pre-seeded catalog is slightly bigger but byte-stable: it costs
// once at step 1 and caches for every step after.
//
// The seed stays bounded by the routine's own scope apps — it does NOT reload
// the output thread's ever-growing persisted discovery set (the ~200k-chars-
// of-guides-per-step incident that motivated lean tick starts). Apps outside
// the routine's declared domain remain deferred and discoverable as before.

import type { ActorContext } from "~/db/rls"
import { listDeferredTools } from "~/modules/agent/tools/tool-bridge"

/** App names derived from `app:resource:action` scope prefixes. */
export function appsFromRoutineScopes(scopes: string[]): Set<string> {
  const apps = new Set<string>()
  for (const scope of scopes) {
    const app = scope.split(":")[0]
    if (app) apps.add(app)
  }
  return apps
}

/** Pure core: unlocked deferred tools whose app is in the routine's scope apps. */
export function filterSeedTools(
  deferred: Array<{ sdkName: string; appName: string; locked?: boolean }>,
  routineScopes: string[],
): Set<string> {
  const apps = appsFromRoutineScopes(routineScopes)
  const seed = new Set<string>()
  for (const t of deferred) {
    if (t.locked) continue
    if (apps.has(t.appName)) seed.add(t.sdkName)
  }
  return seed
}

/** Wiring: resolve the tick's pre-seeded discovery set for this actor. */
export function seedRoutineTickTools(
  orgId: string,
  actor: ActorContext,
  routineScopes: string[],
): Set<string> {
  return filterSeedTools(listDeferredTools(orgId, actor), routineScopes)
}
