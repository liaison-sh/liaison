// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, Match, Switch } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type {
  BlockData,
  DashboardBlockMap,
  DrillTarget,
  FunnelData,
  PieData,
  SeriesData,
} from "../dashboards-client"
import { Chart, type ChartDataset } from "./Chart"
import { FunnelBlock } from "./FunnelBlock"
import { MetricBlock } from "./MetricBlock"
import { TableBlock } from "./TableBlock"
import { TextBlock } from "./TextBlock"

export interface BlockRendererProps {
  data: BlockData
  /** The block spec's map: its format and currency apply when the data names none. */
  map?: DashboardBlockMap
  title?: string
  locale?: string
  /** What the comparison is, when the data carries one. */
  compareMode?: "lastYear" | "previousPeriod"
  /** The empty state's copy when the block follows the dashboard's range ("No data between …"). */
  emptyText?: string
  /** A figure picked (a bar, a slice, a stage, a row): the dashboard opens the rows behind it. */
  onDrill?: (target: DrillTarget) => void
  /** The org's time zone: timestamps read in it. */
  timeZone?: string
  /** The block spans two grid rows: charts take the room. */
  tall?: boolean
}

/**
 * A chart whose map asks for each value as a share of its series' total (`percentOfTotal`):
 * the server sends percent points (0-100), shown as percentages.
 */
export function sharesOf<T extends Array<number | null>>(values: T): Array<number | null> {
  return values.map((v) => (typeof v === "number" ? v / 100 : v))
}

const SERIES_KINDS = new Set(["bar", "line", "area", "combo"])

function seriesEmpty(d: SeriesData): boolean {
  return d.x.length === 0 || d.series.length === 0
}

/**
 * A bar or line block's datasets: its series, then, when the server sent a comparison, each
 * series' previous values (drawn lighter) named "<series> · <comparison>".
 */
export function seriesDatasets(d: SeriesData, previousName: string): ChartDataset[] {
  const lines = new Set(d.kind === "combo" ? (d.display?.lineSeries ?? []) : [])
  const current: ChartDataset[] = d.series.map((x) => ({
    label: x.name,
    values: x.values,
    ...(lines.has(x.name) ? { asLine: true } : {}),
  }))
  const previous: ChartDataset[] = (d.previous?.series ?? [])
    .filter((p) => p.values.some((v) => v !== null))
    .map((p) => ({
      label: d.series.length > 1 && p.name ? `${p.name} · ${previousName}` : previousName,
      values: p.values,
      previous: true,
    }))
  return [...current, ...previous]
}

/**
 * What a pick on a series chart asks for: the category as the server labels it, and the series
 * when the chart splits into several. A pick on a comparison series asks for the comparison
 * window's rows (`previous`), under the comparison's own label for that place; null when that
 * place has no previous value.
 */
export function seriesPick(d: SeriesData, index: number, datasetIndex: number): DrillTarget | null {
  if (datasetIndex >= d.series.length) {
    // The order seriesDatasets draws them in: only comparison series that hold a value.
    const drawn = (d.previous?.series ?? []).filter((p) => p.values.some((v) => v !== null))
    const p = drawn[datasetIndex - d.series.length]
    const label = d.previous?.labels[index]
    if (!p || label === null || label === undefined || p.values[index] == null) return null
    const target: DrillTarget = { category: String(label), previous: true }
    if (d.series.length > 1 && p.name) target.series = p.name
    return target
  }
  const label = d.x[index]
  const target: DrillTarget = {
    category: label === null || label === undefined ? "" : String(label),
  }
  const series = d.series[datasetIndex]
  if (d.series.length > 1 && series) target.series = series.name
  return target
}

/** Draws one block's mapped data, whatever its kind. */
export const BlockRenderer: Component<BlockRendererProps> = (props) => {
  const i18n = useI18n()
  const previousName = () =>
    props.compareMode === "previousPeriod"
      ? i18n.t("kernel.dashboards.comparePrevious")
      : i18n.t("kernel.dashboards.compareLastYear")
  const format = () => props.map?.format
  const share = () => props.map?.percentOfTotal === true
  const currency = () => props.map?.currency
  const empty = (
    <p data-testid="block-empty" class="py-4 text-[13px] text-text-tertiary">
      {props.emptyText ?? i18n.t("kernel.dashboards.noData")}
    </p>
  )
  return (
    <Switch>
      <Match when={props.data.kind === "metric" && props.data}>
        {(d) => {
          const metric = (
            <MetricBlock
              data={d() as Extract<BlockData, { kind: "metric" }>}
              format={format()}
              currency={currency()}
              locale={props.locale}
              compareMode={props.compareMode}
              emptyText={props.emptyText}
            />
          )
          // The figure opens the rows it adds up (a div as a button: the figure holds blocks).
          return props.onDrill ? (
            // biome-ignore lint/a11y/useSemanticElements: the figure holds block elements, which a <button> may not contain
            <div
              role="button"
              tabIndex={0}
              data-testid="block-metric-drill"
              aria-label={i18n.t("kernel.dashboards.drillShowAll")}
              title={i18n.t("kernel.dashboards.drillShowAll")}
              class="-mx-1 cursor-pointer rounded px-1 transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
              onClick={() => props.onDrill?.({})}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  props.onDrill?.({})
                }
              }}
            >
              {metric}
            </div>
          ) : (
            metric
          )
        }}
      </Match>
      <Match when={props.data.kind === "table" && props.data}>
        {(d) => (
          <TableBlock
            data={d() as Extract<BlockData, { kind: "table" }>}
            timeZone={props.timeZone}
            currency={currency()}
            locale={props.locale}
            emptyText={props.emptyText}
            onPickRow={props.onDrill ? (row) => props.onDrill?.({ row }) : undefined}
          />
        )}
      </Match>
      <Match when={SERIES_KINDS.has(props.data.kind) && props.data}>
        {(d) => {
          const raw = () => d() as SeriesData
          const s = (): SeriesData => {
            const r = raw()
            if (!share()) return r
            return {
              ...r,
              series: r.series.map((x) => ({ ...x, values: sharesOf(x.values) })),
              ...(r.previous
                ? {
                    previous: {
                      ...r.previous,
                      series: r.previous.series.map((x) => ({ ...x, values: sharesOf(x.values) })),
                    },
                  }
                : {}),
            }
          }
          return seriesEmpty(s()) ? (
            empty
          ) : (
            <Chart
              type={s().kind}
              labels={s().x}
              datasets={seriesDatasets(s(), previousName())}
              format={share() ? "percent" : (s().format ?? format())}
              timeZone={props.timeZone}
              tall={props.tall}
              currency={s().currency ?? currency()}
              locale={props.locale}
              label={props.title}
              stacked={s().display?.stacked}
              horizontal={s().display?.horizontal}
              secondaryAxis={s().display?.secondaryAxis}
              onPick={
                props.onDrill
                  ? (index, datasetIndex) => {
                      const target = seriesPick(s(), index, datasetIndex)
                      if (target) props.onDrill?.(target)
                    }
                  : undefined
              }
              pickLabel={(label) => i18n.t("kernel.dashboards.drillShowFor", { label })}
            />
          )
        }}
      </Match>
      <Match when={props.data.kind === "funnel" && props.data}>
        {(d) => (
          <FunnelBlock
            data={
              share()
                ? {
                    ...(d() as FunnelData),
                    values: (d() as FunnelData).values.map((v) => v / 100),
                    format: "percent",
                  }
                : (d() as FunnelData)
            }
            format={format()}
            currency={currency()}
            locale={props.locale}
            emptyText={props.emptyText}
            onPick={
              props.onDrill
                ? (index) => props.onDrill?.({ category: (d() as FunnelData).labels[index] ?? "" })
                : undefined
            }
          />
        )}
      </Match>
      <Match when={props.data.kind === "text" && props.data}>
        {(d) => <TextBlock markdown={(d() as Extract<BlockData, { kind: "text" }>).markdown} />}
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
              datasets={[
                { label: props.title ?? "", values: share() ? sharesOf(p().values) : p().values },
              ]}
              format={share() ? "percent" : (p().format ?? format())}
              timeZone={props.timeZone}
              tall={props.tall}
              currency={p().currency ?? currency()}
              locale={props.locale}
              label={props.title}
              onPick={
                props.onDrill
                  ? (index) => props.onDrill?.({ category: String(p().labels[index] ?? "") })
                  : undefined
              }
              pickLabel={(label) => i18n.t("kernel.dashboards.drillShowFor", { label })}
            />
          )
        }}
      </Match>
    </Switch>
  )
}
