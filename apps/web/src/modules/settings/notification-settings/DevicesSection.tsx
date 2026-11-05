// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings -> Notifications -> "Your devices" (S3, S6). Every device that can
// notify the user (iPhone, desktop app, browser), how it is registered, the
// last notification sent to it and the last confirmation it sent back; the
// control that turns on Web Push in this browser (only in a real browser,
// browser-push.ts); and "Send me a test", which reaches every device and shows
// what each one did with it within 30 s (devices-store.ts).

import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { relativeTime } from "~/lib/relative-time"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  type EnableResult,
  enableBrowserPush,
  isRealBrowser,
} from "~/modules/notifications/browser-push"
import { desktopDeviceId } from "~/modules/notifications/desktop-device"
import {
  fetchDevices,
  type NotificationDevice,
  runNotificationTest,
  type TestLine,
} from "~/modules/settings/notification-settings/devices-store"
import { sectionHeading } from "~/modules/settings/notification-settings/styles"
import { useApi } from "~/modules/shell/ApiContext"
import { DEVICE_ID_KEY } from "~/primitives/createWebSocket"

const P = "kernel.notificationSettings"

type TestState = "idle" | "sending" | "waiting" | "done" | "failed" | "none"

function thisBrowserId(): string | null {
  // The desktop app is its install (P1-T6), never a page key.
  const install = desktopDeviceId()
  if (install) return install
  try {
    return localStorage.getItem(DEVICE_ID_KEY)
  } catch {
    return null
  }
}

function browserPermission(): NotificationPermission | "unsupported" {
  try {
    return typeof Notification === "function" ? Notification.permission : "unsupported"
  } catch {
    return "unsupported"
  }
}

const buttonClass =
  "min-h-11 rounded-sm border border-accent-border bg-accent-glow px-4 py-1.5 text-[13px] font-medium text-accent hover:bg-accent-wash hover:text-accent-hover disabled:opacity-50 lg:min-h-0"

export const DevicesSection: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  // Full literal keys keep the catalog guard (i18n.test.tsx) able to check them.
  const t = (key: string, params?: Record<string, string>) => i18n.t(key, params)
  const known = (key: string, fallback: string): string => {
    const value = t(`${P}.${key}`)
    return value === `${P}.${key}` ? fallback : value
  }
  const when = (iso: string) => relativeTime(iso, i18n.locale())

  const [devices, setDevices] = createSignal<NotificationDevice[] | null>(null)
  const [status, setStatus] = createSignal<"loading" | "error" | "ready">("loading")
  const [enabling, setEnabling] = createSignal(false)
  const [enableResult, setEnableResult] = createSignal<EnableResult | null>(null)
  const [testState, setTestState] = createSignal<TestState>("idle")
  const [lines, setLines] = createSignal<TestLine[]>([])
  const browserId = thisBrowserId()
  const realBrowser = isRealBrowser()

  async function load(): Promise<void> {
    try {
      setDevices(await fetchDevices(api))
      setStatus("ready")
    } catch {
      setStatus((s) => (s === "ready" ? s : "error"))
    }
  }
  onMount(() => void load())

  /** Offered in a real browser until this browser holds a Web Push subscription. */
  const offerBrowser = () => {
    if (!realBrowser || status() !== "ready") return false
    const mine = devices()?.find((d) => d.surface === "browser" && d.deviceId === browserId)
    return !(mine?.detail.webPush === true && browserPermission() === "granted")
  }

  async function turnOnBrowser(): Promise<void> {
    const userId = userFromToken()?.userId
    if (enabling() || !userId) return
    setEnabling(true)
    const result = await enableBrowserPush(api, userId)
    setEnableResult(result)
    setEnabling(false)
    await load()
  }

  async function sendTest(): Promise<void> {
    if (testState() === "sending" || testState() === "waiting") return
    setTestState("sending")
    setLines([])
    try {
      let first = true
      const final = await runNotificationTest(api, (next) => {
        setLines(next)
        if (first) {
          first = false
          setTestState(next.length === 0 ? "none" : "waiting")
        }
      })
      setTestState(final.length === 0 ? "none" : "done")
      void load()
    } catch {
      setTestState("failed")
    }
  }

  const registration = (d: NotificationDevice): string => {
    if (d.surface === "browser") {
      return t(
        d.detail.webPush
          ? "kernel.notificationSettings.devices.registration.webPush"
          : "kernel.notificationSettings.devices.registration.inTabOnly",
      )
    }
    if (d.surface === "desktop") {
      const p = d.detail.reportedPermission ?? "unknown"
      return known(`devices.registration.permission.${p}`, p)
    }
    return t(
      d.detail.environment === "sandbox"
        ? "kernel.notificationSettings.devices.registration.sandbox"
        : "kernel.notificationSettings.devices.registration.production",
    )
  }

  const delivery = (d: NotificationDevice): string => {
    const last = d.lastDelivery
    if (!last) return t("kernel.notificationSettings.devices.neverSent")
    return t("kernel.notificationSettings.devices.lastDelivery", {
      when: when(last.attemptedAt),
      result: known(`devices.result.${last.result}`, last.result),
    })
  }

  const receipt = (d: NotificationDevice): string => {
    const last = d.lastReceipt
    if (!last) return t("kernel.notificationSettings.devices.noReceipt")
    return t("kernel.notificationSettings.devices.lastReceipt", {
      when: when(last.at),
      outcome: known(`devices.outcome.${last.outcome}`, last.outcome),
    })
  }

  const lineLabel = (l: TestLine): string => {
    const reason = (r: string | null) =>
      r ? known(`test.reason.${r}`, r) : t("kernel.notificationSettings.test.reason.unknown")
    if (l.status === "suppressed")
      return t("kernel.notificationSettings.test.status.suppressed", {
        reason: reason(l.statusReason),
      })
    if (l.status === "not_delivered") {
      return t("kernel.notificationSettings.test.status.not_delivered", {
        reason: reason(l.statusReason),
      })
    }
    return t(`${P}.test.status.${l.status}`)
  }

  const deviceName = (deviceId: string | null): string | null => {
    const d = devices()?.find((x) => x.deviceId === deviceId)
    if (!d) return null
    if (d.surface === "browser" && d.deviceId === browserId)
      return t("kernel.notificationSettings.devices.thisBrowser")
    if (d.surface === "desktop" && d.detail.os) return d.detail.os
    return null
  }

  return (
    <section data-testid="notif-devices" class="mb-10 border-t border-border-subtle pt-8">
      <h2 class={sectionHeading}>{t("kernel.notificationSettings.devices.title")}</h2>
      <p class="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-text-secondary">
        {t("kernel.notificationSettings.devices.hint")}
      </p>

      <Show when={status() === "loading"}>
        <p data-testid="notif-devices-loading" class="mt-4 text-[12.5px] text-text-tertiary">
          {t("kernel.notificationSettings.devices.loading")}
        </p>
      </Show>
      <Show when={status() === "error"}>
        <p data-testid="notif-devices-error" class="mt-4 text-[12.5px] text-error">
          {t("kernel.notificationSettings.devices.loadFailed")}
        </p>
      </Show>
      <Show when={status() === "ready" && (devices() ?? []).length === 0}>
        <p data-testid="notif-devices-empty" class="mt-4 text-[12.5px] text-text-secondary">
          {t("kernel.notificationSettings.devices.empty")}
        </p>
      </Show>
      <Show when={status() === "ready" && (devices() ?? []).length > 0}>
        <ul class="mt-4 flex flex-col divide-y divide-border-subtle rounded-md border border-border">
          <For each={devices() ?? []}>
            {(d) => (
              <li
                data-testid={`notif-device-row-${d.deviceId}`}
                data-surface={d.surface}
                class="flex flex-col gap-1 px-4 py-3"
              >
                <div class="flex flex-wrap items-baseline justify-between gap-2">
                  <span class="text-[13px] font-medium text-text">
                    {t(`${P}.devices.surface.${d.surface}`)}
                    <Show when={d.surface === "browser" && d.deviceId === browserId}>
                      <span class="ml-2 text-[11.5px] font-normal text-accent">
                        {t("kernel.notificationSettings.devices.thisBrowser")}
                      </span>
                    </Show>
                    <Show when={d.detail.os || d.detail.appVersion}>
                      <span class="ml-2 text-[11.5px] font-normal text-text-tertiary">
                        {[d.detail.os, d.detail.appVersion].filter(Boolean).join(" ")}
                      </span>
                    </Show>
                  </span>
                  <span class="text-[11.5px] text-text-tertiary">
                    {t("kernel.notificationSettings.devices.lastSeen", {
                      when: when(d.lastSeenAt),
                    })}
                  </span>
                </div>
                <span class="text-[12px] text-text-secondary">{registration(d)}</span>
                <span class="text-[12px] text-text-secondary">{delivery(d)}</span>
                <span class="text-[12px] text-text-secondary">{receipt(d)}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={offerBrowser()}>
        <div class="mt-5">
          <button
            type="button"
            data-testid="notif-browser-enable"
            disabled={enabling()}
            onClick={() => void turnOnBrowser()}
            class={buttonClass}
          >
            {enabling()
              ? t("kernel.notificationSettings.browserPush.enabling")
              : t("kernel.notificationSettings.browserPush.enable")}
          </button>
          <p class="mt-2 text-[12px] leading-relaxed text-text-secondary">
            {t("kernel.notificationSettings.browserPush.enableHint")}
          </p>
        </div>
      </Show>
      <Show when={enableResult()}>
        {(result) => (
          <p
            data-testid="notif-browser-result"
            data-result={result()}
            class="mt-2 text-[12px] leading-relaxed"
            classList={{
              "text-accent": result() === "enabled",
              "text-warning": result() !== "enabled",
            }}
          >
            {t(`${P}.browserPush.result.${result()}`)}
          </p>
        )}
      </Show>

      <div class="mt-8">
        <h3 class="text-[13px] font-medium text-text">
          {t("kernel.notificationSettings.test.title")}
        </h3>
        <p class="mt-1 max-w-[60ch] text-[12px] leading-relaxed text-text-secondary">
          {t("kernel.notificationSettings.test.hint")}
        </p>
        <button
          type="button"
          data-testid="notif-test-send"
          disabled={testState() === "sending" || testState() === "waiting"}
          onClick={() => void sendTest()}
          class={`mt-3 ${buttonClass}`}
        >
          {testState() === "sending"
            ? t("kernel.notificationSettings.test.sending")
            : t("kernel.notificationSettings.test.button")}
        </button>
        <Show when={testState() !== "idle" && testState() !== "sending"}>
          <p
            data-testid="notif-test-state"
            data-state={testState()}
            class="mt-2 text-[12px] text-text-secondary"
            classList={{ "text-error": testState() === "failed" }}
          >
            {testState() === "waiting"
              ? t("kernel.notificationSettings.test.waiting")
              : testState() === "done"
                ? t("kernel.notificationSettings.test.done")
                : testState() === "failed"
                  ? t("kernel.notificationSettings.test.failed")
                  : t("kernel.notificationSettings.test.none")}
          </p>
        </Show>
        <Show when={lines().length > 0}>
          <ul class="mt-3 flex flex-col gap-1.5">
            <For each={lines()}>
              {(l) => (
                <li
                  data-testid={`notif-test-line-${l.notificationId}`}
                  data-status={l.status}
                  class="flex flex-wrap items-baseline justify-between gap-2 text-[12.5px]"
                >
                  <span class="text-text">
                    {known(`test.surface.${l.surface}`, l.surface)}
                    <Show when={deviceName(l.deviceId)}>
                      {(name) => <span class="ml-2 text-text-tertiary">{name()}</span>}
                    </Show>
                  </span>
                  <span
                    classList={{
                      "text-accent": l.status === "shown",
                      "text-warning":
                        l.status === "suppressed" ||
                        l.status === "no_receipt" ||
                        l.status === "not_delivered",
                      "text-text-tertiary": l.status === "pending" || l.status === "received",
                    }}
                  >
                    {lineLabel(l)}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </section>
  )
}
