// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { Editor } from "@tiptap/core"
import { createSignal } from "solid-js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { TOOLBAR_LAYOUT, toolbarFit } from "./EditorToolbar"
import { type EditorPreset, editorExtensions } from "./extensions"
import { RichEditor, type RichEditorHandle, type RichEditorProps } from "./RichEditor"
import { editorOf, typeInto } from "./test-helpers"

function mount(props: Partial<RichEditorProps> & { value?: string }) {
  const onChange = vi.fn()
  const [value, setValue] = createSignal(props.value ?? "")
  render(() => (
    <RichEditor
      preset="full"
      {...props}
      value={value()}
      onChange={(md) => {
        onChange(md)
        props.onChange?.(md)
      }}
      data-testid="field"
    />
  ))
  const field = screen.getByTestId("field")
  return { field, editor: editorOf(field), onChange, setValue }
}

const key = (field: HTMLElement, k: string, mods: KeyboardEventInit = {}) =>
  fireEvent.keyDown(field, { key: k, ctrlKey: true, ...mods })

describe("RichEditor: markdown in and out", () => {
  const STORED = [
    "## Relancer Cribbs",
    "",
    "Le taux est de **30,22 %**, soit ++42 convertis++ sur _139_ inscrits.",
    "",
    "- [ ] Vérifier le registre",
    "- [x] Envoyer le rapport",
    "",
    "1. un",
    "2. deux",
    "   - imbriqué",
    "",
    "> citation",
    "",
    "En C++ et C++, `a ++b++` reste du code.",
    "",
    "Voir @[Spec v0.7](knowledge:source_link:abc) et https://exemple.fr/un/très/long/chemin",
  ].join("\n")

  it("shows formatting, never the markers", () => {
    const { field } = mount({ value: STORED })
    expect(field.querySelector("h2")?.textContent).toBe("Relancer Cribbs")
    expect(field.querySelector("strong")?.textContent).toBe("30,22 %")
    expect(field.querySelector("u")?.textContent).toBe("42 convertis")
    expect(field.querySelectorAll('ul[data-type="taskList"] > li')).toHaveLength(2)
    expect(field.querySelector('li[data-checked="true"]')?.textContent).toContain("Envoyer")
    expect(field.querySelector(".mention-pill")?.getAttribute("data-mention-ref")).toBe(
      "knowledge:source_link:abc",
    )
    expect(field.textContent).not.toMatch(/\*\*|\+\+42|\[ \]/)
    expect(field.querySelectorAll("u")).toHaveLength(1)
  })

  it("writes the same markdown back, underline, checklist and mention included", () => {
    const { editor } = mount({ value: "" })
    editor.commands.setContent(STORED.replace("_139_", "*139*"), { contentType: "markdown" })
    expect(editor.getMarkdown()).toBe(STORED.replace("_139_", "*139*"))
  })

  it("hands back the stored string untouched while nothing was edited", () => {
    const { editor, onChange } = mount({ value: STORED })
    // A no-op transaction (a selection move) followed by an edit undone.
    editor.commands.insertContent("x")
    editor.commands.undo()
    expect(onChange).toHaveBeenLastCalledWith(STORED)
    editor.commands.insertContentAt(1, "À ")
    // Only the heading was edited: the paragraph keeps its `_139_`.
    expect(onChange).toHaveBeenLastCalledWith(STORED.replace("## ", "## À "))
  })

  it("keeps an agent's table verbatim through an edit elsewhere", () => {
    const table = "| Hub | Inscrits |\n|-----|---------:|\n| Cribbs | 139 |"
    const { field, editor, onChange } = mount({ value: `Avant\n\n${table}\n\nAprès` })
    expect(field.querySelector("table td")?.textContent).toBe("Cribbs")
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " !")
    expect(onChange).toHaveBeenLastCalledWith(`Avant\n\n${table}\n\nAprès !`)
  })

  it("keeps a one-line field's leading number as text", () => {
    const { field, editor, onChange } = mount({
      preset: "inline",
      value: "1. Préparer **la** démo",
    })
    expect(field.querySelector("ol")).toBeNull()
    expect(field.querySelector("strong")?.textContent).toBe("la")
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " !")
    expect(onChange).toHaveBeenLastCalledWith("1. Préparer **la** démo !")
  })

  it("writes <, > and & as typed, escaping only what would change meaning", () => {
    const line = mount({ preset: "inline", value: "> cité" })
    expect(line.field.querySelector("blockquote")).toBeNull()
    line.editor.commands.insertContentAt(line.editor.state.doc.content.size - 1, " & co")
    expect(line.onChange).toHaveBeenLastCalledWith("> cité & co")
    line.editor.destroy()
    const block = mount({ value: "" })
    typeInto(block.editor, ">x a > b & c <b> &amp;")
    expect(block.onChange).toHaveBeenLastCalledWith("\\>x a > b & c &lt;b> &amp;amp;")
  })

  it("loads a new value from outside (a reset after sending)", () => {
    const { field, setValue } = mount({ value: "brouillon" })
    setValue("")
    expect(field.textContent).toBe("")
  })
})

describe("RichEditor: shortcuts and typed markdown", () => {
  it("Mod-B, Mod-I, Mod-U toggle marks on the selection", () => {
    const { field, editor, onChange } = mount({ value: "mot" })
    editor.commands.selectAll()
    key(field, "b")
    key(field, "i")
    key(field, "u")
    expect(onChange).toHaveBeenLastCalledWith("***++mot++***")
  })

  it("Mod-Shift-X and Mod-Shift-S both toggle strikethrough", () => {
    const { field, editor, onChange } = mount({ value: "mot" })
    editor.commands.selectAll()
    key(field, "x", { shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith("~~mot~~")
    key(field, "x", { shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith("mot")
    key(field, "s", { shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith("~~mot~~")
  })

  it("Mod-Shift-8, 7 and 9 make bulleted, numbered and checklists", () => {
    const { field, editor, onChange } = mount({ value: "point" })
    editor.commands.focus("end")
    key(field, "8", { shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith("- point")
    key(field, "8", { shiftKey: true })
    key(field, "7", { shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith("1. point")
    key(field, "7", { shiftKey: true })
    key(field, "9", { shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith("- [ ] point")
  })

  it("converts typed markdown as you go", () => {
    const { editor, onChange } = mount({ value: "" })
    typeInto(editor, "Soit **gras** et ++souligné++ et _penché_ ")
    expect(onChange).toHaveBeenLastCalledWith("Soit **gras** et ++souligné++ et *penché*")
    expect(editor.view.dom.textContent).toBe("Soit gras et souligné et penché ")
  })

  it("starts a list or a checklist from its typed marker", () => {
    const bullets = mount({ value: "" })
    typeInto(bullets.editor, "- un")
    expect(bullets.onChange).toHaveBeenLastCalledWith("- un")
    bullets.editor.destroy()
    const tasks = mount({ value: "" })
    typeInto(tasks.editor, "[ ] à faire")
    expect(tasks.onChange).toHaveBeenLastCalledWith("- [ ] à faire")
  })

  it("inline: Enter submits, Escape cancels, no line is ever added", () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const { field, editor } = mount({ preset: "inline", value: "titre", onSubmit, onCancel })
    editor.commands.focus("end")
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(field, { key: "Escape" })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(editor.getMarkdown()).toBe("titre")
  })

  it("Mod-Enter submits a multi-line field", () => {
    const onSubmit = vi.fn()
    const { field, editor } = mount({ value: "commentaire", onSubmit })
    editor.commands.focus("end")
    key(field, "Enter")
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("Mod-K links the selection through the link row", async () => {
    const { field, editor, onChange } = mount({ value: "la spec" })
    editor.commands.setTextSelection({ from: 4, to: 8 })
    key(field, "k")
    const input = (await screen.findByTestId("rich-editor.link-input")) as HTMLInputElement
    fireEvent.input(input, { target: { value: "exemple.fr/spec" } })
    fireEvent.click(screen.getByTestId("rich-editor.link-apply"))
    expect(onChange).toHaveBeenLastCalledWith("la [spec](https://exemple.fr/spec)")
    await waitFor(() => expect(screen.queryByTestId("rich-editor.link-input")).toBeNull())
  })

  it("closing the link row hands focus straight back to the text, not to the page", async () => {
    const onBlur = vi.fn()
    const { field, editor } = mount({ value: "la spec", onBlur })
    for (const close of ["apply", "escape"] as const) {
      editor.commands.setTextSelection({ from: 4, to: 8 })
      key(field, "k")
      const input = (await screen.findByTestId("rich-editor.link-input")) as HTMLInputElement
      input.focus()
      fireEvent.input(input, { target: { value: "exemple.fr" } })
      if (close === "apply") {
        // Enter is consumed by the row: left to the browser, it would reach the
        // text (focused again by then) and replace the linked words.
        expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false)
        expect(editor.getMarkdown()).toBe("la [spec](https://exemple.fr)")
      } else fireEvent.keyDown(input, { key: "Escape" })
      // At once: a field that saves on blur (a task description) would close.
      expect(document.activeElement).toBe(editor.view.dom)
    }
    expect(onBlur).not.toHaveBeenCalled()
  })

  it("a focus toolbar folds only once the press that moved focus is released", async () => {
    const { field } = mount({ value: "commentaire", toolbar: "focus" })
    fireEvent.focusIn(field)
    expect(screen.getByTestId("rich-editor.toolbar")).toBeTruthy()
    fireEvent.pointerDown(document.body)
    fireEvent.focusOut(field)
    // Still there while the pointer is down: the layout does not move under it.
    expect(screen.queryByTestId("rich-editor.toolbar")).not.toBeNull()
    fireEvent.pointerUp(document.body)
    await waitFor(() => expect(screen.queryByTestId("rich-editor.toolbar")).toBeNull())
  })

  it("the toolbar buttons format too", () => {
    const { editor, onChange } = mount({ value: "mot" })
    editor.commands.selectAll()
    fireEvent.click(screen.getByTestId("rich-editor.tool-underline"))
    expect(onChange).toHaveBeenLastCalledWith("++mot++")
    expect(screen.getByTestId("rich-editor.tool-underline").getAttribute("aria-pressed")).toBe(
      "true",
    )
  })

  it("drops a pasted file the surface does not take, leaving the text untouched", () => {
    const { field, onChange } = mount({ value: "texte" })
    const image = new File(["png"], "image.png", { type: "image/png" })
    fireEvent.paste(field, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => image }],
        // What Safari puts beside a copied image: its name as plain text.
        types: ["Files", "text/plain"],
        getData: (type: string) => (type === "text/plain" ? "image.png" : ""),
      },
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(field.textContent).toBe("texte")
  })

  it("reads pasted plain text as markdown, and lets the surface take pasted files", () => {
    const onPaste = vi.fn((e: ClipboardEvent) => e.preventDefault())
    const { field, onChange } = mount({ value: "", onPaste })
    const files = { types: ["Files"], getData: () => "" }
    fireEvent.paste(field, { clipboardData: files })
    expect(onPaste).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()

    onPaste.mockImplementation(() => {})
    fireEvent.paste(field, {
      clipboardData: { types: ["text/plain"], getData: () => "**gras** et ++souligné++" },
    })
    expect(field.querySelector("strong")?.textContent).toBe("gras")
    expect(onChange).toHaveBeenLastCalledWith("**gras** et ++souligné++")
  })
})

describe("RichEditor: documents", () => {
  const TABLE = [
    "| Hub | CA | Note |",
    "| --- | ---: | :--: |",
    "| Cribbs | 30,22 % | a \\| b |",
    "| **Lyon** | `x \\| y` | @[Spec](knowledge:document:abc) |",
  ].join("\n")

  it("edits an agent's table as a table and writes it back as one", () => {
    const { field, editor, onChange } = mount({ preset: "document", value: `Avant\n\n${TABLE}` })
    expect(field.querySelector(".tableWrapper table")).not.toBeNull()
    const cells = Array.from(field.querySelectorAll("td")).map((td) => td.textContent)
    expect(cells).toEqual(["Cribbs", "30,22 %", "a | b", "Lyon", "x | y", "#Spec"])
    // Type at the end of the first body cell.
    let end = 0
    editor.state.doc.descendants((node, pos) => {
      if (!end && node.type.name === "tableCell") end = pos + node.nodeSize - 2
    })
    editor.chain().setTextSelection(end).insertContent(" Causeway").run()
    expect(onChange).toHaveBeenLastCalledWith(
      [
        "Avant",
        "",
        "| Hub             | CA       | Note                            |",
        "| --------------- | --------: | :-------------------------------: |",
        "| Cribbs Causeway | 30,22 %  | a \\| b                          |",
        "| **Lyon**        | `x \\| y` | @[Spec](knowledge:document:abc) |",
      ].join("\n"),
    )
  })

  it("adds and deletes rows and columns from the table menu", async () => {
    const { field, editor, onChange } = mount({
      preset: "document",
      value: "| a | b |\n|---|---|\n| 1 | 2 |",
    })
    editor.commands.setTextSelection(4)
    await waitFor(() =>
      expect(screen.getByTestId("rich-editor.tool-table").getAttribute("aria-haspopup")).toBe(
        "true",
      ),
    )
    const act = async (action: string) => {
      fireEvent.keyDown(screen.getByTestId("rich-editor.tool-table"), { key: "ArrowDown" })
      fireEvent.keyDown(await screen.findByTestId(`rich-editor.table-${action}`), { key: "Enter" })
      // Back in the text at once, not once the menu has faded: keys typed
      // meanwhile went to the menu.
      expect(document.activeElement).toBe(editor.view.dom)
      await waitFor(() => expect(screen.queryByTestId("rich-editor.table-menu")).toBeNull())
    }
    await act("addRowAfter")
    expect(field.querySelectorAll("tr")).toHaveLength(3)
    await act("addColumnAfter")
    expect(field.querySelectorAll("tr:first-child th")).toHaveLength(3)
    expect(onChange.mock.lastCall?.[0]).toMatch(/^\| a +\| +\| b +\|\n/)
    await act("deleteColumn")
    await act("deleteRow")
    expect(field.querySelectorAll("tr")).toHaveLength(2)
    await act("deleteTable")
    expect(field.querySelector("table")).toBeNull()
  })

  it("inserts a table from the toolbar", () => {
    const { field, onChange } = mount({ preset: "document", value: "" })
    fireEvent.click(screen.getByTestId("rich-editor.tool-table"))
    expect(field.querySelectorAll("th")).toHaveLength(3)
    expect(onChange.mock.lastCall?.[0]).toMatch(/^\| +\| +\| +\|\n\| -+ \| -+ \| -+ \|/)
  })

  it("keeps verbatim a table it could not write back whole", () => {
    const kept = [
      "| a | b |\n|---|---|\n| 1 | 2 | 3 |",
      "| a | b |\n|---|---|\n| ![logo](logo.png) | 2 |",
      "| a | b |\n|---|---|\n| <span>1</span> | 2 |",
    ].join("\n\n")
    const { field, editor, onChange } = mount({ preset: "document", value: `${kept}\n\nFin` })
    // Shown as read, not as an editable table.
    expect(field.querySelectorAll("table")).toHaveLength(3)
    expect(field.querySelector(".tableWrapper")).toBeNull()
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " !")
    expect(onChange).toHaveBeenLastCalledWith(`${kept}\n\nFin !`)
  })

  it("writes a table it did not edit back as it was written", () => {
    const table = "| Table | Rôle |\n|---|:-:|\n| `dwh.customer` | le membre |\n| `dwh.store` |"
    const { editor, onChange } = mount({ preset: "document", value: `${table}\n\nFin` })
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " !")
    expect(onChange).toHaveBeenLastCalledWith(`${table}\n\nFin !`)
  })

  it("reads a single newline as a soft wrap, whichever editor was made last", () => {
    const wrapped = "Une phrase coupée\nà quatre-vingts colonnes."
    const doc = mount({ preset: "document", value: wrapped })
    // Another surface's editor, made after, parses newlines as breaks.
    const other = new Editor({
      element: document.createElement("div"),
      extensions: editorExtensions("full", { keys: { onLink: () => {} } }),
    })
    expect(other.markdown?.parse("a\nb").content?.[0]?.content?.[1]?.type).toBe("hardBreak")
    doc.setValue(`${wrapped}\n\nSuite`)
    expect(doc.field.querySelector("br")).toBeNull()
    doc.editor.commands.insertContentAt(doc.editor.state.doc.content.size - 1, " !")
    expect(doc.onChange).toHaveBeenLastCalledWith(`${wrapped}\n\nSuite !`)
    other.destroy()
  })

  it("opens with the caret at the top, so the toolbar reflects the first block", () => {
    mount({ preset: "document", value: "# Titre\n\n> Une citation en fin de document" })
    expect(screen.getByTestId("rich-editor.tool-heading1").getAttribute("aria-pressed")).toBe(
      "true",
    )
    expect(screen.getByTestId("rich-editor.tool-quote").getAttribute("aria-pressed")).toBe("false")
  })

  it("offers H1 to H3", () => {
    const { editor, onChange } = mount({ preset: "document", value: "Titre" })
    editor.commands.focus("end")
    fireEvent.click(screen.getByTestId("rich-editor.tool-heading3"))
    expect(onChange).toHaveBeenLastCalledWith("### Titre")
    fireEvent.click(screen.getByTestId("rich-editor.tool-heading1"))
    expect(onChange).toHaveBeenLastCalledWith("# Titre")
  })
})

describe("RichEditor: technical text", () => {
  it("writes a `[[memory]]` link and an identifier's underscore as typed", () => {
    const { editor, onChange } = mount({ value: "" })
    typeInto(editor, "Voir [[memoire-client]] et kpi_run, pas _ seul")
    expect(onChange).toHaveBeenLastCalledWith("Voir [[memoire-client]] et kpi_run, pas \\_ seul")
  })
})

describe("RichEditor: what was not edited is written back as it was read", () => {
  // An agent's document, with what the editor would otherwise rewrite.
  const LIST = "- Le KPI se lit via `kpi_run`.\n\n  Suite du point, indentée.\n- Second point"
  const DOC = [
    "# Synthèse",
    "",
    "Taux ~30 % ce mois, <reason>source registre</reason> confirmé.",
    "",
    "Deuxième paragraphe simple.",
    "",
    LIST,
    "",
    "<details>",
    "<summary>Détail des calculs</summary>",
    "",
    "Calcul *interne* : 42 / 139.",
    "",
    "</details>",
    "",
    "| Hub | CA |",
    "|---|---:|",
    "| Cribbs | 12 450 |",
    "",
    "* étoile un",
    "* étoile deux",
    "",
    "Voir [le registre][reg].",
    "",
    "[reg]: https://kpi.example/explore",
    "",
  ].join("\n")

  const edit = (preset: EditorPreset, find: string, insert: string) => {
    const { editor, onChange } = mount({ preset, value: DOC })
    let pos = -1
    editor.state.doc.descendants((node, at) => {
      if (pos < 0 && node.isText && node.text?.includes(find)) {
        pos = at + node.text.indexOf(find) + find.length
      }
    })
    editor.commands.insertContentAt(pos, insert)
    return { editor, onChange, out: onChange.mock.lastCall?.[0] as string }
  }

  it("an edit in one paragraph changes that paragraph only, byte for byte", () => {
    for (const preset of ["document", "full"] as const) {
      const { out, editor } = edit(preset, "paragraphe", " très")
      expect(out).toBe(
        DOC.replace("Deuxième paragraphe simple.", "Deuxième paragraphe très simple."),
      )
      editor.destroy()
      cleanup()
    }
  })

  it("keeps one blank line before a checklist whose source opens with it", () => {
    const md =
      "Avant la liste,\nsur deux lignes.\n\n- [ ] **1.1** Vérifier\n  la suite.\n- [ ] **1.2** Fin\n"
    const { editor, onChange } = mount({ preset: "document", value: md })
    editor.commands.insertContentAt(1 + "Avant".length, " toute")
    expect(onChange).toHaveBeenLastCalledWith(md.replace("Avant", "Avant toute"))
  })

  it("an edit undone gives back the document byte for byte", () => {
    const { editor, onChange } = edit("document", "paragraphe", " très")
    editor.commands.undo()
    expect(onChange).toHaveBeenLastCalledWith(DOC)
  })

  it("an edit in a list item rewrites that list, nothing around it", () => {
    const { out } = edit("document", "Second point", " ajouté")
    const [before, after] = DOC.split(LIST)
    expect(out.startsWith(before!)).toBe(true)
    expect(out.endsWith(after!)).toBe(true)
    expect(out).toContain("Second point ajouté")
  })

  it("keeps HTML it cannot show as such, as text to edit, tags included", () => {
    const { editor, onChange } = mount({ preset: "document", value: DOC })
    const field = editor.view.dom
    expect(field.querySelector("pre[data-raw-html]")?.textContent).toBe(
      "<details>\n<summary>Détail des calculs</summary>",
    )
    expect(field.querySelector("span[data-raw-html]")?.textContent).toBe("<reason>")
    // An edit inside the HTML block itself, and one in the sentence holding a tag.
    const at = (find: string) => {
      let pos = -1
      editor.state.doc.descendants((node, offset) => {
        if (pos < 0 && node.isText && node.text?.includes(find)) {
          pos = offset + node.text.indexOf(find)
        }
      })
      return pos
    }
    editor.commands.insertContentAt(at("calculs"), "derniers ")
    editor.commands.insertContentAt(at("Taux"), "Le ")
    expect(onChange).toHaveBeenLastCalledWith(
      DOC.replace("Détail des calculs", "Détail des derniers calculs").replace(
        "Taux ~30 %",
        "Le Taux \\~30 %",
      ),
    )
  })
})

describe("RichEditor: a message's emphasis rules stay in messages", () => {
  it("a document field next to a message still converts _x_ at once", () => {
    mount({ preset: "minimal" })
    render(() => <RichEditor preset="full" value="" data-testid="doc" />)
    const doc = editorOf(screen.getByTestId("doc"))
    typeInto(doc, "_x_")
    expect(doc.getMarkdown()).toBe("*x*")
  })
})

describe("RichEditor: typed formatting after a line break", () => {
  for (const preset of ["full", "document", "minimal"] as const) {
    it(`${preset}: converts **x** and _x_ typed right after Shift+Enter`, () => {
      const { editor } = mount({ value: "", preset })
      typeInto(editor, "un")
      editor.commands.setHardBreak()
      typeInto(editor, "**gras** ")
      editor.commands.setHardBreak()
      typeInto(editor, "_penché_ ")
      const strong = editor.view.dom.querySelector("strong")?.textContent
      const em = editor.view.dom.querySelector("em")?.textContent
      expect([strong, em]).toEqual(["gras", "penché"])
    })
  }
})

describe("RichEditor: blank lines are stored as blank lines", () => {
  const blankLines = (editor: Editor) =>
    (editor.getJSON().content ?? []).filter((n) => n.type === "paragraph" && !n.content?.length)
      .length

  for (const preset of ["full", "document", "minimal"] as const) {
    it(`${preset}: two empty lines typed in a row are two blank lines, never &nbsp;`, () => {
      const { editor, onChange } = mount({ value: "", preset })
      typeInto(editor, "a")
      editor.commands.splitBlock()
      editor.commands.splitBlock()
      editor.commands.splitBlock()
      typeInto(editor, "b")
      const out = onChange.mock.lastCall?.[0] as string
      expect(out).toBe("a\n\n\n\n\n\nb")
      editor.destroy()
      cleanup()
      expect(blankLines(mount({ value: out, preset }).editor)).toBe(2)
    })
  }

  it("blank lines added between blocks not edited sit between them as typed", () => {
    const { editor, onChange } = mount({ value: "A\n\nB", preset: "document" })
    editor.commands.setTextSelection(2)
    editor.commands.splitBlock()
    editor.commands.splitBlock()
    expect(onChange).toHaveBeenLastCalledWith("A\n\n\n\n\n\nB")
  })

  it("blank lines typed before new text after a block not edited are kept", () => {
    const { editor, onChange } = mount({ value: "A\n\nB", preset: "document" })
    editor.commands.focus("end")
    editor.commands.splitBlock()
    editor.commands.splitBlock()
    editor.commands.splitBlock()
    typeInto(editor, "C")
    expect(onChange).toHaveBeenLastCalledWith("A\n\nB\n\n\n\n\n\nC")
  })
})

describe("RichEditor: a message's _x_ closed by the end of the line", () => {
  it("converts when the line ends, as it does before a space", () => {
    const { editor, field } = mount({ value: "", preset: "minimal" })
    typeInto(editor, "Ouvrez les _Paramètres_")
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true })
    typeInto(editor, "puis __Exporter__")
    fireEvent.keyDown(field, { key: "Enter" })
    expect(field.querySelector("em")?.textContent).toBe("Paramètres")
    expect(field.querySelector("strong")?.textContent).toBe("Exporter")
  })

  it("leaves an identifier's underscores alone", () => {
    const { editor, field } = mount({ value: "", preset: "minimal" })
    typeInto(editor, "voir snake_case_word")
    fireEvent.keyDown(field, { key: "Enter" })
    expect(field.querySelector("em")).toBeNull()
  })
})

// SK1: dictation holds the caret (or selection) from record start; the person
// may keep typing while it transcribes. What they typed must survive, and the
// dictated text lands AFTER it. A held selection is replaced only if nobody
// edited inside it meanwhile; otherwise the text goes in at its end.
describe("RichEditor: a held place while dictating", () => {
  function mountWithHandle(value: string) {
    let handle: RichEditorHandle | undefined
    render(() => (
      <RichEditor
        preset="minimal"
        value={value}
        ref={(h) => {
          handle = h
        }}
        data-testid="field"
      />
    ))
    const editor = editorOf(screen.getByTestId("field"))
    if (!handle) throw new Error("no handle")
    return { editor, handle }
  }

  it("text typed at the held caret survives, and the dictation follows it", () => {
    const { editor, handle } = mountWithHandle("Hello world")
    editor.commands.setTextSelection(6)
    const held = handle.anchor()
    typeInto(editor, "XY")
    handle.replaceText(held.range(), "D")
    held.release()
    expect(editor.getText()).toBe("HelloXYD world")
    cleanup()
  })

  it("an untouched held selection is replaced, wherever edits elsewhere moved it", () => {
    const { editor, handle } = mountWithHandle("Hello world")
    editor.commands.setTextSelection({ from: 7, to: 12 })
    const held = handle.anchor()
    editor.commands.insertContentAt(1, "Oh ")
    handle.replaceText(held.range(), "D")
    expect(editor.getText()).toBe("Oh Hello D")
    cleanup()
  })

  it("a held selection edited inside is kept: the dictation goes in at its end", () => {
    const { editor, handle } = mountWithHandle("Hello world")
    editor.commands.setTextSelection({ from: 7, to: 12 })
    const held = handle.anchor()
    editor.commands.insertContentAt(9, "ZZ")
    handle.replaceText(held.range(), "D")
    expect(editor.getText()).toBe("Hello woZZrldD")
    cleanup()
  })

  it("a held selection typed over is kept too: the dictation follows the typing", () => {
    const { editor, handle } = mountWithHandle("Hello world")
    editor.commands.setTextSelection({ from: 7, to: 12 })
    const held = handle.anchor()
    typeInto(editor, "there")
    handle.replaceText(held.range(), "D")
    expect(editor.getText()).toBe("Hello thereD")
    cleanup()
  })
})

// The task comment's toolbar sits in a ~340 px column: it scrolled sideways
// and the quote and code tools were cut off at the right edge, a fade the
// only hint. Tools that do not fit go into a "more" menu instead; nothing is
// ever clipped at 320 px and up.
describe("RichEditor: the toolbar at a narrow width", () => {
  function atWidth(px: number) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return (this as HTMLElement).getAttribute("data-testid") === "rich-editor.toolbar" ? px : 0
      },
    })
    return () => {
      if (original) Object.defineProperty(HTMLElement.prototype, "clientWidth", original)
      else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth")
    }
  }

  it("fits every preset's row at 320 px and up, the rest in the more menu", () => {
    for (const preset of ["full", "minimal", "document"] as const) {
      for (const width of [320, 340, 390, 480]) {
        const fit = toolbarFit(preset, width)
        expect(fit.width).toBeLessThanOrEqual(width)
        expect(fit.shown.length + fit.more.length).toBe(TOOLBAR_LAYOUT[preset].flat().length)
      }
    }
    expect(toolbarFit("full", 2000).more).toEqual([])
  })

  it("at 340 px the tools that do not fit are in the more menu, none scrolled out", async () => {
    const restore = atWidth(340)
    try {
      mount({ value: "Hello", toolbar: "always" })
      const bar = await screen.findByTestId("rich-editor.toolbar")
      expect(bar.className).not.toContain("overflow-x-auto")
      await waitFor(() => expect(screen.getByTestId("rich-editor.more")).toBeInTheDocument())
      const shown = toolbarFit("full", 340).shown
      for (const key of shown) expect(screen.getByTestId(`rich-editor.tool-${key}`)).toBeTruthy()
      for (const key of toolbarFit("full", 340).more) {
        expect(screen.queryByTestId(`rich-editor.tool-${key}`)).toBeNull()
      }
      expect(toolbarFit("full", 340).more).toEqual(expect.arrayContaining(["quote", "code"]))
    } finally {
      restore()
      cleanup()
    }
  })

  it("an unmeasured row (no layout) shows every tool and no more menu", async () => {
    mount({ value: "Hello", toolbar: "always" })
    await screen.findByTestId("rich-editor.toolbar")
    expect(screen.getByTestId("rich-editor.tool-quote")).toBeTruthy()
    expect(screen.queryByTestId("rich-editor.more")).toBeNull()
    cleanup()
  })
})

describe("RichEditor: pasted Liaison links", () => {
  beforeEach(() => {
    resetRegistry()
    registerTabType("projects:task", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/projects/tasks/:entityId",
      defaultLabel: "Task",
      referenceable: true,
    })
  })

  const pasteText = (field: HTMLElement, text: string) =>
    fireEvent.paste(field, { clipboardData: { types: ["text/plain"], getData: () => text } })

  it("turns a pasted task address of this server into an entity chip", () => {
    const { field, onChange } = mount({ preset: "minimal", value: "" })
    pasteText(field, `${window.location.origin}/projects/tasks/t-1`)
    expect(field.querySelector('[data-mention-ref="projects:task:t-1"]')).not.toBeNull()
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining("(projects:task:t-1)"))
  })

  it("never turns a crafted address into a hidden person mention", () => {
    const { field, onChange } = mount({ preset: "minimal", value: "" })
    const boss = "0d6f1c2e-6c1a-4c55-9a51-1f0c8c1f2b3a"
    pasteText(field, `${window.location.origin}/projects/tasks/x)@[Boss](user:${boss}`)
    expect(field.querySelector("[data-mention-ref]")).toBeNull()
    const md = String(onChange.mock.lastCall?.[0] ?? "")
    expect(md).not.toMatch(/@\[[^\]]*\]\(user:/)
  })

  it("writes a chip whose reference is not a reference as its plain label", () => {
    const { editor, onChange } = mount({ preset: "minimal", value: "" })
    const boss = "0d6f1c2e-6c1a-4c55-9a51-1f0c8c1f2b3a"
    editor.commands.insertContent({
      type: "mention",
      attrs: { label: "Task", ref: `projects:task:x)@[Boss](user:${boss}` },
    })
    const md = String(onChange.mock.lastCall?.[0] ?? "")
    expect(md).not.toContain("user:")
    expect(md).toContain("Task")
  })

  it("keeps another server's address a plain link", () => {
    const { field, onChange } = mount({ preset: "minimal", value: "" })
    pasteText(field, "https://elsewhere.example/projects/tasks/t-1")
    expect(field.querySelector("[data-mention-ref]")).toBeNull()
    expect(onChange).toHaveBeenLastCalledWith("https://elsewhere.example/projects/tasks/t-1")
  })
})
