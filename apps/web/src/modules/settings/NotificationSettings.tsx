// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings -> Notifications (S8, S9, etiquette rule 10: the one place to tune
// it all). One screen on web, desktop and phone, replacing Settings ->
// Attention and Attention rules (both old paths redirect here, SettingsLayout).
// It holds:
//   - each kind set to interrupt, inbox only or off (off = muted, rule 7);
//   - the grid: for each group, which channels it reaches you on;
//   - how often your agent reminds you of your requests waiting for approval;
//   - the email digest cadence ("off" is the email column off, one rule);
//   - work hours, days and time zone: outside them are the quiet hours, on by
//     default (20:00-08:00 on weekdays and all weekend, rule 8);
//   - the conversations muted (with Unmute) and the channels set to every post;
//   - who is on call for incidents (an admin edits it, rule 9);
//   - what each app sends (the per-app rules, the Liaison row included);
//   - your devices, browser notifications and "Send me a test" (S3, S6);
//   - this device's real permission to notify.
// Every control writes on its own (a targeted PATCH), except work hours, which
// are saved together.

import { type ApprovalReminderFrequency, DEFAULT_APPROVAL_REMINDER } from "@liaison/shared"
import { type Component, createSignal, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { AppRulesSection } from "~/modules/settings/notification-settings/AppRulesSection"
import { ApprovalReminderSection } from "~/modules/settings/notification-settings/ApprovalReminderSection"
import { ConversationsSection } from "~/modules/settings/notification-settings/ConversationsSection"
import { DevicesSection } from "~/modules/settings/notification-settings/DevicesSection"
import { KindModesSection } from "~/modules/settings/notification-settings/KindModesSection"
import { NotificationGrid } from "~/modules/settings/notification-settings/NotificationGrid"
import { OnCallSection } from "~/modules/settings/notification-settings/OnCallSection"
import { SegmentedChoice } from "~/modules/settings/notification-settings/SegmentedChoice"
import {
  type DigestCadence,
  fetchNotificationSettings,
  type KindMode,
  kindModePatch,
  type NotificationSettingsData,
  type NotificationSettingsPatch,
  patchNotificationSettings,
  withKindMode,
} from "~/modules/settings/notification-settings/settings-store"
import { sectionHeading } from "~/modules/settings/notification-settings/styles"
import { ThisDeviceSection } from "~/modules/settings/notification-settings/ThisDeviceSection"
import { WorkHoursSection } from "~/modules/settings/notification-settings/WorkHoursSection"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Skeleton } from "~/ui/Skeleton"

const CADENCE_OPTIONS: DigestCadence[] = ["off", "immediate", "hourly", "daily"]

const NotificationSettings: Component = () => {
  const i18n = useI18n()
  const api = useApi()

  const [data, setData] = createSignal<NotificationSettingsData | null>(null)
  const [status, setStatus] = createSignal<"loading" | "error" | "ready">("loading")

  async function load(): Promise<void> {
    setStatus("loading")
    try {
      setData(await fetchNotificationSettings(api))
      setStatus("ready")
    } catch {
      setStatus("error")
    }
  }
  onMount(() => void load())

  /**
   * Shows `optimistic` at once, then whatever the server answers (it may
   * change more than was asked, e.g. the cadence when an email cell turns
   * on). A refusal puts the screen back and says so.
   */
  async function save(
    patch: NotificationSettingsPatch,
    optimistic: NotificationSettingsData,
  ): Promise<NotificationSettingsData | null> {
    const before = data()
    setData(optimistic)
    try {
      const next = await patchNotificationSettings(api, patch)
      setData(next)
      return next
    } catch {
      setData(before)
      addToast({ message: i18n.t("kernel.notificationSettings.saveFailed"), type: "error" })
      return null
    }
  }

  function setCell(group: string, channel: string, value: boolean): void {
    const current = data()
    if (!current || channel === "in_app") return
    const grid = { ...current.grid, [group]: { ...current.grid[group], [channel]: value } }
    // Turning one email cell on while the digest is off brings the daily digest
    // back (the contract's rule; the server's answer is what stays on screen).
    const revivesDigest = channel === "email" && value && current.digestCadence === "off"
    const optimistic: NotificationSettingsData = {
      ...current,
      grid,
      digestCadence: revivesDigest ? "daily" : current.digestCadence,
    }
    void save({ grid: { [group]: { [channel]: value } } }, optimistic)
  }

  function setKindMode(group: string, mode: KindMode): void {
    const current = data()
    if (!current) return
    void save(kindModePatch(group, mode), withKindMode(current, group, mode))
  }

  function setCadence(next: DigestCadence): void {
    const current = data()
    if (!current || current.digestCadence === next) return
    void save({ digestCadence: next }, { ...current, digestCadence: next })
  }

  // An API that predates the setting sends none: the default (daily) applies.
  const reminder = (s: NotificationSettingsData): ApprovalReminderFrequency =>
    s.approvalReminder ?? DEFAULT_APPROVAL_REMINDER

  function setApprovalReminder(next: ApprovalReminderFrequency): void {
    const current = data()
    if (!current || reminder(current) === next) return
    void save({ approvalReminder: next }, { ...current, approvalReminder: next })
  }

  return (
    <div data-testid="notification-settings" class="pb-20">
      <header class="mb-8">
        <h1 class="font-display text-[26px] font-medium leading-none tracking-[-0.01em] text-text">
          {i18n.t("kernel.notificationSettings.title")}
        </h1>
        <p class="mt-3 max-w-[52ch] text-[13px] leading-relaxed text-text-secondary">
          {i18n.t("kernel.notificationSettings.intro")}
        </p>
      </header>

      <Show when={status() === "loading"}>
        <div data-testid="notification-settings-loading" class="flex flex-col gap-4">
          <Skeleton class="h-48 w-full" />
          <Skeleton class="h-12 w-full" />
          <Skeleton class="h-12 w-full" />
        </div>
      </Show>

      <Show when={status() === "error"}>
        <div
          data-testid="notification-settings-error"
          class="flex items-center justify-between gap-4 rounded-md border border-border bg-surface px-4 py-3"
        >
          <p class="text-[13px] text-error">{i18n.t("kernel.notificationSettings.loadFailed")}</p>
          <button
            type="button"
            data-testid="notification-settings-retry"
            onClick={() => void load()}
            class="min-h-11 shrink-0 rounded-sm border border-border px-3 py-1 text-[12.5px] text-text hover:bg-surface-hover lg:min-h-0"
          >
            {i18n.t("kernel.notificationSettings.retry")}
          </button>
        </div>
      </Show>

      <Show when={status() === "ready" ? data() : null}>
        {(settings) => (
          <>
            <KindModesSection settings={settings()} onChange={setKindMode} />

            <NotificationGrid settings={settings()} onToggle={setCell} />

            <ApprovalReminderSection value={reminder(settings())} onChange={setApprovalReminder} />

            {/* ── Email digest ─────────────────────────────────────────── */}
            <section class="mb-10 border-t border-border-subtle pt-8">
              <div class="mb-3 flex items-baseline justify-between gap-4">
                <h2 class={sectionHeading}>{i18n.t("kernel.notificationSettings.cadenceTitle")}</h2>
                <span class="text-right text-[11px] text-text-tertiary">
                  {i18n.t("kernel.notificationSettings.cadenceHint")}
                </span>
              </div>
              <SegmentedChoice
                name="digestCadence"
                testId="attention-cadence"
                label={i18n.t("kernel.digestCadence")}
                options={CADENCE_OPTIONS}
                value={settings().digestCadence}
                optionLabel={(value) => i18n.t(`kernel.settingsUi.digestCadence.${value}`)}
                onChange={setCadence}
              />
              <p class="mt-2.5 text-[12px] leading-relaxed text-text-secondary">
                <Show
                  when={settings().digestCadence === "off"}
                  fallback={i18n.t(
                    `kernel.settingsUi.digestCadence.${settings().digestCadence}Hint`,
                  )}
                >
                  <span data-testid="notif-cadence-off-note">
                    {i18n.t("kernel.notificationSettings.cadenceOffNote")}
                  </span>
                </Show>
              </p>
            </section>

            <WorkHoursSection
              workHours={settings().workHours}
              onSave={(patch) => save(patch, settings())}
            />
          </>
        )}
      </Show>

      <ConversationsSection />
      <OnCallSection />
      <AppRulesSection />
      <DevicesSection />
      <ThisDeviceSection />
    </div>
  )
}

export default NotificationSettings
