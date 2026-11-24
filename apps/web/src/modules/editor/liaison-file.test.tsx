// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A page's images and files in the editor (S11, S12, edge 8, K-R17): the token
// `![](liaison-file:<id>)` is one node, written back byte for byte; pasted, dropped and
// picked files are uploaded and put where the caret is; a file of another page goes in
// only when the writer can read it, and takes the id of this page's copy after the save.
// Nothing in the editor ever draws an address from the text.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { Editor } from "@tiptap/core"
import { closeHistory } from "@tiptap/pm/history"
import { Slice } from "@tiptap/pm/model"
import { Selection } from "@tiptap/pm/state"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { FileViewDeps, PageFileInfo } from "./file-view"
import { renderFileView } from "./file-view"
import { type EditorFiles, RichEditor, type RichEditorHandle } from "./RichEditor"
import { editorOf, typeInto } from "./test-helpers"

afterEach(cleanup)

const A = "11111111-1111-4111-8111-111111111111" // a file of page A
const B = "22222222-2222-4222-8222-222222222222" // page B's copy of it
const SECRET = "33333333-3333-4333-8333-333333333333" // a file the writer cannot read
const PDF = "44444444-4444-4444-8444-444444444444"
const SVG = "55555555-5555-4555-8555-555555555555"

const FILES: Record<string, PageFileInfo> = {
  [A]: { id: A, filename: "chart.png", mimeType: "image/png", sizeBytes: 2048 },
  [B]: { id: B, filename: "chart.png", mimeType: "image/png", sizeBytes: 2048 },
  [PDF]: { id: PDF, filename: "terms.pdf", mimeType: "application/pdf", sizeBytes: 3 * 1048576 },
  [SVG]: { id: SVG, filename: "logo.svg", mimeType: "image/svg+xml", sizeBytes: 900 },
}

function deps(over: Partial<FileViewDeps> = {}): FileViewDeps {
  return {
    resolve: vi.fn(async (id: string) => FILES[id.toLowerCase()] ?? null),
    imageUrl: vi.fn(async (id: string) => `blob:http://localhost/${id}`),
    labels: {
      unavailable: "Image not available",
      loading: "Loading",
      download: (name) => `Download ${name}`,
    },
    ...over,
  }
}

function mount(value: string, files?: Partial<EditorFiles>) {
  const onChange = vi.fn()
  const onEdit = vi.fn()
  const onRefused = vi.fn()
  const upload = vi.fn(async (_file: File) => B)
  const editorFiles: EditorFiles = {
    view: deps(),
    upload,
    onRefused,
    unreadable: "You cannot open that file",
    uploading: (name) => `Uploading ${name}`,
    ...files,
  }
  let handle: RichEditorHandle | undefined
  render(() => (
    <RichEditor
      preset="document"
      value={value}
      onChange={onChange}
      onEdit={onEdit}
      files={editorFiles}
      ref={(h) => {
        handle = h
      }}
      data-testid="field"
    />
  ))
  const field = screen.getByTestId("field")
  if (!handle) throw new Error("no handle")
  return { field, editor: editorOf(field), handle, onChange, onEdit, editorFiles }
}

const token = (id: string) => `![](liaison-file:${id})`

function fileNodes(editor: Editor): string[] {
  const ids: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === "liaisonFile") ids.push(node.attrs.id)
  })
  return ids
}

function caretAtEnd(editor: Editor) {
  editor.view.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)))
}

/** The caret at the end of the text of the top-level block `index`. */
function caretInBlock(editor: Editor, index: number) {
  let pos = 0
  editor.state.doc.forEach((node, offset, i) => {
    if (i === index) pos = offset + node.nodeSize - 1
  })
  editor.view.dispatch(
    editor.state.tr.setSelection(Selection.near(editor.state.doc.resolve(pos), -1)),
  )
}

const pasteHtml = (field: HTMLElement, html: string, text = "") =>
  fireEvent.paste(field, {
    clipboardData: {
      types: ["text/html", "text/plain"],
      getData: (type: string) => (type === "text/html" ? html : text),
      items: [],
    },
  })

const pasteText = (field: HTMLElement, text: string) =>
  fireEvent.paste(field, {
    clipboardData: { types: ["text/plain"], getData: () => text, items: [] },
  })

describe("the file token", () => {
  const cases: Array<[string, string, number]> = [
    ["paragraph", `See ${token(A)} here.\n\nNext.`, 0],
    ["list", `- one ${token(A)}\n- two\n\nNext.`, 0],
    ["quote", `> quoted ${token(A)}\n\nNext.`, 0],
    ["table cell", `| a | b |\n| --- | --- |\n| ${token(A)} | x |\n\nNext.`, 0],
  ]
  for (const [where, body] of cases) {
    it(`is one node and round-trips byte-equal in a ${where}`, () => {
      const { editor, handle } = mount(body)
      expect(fileNodes(editor)).toEqual([A])
      expect(handle.markdown()).toBe(body)
      // An edit of another block keeps the token's block as it was.
      caretAtEnd(editor)
      typeInto(editor, "!")
      expect(handle.markdown()).toBe(`${body}!`)
    })
  }

  it("is written back canonically by an edited block, and the alt text goes", () => {
    const { editor, handle } = mount(`Before ![a chart](liaison-file:${A}) after`)
    expect(fileNodes(editor)).toEqual([A])
    caretInBlock(editor, 0)
    typeInto(editor, ".")
    expect(handle.markdown()).toBe(`Before ${token(A)} after.`)
  })

  it("draws no element with an address of the text, ever", () => {
    const { field } = mount(
      `${token(A)} ![x](https://evil.example/p.png) <img src="https://evil.example/q.png"> ![](javascript:x)`,
    )
    // The sources stay as text (a data attribute, a chip's label), never in an
    // attribute the browser fetches.
    for (const el of field.querySelectorAll("*")) {
      for (const attr of ["src", "srcset", "href", "style", "poster", "background"]) {
        expect(el.getAttribute(attr) ?? "").not.toMatch(/evil\.example|javascript:/)
      }
    }
    for (const img of field.querySelectorAll("img[src]")) {
      expect(img.getAttribute("src")).toMatch(/^blob:/)
    }
  })
})

describe("the file view", () => {
  it("draws a picture from a blob URL, a card for a file and for SVG, a label for no access", async () => {
    const view = deps()
    const box = (id: string) => {
      const el = document.createElement("span")
      renderFileView(el, id, view)
      return el
    }
    const image = box(A)
    const pdf = box(PDF)
    const svg = box(SVG)
    const secret = box(SECRET)
    await waitFor(() =>
      expect(image.querySelector("img")?.getAttribute("src")).toBe(`blob:http://localhost/${A}`),
    )
    await waitFor(() => expect(pdf.textContent).toContain("terms.pdf"))
    expect(pdf.querySelector("img")).toBeNull()
    await waitFor(() => expect(svg.textContent).toContain("logo.svg"))
    expect(svg.querySelector("img")).toBeNull()
    expect(view.imageUrl).not.toHaveBeenCalledWith(SVG)
    await waitFor(() => expect(secret.textContent).toBe("Image not available"))
  })

  it("never draws a picture from anything but a blob URL", async () => {
    const view = deps({ imageUrl: async () => "https://evil.example/x.png" })
    const el = document.createElement("span")
    renderFileView(el, A, view)
    await waitFor(() => expect(el.dataset.kind).toBe("file"))
    expect(el.querySelector("img")).toBeNull()
  })

  it("looks up nothing for a value that is not a file id", () => {
    const view = deps()
    const el = document.createElement("span")
    renderFileView(el, "https://evil.example/x.png", view)
    expect(view.resolve).not.toHaveBeenCalled()
    expect(el.textContent).toBe("Image not available")
  })
})

describe("pasting, dropping and picking files", () => {
  const image = new File(["png"], "photo.png", { type: "image/png" })
  const pasteFile = (field: HTMLElement) =>
    fireEvent.paste(field, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => image }],
        types: ["Files", "text/plain"],
        getData: (type: string) => (type === "text/plain" ? "photo.png" : ""),
      },
    })

  it("uploads a pasted file once and puts its token where the caret was", async () => {
    const { field, editor, handle, editorFiles } = mount("Start.")
    caretAtEnd(editor)
    pasteFile(field)
    expect(editorFiles.upload).toHaveBeenCalledTimes(1)
    expect(editorFiles.upload).toHaveBeenCalledWith(image)
    await waitFor(() => expect(fileNodes(editor)).toEqual([B]))
    expect(handle.markdown()).toBe(`Start.${token(B)}`)
  })

  it("shows the chip while uploading, and on refusal leaves the text untouched with the reason", async () => {
    let refuse: (err: Error) => void = () => {}
    const { field, editor, handle, editorFiles } = mount("Start.", {
      upload: vi.fn(
        () =>
          new Promise<string>((_, reject) => {
            refuse = reject
          }),
      ),
    })
    caretAtEnd(editor)
    pasteFile(field)
    expect(screen.getByTestId("liaison-file-uploading").textContent).toBe("Uploading photo.png")
    // A save while it uploads writes nothing of the chip.
    expect(handle.markdown()).toBe("Start.")
    refuse(new Error("photo.png was not added: your organization's storage is full."))
    await waitFor(() => expect(editorFiles.onRefused).toHaveBeenCalledTimes(1))
    expect(editorFiles.onRefused).toHaveBeenCalledWith(
      "photo.png was not added: your organization's storage is full.",
    )
    expect(screen.queryByTestId("liaison-file-uploading")).toBeNull()
    expect(handle.markdown()).toBe("Start.")
    expect(fileNodes(editor)).toEqual([])
  })

  it("uploads a dropped file", async () => {
    const { field, editor, editorFiles } = mount("Start.")
    // jsdom lays nothing out, so ProseMirror's own drop handler stops before the
    // field's: the field's handler is called as ProseMirror would.
    const event = new Event("drop", { cancelable: true }) as DragEvent
    Object.defineProperty(event, "dataTransfer", { value: { files: [image] } })
    editor.view.someProp("handleDrop", (f) => f(editor.view, event, Slice.empty, false))
    void field
    expect(editorFiles.upload).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(fileNodes(editor)).toEqual([B]))
  })

  it("uploads files picked with the toolbar's Image tool", async () => {
    const { editor, editorFiles } = mount("Start.")
    const input = screen.getByTestId("rich-editor.pick-image") as HTMLInputElement
    const click = vi.spyOn(input, "click")
    fireEvent.click(screen.getByTestId("rich-editor.tool-image"))
    expect(click).toHaveBeenCalled()
    Object.defineProperty(input, "files", { value: [image], configurable: true })
    fireEvent.change(input)
    expect(editorFiles.upload).toHaveBeenCalledWith(image)
    await waitFor(() => expect(fileNodes(editor)).toEqual([B]))
  })

  it("shows no Image or File tool on a field without files", () => {
    render(() => <RichEditor preset="document" value="x" data-testid="plain" />)
    expect(screen.queryByTestId("rich-editor.tool-image")).toBeNull()
    expect(screen.queryByTestId("rich-editor.tool-file")).toBeNull()
  })
})

describe("a file of another page (edge 8, K-R17)", () => {
  /** Paste, wait for the check, then the save's answer maps A to this page's copy B. */
  async function pasteThenSave(paste: (field: HTMLElement) => void) {
    const m = mount("Start.")
    caretAtEnd(m.editor)
    paste(m.field)
    await waitFor(() => expect(fileNodes(m.editor)).toEqual([A]))
    expect(m.handle.markdown()).toBe(`Start.${token(A)}`)
    const caret = m.editor.state.selection.from
    m.handle.replaceFileIds({ [A]: B })
    expect(fileNodes(m.editor)).toEqual([B])
    expect(m.handle.markdown()).toBe(`Start.${token(B)}`)
    // The caret did not move, and the change was not an edit.
    expect(m.editor.state.selection.from).toBe(caret)
    return m
  }

  it("from page A's editor (its clipboard HTML)", async () => {
    const m = await pasteThenSave((field) =>
      pasteHtml(field, `<p><span data-liaison-file="${A}"></span></p>`, token(A)),
    )
    // Typing (a step of its own) then undoing it never brings A's id back.
    m.editor.view.dispatch(closeHistory(m.editor.state.tr))
    typeInto(m.editor, "x")
    m.editor.commands.undo()
    expect(fileNodes(m.editor)).toEqual([B])
  })

  it("from page A's reader (the hydrated span, its picture a blob)", async () => {
    await pasteThenSave((field) =>
      pasteHtml(
        field,
        `<p><span data-liaison-file="${A}" class="liaison-file"><img src="blob:http://localhost/x" alt="chart.png"></span></p>`,
      ),
    )
  })

  it("as plain token text", async () => {
    await pasteThenSave((field) => pasteText(field, token(A)))
  })

  it("as an image of the app's own inline route", async () => {
    await pasteThenSave((field) =>
      pasteHtml(field, `<img src="${window.location.origin}/api/files/${A}/inline?variant=thumb">`),
    )
  })

  it("an unreadable file: nothing inserted, the writer is told", async () => {
    const { field, editor, handle, editorFiles } = mount("Start.")
    caretAtEnd(editor)
    pasteHtml(field, `<p><span data-liaison-file="${SECRET}"></span></p>`, token(SECRET))
    await waitFor(() =>
      expect(editorFiles.onRefused).toHaveBeenCalledWith("You cannot open that file"),
    )
    expect(fileNodes(editor)).toEqual([])
    expect(handle.markdown()).toBe("Start.")
    pasteText(field, token(SECRET))
    await waitFor(() => expect(editorFiles.onRefused).toHaveBeenCalledTimes(2))
    expect(handle.markdown()).toBe("Start.")
  })

  it("keeps the rest of a paste when one of its files is unreadable", async () => {
    const { field, editor, handle } = mount("")
    pasteText(field, `Kept text ${token(SECRET)} and ${token(A)}`)
    await waitFor(() => expect(fileNodes(editor)).toEqual([A]))
    expect(handle.markdown()).toBe(`Kept text  and ${token(A)}`)
  })

  it("a pasted web image is kept as its source chip, never drawn", async () => {
    const { field, handle } = mount("")
    pasteHtml(field, `<p>Look <img src="https://evil.example/track.png?d=secret"></p>`)
    expect(field.querySelector("img")).toBeNull()
    expect(field.querySelector("[data-raw-kind='image']")).not.toBeNull()
    expect(handle.markdown()).toBe("Look ![](https://evil.example/track.png?d=secret)")
  })

  it("a pasted data: or blob: image outside a file is dropped", () => {
    const { field, handle } = mount("")
    pasteHtml(
      field,
      `<p>A<img src="data:image/svg+xml,<svg onload=alert(1)>">B<img src="blob:x"></p>`,
    )
    expect(field.querySelector("img")).toBeNull()
    expect(handle.markdown()).toBe("AB")
  })
})
