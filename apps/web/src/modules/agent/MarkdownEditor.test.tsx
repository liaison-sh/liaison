// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A memory file read through the shell's shared renderer, and edited in the
 * shared rich editor or, toggled, as its markdown source: one text either way.
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import MarkdownEditor from "~/modules/agent/MarkdownEditor"
import { editorOf, setMarkdown } from "~/modules/editor/test-helpers"
import { ApiContext } from "~/modules/shell/ApiContext"

function setup(props: { value: string; readOnly?: boolean }) {
  const api: any = { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }
  const onInput = vi.fn()
  const [value, setValue] = createSignal(props.value)
  render(() => (
    <ApiContext.Provider value={api as never}>
      <MarkdownEditor
        value={value()}
        readOnly={props.readOnly}
        onInput={(next) => {
          onInput(next)
          setValue(next)
        }}
      />
    </ApiContext.Provider>
  ))
  return { onInput }
}

describe("MarkdownEditor", () => {
  afterEach(() => cleanup())

  it("a read only file renders through the shared renderer, with no editable control", () => {
    setup({ value: "# Heading", readOnly: true })
    expect(screen.getByTestId("agent-memory-body").querySelector("h1")?.textContent).toBe("Heading")
    expect(screen.queryByTestId("agent-memory-editor-input")).toBeNull()
    expect(screen.queryByTestId("agent-memory-source-toggle")).toBeNull()
  })

  it("edits the formatted text in the rich editor", async () => {
    const { onInput } = setup({ value: "# Client\n\nVoir [[memoire-client]]" })
    const field = await screen.findByTestId("agent-memory-editor-input")
    expect(field.querySelector("h1")?.textContent).toBe("Client")
    expect(screen.queryByRole("textbox", { name: /source/i })).toBeNull()
    setMarkdown(field, "# Client\n\nVoir [[memoire-client]] et **kpi_run**")
    expect(onInput).toHaveBeenLastCalledWith("# Client\n\nVoir [[memoire-client]] et **kpi_run**")
  })

  it("the source toggle shows the same markdown, and an edit there reaches the editor", async () => {
    const { onInput } = setup({ value: "Un **mot**" })
    await screen.findByTestId("agent-memory-editor-input")
    fireEvent.click(screen.getByTestId("agent-memory-source-toggle"))
    const source = screen.getByTestId("agent-memory-source") as HTMLTextAreaElement
    expect(source.value).toBe("Un **mot**")
    fireEvent.input(source, { target: { value: "Un ++mot++" } })
    expect(onInput).toHaveBeenLastCalledWith("Un ++mot++")
    fireEvent.click(screen.getByTestId("agent-memory-source-toggle"))
    const field = await screen.findByTestId("agent-memory-editor-input")
    expect(field.querySelector("u")?.textContent).toBe("mot")
    expect(editorOf(field).getText()).toBe("Un mot")
  })
})
