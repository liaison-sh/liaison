// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ONE CHART. Bar, line, area, combo (bars and lines) and pie over chart.js,
// loaded on first use (the library stays out of the main bundle) and
// registering only the pieces these kinds draw. Bars and areas may stack, bars
// may lie horizontal, a combo's lines may read against a right-hand axis.
// Exported for reuse: a dashboard block draws through it, and an app view may
// embed it the same way.
//
// With `onPick`, a click on a bar, a point or a slice picks it (the dashboard
// opens the rows behind it), and the canvas's fallback content lists one button
// per category, so the same pick is reachable from the keyboard.
import { type Component, createEffect, For, on, onCleanup, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { ValueFormat } from "../dashboards-client"
import { formatAxisLabel, formatValue } from "./format"

export type ChartKind = "bar" | "line" | "pie" | "area" | "combo"

export interface ChartDataset {
  label: string
  values: Array<number | null>
  /** A comparison series: drawn lighter (muted, dashed for a line), behind the current one. */
  previous?: boolean
  /** In a combo: this series is drawn as a line (the rest are bars). */
  asLine?: boolean
  /** Read against the right-hand axis (a blended chart's right-axis layer). */
  axis?: "right"
  /** The series' own name in the tooltip, when the legend names it otherwise (by its dates). */
  name?: string
  /** A comparison series: the comparison's own label at each place, named in the tooltip. */
  dayLabels?: Array<string | number | null>
  /** A comparison that is a stack's total: one lighter bar per place, beside the stack. */
  total?: boolean
}

export interface ChartProps {
  type: ChartKind
  labels: Array<string | number>
  datasets: ChartDataset[]
  format?: ValueFormat
  currency?: string
  /** The viewer's language by default. */
  locale?: string
  testid?: string
  /** Accessible name of the drawing (the block's title). */
  label?: string
  /** Bars, areas (or a combo's bars) stacked. */
  stacked?: boolean
  /** Bars lying along the vertical axis. */
  horizontal?: boolean
  /** A combo's lines read against a right-hand axis. */
  secondaryAxis?: boolean
  /** A bar, point or slice picked: its category index and the dataset it belongs to. */
  onPick?: (index: number, datasetIndex: number) => void
  /** The keyboard button's name for a category ("Show rows for {label}"). */
  pickLabel?: (label: string) => string
  /** The org's time zone: timestamp labels read in it. */
  timeZone?: string
  /** A block two grid rows high: the drawing takes the room. */
  tall?: boolean
  /** Lines bend smoothly through their points (default: straight segments). */
  curve?: "smooth"
  /** The place of the bucket still filling (today's): drawn dotted. */
  inProgressIndex?: number
  /** A stack's total in the tooltip ("Total: {value}"). */
  totalLabel?: (value: string) => string
}

type ChartModule = typeof import("chart.js")
let loading: Promise<ChartModule> | null = null

/** chart.js with the controllers, elements and scales of bar, line and pie registered once. */
export function loadChartJs(): Promise<ChartModule> {
  loading ??= import("chart.js")
    .then((m) => {
      m.Chart.register(
        m.BarController,
        m.BarElement,
        m.LineController,
        m.LineElement,
        m.PointElement,
        m.Filler,
        m.PieController,
        m.ArcElement,
        m.CategoryScale,
        m.LinearScale,
        m.Tooltip,
        m.Legend,
      )
      return m
    })
    .catch((err) => {
      loading = null
      throw err
    })
  return loading
}

// Calm, low-saturation hues after the accent: series are told apart, nothing alarms.
const MUTED_HUES = ["#7c8db5", "#8fb3a8", "#c2a878", "#a993c4", "#89a9c9", "#b59a8f", "#9ab07f"]

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export function chartPalette(count: number): string[] {
  const accent = cssVar("--color-accent", "#6366f1")
  const out: string[] = []
  for (let i = 0; i < count; i++)
    out.push(i === 0 ? accent : MUTED_HUES[(i - 1) % MUTED_HUES.length])
  return out
}

/** The chart.js configuration for the props: pure, so it is tested without a canvas. */
export function chartConfig(props: ChartProps, locale: string): Record<string, unknown> {
  const fmt = (v: unknown) =>
    formatValue(v, { format: props.format, currency: props.currency, locale })
  const labels = props.labels.map((l) => formatAxisLabel(l, locale, props.timeZone))
  const grid = cssVar("--color-border-subtle", "#2a2a30")
  const text = cssVar("--color-text-tertiary", "#65656e")
  if (props.type === "pie") {
    const values = props.datasets[0]?.values ?? []
    return {
      type: "pie",
      data: {
        labels,
        datasets: [{ data: values, backgroundColor: chartPalette(values.length), borderWidth: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { color: text, boxWidth: 10 } },
          tooltip: {
            callbacks: {
              label: (c: { label: string; raw: unknown }) => `${c.label}: ${fmt(c.raw)}`,
            },
          },
        },
        ...pickOptions(props),
      },
    }
  }
  const current = props.datasets.filter((d) => !d.previous)
  const colors = chartPalette(current.length)
  const muted = cssVar("--color-border", "#3a3a42")
  const area = props.type === "area"
  const combo = props.type === "combo"
  const horizontal = props.type === "bar" && props.horizontal === true
  const stacked = props.stacked === true && (props.type === "bar" || area || combo)
  // A combo's lines never stack on its bars: they go on their own unstacked axis on the right,
  // asked for (secondaryAxis) or because the bars stack.
  // A dataset may name the right axis itself (a blended chart's layer); otherwise a combo's lines
  // go there.
  const named = props.datasets.some((d) => d.axis === "right")
  const rightAxis = named || (combo && (props.secondaryAxis === true || stacked))
  const onRight = (d: ChartDataset, line: boolean) => (named ? d.axis === "right" : line)
  const smooth = props.curve === "smooth"
  const ip = props.inProgressIndex
  const partial = typeof ip === "number" && ip >= 0
  // A stack of bars: the tooltip adds up the place, and the comparison's total reads under it.
  const stackedBar = (d: ChartDataset) =>
    stacked && !d.previous && !(combo && d.asLine === true) && !area
  const stack = stacked && props.datasets.filter(stackedBar).length > 1
  const totalLabel = props.totalLabel ?? ((value: string) => `Total: ${value}`)
  const tipName = (d: ChartDataset | undefined, at: number | undefined, fallback?: string) => {
    const day = at === undefined ? undefined : d?.dayLabels?.[at]
    return day !== undefined && day !== null
      ? formatAxisLabel(day, locale, props.timeZone)
      : (d?.name ?? fallback ?? d?.label ?? "")
  }
  // Counts read on whole-number ticks (1, 2, 3, never 0.2 steps): an axis whose every value is a
  // whole number gets precision 0. Which datasets an axis carries mirrors yAxisID below.
  const isLine = (d: ChartDataset) => props.type === "line" || area || (combo && d.asLine === true)
  const leftWhole = wholeNumbers(
    props.datasets.filter((d) => !(rightAxis && onRight(d, isLine(d)))),
  )
  const rightWhole = wholeNumbers(props.datasets.filter((d) => rightAxis && onRight(d, isLine(d))))
  const valueTicks = (whole: boolean) => ({
    color: text,
    callback: (v: unknown) => fmt(v),
    ...(whole ? { precision: 0 } : {}),
  })
  let next = 0
  return {
    // An area is a filled line; a combo is bars with some datasets drawn as lines.
    type: area ? "line" : combo ? "bar" : props.type,
    data: {
      labels,
      datasets: props.datasets.map((d) => {
        const color = d.previous ? muted : colors[next++]
        const line = props.type === "line" || area || (combo && d.asLine === true)
        const bar = !line
        // Today's bucket is still filling: its line segment dotted, its point hollow, its bar faint.
        const filling = partial && !d.previous
        return {
          ...(combo && line ? { type: "line" } : {}),
          label: d.label,
          data: d.values,
          // An area's fill is the series' colour, faint (calm: hues, never alarms).
          backgroundColor:
            area && !d.previous
              ? `${color}40`
              : filling && bar
                ? (c: { dataIndex: number }) => (c.dataIndex === ip ? `${color}59` : color)
                : color,
          borderColor: d.previous && line ? text : color,
          ...(filling && bar
            ? { borderWidth: (c: { dataIndex: number }) => (c.dataIndex === ip ? 1 : 0) }
            : {}),
          ...(filling && line
            ? {
                segment: {
                  borderDash: (c: { p1DataIndex: number }) =>
                    c.p1DataIndex === ip ? [2, 3] : undefined,
                },
                pointBackgroundColor: (c: { dataIndex: number }) =>
                  c.dataIndex === ip ? "transparent" : color,
              }
            : {}),
          borderRadius: bar ? 3 : undefined,
          maxBarThickness: bar ? 40 : undefined,
          tension: line ? (smooth ? 0.4 : 0) : undefined,
          ...(line && smooth ? { cubicInterpolationMode: "monotone" } : {}),
          pointRadius: line ? (d.previous ? 0 : 2) : undefined,
          borderWidth: line && d.previous ? 1.5 : undefined,
          borderDash: line && d.previous ? [4, 4] : undefined,
          fill: area && !d.previous ? (stacked ? (next === 1 ? "origin" : "-1") : "origin") : false,
          ...(rightAxis && onRight(d, line) ? { yAxisID: "y1" } : {}),
          ...(stacked && !d.previous && !(combo && line) ? { stack: "current" } : {}),
          // Drawn behind the current series; a combo's lines over its bars.
          order: d.previous ? 1 : combo && line ? -1 : 0,
        }
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      ...(horizontal ? { indexAxis: "y" } : {}),
      ...pickOptions(props),
      plugins: {
        legend: { display: props.datasets.length > 1, labels: { color: text, boxWidth: 10 } },
        tooltip: {
          // Every series at the hovered place: the current value beside the comparison's.
          mode: "index",
          intersect: false,
          callbacks: {
            label: (c: {
              dataset?: { label?: string }
              datasetIndex?: number
              dataIndex?: number
              raw: unknown
            }) => {
              const d = c.datasetIndex === undefined ? undefined : props.datasets[c.datasetIndex]
              const name = tipName(d, c.dataIndex, c.dataset?.label)
              return `${name ? `${name}: ` : ""}${fmt(c.raw)}`
            },
            ...(stack
              ? {
                  // The stack's total and the comparison's, under the series' own values.
                  footer: (items: Array<{ dataIndex?: number }>) => {
                    const at = items[0]?.dataIndex
                    if (at === undefined) return []
                    let sum: number | null = null
                    for (const d of props.datasets) {
                      const v = stackedBar(d) ? d.values[at] : null
                      if (typeof v === "number") sum = (sum ?? 0) + v
                    }
                    const out = [totalLabel(fmt(sum))]
                    for (const d of props.datasets) {
                      if (!d.total) continue
                      const v = d.values[at]
                      if (v === null || v === undefined) continue
                      const name = tipName(d, at)
                      out.push(`${name ? `${name}: ` : ""}${fmt(v)}`)
                    }
                    return out
                  },
                }
              : {}),
          },
          // A stack's comparison total reads in the footer, beside the current total.
          filter: (c: { datasetIndex?: number }) =>
            c.datasetIndex === undefined || props.datasets[c.datasetIndex]?.total !== true,
        },
      },
      scales: horizontal
        ? {
            x: {
              beginAtZero: true,
              stacked,
              grid: { color: grid },
              ticks: valueTicks(leftWhole),
            },
            y: { stacked, grid: { display: false }, ticks: { color: text } },
          }
        : {
            x: { stacked, grid: { display: false }, ticks: { color: text } },
            y: {
              beginAtZero: true,
              stacked,
              grid: { color: grid },
              ticks: valueTicks(leftWhole),
            },
            ...(rightAxis
              ? {
                  y1: {
                    position: "right",
                    beginAtZero: true,
                    grid: { display: false },
                    ticks: valueTicks(rightWhole),
                  },
                }
              : {}),
          },
    },
  }
}

/** Every value of the datasets is a whole number (at least one value): an axis of counts. */
export function wholeNumbers(datasets: ChartDataset[]): boolean {
  let any = false
  for (const d of datasets) {
    for (const v of d.values) {
      if (v === null || v === undefined) continue
      if (!Number.isInteger(v)) return false
      any = true
    }
  }
  return any
}

/** A click on a drawn element picks it; the pointer says it can be clicked. */
function pickOptions(props: ChartProps): Record<string, unknown> {
  const pick = props.onPick
  if (!pick) return {}
  return {
    onClick: (_e: unknown, elements: Array<{ index: number; datasetIndex: number }>) => {
      const hit = elements[0]
      if (hit) pick(hit.index, hit.datasetIndex)
    },
    onHover: (e: { native?: { target?: { style?: { cursor: string } } } }, elements: unknown[]) => {
      const style = e.native?.target?.style
      if (style) style.cursor = elements.length ? "pointer" : "default"
    },
  }
}

export const Chart: Component<ChartProps> = (props) => {
  const i18n = useI18n()
  const totalLabel = (value: string) => i18n.t("kernel.dashboards.chartTotal", { value })
  const locale = () => props.locale ?? i18n.locale()
  let canvas: HTMLCanvasElement | undefined
  let instance: { destroy: () => void } | null = null
  let run = 0

  createEffect(
    on(
      () =>
        [
          props.type,
          props.labels,
          props.datasets,
          props.format,
          props.currency,
          props.stacked,
          props.horizontal,
          props.secondaryAxis,
          props.timeZone,
          props.curve,
          props.inProgressIndex,
          locale(),
        ] as const,
      async () => {
        const mine = ++run
        const m = await loadChartJs().catch(() => null)
        if (!m || mine !== run || !canvas) return
        instance?.destroy()
        // chart.js types its config per chart kind; chartConfig builds all three.
        instance = new m.Chart(
          canvas,
          chartConfig({ ...props, totalLabel: props.totalLabel ?? totalLabel }, locale()) as any,
        )
      },
    ),
  )
  onCleanup(() => {
    run++
    instance?.destroy()
    instance = null
  })

  return (
    <div
      data-testid={props.testid ?? "dashboard-chart"}
      data-chart-type={props.type}
      class={props.tall ? "relative h-[26rem] w-full" : "relative h-56 w-full"}
    >
      <canvas ref={canvas} role="img" aria-label={props.label ?? props.type}>
        <Show when={props.onPick}>
          {(pick) => (
            <ul data-testid="dashboard-chart-picks">
              <For each={props.labels}>
                {(label, i) => {
                  const text = formatAxisLabel(label, locale(), props.timeZone)
                  return (
                    <li>
                      <button
                        type="button"
                        data-testid={`dashboard-chart-pick-${i()}`}
                        onClick={() => pick()(i(), 0)}
                      >
                        {props.pickLabel ? props.pickLabel(text) : text}
                      </button>
                    </li>
                  )
                }}
              </For>
            </ul>
          )}
        </Show>
      </canvas>
    </div>
  )
}
