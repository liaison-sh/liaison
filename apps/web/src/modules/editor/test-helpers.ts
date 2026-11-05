// SPDX-License-Identifier: FSL-1.1-ALv2
// Driving a RichEditor from a jsdom test: jsdom has no text input, so typing
// goes through ProseMirror's own text-input hook, which is where typed
// markdown (input rules) is converted.
import { screen, waitFor } from "@solidjs/testing-library"
import type { Editor } from "@tiptap/core"
// Loaded up front, so a lazy field mounts within a test's default wait.
import "./RichEditor"

// jsdom lays nothing out and its Range has no rects: a focus that scrolls the
// caret into view (autofocus at the end) threw. Empty rects say "nowhere".
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
}

/** The editor behind a rendered field (the element carrying its data-testid). */
export function editorOf(field: Element): Editor {
  const editor = (field as Element & { editor?: Editor }).editor
  if (!editor) throw new Error("not a RichEditor field")
  return editor
}

/** Type `text` at the caret, one character at a time. */
export function typeInto(editor: Editor, text: string): void {
  const { view } = editor
  for (const ch of text) {
    const { from, to } = view.state.selection
    const insert = () => view.state.tr.insertText(ch, from, to)
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, insert))
    if (!handled) view.dispatch(insert())
  }
}

/** Replace the whole content as if typed, firing the field's onChange. */
export function setMarkdown(field: Element, markdown: string): void {
  editorOf(field).commands.setContent(markdown, { contentType: "markdown", emitUpdate: true })
}

/** The editable text inside a surface's frame (by its data-testid), once the editor has loaded. */
export function editableIn(testId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = screen.getByTestId(testId).querySelector<HTMLElement>("[contenteditable]")
    if (!el) throw new Error(`no editor in ${testId} yet`)
    return el
  })
}
