// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Global "content is loading" indicator for the tab system.
//
// App views fetch external data with `createResource` and render under the
// per-tab <Suspense> in MainPanel. That boundary previously had no fallback,
// so opening a data-backed tab (Shopify, Social, Meta Ads, Shipping…) showed
// a blank pane with zero feedback while the external call was in flight.
//
// Mechanism: MainPanel passes <TabSuspenseFallback tabId=…> as the Suspense
// fallback. The fallback's lifetime IS the loading window — mounting it flags
// the tab as loading, its disposal (resources resolved, or tab closed) clears
// the flag. <TabLoadingBar> renders a slim indeterminate gradient sweep pinned
// to the seam between the tab bar and the content area — only when the ACTIVE
// tab is loading, because inactive tabs are kept alive (display: none) and may
// suspend or resolve in the background without the user watching them.

import { type Component, createEffect, createSignal, onCleanup } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { tabStore } from "~/modules/shell/tab-store"

const [loadingTabIds, setLoadingTabIds] = createSignal<ReadonlySet<string>>(new Set())

function markTabLoading(tabId: string, loading: boolean): void {
  setLoadingTabIds((prev) => {
    if (prev.has(tabId) === loading) return prev
    const next = new Set(prev)
    if (loading) next.add(tabId)
    else next.delete(tabId)
    return next
  })
}

export function isTabLoading(tabId: string): boolean {
  return loadingTabIds().has(tabId)
}

/** Test-only: clear all loading flags (mirrors resetTabStore). */
export function resetTabLoading(): void {
  setLoadingTabIds(new Set<string>())
}

/** Rendered as a per-tab Suspense fallback; renders nothing, only tracks.
 *
 *  A TAB ID IS NOT STABLE. `rehydrateTabs` re-keys an open tab (P4c FX-F4), so
 *  a fallback mounted under the old id can be handed a new one while it is
 *  still suspended. A body read plus a cleanup read would then flag the OLD id
 *  and clear the NEW one, leaving the old id loading forever and a loading bar
 *  that never resolves for whoever reads that id next. The effect tracks the
 *  id instead: its scoped cleanup runs before each re-run, so the id being
 *  left is always the id that was flagged. */
export const TabSuspenseFallback: Component<{ tabId: string }> = (props) => {
  createEffect(() => {
    const tabId = props.tabId
    markTabLoading(tabId, true)
    onCleanup(() => markTabLoading(tabId, false))
  })
  return null
}

/**
 * Slim indeterminate loading bar. Absolutely positioned at the top of the
 * tab content area (no layout shift when it appears/disappears). The 150ms
 * appear delay keeps fast loads from flashing it.
 */
export const TabLoadingBar: Component = () => {
  const i18n = useI18n()
  const active = () => {
    const id = tabStore.activeTabId
    return id !== null && isTabLoading(id)
  }
  return (
    <div
      data-testid="tab-loading-bar"
      role="progressbar"
      aria-label={i18n.t("kernel.loading")}
      aria-hidden={active() ? undefined : "true"}
      data-loading={active() ? "true" : "false"}
      class={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden transition-opacity",
        active() ? "opacity-100 delay-150 duration-300" : "opacity-0 delay-0 duration-200",
      )}
    >
      <div
        class={cn(
          "h-full w-2/5 bg-gradient-to-r from-transparent via-accent to-transparent motion-reduce:hidden",
          active() && "animate-loading-sweep",
        )}
      />
      <div class="hidden h-full w-full bg-accent/30 motion-reduce:block" />
    </div>
  )
}
