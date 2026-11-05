// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "This device" on Settings -> Notifications: the real permission this phone,
// desktop app or browser has to notify, and the one way to change it from
// here (this-device.ts). A refusal can only be undone in the system's own
// settings, so the row says where, rather than offering a button that can no
// longer show a prompt.

import { type Component, createSignal, Match, onMount, Show, Switch } from "solid-js"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { useI18n } from "~/modules/i18n/i18n-context"
import { sectionHeading } from "~/modules/settings/notification-settings/styles"
import {
  type DevicePermission,
  thisDevice,
} from "~/modules/settings/notification-settings/this-device"
import { Switch as Toggle } from "~/ui/Switch"

/**
 * LAUNCH AT LOGIN (P1-T6), desktop app only: the app is the computer's
 * notification channel only while it runs, so it starts at login by default
 * (src-tauri/src/autostart.rs) and this is the switch that turns it off.
 */
const LaunchAtLoginRow: Component = () => {
  const i18n = useI18n()
  const shell = getDesktopBridge()
  const [on, setOn] = createSignal<boolean | null>(null)
  onMount(() => {
    void shell
      ?.launchAtLogin?.()
      .then(setOn)
      .catch(() => setOn(false))
  })
  async function change(next: boolean): Promise<void> {
    setOn(next)
    try {
      setOn((await shell?.setLaunchAtLogin?.(next)) ?? next)
    } catch {
      setOn(!next)
    }
  }
  return (
    <div
      data-testid="notif-launch-at-login"
      class="mt-4 flex items-start justify-between gap-6 border-t border-border-subtle pt-4"
    >
      <div class="min-w-0 flex-1">
        <p class="text-[13px] font-medium text-text-primary">
          {i18n.t("kernel.notificationSettings.launchAtLogin")}
        </p>
        <p class="mt-1 text-[12px] leading-relaxed text-text-secondary">
          {i18n.t("kernel.notificationSettings.launchAtLoginHint")}
        </p>
      </div>
      <Toggle
        data-testid="notif-launch-at-login-switch"
        checked={on() === true}
        disabled={on() === null}
        label={i18n.t("kernel.notificationSettings.launchAtLogin")}
        onChange={(next) => void change(next)}
      />
    </div>
  )
}

export const ThisDeviceSection: Component = () => {
  const i18n = useI18n()
  const device = thisDevice()
  const [state, setState] = createSignal<DevicePermission | null>(null)
  const [asking, setAsking] = createSignal(false)

  onMount(() => {
    void device.read().then(setState)
  })

  async function ask(): Promise<void> {
    if (asking()) return
    setAsking(true)
    setState(await device.request())
    setAsking(false)
  }

  const stateLabel = (s: DevicePermission): string => {
    if (s === "granted" && device.kind === "desktop_app") return i18n.t("kernel.settingsUi.on")
    if (s === "denied" && device.kind === "browser") {
      return i18n.t("kernel.notificationSettings.state.deniedBrowser")
    }
    return i18n.t(`kernel.notificationSettings.state.${s}`)
  }

  return (
    <section
      data-testid="notif-device"
      data-device={device.kind}
      class="mb-2 border-t border-border-subtle pt-8"
    >
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div class="min-w-0 flex-1">
          <h2 class={sectionHeading}>{i18n.t("kernel.notificationSettings.deviceTitle")}</h2>
          <p class="mt-2 text-[13px] leading-relaxed text-text-secondary">
            {i18n.t(`kernel.notificationSettings.device.${device.kind}`)}
          </p>
        </div>
        <span
          data-testid="notif-device-state"
          data-state={state() ?? "checking"}
          class="shrink-0 text-[12.5px] font-medium"
          classList={{
            "text-text-tertiary": state() === null || state() === "unsupported",
            "text-accent": state() === "granted",
            "text-text-secondary": state() === "prompt",
            "text-warning": state() === "denied",
          }}
        >
          {(() => {
            const s = state()
            return s === null ? i18n.t("kernel.notificationSettings.deviceChecking") : stateLabel(s)
          })()}
        </span>
      </div>

      <Switch>
        <Match when={state() === "granted" && device.kind === "desktop_app"}>
          {/* The system's own answer (P1-T6): on, and it keeps notifying
              with the window closed to the tray. */}
          <p
            data-testid="notif-device-desktop-hint"
            class="mt-3 text-[12px] leading-relaxed text-text-secondary"
          >
            {i18n.t("kernel.notificationSettings.desktopAppOn")}
          </p>
        </Match>
        <Match when={state() === "prompt"}>
          <button
            type="button"
            data-testid="notif-device-request"
            disabled={asking()}
            onClick={() => void ask()}
            class="mt-3 min-h-11 rounded-sm border border-accent-border bg-accent-glow px-4 py-1.5 text-[13px] font-medium text-accent hover:bg-accent-wash hover:text-accent-hover disabled:opacity-50 lg:min-h-0"
          >
            {i18n.t("kernel.notificationSettings.deviceAllow")}
          </button>
        </Match>
        <Match when={state() === "denied"}>
          <p
            data-testid="notif-device-blocked"
            class="mt-3 text-[12px] leading-relaxed text-warning"
          >
            {i18n.t(`kernel.notificationSettings.blocked.${device.kind}`)}
          </p>
        </Match>
        <Match when={state() === "unsupported"}>
          <p class="mt-3 text-[12px] leading-relaxed text-text-tertiary">
            {i18n.t(`kernel.notificationSettings.unsupported.${device.kind}`)}
          </p>
        </Match>
      </Switch>
      <Show when={device.kind === "desktop_app" && getDesktopBridge()?.launchAtLogin}>
        <LaunchAtLoginRow />
      </Show>
    </section>
  )
}
