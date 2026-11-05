// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import SchedulePicker from "./SchedulePicker"

describe("SchedulePicker", () => {
  it("emits a cron string for the 'weekdays' preset", () => {
    const onChange = vi.fn()
    const { getByTestId } = render(() => <SchedulePicker kind="recurring" onChange={onChange} />)
    fireEvent.click(getByTestId("schedule-preset-weekdays"))
    fireEvent.input(getByTestId("schedule-time"), { target: { value: "08:30" } })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "recurring", cron: "30 8 * * 1-5" }),
    )
  })

  it("exposes a custom-cron escape hatch", () => {
    const onChange = vi.fn()
    const { getByTestId } = render(() => <SchedulePicker kind="recurring" onChange={onChange} />)
    fireEvent.click(getByTestId("schedule-preset-custom"))
    fireEvent.input(getByTestId("schedule-cron-input"), {
      target: { value: "*/15 * * * *" },
    })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ cron: "*/15 * * * *" }))
  })

  it("emits a runAt ISO timestamp in 'scheduled' mode", () => {
    const onChange = vi.fn()
    const { getByTestId } = render(() => <SchedulePicker kind="scheduled" onChange={onChange} />)
    fireEvent.input(getByTestId("schedule-datetime"), {
      target: { value: "2099-06-01T09:00" },
    })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "scheduled",
        runAt: expect.stringContaining("2099-06-01"),
      }),
    )
  })

  it("rejects a past datetime in 'scheduled' mode", () => {
    const onChange = vi.fn()
    const { getByTestId, getByText } = render(() => (
      <SchedulePicker kind="scheduled" onChange={onChange} />
    ))
    fireEvent.input(getByTestId("schedule-datetime"), {
      target: { value: "2020-01-01T09:00" },
    })
    expect(getByText(/must be in the future/i)).toBeTruthy()
  })
})
