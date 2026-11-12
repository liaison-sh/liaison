// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Sidebar (You): which apps the person's own sidebar shows, on the
// desktop and tablet rail and the phone Work list. Each switch saves at once
// through the session's sidebar store (shell/sidebar-visibility.ts), so the
// rail follows as the switch moves. Hiding is a display preference: a hidden
// app still opens from search, the command palette and links.
import { type Component, createSignal, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { SidebarAppsEditor } from "~/modules/settings/sidebar-settings/SidebarAppsEditor"
import { useApi } from "~/modules/shell/ApiContext"
import {
  hiddenSidebarApps,
  hydrateSidebarVisibility,
  setHiddenSidebarApps,
} from "~/modules/shell/sidebar-visibility"
import { addToast } from "~/modules/shell/toast-store"
import { Skeleton } from "~/ui/Skeleton"

const SidebarSettings: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [ready, setReady] = createSignal(false)

  onMount(() => {
    // Normally read at startup already; this only waits for that read.
    void hydrateSidebarVisibility(api).finally(() => setReady(true))
  })

  async function change(next: string[]): Promise<void> {
    const saved = await setHiddenSidebarApps(next, api)
    if (!saved) addToast({ message: i18n.t("kernel.sidebarSettings.saveFailed"), type: "error" })
  }

  return (
    <div data-testid="sidebar-settings" class="pb-20">
      <header class="mb-8">
        <h1 class="font-display text-[26px] font-medium leading-none tracking-[-0.01em] text-text">
          {i18n.t("kernel.sidebarSettings.title")}
        </h1>
        <p class="mt-3 max-w-[52ch] text-[13px] leading-relaxed text-text-secondary">
          {i18n.t("kernel.sidebarSettings.intro")}
        </p>
      </header>

      <Show
        when={ready()}
        fallback={
          <div data-testid="sidebar-settings-loading" class="flex flex-col gap-2">
            <Skeleton class="h-11 w-full" />
            <Skeleton class="h-11 w-full" />
            <Skeleton class="h-11 w-full" />
          </div>
        }
      >
        <SidebarAppsEditor
          hidden={hiddenSidebarApps()}
          onChange={(next) => void change(next)}
          testIdPrefix="sidebar-settings"
        />
      </Show>
      <p data-testid="sidebar-settings-note" class="mt-3 text-[12px] text-text-tertiary">
        {i18n.t("kernel.sidebarSettings.note")}
      </p>
    </div>
  )
}

export default SidebarSettings
