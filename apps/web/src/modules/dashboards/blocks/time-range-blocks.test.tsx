// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the time range adds to a block: the metric's change, sparkline and target,
// a fixed block's own-window chip, "Updated N min ago", rows left out, the empty
// state naming the range, auto-refresh, and the chart's comparison series.
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BlockResult, DashboardBlockSpec, MetricData, SeriesData } from "../dashboards-client"
import { BlockCard, ownWindowText, updatedAgo } from "./BlockCard"
import { seriesDatasets } from "./BlockRenderer"
import { chartConfig } from "./Chart"
import { formatDelta, MetricBlock, sparklinePoints } from "./MetricBlock"

vi.mock("chart.js", () => {
  class Chart {
    static register() {}
    destroy() {}
  }
  return { Chart }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const block: DashboardBlockSpec = {
  id: "b1",
  type: "metric",
  title: "Revenue",
  width: 1,
  source: { kind: "tool", tool: "x" },
}
const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

describe("MetricBlock", () => {
  const metric = (extra: Partial<MetricData>): MetricData => ({
    kind: "metric",
    value: 112,
    ...extra,
  })

  it("shows the change against the same period last year, calmly", () => {
    render(() => (
      <MetricBlock data={metric({ previous: 100 })} locale="en" compareMode="lastYear" />
    ))
    const delta = screen.getByTestId("block-metric-delta")
    expect(delta.textContent).toContain("+12%")
    expect(delta.textContent).toContain("vs same period last year")
    expect(delta.dataset.direction).toBe("up")
    // Calm: secondary text, no alarm colour.
    expect(delta.className).toContain("text-text-secondary")
    expect(delta.className).not.toMatch(/red|green|danger|success/)
  })

  it("names the previous period, and a fall reads down", () => {
    render(() => (
      <MetricBlock
        data={metric({ value: 90, previous: 100 })}
        locale="en"
        compareMode="previousPeriod"
      />
    ))
    const delta = screen.getByTestId("block-metric-delta")
    expect(delta.textContent).toContain("-10%")
    expect(delta.textContent).toContain("vs previous period")
    expect(delta.dataset.direction).toBe("down")
  })

  it("shows no change without a usable previous value", () => {
    render(() => <MetricBlock data={metric({ previous: 0 })} locale="en" />)
    expect(screen.queryByTestId("block-metric-delta")).toBeNull()
  })

  it("shows the target as x of y with a thin bar", () => {
    render(() => <MetricBlock data={metric({ value: 30, target: 40 })} locale="en" />)
    expect(screen.getByTestId("block-metric-target").textContent).toContain("30 of 40")
    expect(screen.getByTestId("block-metric-target-bar").style.width).toBe("75%")
  })

  it("draws a sparkline when the server sent one", () => {
    render(() => (
      <MetricBlock
        data={metric({ sparkline: { labels: ["a", "b", "c"], values: [1, 3, 2] } })}
        locale="en"
      />
    ))
    expect(screen.getByTestId("block-metric-sparkline")).toBeTruthy()
    expect(sparklinePoints([1, 3, 2])).toBe("0,24 50,0 100,12")
    expect(sparklinePoints([2, 2])).toBe("0,12 100,12")
  })

  it("an empty metric names the range when given", () => {
    render(() => (
      <MetricBlock data={metric({ value: null })} locale="en" emptyText="No data between x and y" />
    ))
    expect(screen.getByTestId("block-metric-empty").textContent).toBe("No data between x and y")
  })

  it("formats a change with its sign", () => {
    expect(formatDelta(0.12, "en")).toBe("+12%")
    expect(formatDelta(-0.034, "en")).toBe("-3.4%")
    expect(formatDelta(0, "en")).toBe("0%")
  })
})

describe("BlockCard and the time range", () => {
  it("shows a fixed block's own window as a chip", async () => {
    const load = async (): Promise<BlockResult> => ({
      ok: true,
      data: { kind: "metric", value: 3 },
      info: {
        window: {
          mode: "fixed",
          dates: [
            { token: "{{today}}", date: "2026-11-11" },
            { token: "{{today-90d}}", date: "2026-08-13" },
          ],
        },
      },
    })
    render(() => <BlockCard block={block} load={load} locale="en-GB" showOwnWindow />)
    await waitFor(() => expect(screen.getByTestId("dashboard-block-window-b1")).toBeTruthy())
    expect(screen.getByTestId("dashboard-block-window-b1").textContent).toMatch(/13 Aug/)
  })

  it("shows no chip when the dashboard has no range picker", async () => {
    const load = async (): Promise<BlockResult> => ({
      ok: true,
      data: { kind: "metric", value: 3 },
      info: { window: { mode: "fixed", dates: [] } },
    })
    render(() => <BlockCard block={block} load={load} locale="en" />)
    await waitFor(() => expect(screen.getByTestId("block-metric-value")).toBeTruthy())
    expect(screen.queryByTestId("dashboard-block-window-b1")).toBeNull()
  })

  it("says when its data was read, following the page's clock", async () => {
    const computedAt = "2026-11-11T10:00:00.000Z"
    const [now, setNow] = createSignal(Date.parse(computedAt) + 10_000)
    const load = async (): Promise<BlockResult> => ({
      ok: true,
      data: { kind: "metric", value: 3 },
      info: { computedAt, skippedRows: 4 },
    })
    render(() => <BlockCard block={block} load={load} locale="en" now={now()} />)
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-block-updated-b1").textContent).toBe("Updated just now"),
    )
    setNow(Date.parse(computedAt) + 4 * 60_000)
    expect(screen.getByTestId("dashboard-block-updated-b1").textContent).toBe("Updated 4 min. ago")
    expect(screen.getByTestId("dashboard-block-skipped").textContent).toContain(
      "4 rows are left out",
    )
  })

  it("an empty block following the range names its days", async () => {
    const load = async (): Promise<BlockResult> => ({
      ok: true,
      data: { kind: "table", columns: [{ field: "a", label: "A" }], rows: [] },
      info: { window: { mode: "dashboard", preset: "mtd", from: "2026-11-01", to: "2026-11-11" } },
    })
    render(() => (
      <BlockCard
        block={{ ...block, type: "table" }}
        load={load}
        locale="en-GB"
        now={Date.parse("2026-11-11T12:00:00Z")}
      />
    ))
    await waitFor(() =>
      expect(screen.getByTestId("block-empty").textContent).toBe(
        "No data between 1 Nov and 11 Nov",
      ),
    )
  })

  it("re-reads when the range changes", async () => {
    const load = vi.fn(
      async (): Promise<BlockResult> => ({ ok: true, data: { kind: "metric", value: 1 } }),
    )
    const [key, setKey] = createSignal("mtd:lastYear")
    render(() => <BlockCard block={block} load={load} rangeKey={key()} />)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    setKey("ytd:lastYear")
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(load).toHaveBeenLastCalledWith(false)
  })

  it("auto-refreshes on its refreshSec only while visible", async () => {
    vi.useFakeTimers()
    const load = vi.fn(
      async (): Promise<BlockResult> => ({ ok: true, data: { kind: "metric", value: 1 } }),
    )
    const [visible, setVisible] = createSignal(true)
    render(() => <BlockCard block={{ ...block, refreshSec: 60 }} load={load} visible={visible()} />)
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(2)
    setVisible(false)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(load).toHaveBeenCalledTimes(2)
    setVisible(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it("never auto-refreshes a block without refreshSec", async () => {
    vi.useFakeTimers()
    const load = vi.fn(
      async (): Promise<BlockResult> => ({ ok: true, data: { kind: "metric", value: 1 } }),
    )
    render(() => <BlockCard block={block} load={load} visible />)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe("helpers", () => {
  it("updatedAgo reads minutes, hours and days", () => {
    const at = "2026-11-11T10:00:00Z"
    const base = Date.parse(at)
    expect(updatedAgo(at, base + 30_000, t, "en")).toBe("kernel.dashboards.updatedJustNow")
    expect(updatedAgo(at, base + 2 * 3_600_000, t, "en")).toContain("2 hr. ago")
    expect(updatedAgo("nope", base, t, "en")).toBeNull()
  })

  it("ownWindowText: none, one day, several", () => {
    expect(ownWindowText({ mode: "fixed", dates: [] }, t, "en")).toBe("kernel.dashboards.ownPeriod")
    expect(
      ownWindowText(
        { mode: "fixed", dates: [{ token: "{{today-7d}}", date: "2026-11-04" }] },
        t,
        "en-GB",
      ),
    ).toContain("4 Nov 2026")
    expect(
      ownWindowText({ mode: "dashboard", preset: "mtd", from: "a", to: "b" }, t, "en"),
    ).toBeNull()
  })

  it("a chart's comparison series come after its own, drawn lighter and dashed", () => {
    const data: SeriesData = {
      kind: "line",
      x: ["2026-11-01", "2026-11-02"],
      series: [{ name: "Orders", values: [3, 4] }],
      previous: {
        labels: ["2025-11-01", "2025-11-02"],
        series: [{ name: "Orders", values: [2, null] }],
      },
    }
    const sets = seriesDatasets(data, "Same period last year")
    expect(sets).toEqual([
      { label: "Orders", values: [3, 4] },
      { label: "Same period last year", values: [2, null], previous: true },
    ])
    const config = chartConfig({ type: "line", labels: data.x, datasets: sets }, "en") as {
      data: { datasets: Array<{ borderDash?: number[]; order: number }> }
    }
    expect(config.data.datasets[0].borderDash).toBeUndefined()
    expect(config.data.datasets[1].borderDash).toEqual([4, 4])
    expect(config.data.datasets[1].order).toBe(1)
  })
})
