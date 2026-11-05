// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal, Show } from "solid-js"
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

describe("RichEditor while its chunk loads, in a field with its own placeholder", () => {
  it("shows a draft the field opened with, not a placeholder over nothing", () => {
    render(() => <RichEditor preset="minimal" value="draft" placeholder="Write" data-testid="d" />)
    const standIns = screen.getAllByTestId("rich-editor.loading")
    expect(standIns.at(-1)?.textContent).toBe("draft")
  })

  it("what is typed reaches the field at once, so its placeholder never sits over it", async () => {
    // The chat composer's shape: a placeholder of its own, shown while its value is empty.
    const [text, setText] = createSignal("")
    render(() => (
      <div>
        <RichEditor preset="minimal" value={text()} onChange={setText} autofocus data-testid="f" />
        <Show when={!text()}>
          <div data-testid="own-placeholder">Write a message</div>
        </Show>
      </div>
    ))
    const standIn = screen.getByTestId("rich-editor.loading")
    await waitFor(() => expect(document.activeElement).toBe(standIn))
    for (const key of ["h", "i"]) fireEvent.keyDown(standIn, { key })
    expect(text()).toBe("hi")
    expect(screen.queryByTestId("own-placeholder")).toBeNull()

    chunk.release()
    const field = await screen.findByTestId("f", {}, { timeout: 15_000 })
    // Not typed twice: the editor opens on the value the keys already made.
    await waitFor(() => expect(field.textContent).toBe("hi"))
    expect(text()).toBe("hi")
  })
})
