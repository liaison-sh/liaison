// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE AI MODELS PAGE'S "VOICE DICTATION" SETTING: which transcription model
// the org's composers dictate with. Only models a configured key can run are
// listed, each with its price per minute; the measured default carries a
// badge, and choosing it follows the default (a later, better measured
// default is picked up). With no capable key the section says which key turns
// dictation on; the mic is absent from every composer until then.

import type { TranscriptionSettings } from "@liaison/shared"
import { type Component, createEffect, createSignal, For, on, Show } from "solid-js"
import { currentLocale, useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"

export const VoiceDictationSection: Component<{
  /** Bumped by the page when keys change: the list is read again. */
  version: number
}> = (props) => {
  const { t } = useI18n()
  const api = useApi()
  // A signal rather than a resource: the page around it must not suspend.
  const [current, setCurrent] = createSignal<TranscriptionSettings | null>(null)
  const [loadFailed, setLoadFailed] = createSignal(false)
  createEffect(
    on(
      () => props.version,
      () => {
        api
          .get<TranscriptionSettings>("/settings/ai/transcription", { suppressGlobalError: true })
          .then((read) => {
            setCurrent(read)
            setLoadFailed(false)
          })
          .catch(() => setLoadFailed(true))
      },
    ),
  )
  const chosen = () => {
    const s = current()
    return s ? (s.current ?? s.default) : null
  }
  const [saving, setSaving] = createSignal(false)

  // Self-hosted: the list price in USD; a managed cell serves credits instead (S18).
  const perMinute = (m: { pricePerMinuteUsd?: number; creditsPerMinute?: number }) =>
    typeof m.creditsPerMinute === "number"
      ? t("kernel.aiModels.voicePerMinuteCredits", {
          amount: new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 4 }).format(
            m.creditsPerMinute,
          ),
        })
      : t("kernel.aiModels.voicePerMinute", {
          price: new Intl.NumberFormat(currentLocale(), {
            style: "currency",
            currency: "USD",
            maximumFractionDigits: 4,
          }).format(m.pricePerMinuteUsd ?? 0),
        })

  async function choose(key: string) {
    const s = current()
    if (!s || saving() || key === chosen()) return
    setSaving(true)
    try {
      // The default is followed rather than pinned.
      const next = await api.patch<TranscriptionSettings>("/settings/ai/transcription", {
        modelKey: key === s.default ? null : key,
      })
      setCurrent(next)
      addToast({ message: t("kernel.aiModels.voiceSaved"), type: "success" })
    } catch {
      addToast({ message: t("kernel.aiModels.voiceSaveFailed"), type: "error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section class="flex flex-col gap-2" data-testid="ai-models-voice">
      <h2 class="text-sm font-semibold text-text">{t("kernel.aiModels.voiceTitle")}</h2>
      <p class="text-[13px] text-text-secondary">{t("kernel.aiModels.voiceDescription")}</p>
      <Show when={loadFailed() && !current()}>
        <p class="text-[13px] text-text-secondary" data-testid="ai-models-voice-load-failed">
          {t("kernel.aiModels.voiceLoadFailed")}
        </p>
      </Show>
      <Show when={current()}>
        {(s) => (
          <Show
            when={s().available.length > 0}
            fallback={
              <p class="text-[13px] text-text-secondary" data-testid="ai-models-voice-empty">
                {t("kernel.aiModels.voiceEmpty")}
              </p>
            }
          >
            <div
              role="radiogroup"
              aria-label={t("kernel.aiModels.voiceModelLabel")}
              class="flex flex-col divide-y divide-border rounded-md border border-border"
            >
              <For each={s().available}>
                {(m) => (
                  <label
                    class="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-[13px]"
                    data-testid="ai-models-voice-option"
                    data-key={m.key}
                  >
                    <input
                      type="radio"
                      name="ai-models-voice"
                      value={m.key}
                      checked={chosen() === m.key}
                      disabled={saving()}
                      onChange={() => void choose(m.key)}
                    />
                    <span class="min-w-0 flex-1">
                      <span class="text-text">{m.label}</span>
                      <span class="text-text-tertiary"> · {m.provider}</span>
                    </span>
                    <Show when={m.key === s().default}>
                      <span
                        class="rounded border border-border px-1.5 text-[11px] text-text-secondary"
                        data-testid="ai-models-voice-default"
                      >
                        {t("kernel.aiModels.voiceDefaultBadge")}
                      </span>
                    </Show>
                    <span class="shrink-0 tabular-nums text-[12px] text-text-tertiary">
                      {perMinute(m)}
                    </span>
                  </label>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
    </section>
  )
}
