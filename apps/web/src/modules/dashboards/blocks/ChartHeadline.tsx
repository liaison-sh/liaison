// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A chart's headline: the period's figure(s) above the drawing (the block's total, one per
// series, a blended chart's layer totals and computed figures), each with its change against
// the comparison, calmly: an arrow and the percentage in the text's own colour, never red or
// green. The comparison's days are named once, under the figures.
import { type Component, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { ChartLayer, HeadlineFigure, ValueFormat } from "../dashboards-client"
import { deltaOf } from "../time-range"
import { formatValue } from "./format"

export interface ChartHeadlineProps {
  figures: HeadlineFigure[]
  /** A blended chart's layers: a layer's figure reads in that layer's format. */
  layers?: ChartLayer[]
  format?: ValueFormat
  currency?: string
  locale: string
  /** The comparison as it reads ("Oct 1 – 12, 2026", or "Previous period"). */
  compareName?: string
}

/** A change as it reads: "↑ 12%", "↓ 25%", "0%" (no sign: the arrow says which way). */
export function headlineChange(delta: number, locale: string): string {
  const pct = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: Math.abs(delta) < 0.1 && delta !== 0 ? 1 : 0,
  }).format(Math.abs(delta))
  if (pct.replace(/[^\d]/g, "").replace(/^0+/, "") === "") return pct
  return `${delta > 0 ? "↑" : "↓"} ${pct}`
}

export const ChartHeadline: Component<ChartHeadlineProps> = (props) => {
  const i18n = useI18n()
  const fmtOf = (f: HeadlineFigure) => {
    const layer = f.layer ? props.layers?.find((l) => l.id === f.layer) : undefined
    // A computed figure is a ratio of totals: a plain number.
    const format = f.calc ? undefined : (layer?.format ?? props.format)
    const currency = layer?.currency ?? props.currency
    return (v: unknown) => formatValue(v, { format, currency, locale: props.locale })
  }
  const compared = () => props.figures.some((f) => f.previous !== undefined)
  const single = () => props.figures.length === 1
  return (
    <div data-testid="chart-headline" class="mb-2">
      <div class="flex flex-wrap items-end gap-x-6 gap-y-2">
        <For each={props.figures}>
          {(f, i) => {
            const fmt = fmtOf(f)
            const delta = () => deltaOf(f.value, f.previous)
            return (
              <div data-testid={`chart-headline-figure-${i()}`} data-key={f.key} class="min-w-0">
                <p class="truncate text-[12px] text-text-tertiary">{f.label}</p>
                <div class="flex items-baseline gap-2">
                  <span
                    data-testid={`chart-headline-value-${i()}`}
                    class={
                      single()
                        ? "text-[28px] font-semibold leading-tight tabular-nums text-text"
                        : "text-[18px] font-semibold leading-tight tabular-nums text-text"
                    }
                  >
                    {f.value === null ? i18n.t("kernel.dashboards.noValue") : fmt(f.value)}
                  </span>
                  <Show when={delta() !== null}>
                    <span
                      data-testid={`chart-headline-change-${i()}`}
                      data-direction={delta()! > 0 ? "up" : delta()! < 0 ? "down" : "flat"}
                      title={i18n.t("kernel.dashboards.previousValue", {
                        value: fmt(f.previous),
                      })}
                      class="text-[12px] tabular-nums text-text-secondary"
                    >
                      {headlineChange(delta()!, props.locale)}
                    </span>
                  </Show>
                </div>
              </div>
            )
          }}
        </For>
      </div>
      <Show when={compared() && props.compareName}>
        <p data-testid="chart-headline-compare" class="mt-0.5 text-[11.5px] text-text-tertiary">
          {i18n.t("kernel.dashboards.chartVs", { range: props.compareName ?? "" })}
        </p>
      </Show>
    </div>
  )
}
