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
  const rightAxis = combo && (props.secondaryAxis === true || stacked)
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
        return {
          ...(combo && line ? { type: "line" } : {}),
          label: d.label,
          data: d.values,
          // An area's fill is the series' colour, faint (calm: hues, never alarms).
          backgroundColor: area && !d.previous ? `${color}40` : color,
          borderColor: d.previous && line ? text : color,
          borderRadius: bar ? 3 : undefined,
          maxBarThickness: bar ? 40 : undefined,
          tension: line ? 0.25 : undefined,
          pointRadius: line ? (d.previous ? 0 : 2) : undefined,
          borderWidth: line && d.previous ? 1.5 : undefined,
          borderDash: line && d.previous ? [4, 4] : undefined,
          fill: area && !d.previous ? (stacked ? (next === 1 ? "origin" : "-1") : "origin") : false,
          ...(rightAxis && line ? { yAxisID: "y1" } : {}),
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
          callbacks: {
            label: (c: { dataset: { label?: string }; raw: unknown }) =>
              `${c.dataset.label ? `${c.dataset.label}: ` : ""}${fmt(c.raw)}`,
          },
        },
      },
      scales: horizontal
        ? {
            x: {
              beginAtZero: true,
              stacked,
              grid: { color: grid },
              ticks: { color: text, callback: (v: unknown) => fmt(v) },
            },
            y: { stacked, grid: { display: false }, ticks: { color: text } },
          }
        : {
            x: { stacked, grid: { display: false }, ticks: { color: text } },
            y: {
              beginAtZero: true,
              stacked,
              grid: { color: grid },
              ticks: { color: text, callback: (v: unknown) => fmt(v) },
            },
            ...(rightAxis
              ? {
                  y1: {
                    position: "right",
                    beginAtZero: true,
                    grid: { display: false },
                    ticks: { color: text, callback: (v: unknown) => fmt(v) },
                  },
                }
              : {}),
          },
    },
  }
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
          locale(),
        ] as const,
      async () => {
        const mine = ++run
        const m = await loadChartJs().catch(() => null)
        if (!m || mine !== run || !canvas) return
        instance?.destroy()
        // chart.js types its config per chart kind; chartConfig builds all three.
        instance = new m.Chart(canvas, chartConfig(props, locale()) as any)
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
