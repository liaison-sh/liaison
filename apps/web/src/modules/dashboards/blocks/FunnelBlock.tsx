// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A funnel: its stages top to bottom, each a calm bar as wide as its share of
// the first stage, and between two stages the conversion from one to the next
// ("62 % continue"). Drawn in HTML, not on a canvas: every stage is a button
// when the dashboard can open the rows behind it.
import { type Component, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { FunnelData, ValueFormat } from "../dashboards-client"
import { formatValue } from "./format"

export interface FunnelBlockProps {
  data: FunnelData
  format?: ValueFormat
  currency?: string
  locale?: string
  emptyText?: string
  /** A stage picked: the dashboard opens the rows behind it. */
  onPick?: (index: number) => void
}

export interface FunnelStage {
  label: string
  value: number
  /** Width against the largest stage, 0 to 1. */
  share: number
  /** This stage over the one before it (null for the first, or after an empty stage). */
  conversion: number | null
}

/** The stages with their widths and the conversion from each one to the next. */
export function funnelStages(labels: string[], values: number[]): FunnelStage[] {
  const max = Math.max(0, ...values.map((v) => (Number.isFinite(v) ? v : 0)))
  return labels.map((label, i) => {
    const value = Number.isFinite(values[i]) ? (values[i] as number) : 0
    const prev = i > 0 ? (values[i - 1] ?? 0) : null
    return {
      label,
      value,
      share: max > 0 ? Math.max(0, value) / max : 0,
      conversion: prev !== null && prev > 0 ? value / prev : null,
    }
  })
}

export const FunnelBlock: Component<FunnelBlockProps> = (props) => {
  const i18n = useI18n()
  const locale = () => props.locale ?? i18n.locale()
  const stages = () => funnelStages(props.data.labels, props.data.values)
  const fmt = (v: number) =>
    formatValue(v, {
      format: props.data.format ?? props.format,
      currency: props.data.currency ?? props.currency,
      locale: locale(),
    })
  const pct = (v: number) =>
    new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 1 }).format(v)
  return (
    <Show
      when={stages().length > 0}
      fallback={
        <p data-testid="block-empty" class="py-4 text-[13px] text-text-tertiary">
          {props.emptyText ?? i18n.t("kernel.dashboards.noData")}
        </p>
      }
    >
      <ol data-testid="block-funnel" class="flex flex-col py-1">
        <For each={stages()}>
          {(stage, i) => {
            const body = (
              <>
                <span class="flex items-baseline justify-between gap-2 text-[12.5px]">
                  <span class="min-w-0 truncate text-text-secondary">{stage.label}</span>
                  <span
                    data-testid={`block-funnel-value-${i()}`}
                    class="shrink-0 tabular-nums text-text"
                  >
                    {fmt(stage.value)}
                  </span>
                </span>
                <span class="mt-1 block h-2 w-full overflow-hidden rounded-full bg-surface-hover">
                  <span
                    class="block h-full rounded-full bg-accent/60"
                    style={{ width: `${Math.round(stage.share * 1000) / 10}%` }}
                  />
                </span>
              </>
            )
            return (
              <li data-testid={`block-funnel-stage-${i()}`}>
                <Show when={stage.conversion !== null}>
                  <p
                    data-testid={`block-funnel-conversion-${i()}`}
                    class="py-1 pl-2 text-[11.5px] tabular-nums text-text-tertiary"
                  >
                    {i18n.t("kernel.dashboards.funnelConversion", {
                      percent: pct(stage.conversion ?? 0),
                    })}
                  </p>
                </Show>
                <Show when={props.onPick} fallback={<div class="py-1">{body}</div>}>
                  {(pick) => (
                    <button
                      type="button"
                      data-testid={`block-funnel-pick-${i()}`}
                      aria-label={i18n.t("kernel.dashboards.drillShowFor", { label: stage.label })}
                      onClick={() => pick()(i())}
                      class="block w-full rounded px-1 py-1 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                    >
                      {body}
                    </button>
                  )}
                </Show>
              </li>
            )
          }}
        </For>
      </ol>
    </Show>
  )
}
