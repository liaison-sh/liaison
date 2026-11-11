// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ONE CHART. Bar, line and pie over chart.js, loaded on first use (the
// library stays out of the main bundle) and registering only the pieces these
// three kinds draw. Exported for reuse: a dashboard block draws through it, and
// an app view may embed it the same way.
import { type Component, createEffect, on, onCleanup } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { ValueFormat } from "../dashboards-client"
import { formatAxisLabel, formatValue } from "./format"

export type ChartKind = "bar" | "line" | "pie"

export interface ChartDataset {
  label: string
  values: Array<number | null>
  /** A comparison series: drawn lighter (muted, dashed for a line), behind the current one. */
  previous?: boolean
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
  const labels = props.labels.map((l) => formatAxisLabel(l, locale))
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
      },
    }
  }
  const current = props.datasets.filter((d) => !d.previous)
  const colors = chartPalette(current.length)
  const muted = cssVar("--color-border", "#3a3a42")
  let next = 0
  return {
    type: props.type,
    data: {
      labels,
      datasets: props.datasets.map((d) => {
        const color = d.previous ? muted : colors[next++]
        return {
          label: d.label,
          data: d.values,
          backgroundColor: color,
          borderColor: d.previous && props.type === "line" ? text : color,
          borderRadius: props.type === "bar" ? 3 : undefined,
          maxBarThickness: props.type === "bar" ? 40 : undefined,
          tension: props.type === "line" ? 0.25 : undefined,
          pointRadius: props.type === "line" ? (d.previous ? 0 : 2) : undefined,
          borderWidth: props.type === "line" && d.previous ? 1.5 : undefined,
          borderDash: props.type === "line" && d.previous ? [4, 4] : undefined,
          // Drawn behind the current series.
          order: d.previous ? 1 : 0,
        }
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: props.datasets.length > 1, labels: { color: text, boxWidth: 10 } },
        tooltip: {
          callbacks: {
            label: (c: { dataset: { label?: string }; raw: unknown }) =>
              `${c.dataset.label ? `${c.dataset.label}: ` : ""}${fmt(c.raw)}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: text } },
        y: {
          beginAtZero: true,
          grid: { color: grid },
          ticks: { color: text, callback: (v: unknown) => fmt(v) },
        },
      },
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
        [props.type, props.labels, props.datasets, props.format, props.currency, locale()] as const,
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
      class="relative h-56 w-full"
    >
      <canvas ref={canvas} role="img" aria-label={props.label ?? props.type} />
    </div>
  )
}
