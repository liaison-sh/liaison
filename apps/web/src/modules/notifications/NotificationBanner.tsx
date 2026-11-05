// SPDX-License-Identifier: FSL-1.1-ALv2
// One-time dismissible Home banner offering to enable desktop notifications
// (Task 6's opt-in flow, mounted on Home per Task 8). Renders only when the
// browser supports the Notification API, the permission is still undecided,
// and the banner has not already been dismissed this browser.

import { Bell, X } from "lucide-solid"
import { type Component, createSignal, Show } from "solid-js"
import { isDesktop } from "~/modules/desktop/desktop-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import * as desktopNotifications from "~/modules/notifications/desktop"
import { addToast } from "~/modules/shell/toast-store"

const NotificationBanner: Component = () => {
  const i18n = useI18n()
  /**
   * THE SAME BANNER RUNS INSIDE THE DESKTOP APP, where "a browser notification"
   * and "this tab" name nothing the user can see: there is no tab, and the
   * permission belongs to Liaison itself. Same banner, same flow, the copy the
   * window it is in can be read against.
   */
  const copy = (key: string): string => i18n.t(`kernel.${key}${isDesktop() ? "App" : ""}`)
  const [dismissed, setDismissed] = createSignal(desktopNotifications.isBannerDismissed())
  const [enabling, setEnabling] = createSignal(false)

  const visible = (): boolean =>
    !dismissed() &&
    desktopNotifications.isSupported() &&
    desktopNotifications.permissionState() === "default"

  async function handleEnable(): Promise<void> {
    if (enabling()) return
    setEnabling(true)
    try {
      const granted = await desktopNotifications.enable()
      if (granted) {
        setDismissed(true)
        desktopNotifications.dismissBanner()
      } else if (desktopNotifications.permissionState() === "denied") {
        addToast({
          message: copy("desktopNotificationsBlockedToast"),
          type: "error",
        })
      }
    } finally {
      setEnabling(false)
    }
  }

  function handleDismiss(): void {
    desktopNotifications.dismissBanner()
    setDismissed(true)
  }

  return (
    <Show when={visible()}>
      <div
        data-testid="home-notification-banner"
        class="mb-6 flex items-center gap-3 rounded-md border border-border-subtle bg-surface px-4 py-3"
      >
        <Bell size={16} class="shrink-0 text-text-tertiary" />
        <p class="flex-1 text-[12.5px] leading-relaxed text-text-secondary">
          {copy("desktopNotificationsBannerHint")}
        </p>
        <button
          type="button"
          data-testid="home-notification-banner-enable"
          disabled={enabling()}
          onClick={() => void handleEnable()}
          class="shrink-0 rounded-sm border border-accent-border bg-accent-glow px-2.5 py-1 text-[12px] font-medium text-accent hover:bg-accent-wash disabled:opacity-50"
        >
          {enabling() ? i18n.t("kernel.enabling") : i18n.t("kernel.enable")}
        </button>
        <button
          type="button"
          data-testid="home-notification-banner-dismiss"
          aria-label={i18n.t("kernel.dismiss")}
          onClick={handleDismiss}
          class="shrink-0 rounded-sm p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
        >
          <X size={14} />
        </button>
      </div>
    </Show>
  )
}

export default NotificationBanner
