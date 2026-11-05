// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { editorOf, typeInto } from "~/modules/editor/test-helpers"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { MessageEditField } from "./MessageEditField"

function mount(content: string) {
  const onSave = vi.fn()
  const onCancel = vi.fn()
  render(() => (
    <I18nProvider initialLocale="en">
      {/* The writing helpers beside the field read the API from context. */}
      <ApiContext.Provider value={{} as ApiClient}>
        <MessageEditField content={content} onSave={onSave} onCancel={onCancel} />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return { onSave, onCancel }
}

const field = () => screen.findByTestId("message-edit-field")

describe("MessageEditField", () => {
  it("edits in the composer's editor, not a plain text box", async () => {
    mount("Bonjour")
    const el = await field()
    expect(el.getAttribute("contenteditable")).toBe("true")
    expect(el.textContent).toBe("Bonjour")
  })

  it("Enter saves; a message saved untouched is stored exactly as it was", async () => {
    const stored = "Voir `kpi_run` et snake_case_word\nligne 2 &amp; **gras**"
    const { onSave } = mount(stored)
    fireEvent.keyDown(await field(), { key: "Enter" })
    expect(onSave).toHaveBeenCalledWith(stored)
  })

  it("typed emphasis follows the composer's rules and is stored as typed", async () => {
    const { onSave } = mount("")
    const el = await field()
    const editor = editorOf(el)
    typeInto(editor, "un **gras** et _private_var")
    fireEvent.keyDown(el, { key: "Enter" })
    expect(el.querySelector("strong")?.textContent).toBe("gras")
    expect(onSave).toHaveBeenCalledWith("un **gras** et _private_var")
  })

  it("Shift+Enter is a new line, Escape cancels and is taken from the page", async () => {
    const { onSave, onCancel } = mount("a")
    const el = await field()
    editorOf(el).commands.focus("end")
    fireEvent.keyDown(el, { key: "Enter", shiftKey: true })
    typeInto(editorOf(el), "b")
    expect(onSave).not.toHaveBeenCalled()
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    el.dispatchEvent(esc)
    expect(onCancel).toHaveBeenCalled()
    expect(esc.defaultPrevented).toBe(true)
  })

  it("an emptied message is not saved", async () => {
    const { onSave } = mount("x")
    const el = await field()
    editorOf(el).commands.clearContent(true)
    fireEvent.keyDown(el, { key: "Enter" })
    expect(onSave).not.toHaveBeenCalled()
  })
})
