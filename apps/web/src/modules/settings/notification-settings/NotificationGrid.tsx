// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The grid of Settings -> Notifications: one row per group, one column per
// channel; groups the API places in a section (the three computer session rows)
// follow under that section's heading. The In Liaison column is shown checked and cannot be switched off
// (the feed is where everything lands), and with the digest off every email
// cell reads off (settings-store.ts `cellChecked`).

import { type Component, For, Show } from "solid-js"
import { catalogHasKey, useI18n } from "~/modules/i18n/i18n-context"
import {
  cellChecked,
  gridLayout,
  type NotificationGroupRow,
  type NotificationGroupSectionRow,
  type NotificationSettingsData,
} from "~/modules/settings/notification-settings/settings-store"
import { sectionHeading } from "~/modules/settings/notification-settings/styles"

interface NotificationGridProps {
  settings: NotificationSettingsData
  onToggle: (group: string, channel: string, value: boolean) => void
}

export const NotificationGrid: Component<NotificationGridProps> = (props) => {
  const i18n = useI18n()

  // The API's `labelKey` ("notifications.groups.direct") lives in the kernel
  // catalog; a group the catalog does not know yet keeps the English label.
  const groupLabel = (group: NotificationGroupRow): string => {
    const key = `kernel.${group.labelKey ?? `notifications.groups.${group.id}`}`
    return catalogHasKey(key) ? i18n.t(key) : group.label
  }
  const channelLabel = (channel: string): string => {
    const key = `kernel.notificationSettings.channels.${channel}`
    return catalogHasKey(key) ? i18n.t(key) : channel
  }

  const sectionLabel = (section: NotificationGroupSectionRow): string => {
    const key = `kernel.${section.labelKey}`
    return catalogHasKey(key) ? i18n.t(key) : section.label
  }
  // Under a heading the row reads short ("Done" under "Computer sessions");
  // the cell's accessible name keeps the full group label.
  const rowLabel = (group: NotificationGroupRow, inSection: boolean): string => {
    const key = `kernel.notificationSettings.sectionRows.${group.id}`
    return inSection && catalogHasKey(key) ? i18n.t(key) : groupLabel(group)
  }
  const layout = () => gridLayout(props.settings)

  const GroupRow: Component<{ group: NotificationGroupRow; inSection?: boolean }> = (row) => (
    <tr
      data-testid={`notif-row-${row.group.id}`}
      class="border-b border-border-subtle last:border-b-0"
    >
      <th scope="row" class="px-3 py-2.5 text-left text-[13px] font-normal leading-snug text-text">
        {rowLabel(row.group, row.inSection === true)}
      </th>
      <For each={props.settings.channels}>
        {(channel) => {
          const locked = channel === "in_app"
          return (
            <td class="p-0 text-center">
              <label
                class="flex min-h-11 items-center justify-center lg:min-h-9"
                classList={{ "cursor-pointer": !locked }}
              >
                <input
                  type="checkbox"
                  data-testid={`notif-cell-${row.group.id}-${channel}`}
                  aria-label={i18n.t("kernel.notificationSettings.cellLabel", {
                    group: groupLabel(row.group),
                    channel: channelLabel(channel),
                  })}
                  checked={cellChecked(props.settings, row.group.id, channel)}
                  disabled={locked}
                  onChange={(e) => {
                    if (locked) return
                    props.onToggle(row.group.id, channel, e.currentTarget.checked)
                  }}
                  class="h-4 w-4 accent-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
            </td>
          )
        }}
      </For>
    </tr>
  )

  return (
    <section class="mb-10">
      <h2 class={`mb-3 ${sectionHeading}`}>{i18n.t("kernel.notificationSettings.gridTitle")}</h2>
      <Show
        when={props.settings.groups.length > 0}
        fallback={
          <p data-testid="notif-grid-empty" class="text-[13px] text-text-tertiary">
            {i18n.t("kernel.notificationSettings.gridEmpty")}
          </p>
        }
      >
        <div class="overflow-hidden rounded-md border border-border bg-surface">
          <table data-testid="notif-grid" class="w-full table-fixed border-collapse">
            <colgroup>
              <col />
              <For each={props.settings.channels}>
                {() => <col class="w-[3.5rem] sm:w-[4.5rem]" />}
              </For>
            </colgroup>
            <thead>
              <tr class="border-b border-border-subtle">
                <th
                  scope="col"
                  class="px-3 py-2 text-left text-[11px] font-normal text-text-tertiary"
                >
                  {i18n.t("kernel.notificationSettings.gridKindColumn")}
                </th>
                <For each={props.settings.channels}>
                  {(channel) => (
                    <th
                      scope="col"
                      class="px-0.5 py-2 text-center align-bottom text-[11px] font-medium leading-tight text-text-secondary"
                    >
                      {channelLabel(channel)}
                    </th>
                  )}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={layout().loose}>{(group) => <GroupRow group={group} />}</For>
            </tbody>
            <For each={layout().sections}>
              {(entry) => (
                <tbody class="border-t border-border-subtle">
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={props.settings.channels.length + 1}
                      data-testid={`notif-section-${entry.section.id}`}
                      class="px-3 pt-3 pb-1.5 text-left text-[11px] font-medium text-text-secondary"
                    >
                      {sectionLabel(entry.section)}
                    </th>
                  </tr>
                  <For each={entry.groups}>{(group) => <GroupRow group={group} inSection />}</For>
                </tbody>
              )}
            </For>
          </table>
        </div>
        <p
          data-testid="notif-in-app-why"
          class="mt-2.5 text-[12px] leading-relaxed text-text-tertiary"
        >
          {i18n.t("kernel.notificationSettings.inAppWhy")}
        </p>
      </Show>
    </section>
  )
}
