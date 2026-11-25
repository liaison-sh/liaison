// SPDX-License-Identifier: FSL-1.1-ALv2
// The switches inside one app (`kernel.org_app_features`) an admin turns on for the
// workspace: Companies in Contacts, Deals and Client reports in Projects, Recurring
// billing in Invoicing. Each is off until turned on; off hides its tabs, sidebar
// entries and agent tools again, and deletes nothing. Read from
// `GET /api/apps/<app>/features`, written with `PUT .../features/<feature>`; the
// shell's own feature set (org-features.ts) is read again after a change.
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { setEnabledOrgFeatures } from "~/framework/org-features"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Switch } from "~/ui/Switch"

const P = "kernel.appFeatures"

export interface AppFeatureRow {
  feature: string
  labelKey: string
  descriptionKey?: string
  adminScope: string
  enabled: boolean
  canChange: boolean
}

export const AppFeatureSwitches: Component<{ appId: string }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [rows, { mutate }] = createResource(
    () => props.appId,
    async (app) => {
      try {
        return await api.get<AppFeatureRow[]>(`/apps/${encodeURIComponent(app)}/features`)
      } catch {
        return []
      }
    },
  )
  const [failed, setFailed] = createSignal<string | null>(null)
  const label = (r: AppFeatureRow) => {
    const t = i18n.t(r.labelKey)
    return t === r.labelKey ? r.feature : t
  }
  const toggle = async (r: AppFeatureRow, enabled: boolean) => {
    setFailed(null)
    try {
      await api.put(
        `/apps/${encodeURIComponent(props.appId)}/features/${encodeURIComponent(r.feature)}`,
        { enabled },
      )
      mutate((list) => list?.map((x) => (x.feature === r.feature ? { ...x, enabled } : x)))
      const feed = await api.get<Array<{ app: string; feature: string }>>("/apps/features")
      if (Array.isArray(feed)) setEnabledOrgFeatures(feed)
    } catch {
      setFailed(r.feature)
    }
  }
  return (
    <Show when={(rows() ?? []).length > 0}>
      <section
        class="mb-6 rounded-lg border border-border bg-surface px-4 py-3"
        data-testid={`app-features-${props.appId}`}
      >
        <h2 class="text-[13px] font-semibold">{i18n.t(`${P}.title`)}</h2>
        <p class="mt-1 text-[12.5px] text-text-secondary">{i18n.t(`${P}.intro`)}</p>
        <ul class="mt-3 flex flex-col gap-3">
          <For each={rows()}>
            {(r) => (
              <li class="flex items-start justify-between gap-4">
                <div class="min-w-0">
                  <div class="text-[13px] font-medium">{label(r)}</div>
                  <Show when={r.descriptionKey}>
                    {(key) => <div class="text-[12.5px] text-text-secondary">{i18n.t(key())}</div>}
                  </Show>
                  <Show when={!r.canChange}>
                    <div class="text-[12px] text-text-secondary">
                      {i18n.t(`${P}.noRight`, { scope: r.adminScope })}
                    </div>
                  </Show>
                  <Show when={failed() === r.feature}>
                    <div class="text-[12px] text-danger" role="alert">
                      {i18n.t(`${P}.saveFailed`, { feature: label(r) })}
                    </div>
                  </Show>
                </div>
                <Switch
                  checked={r.enabled}
                  disabled={!r.canChange}
                  label={label(r)}
                  onChange={(next) => void toggle(r, next)}
                  data-testid={`app-feature-${props.appId}-${r.feature}`}
                />
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  )
}
