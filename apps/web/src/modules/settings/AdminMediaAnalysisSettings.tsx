// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Toggle } from "~/ui/Toggle"

type Surface = "tickets" | "mail"
type Kind = "image" | "video"

interface MediaAnalysisSettings {
  tickets: { image: boolean; video: boolean }
  mail: { image: boolean; video: boolean }
}

const DEFAULTS: MediaAnalysisSettings = {
  tickets: { image: true, video: true },
  mail: { image: false, video: false },
}

const AdminMediaAnalysisSettings: Component = () => {
  const i18n = useI18n()
  const api = useApi()

  // The route returns the resolved 2×2 (four concrete booleans).
  const [loaded] = createResource(async () => {
    const res = (await api.get("/org/settings/media-analysis")) as
      | MediaAnalysisSettings
      | { data?: MediaAnalysisSettings }
    const data =
      ("data" in (res as Record<string, unknown>)
        ? (res as { data?: MediaAnalysisSettings }).data
        : (res as MediaAnalysisSettings)) ?? DEFAULTS
    setState(data)
    return data
  })

  const [state, setState] = createStore<MediaAnalysisSettings>({ ...DEFAULTS })
  // While a PUT is in flight, every toggle is disabled. This both satisfies the
  // spec's "saving (toggle briefly disabled)" state AND prevents the concurrent-
  // toggle race (a second toggle would otherwise PUT a body merged with the
  // first's optimistic state, leaving the server inconsistent if the first
  // reverts).
  const [saving, setSaving] = createSignal(false)

  async function toggle(surface: Surface, kind: Kind) {
    if (saving()) return
    const previous = state[surface][kind]
    // Optimistic update.
    setState(surface, kind, !previous)
    setSaving(true)
    try {
      await api.put("/org/settings/media-analysis", {
        tickets: { ...state.tickets },
        mail: { ...state.mail },
      })
    } catch {
      // Revert on error.
      setState(surface, kind, previous)
      addToast({ message: i18n.t("kernel.mediaAnalysisSaveFailed"), type: "error" })
    } finally {
      setSaving(false)
    }
  }

  const surfaces: { key: Surface; label: string }[] = [
    { key: "tickets", label: i18n.t("kernel.mediaAnalysisTickets") },
    { key: "mail", label: i18n.t("kernel.mediaAnalysisEmail") },
  ]
  const kinds: { key: Kind; label: string }[] = [
    { key: "image", label: i18n.t("kernel.mediaAnalysisImages") },
    { key: "video", label: i18n.t("kernel.mediaAnalysisVideos") },
  ]

  return (
    <div>
      <Show
        when={!loaded.loading}
        fallback={
          <div
            class="h-32 animate-pulse rounded-md bg-surface-hover"
            data-testid="media-analysis-skeleton"
          />
        }
      >
        <div
          class="grid grid-cols-[auto_1fr_1fr] items-center gap-x-6 gap-y-3"
          data-testid="media-analysis-grid"
        >
          <div />
          <For each={kinds}>
            {(k) => <div class="text-xs font-medium text-text-secondary">{k.label}</div>}
          </For>
          <For each={surfaces}>
            {(s) => (
              <>
                <div class="text-sm font-medium text-text">{s.label}</div>
                <For each={kinds}>
                  {(k) => (
                    <Toggle
                      pressed={state[s.key][k.key]}
                      onChange={() => toggle(s.key, k.key)}
                      disabled={saving()}
                      data-testid={`media-analysis-toggle-${s.key}-${k.key}`}
                    >
                      {state[s.key][k.key]
                        ? i18n.t("kernel.mediaAnalysisOn")
                        : i18n.t("kernel.mediaAnalysisOff")}
                    </Toggle>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export default AdminMediaAnalysisSettings
