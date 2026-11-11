// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TimeRangePicker } from "./TimeRangePicker"
import type { RangeChoice } from "./time-range"

afterEach(cleanup)

const choice: RangeChoice = { timeRange: { preset: "mtd" }, compare: "lastYear" }

function mount(extra: { saved?: boolean } = {}) {
  const onChange = vi.fn()
  const onReset = vi.fn()
  render(() => (
    <TimeRangePicker
      choice={choice}
      label="1–11 Nov 2026 · vs 1–11 Nov 2025"
      window={{ from: "2026-11-01", to: "2026-11-11" }}
      saved={extra.saved ?? false}
      onChange={onChange}
      onReset={onReset}
    />
  ))
  return { onChange, onReset }
}

/** Picks a menu row as the keyboard does (Kobalte selects on Enter). */
function choose(testId: string) {
  const item = screen.getByTestId(testId)
  item.focus()
  fireEvent.keyDown(item, { key: "Enter" })
}

async function openMenu() {
  fireEvent.keyDown(screen.getByTestId("dashboard-range-trigger"), { key: "ArrowDown" })
  await waitFor(() => expect(screen.getByTestId("dashboard-range-menu")).toBeTruthy())
}

describe("TimeRangePicker", () => {
  it("reads the range as days on its button", () => {
    mount()
    expect(screen.getByTestId("dashboard-range-label").textContent).toBe(
      "1–11 Nov 2026 · vs 1–11 Nov 2025",
    )
  })

  it("a preset keeps the comparison", async () => {
    const { onChange } = mount()
    await openMenu()
    choose("dashboard-range-preset-lastQuarter")
    expect(onChange).toHaveBeenCalledWith({
      timeRange: { preset: "lastQuarter" },
      compare: "lastYear",
    })
  })

  it("a comparison keeps the range", async () => {
    const { onChange } = mount()
    await openMenu()
    choose("dashboard-range-compare-previousPeriod")
    expect(onChange).toHaveBeenCalledWith({
      timeRange: { preset: "mtd" },
      compare: "previousPeriod",
    })
  })

  it("lists every preset and the three comparisons", async () => {
    mount()
    await openMenu()
    for (const p of [
      "last7d",
      "last30d",
      "last90d",
      "mtd",
      "lastMonth",
      "qtd",
      "lastQuarter",
      "ytd",
      "lastYear",
      "custom",
    ]) {
      expect(screen.getByTestId(`dashboard-range-preset-${p}`)).toBeTruthy()
    }
    expect(screen.getByTestId("dashboard-range-compare-lastYear").textContent).toContain(
      "Same period last year",
    )
    expect(screen.getByTestId("dashboard-range-compare-none")).toBeTruthy()
    // Nothing saved: no way back to a default it already shows.
    expect(screen.queryByTestId("dashboard-range-reset")).toBeNull()
  })

  it("a custom range opens on the days shown and applies only in order", async () => {
    const { onChange } = mount()
    await openMenu()
    choose("dashboard-range-preset-custom")
    await waitFor(() => expect(screen.getByTestId("dashboard-range-from")).toBeTruthy())
    const from = screen.getByTestId("dashboard-range-from") as HTMLInputElement
    const to = screen.getByTestId("dashboard-range-to") as HTMLInputElement
    expect(from.value).toBe("2026-11-01")
    expect(to.value).toBe("2026-11-11")
    fireEvent.input(from, { target: { value: "2026-12-01" } })
    expect(screen.getByTestId("dashboard-range-invalid")).toBeTruthy()
    expect((screen.getByTestId("dashboard-range-apply") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.input(from, { target: { value: "2026-10-05" } })
    fireEvent.submit(screen.getByTestId("dashboard-range-custom"))
    expect(onChange).toHaveBeenCalledWith({
      timeRange: { preset: "custom", from: "2026-10-05", to: "2026-11-11" },
      compare: "lastYear",
    })
  })

  it("offers the dashboard's default back when the person saved a range", async () => {
    const { onReset } = mount({ saved: true })
    await openMenu()
    choose("dashboard-range-reset")
    expect(onReset).toHaveBeenCalled()
  })
})
