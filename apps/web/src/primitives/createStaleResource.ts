// SPDX-License-Identifier: FSL-1.1-ALv2
// A createResource wrapper that revalidates on two triggers:
//   (a) the global resync bus bumps (WS sync frame / reconnect), or
//   (b) the owning tab transitions inactive -> active AND the last successful
//       fetch is older than staleAfterMs (default 60s).
//
// Refetch-in-place: createResource keeps the previous value during a refetch,
// so the UI never flashes empty. The effect skips the initial mount so there is
// no effect-driven double fetch.
import { createEffect, createResource, type Resource } from "solid-js"
import { resyncVersion } from "~/framework/resync"
import { useTabIsActive } from "~/modules/shell/TabVisibilityContext"

export const STALE_AFTER_MS = 60_000

export interface CreateStaleResourceOptions {
  staleAfterMs?: number
}

export type StaleResource<T> = Resource<T> & {
  refetch: (info?: unknown) => T | Promise<T | undefined> | null | undefined
  mutate: (v: T | undefined) => T | undefined
}

export function createStaleResource<T>(
  fetcher: () => T | Promise<T>,
  opts?: CreateStaleResourceOptions,
): StaleResource<T> {
  const staleAfterMs = opts?.staleAfterMs ?? STALE_AFTER_MS
  const isActive = useTabIsActive()

  let lastFetchedAt = 0
  let resolvedOnce = false
  let lastSeenVersion = resyncVersion()
  let wasActive = isActive()
  // Last successful value — kept so a failed refetch never wipes the UI. Solid
  // clears the resource value to undefined on error; we hold the last-good and
  // surface it through the returned accessor while `.error` still reports.
  let lastGood: T | undefined

  const [resource, { refetch, mutate }] = createResource<T>(async () => {
    const value = await fetcher()
    lastFetchedAt = Date.now()
    resolvedOnce = true
    lastGood = value
    return value
  })

  // Revalidation effect. Tracks both the resync bus and tab-active accessor.
  // Skips until the initial fetch has resolved so mount does not double-fetch.
  createEffect(() => {
    const version = resyncVersion()
    const active = isActive()

    // Establish reactive dependencies, then decide. Do nothing before the very
    // first fetch resolves — createResource already issued that one.
    if (!resolvedOnce) {
      wasActive = active
      lastSeenVersion = version
      return
    }

    const versionBumped = version !== lastSeenVersion
    const activated = active && !wasActive
    wasActive = active

    if (versionBumped) {
      lastSeenVersion = version
      void refetch()
      return
    }

    if (activated && Date.now() - lastFetchedAt > staleAfterMs) {
      void refetch()
    }
  })

  // Wrap the value accessor so that on a REFETCH error (there is a last-good
  // value from a prior successful fetch) we return that last-good value
  // instead of throwing — the refetch-in-place / no-wipe contract. On a
  // FIRST-load failure there is no last-good value yet, so we must NOT
  // swallow the throw: fall through to resource(), which re-throws the
  // resource's error so <ErrorBoundary> can catch it. Returning `undefined`
  // silently there previously hid every first-load failure from the boundary.
  const value = (() => {
    if (resource.error !== undefined && lastGood !== undefined) return lastGood
    return resource()
  }) as StaleResource<T>

  Object.defineProperties(value, {
    error: { get: () => resource.error },
    loading: { get: () => resource.loading },
    state: { get: () => resource.state },
    latest: { get: () => (resource.error !== undefined ? lastGood : resource.latest) },
  })

  return Object.assign(value, { refetch, mutate }) as StaleResource<T>
}
