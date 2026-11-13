// SPDX-License-Identifier: FSL-1.1-ALv2
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { MetricData, ValueFormat } from "../dashboards-client"
import { deltaOf } from "../time-range"
import { formatValue } from "./format"

export interface MetricBlockProps {
  data: MetricData
  /** The block spec's format, used when the data names none. */
  format?: ValueFormat
  currency?: string
  locale?: string
  /** What `previous` is: names the comparison under the figure. */
  compareMode?: "lastYear" | "previousPeriod"
  /** Shown instead of "No value yet" when the block follows the dashboard's range. */
  emptyText?: string
  /** map.higherIsBetter: the change reads in the success or error tone by its direction. Absent:
   *  neutral (a count going up is not good or bad by itself). */
  higherIsBetter?: boolean
}

/** The change's tone: "good", "bad", or "neutral" (no direction said, or no change). */
export function deltaTone(
  delta: number,
  higherIsBetter: boolean | undefined,
): "good" | "bad" | "neutral" {
  if (higherIsBetter === undefined || delta === 0) return "neutral"
  return delta > 0 === higherIsBetter ? "good" : "bad"
}

const TONE_TEXT = { good: "text-success", bad: "text-error", neutral: "text-text-secondary" }
const TONE_STROKE = {
  good: "var(--color-success)",
  bad: "var(--color-error)",
  neutral: "var(--color-chart-1)",
}

/** A change as it reads: "+12 %", "−3 %", "0 %". */
export function formatDelta(delta: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: Math.abs(delta) < 0.1 ? 1 : 0,
    signDisplay: "exceptZero",
  }).format(delta)
}

/** The points of a sparkline polyline in a `w` × `h` box (flat when every value is equal). */
export function sparklinePoints(values: number[], w = 100, h = 24): string {
  if (values.length === 0) return ""
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = values.length > 1 ? w / (values.length - 1) : 0
  return values
    .map((v, i) => {
      const x = values.length > 1 ? i * step : w / 2
      const y = max === min ? h / 2 : h - ((v - min) / span) * h
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`
    })
    .join(" ")
}

/**
 * One number, large, in the display face. Beside it the change against the comparison window
 * (neutral unless the block says which direction is better: then the success or error tone, on
 * the text only), under it a sparkline of the same rows in the series colour, and the goal as
 * "x of y" with a thin bar. A metric with no value says so rather than showing 0.
 */
export const MetricBlock: Component<MetricBlockProps> = (props) => {
  const i18n = useI18n()
  const locale = () => props.locale ?? i18n.locale()
  const fmt = (v: unknown) =>
    formatValue(v, {
      format: props.data.format ?? props.format,
      currency: props.data.currency ?? props.currency,
      locale: locale(),
    })
  const text = () => fmt(props.data.value)
  const delta = () => deltaOf(props.data.value, props.data.previous)
  const compareText = () =>
    props.compareMode === "previousPeriod"
      ? i18n.t("kernel.dashboards.vsPreviousPeriod")
      : i18n.t("kernel.dashboards.vsLastYear")
  const progress = () => {
    const t = props.data.target
    const v = props.data.value
    if (typeof t !== "number" || t <= 0 || typeof v !== "number") return null
    return Math.max(0, Math.min(1, v / t))
  }
  const tone = () => {
    const d = delta()
    return d === null ? "neutral" : deltaTone(d, props.higherIsBetter)
  }
  const spark = () => {
    const s = props.data.sparkline?.values.filter((v) => typeof v === "number") ?? []
    return s.length > 1 ? s : null
  }
  return (
    <Show
      when={text() !== ""}
      fallback={
        <p data-testid="block-metric-empty" class="py-4 text-[13px] text-text-tertiary">
          {props.emptyText ?? i18n.t("kernel.dashboards.noValue")}
        </p>
      }
    >
      <div class="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1 pt-1 pb-1">
        <p
          data-testid="block-metric-value"
          class="min-w-0 truncate font-display text-[36px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-text"
        >
          {text()}
        </p>
        <Show when={delta() !== null}>
          <p
            data-testid="block-metric-delta"
            data-direction={delta()! > 0 ? "up" : delta()! < 0 ? "down" : "flat"}
            data-tone={tone()}
            title={i18n.t("kernel.dashboards.previousValue", { value: fmt(props.data.previous) })}
            class={`flex items-center gap-1 text-[12.5px] tabular-nums ${TONE_TEXT[tone()]}`}
          >
            {delta()! > 0 ? (
              <ArrowUpRight size={13} aria-hidden="true" />
            ) : delta()! < 0 ? (
              <ArrowDownRight size={13} aria-hidden="true" />
            ) : (
              <ArrowRight size={13} aria-hidden="true" />
            )}
            <span>
              {formatDelta(delta()!, locale())} {compareText()}
            </span>
          </p>
        </Show>
      </div>
      <Show when={spark()}>
        {(values) => (
          <svg
            data-testid="block-metric-sparkline"
            viewBox="0 0 200 32"
            preserveAspectRatio="none"
            class="mt-1 h-8 w-full"
            aria-hidden="true"
          >
            <polyline
              points={sparklinePoints(values(), 200, 28)}
              transform="translate(0 2)"
              fill="none"
              stroke={TONE_STROKE[tone()]}
              stroke-width="2"
              vector-effect="non-scaling-stroke"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          </svg>
        )}
      </Show>
      <Show when={progress() !== null}>
        <div data-testid="block-metric-target" class="mt-2">
          <p class="text-[12px] tabular-nums text-text-tertiary">
            {i18n.t("kernel.dashboards.targetOf", {
              value: text(),
              target: fmt(props.data.target),
            })}
          </p>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress()! * 100)}
            aria-label={i18n.t("kernel.dashboards.targetLabel")}
            class="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-hover"
          >
            <div
              data-testid="block-metric-target-bar"
              class="h-full rounded-full bg-accent/70"
              style={{ width: `${Math.round(progress()! * 100)}%` }}
            />
          </div>
        </div>
      </Show>
    </Show>
  )
}
