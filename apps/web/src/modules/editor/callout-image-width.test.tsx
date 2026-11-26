// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Callouts and picture widths: stored as portable markdown, read back the same by the
// editor, drawn the same by the reader.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { renderMarkdown } from "~/modules/knowledge/markdown"
import { fileRef, imageWidthOfRef } from "./file-view"
import { RichEditor, type RichEditorHandle } from "./RichEditor"
import { editorOf } from "./test-helpers"

afterEach(cleanup)

const ID = "0b9f0e7c-2d0f-4c1e-9a55-3d6c1c5e8a10"

function mount(value: string) {
  let handle: RichEditorHandle | undefined
  render(() => (
    <RichEditor
      preset="document"
      value={value}
      onChange={() => {}}
      ref={(h) => {
        handle = h
      }}
      data-testid="field"
    />
  ))
  if (!handle) throw new Error("no handle")
  return { handle, editor: editorOf(screen.getByTestId("field")) }
}

describe("callouts", () => {
  it("a GitHub-style alert opens as a callout and is written back byte for byte", () => {
    const md =
      "Before\n\n> [!WARNING]\n> Never restart prod on a Friday.\n>\n> - check backups\n\nAfter"
    const { handle, editor } = mount(md)
    let kind = ""
    editor.state.doc.descendants((n) => {
      if (n.type.name === "callout") kind = n.attrs.kind
    })
    expect(kind).toBe("warning")
    expect(handle.markdown()).toBe(md)
  })

  it("the reader draws a callout as a tinted quote with its kind, and a plain quote stays a quote", () => {
    const html = renderMarkdown("> [!NOTE]\n> Ask **first**.\n\n> Just a quote")
    const host = document.createElement("div")
    host.innerHTML = html
    const callout = host.querySelector("blockquote.md-callout")
    expect(callout?.getAttribute("data-callout")).toBe("note")
    expect(callout?.textContent?.trim()).toBe("Ask first.")
    expect(callout?.querySelector("strong")).toBeTruthy()
    expect(host.querySelectorAll("blockquote").length).toBe(2)
    expect(host.textContent).not.toContain("[!NOTE]")
  })
})

describe("picture widths", () => {
  it("reads and writes the width in the token's alt text", () => {
    expect(fileRef(ID, "medium")).toBe(`![width=50%](liaison-file:${ID})`)
    expect(fileRef(ID, "full")).toBe(`![](liaison-file:${ID})`)
    expect(imageWidthOfRef(`![width=33%](liaison-file:${ID})`)).toBe("small")
    expect(imageWidthOfRef(`![width=75%](liaison-file:${ID})`)).toBe("large")
    expect(imageWidthOfRef(`![a photo](liaison-file:${ID})`)).toBe("full")
  })

  it("the editor keeps a picture's width, and a width set on it is written", () => {
    const md = `Intro\n\n![width=50%](liaison-file:${ID})`
    const { handle, editor } = mount(md)
    expect(handle.markdown()).toBe(md)
    let pos = -1
    editor.state.doc.descendants((n, p) => {
      if (n.type.name === "liaisonFile") pos = p
    })
    editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "width", "small"))
    expect(handle.markdown()).toBe(`Intro\n\n![width=33%](liaison-file:${ID})`)
    editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "width", "full"))
    expect(handle.markdown()).toBe(`Intro\n\n![](liaison-file:${ID})`)
  })

  it("the reader carries the width to the picture's span", () => {
    const host = document.createElement("div")
    host.innerHTML = renderMarkdown(`![width=75%](liaison-file:${ID})`)
    const span = host.querySelector("span[data-page-file]")
    expect(span?.getAttribute("data-page-file")).toBe(ID)
    expect(span?.getAttribute("data-width")).toBe("large")
  })
})
