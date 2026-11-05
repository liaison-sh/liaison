// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The anatomy every regrouped kernel settings page shares (settings overhaul
// S16, prototype v2.1): one page title, then sections, each with its own
// heading, an optional line under it and a badge saying whose setting it is.
import { type JSX, type ParentComponent, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"

export const SettingsPageHeader: ParentComponent<{ title: string; intro?: string }> = (props) => (
  <div class="mb-6">
    <h1 class="text-lg font-semibold text-text">{props.title}</h1>
    <Show when={props.intro}>
      <p class="mt-1 text-sm text-text-secondary">{props.intro}</p>
    </Show>
    {props.children}
  </div>
)

export const SettingsPageSection: ParentComponent<{
  title: string
  description?: string
  /** Whose setting this is: the organisation's, or the viewer's own. */
  scope?: "org" | "user"
  action?: JSX.Element
  "data-testid"?: string
}> = (props) => {
  const i18n = useI18n()
  return (
    <section data-testid={props["data-testid"]} class="mb-10 last:mb-0">
      <div class="mb-3 flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="flex flex-wrap items-center gap-2 text-sm font-semibold text-text">
            {props.title}
            <Show when={props.scope}>
              <span class="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
                {props.scope === "org"
                  ? i18n.t("kernel.settingsRegroup.scopeOrg")
                  : i18n.t("kernel.settingsRegroup.scopeUser")}
              </span>
            </Show>
          </h2>
          <Show when={props.description}>
            <p class="mt-1 text-xs text-text-secondary">{props.description}</p>
          </Show>
        </div>
        <Show when={props.action}>{props.action}</Show>
      </div>
      {props.children}
    </section>
  )
}
