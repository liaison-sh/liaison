// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { confirmDiscard, pendingDiscard, resetUnsavedWork } from "~/lib/unsaved-work"
import { UnsavedWorkConfirm } from "~/modules/shell/UnsavedWorkConfirm"

afterEach(() => resetUnsavedWork())

describe("UnsavedWorkConfirm", () => {
  it("names what a reload would lose; Keep editing keeps it, Discard reloads", async () => {
    render(() => <UnsavedWorkConfirm />)
    const reload = vi.fn()
    confirmDiscard("reload", ["A message you have not sent"], reload)
    const dialog = await screen.findByTestId("unsaved-work-confirm")
    expect(dialog.textContent).toContain("Reload and lose unsaved work?")
    expect(screen.getByTestId("unsaved-work-items").textContent).toContain(
      "A message you have not sent",
    )
    fireEvent.click(screen.getByTestId("unsaved-work-keep"))
    expect(reload).not.toHaveBeenCalled()
    expect(pendingDiscard()).toBeNull()
    await waitFor(() => expect(screen.queryByTestId("unsaved-work-confirm")).toBeNull())

    confirmDiscard("close-tabs", ["Unsaved settings changes"], reload)
    expect((await screen.findByTestId("unsaved-work-discard")).textContent).toContain(
      "Discard and close",
    )
    fireEvent.click(screen.getByTestId("unsaved-work-discard"))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
