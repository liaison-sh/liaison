// SPDX-License-Identifier: FSL-1.1-ALv2
// The `:` emoji shortcode picker in the rich editor: opens after `:` and two
// letters, never inside a time, a URL or code, and stores the unicode character.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RichEditor, type RichEditorProps } from "./RichEditor"
import { editorOf, typeInto } from "./test-helpers"

afterEach(cleanup)

function mount(props: Partial<RichEditorProps> = {}) {
  const onChange = vi.fn()
  const onKeyDown = vi.fn(() => false)
  render(() => (
    <RichEditor
      preset="minimal"
      value=""
      onChange={onChange}
      onKeyDown={onKeyDown}
      {...props}
      data-testid="field"
    />
  ))
  const field = screen.getByTestId("field")
  const editor = editorOf(field)
  editor.view.focus()
  editor.commands.focus("end")
  return { field, editor, onChange, onKeyDown }
}

const picker = () => screen.queryByTestId("emoji-suggest")
const press = (field: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(field, { key: k, ...init })

describe("RichEditor emoji shortcodes", () => {
  it("opens after ':sm' with the best match first and at most 8 rows", () => {
    const { editor } = mount()
    typeInto(editor, "hello :s")
    expect(picker()).toBeNull()
    typeInto(editor, "m")
    expect(picker()).not.toBeNull()
    const rows = screen.getAllByTestId("emoji-suggest-item")
    expect(rows.length).toBeLessThanOrEqual(8)
    expect(rows[0]?.textContent).toContain("😄")
    expect(rows[0]?.textContent).toContain(":smile:")
  })

  it("opens at the start of a line and after punctuation", () => {
    const a = mount()
    typeInto(a.editor, ":sm")
    expect(picker()).not.toBeNull()
    cleanup()
    const b = mount()
    typeInto(b.editor, "(:sm")
    expect(picker()).not.toBeNull()
  })

  it("does not open after a digit, mid-word or in a URL", () => {
    const { editor } = mount()
    typeInto(editor, "at 10:30")
    expect(picker()).toBeNull()
    typeInto(editor, " and word:smi")
    expect(picker()).toBeNull()
    typeInto(editor, " https://example.com/a:smi")
    expect(picker()).toBeNull()
    typeInto(editor, " https://exa:sm")
    expect(picker()).toBeNull()
  })

  it("does not open inside inline code or a code block", () => {
    const a = mount({ value: "" })
    a.editor.commands.setContent("`x` ", { contentType: "markdown" })
    a.editor.commands.focus("end")
    a.editor.commands.toggleCode()
    typeInto(a.editor, ":sm")
    expect(picker()).toBeNull()
    cleanup()
    const b = mount()
    b.editor.commands.setCodeBlock()
    typeInto(b.editor, ":sm")
    expect(picker()).toBeNull()
  })

  it("Enter inserts the character and the stored text is unicode", () => {
    const { editor, field, onChange } = mount()
    typeInto(editor, "ok :sm")
    press(field, "Enter")
    expect(picker()).toBeNull()
    expect(editor.getMarkdown()).toBe("ok 😄")
    expect(onChange).toHaveBeenLastCalledWith("ok 😄")
  })

  it("Tab, arrows and mouse pick; Escape closes", () => {
    const a = mount()
    typeInto(a.editor, ":sm")
    press(a.field, "ArrowDown")
    const second = screen.getAllByTestId("emoji-suggest-item")[1]?.textContent ?? ""
    press(a.field, "Tab")
    expect(second).toContain(a.editor.getText())
    cleanup()
    const b = mount()
    typeInto(b.editor, ":sm")
    press(b.field, "Escape")
    expect(picker()).toBeNull()
    expect(b.editor.getText()).toBe(":sm")
    cleanup()
    const c = mount()
    typeInto(c.editor, ":sm")
    fireEvent.mouseDown(screen.getAllByTestId("emoji-suggest-item")[0]!)
    expect(c.editor.getText()).toBe("😄")
  })

  it("converts an exact shortcode at its closing colon", () => {
    const { editor } = mount()
    typeInto(editor, "nice :thumbsup:")
    expect(editor.getMarkdown()).toBe("nice 👍")
    expect(picker()).toBeNull()
  })

  it("a shortcode whose picker Escape closed stays text at its closing colon", () => {
    const { field, editor } = mount()
    typeInto(editor, ":smile")
    press(field, "Escape")
    typeInto(editor, ":")
    expect(editor.getText()).toBe(":smile:")
    // A fresh shortcode afterwards converts as usual.
    typeInto(editor, " :smile:")
    expect(editor.getText()).toBe(":smile: 😄")
  })

  it("leaves unknown names, times and URLs alone at a closing colon", () => {
    const { editor } = mount()
    typeInto(editor, ":nopenotreal: 10:30: https://a.b/x:smile:")
    expect(editor.getText()).toBe(":nopenotreal: 10:30: https://a.b/x:smile:")
  })

  it("does not convert inside inline code", () => {
    const { editor } = mount()
    editor.commands.toggleCode()
    typeInto(editor, ":smile:")
    expect(editor.getText()).toBe(":smile:")
  })

  it("lets the host see keys when no picker is open", () => {
    const { field, onKeyDown } = mount()
    press(field, "Enter")
    expect(onKeyDown).toHaveBeenCalled()
  })
})
