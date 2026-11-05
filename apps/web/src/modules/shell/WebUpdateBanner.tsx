// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Liaison has been updated. Reload", when a newer web build is deployed and
// reloading on its own would lose something (see lib/web-build.ts). Small and
// non-blocking: the person reloads when they are done.

import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { webBuildWatcher } from "~/modules/shell/web-update"

const WebUpdateBanner: Component = () => {
  const i18n = useI18n()
  const visible = () => webBuildWatcher()?.bannerVisible() ?? false
  return (
    <Show when={visible()}>
      <div
        role="status"
        data-testid="web-update-banner"
        class="fixed bottom-4 left-1/2 z-[90] flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-elevated px-4 py-2 text-sm text-text shadow-popover"
      >
        <span>{i18n.t("kernel.webUpdateAvailable")}</span>
        <button
          type="button"
          data-testid="web-update-reload"
          onClick={() => window.location.reload()}
          class="rounded-md bg-accent px-3 py-1 text-sm font-medium text-bg transition-colors hover:bg-accent/90"
        >
          {i18n.t("kernel.webUpdateReload")}
        </button>
      </div>
    </Show>
  )
}

export default WebUpdateBanner
