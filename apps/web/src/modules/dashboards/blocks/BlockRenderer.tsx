// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, Match, Show, Switch } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type {
  BlockData,
  DashboardBlockMap,
  DrillTarget,
  FunnelData,
  PieData,
  SeriesData,
} from "../dashboards-client"
import { formatWindow } from "../time-range"
import { Chart, type ChartDataset } from "./Chart"
import { ChartHeadline } from "./ChartHeadline"
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
  /** The days the data covers (a block following the dashboard's range): names the legend. */
  window?: { from: string; to: string }
  /** The comparison's real days: names the comparison in the legend and the headline. */
  compareWindow?: { from: string; to: string }
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

/** How the legend names what it shows, when the block knows its days. */
export interface DatasetNames {
  /** The current window as it reads ("Nov 1 – 12, 2026"): names a lone series in the legend. */
  current?: string
  /** "{name} (right axis)": a series read against the right-hand axis. */
  rightAxis?: (name: string) => string
}

/**
 * A bar or line block's datasets: its series, then, when the server sent a comparison, each
 * series' previous values (drawn lighter) named "<series> · <comparison>". With `names.current`,
 * a lone series is named by its days and its comparison by the comparison's, and the tooltip
 * names each comparison value by its own day. A blended chart's right-axis series say so.
 */
export function seriesDatasets(
  d: SeriesData,
  previousName: string,
  names: DatasetNames = {},
): ChartDataset[] {
  const lines = new Set(d.kind === "combo" ? (d.display?.lineSeries ?? []) : [])
  const right = new Set(d.display?.rightAxis ?? [])
  const lone = d.series.length === 1 && !!names.current
  const shown = (name: string) =>
    right.has(name) && names.rightAxis ? names.rightAxis(name) : name
  const current: ChartDataset[] = d.series.map((x) => ({
    label: lone ? (names.current as string) : shown(x.name),
    values: x.values,
    ...(lines.has(x.name) ? { asLine: true } : {}),
    ...(right.has(x.name) ? { axis: "right" as const } : {}),
    ...(lone ? { name: x.name } : {}),
  }))
  const previous: ChartDataset[] = (d.previous?.series ?? [])
    .filter((p) => p.values.some((v) => v !== null))
    .map((p) => ({
      label: d.series.length > 1 && p.name ? `${shown(p.name)} · ${previousName}` : previousName,
      values: p.values,
      previous: true,
      ...(lines.has(p.name) ? { asLine: true } : {}),
      ...(right.has(p.name) ? { axis: "right" as const } : {}),
      ...(names.current && d.previous ? { dayLabels: d.previous.labels } : {}),
    }))
  return [...current, ...previous]
}

/**
 * A blended chart's layer behind a series, and the series name its rows know: an unsplit layer's
 * one series is named by its label (no series to ask for), a split layer's may carry
 * " (<label>)" when another layer took the name first.
 */
export function layerOfSeries(
  d: SeriesData,
  name: string,
): { layer: string; series?: string } | null {
  const layer = d.layers?.find((l) => l.series.includes(name))
  if (!layer) return null
  if (layer.series.length === 1 && name === layer.label) return { layer: layer.id }
  const suffix = ` (${layer.label})`
  return {
    layer: layer.id,
    series: name.endsWith(suffix) ? name.slice(0, -suffix.length) : name,
  }
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
    if (d.layers) return withLayer(d, target, p.name)
    if (d.series.length > 1 && p.name) target.series = p.name
    return target
  }
  const label = d.x[index]
  const target: DrillTarget = {
    category: label === null || label === undefined ? "" : String(label),
  }
  const series = d.series[datasetIndex]
  if (d.layers) return series ? withLayer(d, target, series.name) : null
  if (d.series.length > 1 && series) target.series = series.name
  return target
}

/** A blended chart's pick reads its own layer's rows (null: a series no layer drew). */
function withLayer(d: SeriesData, target: DrillTarget, name: string): DrillTarget | null {
  const at = layerOfSeries(d, name)
  if (!at) return null
  target.layer = at.layer
  const layer = d.layers?.find((l) => l.id === at.layer)
  if (at.series !== undefined && (layer?.series.length ?? 0) > 1) target.series = at.series
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
          const locale = () => props.locale ?? i18n.locale()
          const range = (w: { from: string; to: string } | undefined) =>
            w ? formatWindow(w, locale()) : undefined
          const compareName = () => range(props.compareWindow) ?? previousName()
          const inProgress = () => {
            const l = s().inProgressLabel
            if (l === undefined) return undefined
            const at = s().x.findIndex((x) => String(x) === l)
            return at >= 0 ? at : undefined
          }
          const chart = () => (
            <Chart
              type={s().kind}
              labels={s().x}
              curve={s().display?.curve}
              inProgressIndex={inProgress()}
              datasets={seriesDatasets(s(), compareName(), {
                current: range(props.window),
                rightAxis: (name) => i18n.t("kernel.dashboards.chartRightAxis", { name }),
              })}
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
          return (
            <>
              <Show when={s().headline}>
                {(figures) => (
                  <ChartHeadline
                    figures={figures()}
                    layers={s().layers}
                    format={share() ? undefined : (s().format ?? format())}
                    currency={s().currency ?? currency()}
                    locale={locale()}
                    compareName={compareName()}
                  />
                )}
              </Show>
              {seriesEmpty(s()) ? empty : chart()}
              <Show when={!seriesEmpty(s()) && inProgress() !== undefined}>
                <p
                  data-testid="chart-in-progress"
                  class="mt-1 flex items-center gap-1.5 text-[11.5px] text-text-tertiary"
                >
                  <span
                    aria-hidden="true"
                    class="inline-block w-4 border-t-2 border-dotted border-text-tertiary"
                  />
                  {i18n.t("kernel.dashboards.chartInProgress")}
                </p>
              </Show>
            </>
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
