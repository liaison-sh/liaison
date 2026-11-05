// SPDX-License-Identifier: FSL-1.1-ALv2
import { A, useLocation } from "@solidjs/router"
import { type Component, createMemo, For, Show } from "solid-js"
import { getActivityBarEntries, registryLabel } from "~/framework/app-registry"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { ScrollFade } from "~/ui/ScrollFade"
import {
  buildSettingsNavGroups,
  SETTINGS_NAV_GROUP_LABEL_KEY,
  type SettingsNavRow,
} from "./settings-nav-groups"
import { visibleSettingsSections } from "./visible-settings-sections"

export const SettingsSidebar: Component = () => {
  const i18n = useI18n()
  const location = useLocation()

  const matchesPath = (href: string) =>
    href === "/settings"
      ? location.pathname === "/settings"
      : location.pathname === href || location.pathname.startsWith(`${href}/`)
  const isActive = (row: SettingsNavRow) => row.hrefs.some(matchesPath)

  const groups = createMemo(() =>
    buildSettingsNavGroups(
      visibleSettingsSections().filter((s) => !s.hidden),
      getActivityBarEntries(),
      i18n.t,
    ),
  )

  const RowLink: Component<{ row: SettingsNavRow }> = (props) => (
    <A
      href={props.row.href}
      data-testid={`settings-link-${props.row.key}`}
      class={cn(
        "rounded-md px-3 py-1.5 text-sm transition-colors duration-150",
        isActive(props.row)
          ? "bg-surface-active text-text font-medium"
          : "text-text-secondary hover:bg-surface-hover hover:text-text",
      )}
    >
      <span class="flex items-center justify-between gap-3">
        <span>{props.row.label}</span>
        <Show when={props.row.section.badge}>
          {(badge) => (
            <span class="text-[10px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
              {registryLabel(i18n.t, { label: badge(), labelKey: props.row.section.badgeKey })}
            </span>
          )}
        </Show>
      </span>
    </A>
  )

  const headingClass = "mb-1 block px-4 text-[11px] font-semibold uppercase tracking-wider"

  return (
    <div class="flex min-h-0 flex-1 flex-col py-4" data-testid="settings-sidebar">
      <h2 class="mb-3 px-4 text-[13px] font-semibold uppercase tracking-[0.02em] text-text-secondary">
        {i18n.t("kernel.nav.settings")}
      </h2>
      <ScrollFade class="min-h-0 flex-1">
        <For each={groups()}>
          {(group) => (
            <div class="mb-5" data-testid={`settings-group-${group.id}`}>
              <h2 data-testid={`settings-group-heading-${group.id}`}>
                <Show
                  when={group.link}
                  fallback={
                    <span class={cn(headingClass, "text-text-tertiary")}>
                      {i18n.t(SETTINGS_NAV_GROUP_LABEL_KEY[group.id])}
                    </span>
                  }
                >
                  {(link) => (
                    // The Connectors heading IS the page's link (D26): no
                    // row beneath it repeats its name.
                    <A
                      href={link().href}
                      data-testid={`settings-link-${link().key}`}
                      class={cn(
                        headingClass,
                        "rounded-md py-1 transition-colors duration-150 hover:bg-surface-hover hover:text-text",
                        isActive(link()) ? "bg-surface-active text-text" : "text-text-tertiary",
                      )}
                    >
                      {i18n.t(SETTINGS_NAV_GROUP_LABEL_KEY[group.id])}
                    </A>
                  )}
                </Show>
              </h2>
              <Show when={group.rows.length > 0}>
                <nav class="flex flex-col gap-0.5 px-2">
                  <For each={group.rows}>{(row) => <RowLink row={row} />}</For>
                </nav>
              </Show>
            </div>
          )}
        </For>
      </ScrollFade>
    </div>
  )
}
