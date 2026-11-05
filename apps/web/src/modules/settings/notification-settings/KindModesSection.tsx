// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings -> Notifications, "How each kind reaches you" (etiquette rules 7
// and 10): each kind is set to interrupt (computer and phone), inbox only, or
// off. Off mutes the kind on every channel; its items still show in the inbox,
// already read. The grid below keeps the per-channel detail.

import { type Component, For } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { SegmentedChoice } from "~/modules/settings/notification-settings/SegmentedChoice"
import {
  KIND_MODES,
  type KindMode,
  kindMode,
  type NotificationSettingsData,
} from "~/modules/settings/notification-settings/settings-store"
import { sectionHeading } from "~/modules/settings/notification-settings/styles"

interface KindModesSectionProps {
  settings: NotificationSettingsData
  onChange: (group: string, mode: KindMode) => void
}

export const KindModesSection: Component<KindModesSectionProps> = (props) => {
  const i18n = useI18n()
  const k = (key: string) => i18n.t(`kernel.notificationSettings.${key}`)
  const groupLabel = (g: { id: string; label: string; labelKey?: string }) =>
    g.labelKey ? i18n.t(`kernel.${g.labelKey}`) : g.label
  return (
    <section data-testid="notif-kind-modes" class="mb-10">
      <h2 class={`mb-3 ${sectionHeading}`}>{k("kindsTitle")}</h2>
      <p class="mb-4 max-w-[60ch] text-[12px] leading-relaxed text-text-secondary">
        {k("kindsHint")}
      </p>
      <ul class="flex flex-col gap-3">
        <For each={props.settings.groups}>
          {(group) => (
            <li
              data-testid={`notif-kind-${group.id}`}
              class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-center"
            >
              <span class="text-[13px] leading-snug text-text">{groupLabel(group)}</span>
              <SegmentedChoice
                name={`kind-mode-${group.id}`}
                testId={`notif-kind-mode-${group.id}`}
                label={groupLabel(group)}
                options={KIND_MODES}
                value={kindMode(props.settings, group.id)}
                optionLabel={(mode) => k(`kindModes.${mode}`)}
                onChange={(mode) => props.onChange(group.id, mode)}
                threeColumns
              />
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}
