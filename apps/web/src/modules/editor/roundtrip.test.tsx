// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The page editor and stored text (S10): opening and closing a page writes nothing,
// an edit rewrites only the block it touched, and what the editor has no node for
// (a web image, a page link with no label) is kept byte for byte, never drawn.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { Selection } from "@tiptap/pm/state"
import { afterEach, describe, expect, it, vi } from "vitest"
import { STORED_BODIES } from "./__fixtures__/stored-bodies"
import { PageTextEditor } from "./PageTextEditor"
import { RichEditor, type RichEditorHandle } from "./RichEditor"
import { editorOf, typeInto } from "./test-helpers"

afterEach(cleanup)

function mount(value: string) {
  const onChange = vi.fn()
  const onEdit = vi.fn()
  let handle: RichEditorHandle | undefined
  const view = render(() => (
    <RichEditor
      preset="document"
      value={value}
      onChange={onChange}
      onEdit={onEdit}
      ref={(h) => {
        handle = h
      }}
      data-testid="field"
    />
  ))
  const field = screen.getByTestId("field")
  if (!handle) throw new Error("no handle")
  return { field, editor: editorOf(field), onChange, onEdit, handle, view }
}

/** The caret at the end of the text of the top-level block `index`. */
function caretInBlock(editor: ReturnType<typeof editorOf>, index: number) {
  let pos = 0
  editor.state.doc.forEach((node, offset, i) => {
    if (i === index) pos = offset + node.nodeSize - 1
  })
  editor.view.dispatch(
    editor.state.tr.setSelection(Selection.near(editor.state.doc.resolve(pos), -1)),
  )
}

describe("opening and closing writes nothing", () => {
  it("200 stored bodies: mount, focus, blur, unmount: no change and no edit", () => {
    expect(STORED_BODIES.length).toBe(200)
    const changed: number[] = []
    STORED_BODIES.forEach((body, i) => {
      const { editor, onChange, onEdit, handle, view } = mount(body)
      editor.view.focus()
      editor.commands.blur()
      if (onChange.mock.calls.length || onEdit.mock.calls.length) changed.push(i)
      // What the page would save, unasked, is the stored text itself.
      if (handle.markdown() !== body) changed.push(i)
      view.unmount()
    })
    expect(changed).toEqual([])
  })
})

describe("an edit rewrites only its block", () => {
  const BLOCKS = [
    // Blocks the editor would spell its own way if it wrote them (`~` alone, the
    // padded table, the loose list): kept, since only block 2 is edited.
    "# Title ~x~  ",
    "First paragraph with a ++mark++.",
    "| a |  b |\n|---|---|\n| 1 |  2 |",
    "- loose\n\n- list",
    'Logo ![logo](https://example.com/logo.png "Logo") end.',
  ]
  const BODY = BLOCKS.join("\n\n")

  it("typing in block 2 leaves every other block byte-equal", () => {
    const { editor, handle, onEdit } = mount(BODY)
    caretInBlock(editor, 1)
    typeInto(editor, " More")
    expect(onEdit).toHaveBeenCalled()
    const out = handle.markdown()
    expect(out).toBe(
      [BLOCKS[0], "First paragraph with a ++mark++. More", ...BLOCKS.slice(2)].join("\n\n"),
    )
  })

  it("editing a paragraph that holds a web image keeps the image's markdown", () => {
    const body = `Before ![chart](https://example.com/c.png?a=(1)) after.`
    const { editor, handle, field } = mount(body)
    caretInBlock(editor, 0)
    typeInto(editor, "!")
    expect(handle.markdown()).toBe(`${body}!`)
    // Never drawn: no image element, no address in any URL attribute.
    expect(field.querySelector("img")).toBeNull()
    expect(field.innerHTML).not.toMatch(/(src|href|srcset)=/)
  })

  it("editing a paragraph that holds a page link with no label keeps it", () => {
    const link = "[](knowledge:document:0b9a3c5e-1d2f-4a6b-8c7d-9e0f1a2b3c4d)"
    const body = `See ${link} and [](https://example.com/x) here.`
    const { editor, handle, field } = mount(body)
    caretInBlock(editor, 0)
    typeInto(editor, " Done")
    expect(handle.markdown()).toBe(`${body} Done`)
    expect(field.textContent).toContain("Page link")
  })

  it("markdown() is the stored text until something is edited", () => {
    const { handle } = mount(BODY)
    expect(handle.roundTrips).toBe(true)
    expect(handle.markdown()).toBe(BODY)
  })
})

describe("a text from elsewhere", () => {
  it("applyRemote keeps the caret where it was and emits nothing", () => {
    const body = "Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph."
    const { editor, handle, onChange, onEdit } = mount(body)
    // Caret after "Beta par".
    let at = 0
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.startsWith("Beta")) at = pos + "Beta par".length
    })
    editor.view.dispatch(editor.state.tr.setSelection(Selection.near(editor.state.doc.resolve(at))))
    handle.applyRemote("Alpha paragraph, longer now.\n\nBeta paragraph.\n\nGamma paragraph.")
    expect(onChange).not.toHaveBeenCalled()
    expect(onEdit).not.toHaveBeenCalled()
    const { $from } = editor.state.selection
    expect($from.parent.textContent).toBe("Beta paragraph.")
    expect($from.parentOffset).toBe("Beta par".length)
    expect(handle.markdown()).toBe(
      "Alpha paragraph, longer now.\n\nBeta paragraph.\n\nGamma paragraph.",
    )
    // Not in the undo history: undo does not bring the old text back.
    editor.commands.undo()
    expect(handle.markdown()).toBe(
      "Alpha paragraph, longer now.\n\nBeta paragraph.\n\nGamma paragraph.",
    )
  })
})

describe("a body the editor cannot write back", () => {
  it("opens in the source editor, which keeps it byte for byte", () => {
    // A checklist nested in a checklist: the editor would write it otherwise.
    const body = "- [ ] a\n  - [x] b"
    const onChange = vi.fn()
    render(() => <PageTextEditor value={body} onChange={onChange} data-testid="page" />)
    const area = screen.getByTestId("page-source") as HTMLTextAreaElement
    expect(area.value).toBe(body)
    expect(onChange).not.toHaveBeenCalled()
  })

  it("a body it can write back opens in the rich editor", () => {
    render(() => <PageTextEditor value={"# Hello\n\nWorld"} data-testid="page" />)
    expect(screen.queryByTestId("page-source")).toBeNull()
    expect(screen.getByTestId("page")).toBeTruthy()
  })
})
