// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, Match, Switch } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { BlockData, DashboardBlockMap, PieData, SeriesData } from "../dashboards-client"
import { Chart } from "./Chart"
import { MetricBlock } from "./MetricBlock"
import { TableBlock } from "./TableBlock"

export interface BlockRendererProps {
  data: BlockData
  /** The block spec's map: its format and currency apply when the data names none. */
  map?: DashboardBlockMap
  title?: string
  locale?: string
}

function seriesEmpty(d: SeriesData): boolean {
  return d.x.length === 0 || d.series.length === 0
}

/** Draws one block's mapped data, whatever its kind. */
export const BlockRenderer: Component<BlockRendererProps> = (props) => {
  const i18n = useI18n()
  const format = () => props.map?.format
  const currency = () => props.map?.currency
  const empty = (
    <p data-testid="block-empty" class="py-4 text-[13px] text-text-tertiary">
      {i18n.t("kernel.dashboards.noData")}
    </p>
  )
  return (
    <Switch>
      <Match when={props.data.kind === "metric" && props.data}>
        {(d) => (
          <MetricBlock
            data={d() as Extract<BlockData, { kind: "metric" }>}
            format={format()}
            currency={currency()}
            locale={props.locale}
          />
        )}
      </Match>
      <Match when={props.data.kind === "table" && props.data}>
        {(d) => (
          <TableBlock
            data={d() as Extract<BlockData, { kind: "table" }>}
            currency={currency()}
            locale={props.locale}
          />
        )}
      </Match>
      <Match when={(props.data.kind === "bar" || props.data.kind === "line") && props.data}>
        {(d) => {
          const s = () => d() as SeriesData
          return seriesEmpty(s()) ? (
            empty
          ) : (
            <Chart
              type={s().kind}
              labels={s().x}
              datasets={s().series.map((x) => ({ label: x.name, values: x.values }))}
              format={s().format ?? format()}
              currency={s().currency ?? currency()}
              locale={props.locale}
              label={props.title}
            />
          )
        }}
      </Match>
      <Match when={props.data.kind === "pie" && props.data}>
        {(d) => {
          const p = () => d() as PieData
          return p().labels.length === 0 ? (
            empty
          ) : (
            <Chart
              type="pie"
              labels={p().labels}
              datasets={[{ label: props.title ?? "", values: p().values }]}
              format={p().format ?? format()}
              currency={p().currency ?? currency()}
              locale={props.locale}
              label={props.title}
            />
          )
        }}
      </Match>
    </Switch>
  )
}
