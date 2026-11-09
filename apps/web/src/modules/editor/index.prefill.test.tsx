// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
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

// A surface that fills its value just after the field mounts (the ticket
// reply's signature, set by an effect once the composer exists): the keys
// typed into the stand-in are edits of THAT text. They were added to the value
// the stand-in was created with (empty), so the first key dropped the
// signature and the editor then opened on the typed letters alone.
describe("RichEditor while its chunk loads, value filled late", () => {
  it("keys typed after a late prefill keep the prefill, also once the editor is in", async () => {
    const [value, setValue] = createSignal("")
    const onChange = vi.fn((next: string) => setValue(next))
    render(() => (
      <RichEditor preset="minimal" value={value()} autofocus onChange={onChange} data-testid="f" />
    ))
    const standIn = screen.getByTestId("rich-editor.loading")
    setValue("Hi\n\nBest regards")
    await waitFor(() => expect(document.activeElement).toBe(standIn))
    for (const key of ["!", "!"]) fireEvent.keyDown(standIn, { key })
    expect(onChange).toHaveBeenLastCalledWith("Hi\n\nBest regards!!")
    expect(standIn.textContent).toBe("Hi\n\nBest regards!!")

    chunk.release()
    const field = await screen.findByTestId("f", {}, { timeout: 15_000 })
    expect(field.textContent).toBe("HiBest regards!!")
    expect(value()).toBe("Hi\n\nBest regards!!")
  })
})
