// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { MetricData, ValueFormat } from "../dashboards-client"
import { formatValue } from "./format"

export interface MetricBlockProps {
  data: MetricData
  /** The block spec's format, used when the data names none. */
  format?: ValueFormat
  currency?: string
  locale?: string
}

/** One number, large. A metric with no value says so rather than showing 0. */
export const MetricBlock: Component<MetricBlockProps> = (props) => {
  const i18n = useI18n()
  const text = () =>
    formatValue(props.data.value, {
      format: props.data.format ?? props.format,
      currency: props.data.currency ?? props.currency,
      locale: props.locale ?? i18n.locale(),
    })
  return (
    <Show
      when={text() !== ""}
      fallback={
        <p data-testid="block-metric-empty" class="py-4 text-[13px] text-text-tertiary">
          {i18n.t("kernel.dashboards.noValue")}
        </p>
      }
    >
      <p
        data-testid="block-metric-value"
        class="truncate py-2 text-[28px] font-semibold leading-tight tabular-nums text-text"
      >
        {text()}
      </p>
    </Show>
  )
}
