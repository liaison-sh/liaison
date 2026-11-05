// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"

// The editor chunk arrives only when the test says so.
const chunk = vi.hoisted(() => {
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  return { ready, release }
})
vi.mock("./RichEditor", async (importOriginal) => {
  await chunk.ready
  return importOriginal()
})

import { RichEditor } from "./index"

describe("RichEditor while its chunk loads", () => {
  it("keeps the keys typed meanwhile: none reaches the app, all reach the editor", async () => {
    const shortcut = vi.fn()
    window.addEventListener("keydown", shortcut)
    const onChange = vi.fn()
    render(() => (
      <RichEditor preset="full" value="" autofocus onChange={onChange} data-testid="f" />
    ))
    const standIn = screen.getByTestId("rich-editor.loading")
    await waitFor(() => expect(document.activeElement).toBe(standIn))
    for (const key of ["n", "o", "x", "Backspace", "t", "e"]) fireEvent.keyDown(standIn, { key })
    expect(shortcut).not.toHaveBeenCalled()
    expect(standIn.textContent).toBe("note")

    chunk.release()
    const field = await screen.findByTestId("f", {}, { timeout: 15_000 })
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("note"))
    expect(field.textContent).toBe("note")
    window.removeEventListener("keydown", shortcut)
  })
})
