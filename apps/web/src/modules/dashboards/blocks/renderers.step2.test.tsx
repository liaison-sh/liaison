// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

const nav = vi.hoisted(() => ({ to: [] as string[] }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: (p: string) => nav.to.push(p) }))
vi.mock("chart.js", () => {
  class Chart {
    static register() {}
    destroy() {}
  }
  return { Chart }
})

import { BlockRenderer, seriesPick } from "./BlockRenderer"
import { chartConfig } from "./Chart"
import { FunnelBlock, funnelStages } from "./FunnelBlock"
import { renderNote, TextBlock } from "./TextBlock"

afterEach(() => {
  cleanup()
  nav.to.length = 0
})

type Cfg = {
  type: string
  data: { datasets: Array<Record<string, unknown>> }
  options: { indexAxis?: string; scales: Record<string, { stacked?: boolean; position?: string }> }
}

describe("chart kinds", () => {
  it("an area is a filled line", () => {
    const c = chartConfig(
      { type: "area", labels: ["a", "b"], datasets: [{ label: "x", values: [1, 2] }] },
      "en",
    ) as unknown as Cfg
    expect(c.type).toBe("line")
    expect(c.data.datasets[0]!.fill).toBe("origin")
  })

  it("stacks bars and areas on both axes", () => {
    for (const type of ["bar", "area"] as const) {
      const c = chartConfig(
        {
          type,
          stacked: true,
          labels: ["a"],
          datasets: [
            { label: "x", values: [1] },
            { label: "y", values: [2] },
          ],
        },
        "en",
      ) as unknown as Cfg
      expect(c.options.scales.x!.stacked).toBe(true)
      expect(c.options.scales.y!.stacked).toBe(true)
    }
  })

  it("lays bars along the vertical axis when horizontal", () => {
    const c = chartConfig(
      { type: "bar", horizontal: true, labels: ["a"], datasets: [{ label: "x", values: [1] }] },
      "en",
    ) as unknown as Cfg
    expect(c.options.indexAxis).toBe("y")
  })

  it("draws a combo's line series as lines on a right-hand axis", () => {
    const c = chartConfig(
      {
        type: "combo",
        secondaryAxis: true,
        labels: ["a"],
        datasets: [
          { label: "Orders", values: [1] },
          { label: "Revenue", values: [10], asLine: true },
        ],
      },
      "en",
    ) as unknown as Cfg
    expect(c.type).toBe("bar")
    expect(c.data.datasets[0]!.type).toBeUndefined()
    expect(c.data.datasets[1]).toMatchObject({ type: "line", yAxisID: "y1" })
    expect(c.options.scales.y1!.position).toBe("right")
  })

  it("a combo marks the series the server names as lines", () => {
    render(() => (
      <BlockRenderer
        data={{
          kind: "combo",
          x: ["Jan"],
          series: [
            { name: "Orders", values: [1] },
            { name: "Revenue", values: [10] },
          ],
          display: { lineSeries: ["Revenue"] },
        }}
      />
    ))
    expect(screen.getByTestId("dashboard-chart").getAttribute("data-chart-type")).toBe("combo")
  })

  it("a chart pick asks for the category and the split series", () => {
    const d = {
      kind: "bar" as const,
      x: ["2026-11-01", "2026-11-02"],
      series: [
        { name: "b2b", values: [1, 2] },
        { name: "dtc", values: [3, 4] },
      ],
    }
    expect(seriesPick(d, 1, 1)).toEqual({ category: "2026-11-02", series: "dtc" })
    expect(seriesPick({ ...d, series: [d.series[0]!] }, 0, 0)).toEqual({ category: "2026-11-01" })
  })

  it("each category is a keyboard pick inside the canvas", () => {
    const onDrill = vi.fn()
    render(() => (
      <BlockRenderer
        data={{ kind: "pie", labels: ["FR", "DE"], values: [3, 1] }}
        onDrill={onDrill}
      />
    ))
    fireEvent.click(screen.getByTestId("dashboard-chart-pick-1"))
    expect(onDrill).toHaveBeenCalledWith({ category: "DE" })
  })
})

describe("funnel", () => {
  it("works out each step's conversion and width", () => {
    const s = funnelStages(["Visits", "Carts", "Orders"], [200, 50, 0])
    expect(s.map((x) => x.conversion)).toEqual([null, 0.25, 0])
    expect(s.map((x) => x.share)).toEqual([1, 0.25, 0])
    expect(funnelStages(["a", "b"], [0, 5])[1]!.conversion).toBeNull()
  })

  it("shows the stages with the conversion between them, each a pick", () => {
    const onPick = vi.fn()
    render(() => (
      <FunnelBlock
        data={{ kind: "funnel", labels: ["Visits", "Orders"], values: [200, 50] }}
        locale="en"
        onPick={onPick}
      />
    ))
    expect(screen.getByTestId("block-funnel-value-0").textContent).toBe("200")
    expect(screen.getByTestId("block-funnel-conversion-1").textContent).toContain("25%")
    fireEvent.click(screen.getByTestId("block-funnel-pick-1"))
    expect(onPick).toHaveBeenCalledWith(1)
  })
})

describe("text note", () => {
  it("renders markdown and shows raw HTML as text, never as markup", () => {
    const { html } = renderNote(
      '**B2B** means dealers.\n\n<img src=x onerror="alert(1)"><script>x()</script>',
    )
    expect(html).toContain("<strong>B2B</strong>")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<script")
    expect(html).toContain("&lt;script&gt;")
  })

  it("keeps web links, drops script links, and opens app paths in place", () => {
    const { html, paths } = renderNote(
      "[site](https://example.com) [bad](javascript:alert(1)) [orders](/projects)",
    )
    expect(html).toContain('href="https://example.com"')
    expect(html).not.toContain("javascript:")
    expect(html).toContain('data-mention-ref="0"')
    expect(paths).toEqual(["/projects"])
    expect(html).not.toContain('href="/projects"')
    render(() => <TextBlock markdown="[orders](/projects) [evil](//evil.example)" />)
    const a = screen.getByText("orders") as HTMLAnchorElement
    expect(a.getAttribute("target")).toBeNull()
    expect(a.getAttribute("tabindex")).toBe("0")
    fireEvent.click(a)
    fireEvent.keyDown(a, { key: "Enter" })
    fireEvent.click(screen.getByText("evil"))
    expect(nav.to).toEqual(["/projects", "/projects"])
  })
})
