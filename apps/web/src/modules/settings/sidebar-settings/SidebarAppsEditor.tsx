// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one list both Settings > Sidebar (the person's own) and an admin's
// member page use to choose which apps a sidebar shows: one row per app of
// the rail, in rail order, its glyph in the rail's own colour, its name, and a
// "show in the sidebar" switch. Every switch is a change on its own (no save
// button). Ids this device does not know (an app another device runs) are
// kept in the list it hands back: only the row switched moves.
import { type Component, createMemo, For } from "solid-js"
import { getActivityBarEntries, registryLabel } from "~/framework/app-registry"
import { useI18n } from "~/modules/i18n/i18n-context"
import { applyActivityBarOrder } from "~/modules/shell/activity-bar-order-store"
import { appIconColor } from "~/modules/shell/app-color"
import { Switch } from "~/ui/Switch"

interface SidebarAppsEditorProps {
  /** The ids hidden from the sidebar. */
  hidden: string[]
  /** Called with the whole next list after one switch moved. */
  onChange: (next: string[]) => void
  /** Prefix of every test id, so the self page and the admin page differ. */
  testIdPrefix: string
}

export const SidebarAppsEditor: Component<SidebarAppsEditorProps> = (props) => {
  const i18n = useI18n()
  const entries = createMemo(() =>
    applyActivityBarOrder(getActivityBarEntries().filter((e) => e.position !== "bottom")),
  )

  function toggle(id: string, show: boolean): void {
    const without = props.hidden.filter((e) => e !== id)
    props.onChange(show ? without : [...without, id])
  }

  return (
    <ul
      data-testid={`${props.testIdPrefix}-list`}
      class="divide-y divide-border-subtle overflow-hidden rounded-md border border-border bg-surface"
    >
      <For each={entries()}>
        {(entry) => {
          const label = () => registryLabel(i18n.t, entry)
          const shown = () => !props.hidden.includes(entry.id)
          return (
            <li
              data-testid={`${props.testIdPrefix}-row-${entry.id}`}
              data-hidden={shown() ? undefined : ""}
              class="flex min-h-11 items-center justify-between gap-4 px-4 py-2"
            >
              <span class="flex min-w-0 items-center gap-3">
                <span
                  data-app-glyph={entry.appId}
                  aria-hidden="true"
                  class="flex h-5 w-5 shrink-0 items-center justify-center"
                  style={{ color: appIconColor(entry.appId) }}
                >
                  <entry.icon size={16} />
                </span>
                <span
                  class={
                    shown()
                      ? "truncate text-[13px] text-text"
                      : "truncate text-[13px] text-text-tertiary"
                  }
                >
                  {label()}
                </span>
              </span>
              <Switch
                data-testid={`${props.testIdPrefix}-switch-${entry.id}`}
                checked={shown()}
                onChange={(next) => toggle(entry.id, next)}
                label={i18n.t("kernel.sidebarSettings.showInSidebar", { app: label() })}
              />
            </li>
          )
        }}
      </For>
    </ul>
  )
}
