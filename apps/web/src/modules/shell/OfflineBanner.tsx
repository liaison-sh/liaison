// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One line, at the top of the content, while the device has no connection.
//
// PHONE AND TABLET ONLY. A desktop browser tab already tells the user it
// cannot reach the network, in the chrome around the page and in the reload it
// offers; a phone in an app has no chrome at all, so the app is the only thing
// that can say it. Every list on screen is showing whatever was last loaded
// and will keep showing it, silently, for as long as the user scrolls: the
// banner is what stops that reading as fresh.
//
// It says what the user can act on and nothing else: that they are offline and
// that what they are looking at is old. It carries no retry control, because
// there is nothing to retry: the app reconnects on its own the moment the
// device does, and the banner goes with it.
import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { shellTier } from "~/modules/shell/shell-tier"
import { createConnectivity } from "~/primitives/createConnectivity"

export const OfflineBanner: Component = () => {
  const i18n = useI18n()
  const online = createConnectivity()
  const compact = () => shellTier() === "phone" || shellTier() === "tablet"

  return (
    <Show when={compact() && !online()}>
      <div
        data-testid="offline-banner"
        // `status`, not `alert`: it is a standing condition, not an
        // interruption, so a screen reader announces it without cutting off
        // whatever it was reading.
        role="status"
        class="flex h-11 shrink-0 items-center justify-center border-b border-border-subtle bg-surface-active px-4 text-center text-[13px] text-text-secondary"
      >
        {i18n.t("kernel.offlineBanner")}
      </div>
    </Show>
  )
}
