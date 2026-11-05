// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE AI MODELS PAGE'S "CONVERSATION HISTORY" SETTING: after how many tokens of
// raw history an agent summarizes the older part of a conversation (a
// checkpoint), and whether an idle conversation is summarized while the
// provider's prompt cache is still warm. Entered in thousands of tokens; the
// server clamps the value to what each model's window can hold.

import type { HistorySettings } from "@liaison/shared"
import { type Component, createSignal, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Switch } from "~/ui/Switch"

const K = 1000

export const HistorySection: Component = () => {
  const { t } = useI18n()
  const api = useApi()
  const [current, setCurrent] = createSignal<HistorySettings | null>(null)
  const [draft, setDraft] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  const effective = (s: HistorySettings) => s.budgetTokens ?? s.defaultBudgetTokens
  const show = (s: HistorySettings) => {
    setCurrent(s)
    setDraft(String(Math.round(effective(s) / K)))
  }

  onMount(() => {
    api
      .get<HistorySettings>("/settings/ai/history", { suppressGlobalError: true })
      .then(show)
      .catch(() => setCurrent(null))
  })

  const draftTokens = () => Math.round(Number(draft()) * K)
  const draftValid = () => {
    const s = current()
    const n = draftTokens()
    return (
      Boolean(s) &&
      Number.isFinite(n) &&
      n >= (s?.minBudgetTokens ?? 0) &&
      n <= (s?.maxBudgetTokens ?? 0)
    )
  }
  const dirty = () => {
    const s = current()
    return Boolean(s) && draftTokens() !== effective(s as HistorySettings)
  }

  async function save(patch: { budgetTokens?: number | null; warmCompaction?: boolean }) {
    if (saving()) return
    setSaving(true)
    try {
      show(await api.patch<HistorySettings>("/settings/ai/history", patch))
      addToast({ message: t("kernel.aiModels.historySaved"), type: "success" })
    } catch {
      addToast({ message: t("kernel.aiModels.historySaveFailed"), type: "error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section class="flex flex-col gap-2" data-testid="ai-models-history">
      <h2 class="text-sm font-semibold text-text">{t("kernel.aiModels.historyTitle")}</h2>
      <Show when={current()}>
        {(s) => (
          <>
            <label
              class="flex flex-wrap items-center gap-2 text-[13px] text-text"
              for="ai-models-history-budget"
            >
              {t("kernel.aiModels.historyBudgetLabel")}
            </label>
            <div class="flex flex-wrap items-center gap-2">
              <input
                id="ai-models-history-budget"
                type="number"
                inputmode="numeric"
                min={s().minBudgetTokens / K}
                max={s().maxBudgetTokens / K}
                step="1"
                class="h-9 w-28 rounded-md border border-border bg-surface px-2 text-[13px] tabular-nums text-text"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                disabled={saving()}
                data-testid="ai-models-history-budget"
              />
              <span class="text-[13px] text-text-secondary">
                {t("kernel.aiModels.historyBudgetUnit")}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={saving() || !dirty() || !draftValid()}
                onClick={() => void save({ budgetTokens: draftTokens() })}
                data-testid="ai-models-history-save"
              >
                {t("kernel.aiModels.historySave")}
              </Button>
              <Show when={s().budgetTokens !== null}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving()}
                  onClick={() => void save({ budgetTokens: null })}
                  data-testid="ai-models-history-reset"
                >
                  {t("kernel.aiModels.historyReset", {
                    value: String(Math.round(s().defaultBudgetTokens / K)),
                  })}
                </Button>
              </Show>
            </div>
            <Show when={!draftValid()}>
              <p class="text-[12px] text-error" data-testid="ai-models-history-invalid">
                {t("kernel.aiModels.historyBudgetRange", {
                  min: String(s().minBudgetTokens / K),
                  max: String(s().maxBudgetTokens / K),
                })}
              </p>
            </Show>
            <p class="text-[12px] text-text-tertiary">{t("kernel.aiModels.historyBudgetHelp")}</p>
            <div class="mt-1 flex items-center gap-3 text-[13px] text-text">
              <Switch
                checked={s().warmCompaction}
                disabled={saving()}
                label={t("kernel.aiModels.historyWarmLabel")}
                onChange={(next) => void save({ warmCompaction: next })}
                data-testid="ai-models-history-warm"
              />
              <span class="min-w-0 flex-1">
                <span>{t("kernel.aiModels.historyWarmLabel")}</span>
                <span class="block text-[12px] text-text-tertiary">
                  {t("kernel.aiModels.historyWarmHelp")}
                </span>
              </span>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}
