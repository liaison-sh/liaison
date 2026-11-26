// SPDX-License-Identifier: FSL-1.1-ALv2
// The `/` block menu of a page (S20): it opens at the start of a block or after a
// space and nowhere else, filters by name and search words in the reader's language,
// is driven from the keyboard with the caret kept in the text, and each block it
// inserts is written as markdown that opens again as the same text. Checklists tick
// in place (mouse or Mod-Enter): one edit each, never in a read-only field.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { SLASH_FIXTURES } from "./__fixtures__/stored-bodies"
import { RichEditor, type RichEditorHandle, type RichEditorProps } from "./RichEditor"
import { SLASH_BLOCKS, type SlashKey } from "./slash"
import { editorOf, typeInto } from "./test-helpers"

afterEach(cleanup)

function mount(props: Partial<RichEditorProps> = {}, locale: "en" | "fr" = "en") {
  const onChange = vi.fn()
  const onEdit = vi.fn()
  let handle: RichEditorHandle | undefined
  render(() => (
    <I18nProvider initialLocale={locale}>
      <RichEditor
        preset="document"
        value=""
        onChange={onChange}
        onEdit={onEdit}
        ref={(h) => {
          handle = h
        }}
        {...props}
        data-testid="field"
      />
    </I18nProvider>
  ))
  const field = screen.getByTestId("field")
  const editor = editorOf(field)
  editor.view.focus()
  editor.commands.focus("end")
  if (!handle) throw new Error("no handle")
  return { field, editor, onChange, onEdit, handle }
}

const menu = () => screen.queryByTestId("slash-suggest")
const blocks = () =>
  screen
    .queryAllByTestId("slash-suggest-item")
    .map((el) => el.querySelector("[data-block]")?.getAttribute("data-block"))
const key = (field: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(field, { key: k, ...init })

describe("where `/` opens the menu", () => {
  it("at the start of a block and after a space", () => {
    const { editor } = mount()
    typeInto(editor, "/")
    expect(menu()).not.toBeNull()
    typeInto(editor, "qqq ")
    expect(menu()).toBeNull()
    typeInto(editor, "/")
    expect(menu()).not.toBeNull()
  })

  it("not in an address, a path, a date or code", () => {
    for (const text of ["https://", "a/", "24/"]) {
      const { editor } = mount()
      typeInto(editor, text)
      expect(menu(), text).toBeNull()
      cleanup()
    }
    const code = mount({ value: "```\nx\n```" })
    code.editor.commands.setTextSelection(2)
    typeInto(code.editor, " /")
    expect(menu()).toBeNull()
    cleanup()
    const inline = mount({ value: "`ab`" })
    inline.editor.commands.setTextSelection(2)
    typeInto(inline.editor, " /")
    expect(menu()).toBeNull()
  })

  it("only in a page: a message or a task has no block menu", () => {
    const { editor } = mount({ preset: "full" })
    typeInto(editor, "/")
    expect(menu()).toBeNull()
  })

  it("never in a field that cannot be edited", () => {
    const { editor } = mount({ disabled: true })
    editor.commands.insertContent("/")
    expect(menu()).toBeNull()
  })
})

describe("what the menu offers", () => {
  it("image, file and page link only where the page has them", () => {
    const { editor } = mount()
    typeInto(editor, "/")
    expect(blocks()).not.toContain("image")
    expect(blocks()).not.toContain("file")
    expect(blocks()).not.toContain("linkToPage")
    cleanup()
    const withAll = mount({
      files: {
        view: null as never,
        upload: async () => "f1",
        onRefused: () => {},
        unreadable: "",
        uploading: (n) => n,
      },
      pages: {
        link: { watch: () => () => {}, open: () => {}, labels: { unavailable: "", loading: "" } },
        pick: async () => [],
      },
    })
    typeInto(withAll.editor, "/")
    expect(blocks()).toEqual(SLASH_BLOCKS.map((b) => b.key))
  })

  it("filters by name and search words; nothing found closes it", () => {
    const { editor } = mount()
    typeInto(editor, "/head")
    expect(blocks()).toEqual(["heading1", "heading2", "heading3"])
    cleanup()
    const todo = mount()
    typeInto(todo.editor, "/todo")
    expect(blocks()).toEqual(["taskList"])
    typeInto(todo.editor, "zzz")
    expect(menu()).toBeNull()
  })

  it("takes the words a Notion user types: /to-do, /callout", () => {
    const { editor } = mount()
    typeInto(editor, "/to-do")
    expect(blocks()).toEqual(["taskList"])
    cleanup()
    const callout = mount()
    typeInto(callout.editor, "/callout")
    expect(blocks()).toEqual(["quote"])
  })

  it("in French, by French words, accents optional", () => {
    const { editor } = mount({}, "fr")
    typeInto(editor, "/tache")
    expect(blocks()).toEqual(["taskList"])
    expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe("Blocs")
    expect(screen.getByText("Liste de tâches")).toBeTruthy()
  })
})

describe("the keyboard and screen readers", () => {
  it("arrows move the active option the text field points at; Enter picks", () => {
    const { editor, field, handle } = mount()
    typeInto(editor, "/")
    const list = screen.getByRole("listbox")
    expect(field.getAttribute("aria-controls")).toBe(list.id)
    expect(field.getAttribute("aria-expanded")).toBe("true")
    key(field, "ArrowDown")
    const active = field.getAttribute("aria-activedescendant")
    expect(active && document.getElementById(active)?.textContent).toContain("Heading 1")
    key(field, "Enter")
    expect(menu()).toBeNull()
    expect(field.hasAttribute("aria-controls")).toBe(false)
    typeInto(editor, "Title")
    expect(handle.markdown()).toBe("# Title")
  })

  it("after a word, Enter stays prose: `km /h` then Enter is a new line, not a heading", () => {
    const { editor, field, handle } = mount()
    typeInto(editor, "50 km /h")
    expect(menu()).not.toBeNull()
    key(field, "Enter")
    expect(menu()).toBeNull()
    expect(handle.markdown()).toContain("50 km /h")
    expect(handle.markdown()).not.toMatch(/^#/)
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph")
  })

  it("after a word, Enter picks once an arrow chose the block", () => {
    const { editor, field, handle } = mount()
    typeInto(editor, "Note /")
    key(field, "ArrowDown")
    key(field, "Enter")
    expect(menu()).toBeNull()
    expect(handle.markdown()).toBe("# Note")
  })

  it("at the start of a block, Enter picks what was typed", () => {
    const { editor, field, handle } = mount()
    typeInto(editor, "/heading 2")
    key(field, "Enter")
    typeInto(editor, "Plan")
    expect(handle.markdown()).toBe("## Plan")
  })

  it("Escape closes it and it stays closed for that slash", () => {
    const { editor, field, handle } = mount()
    typeInto(editor, "/he")
    key(field, "Escape")
    expect(menu()).toBeNull()
    typeInto(editor, "a")
    expect(menu()).toBeNull()
    expect(handle.markdown()).toBe("/hea")
  })

  it("a click picks without taking the caret from the text", () => {
    const { editor, handle } = mount()
    typeInto(editor, "/quo")
    const item = screen.getAllByTestId("slash-suggest-item")[0]!
    fireEvent.mouseDown(item)
    typeInto(editor, "Said")
    expect(handle.markdown()).toBe("> Said")
  })
})

/** Insert `block` from the menu in an empty page, then type `text` in it. */
function insert(block: SlashKey, text: string): string {
  const { editor, field, handle } = mount()
  typeInto(editor, "/")
  const i = SLASH_BLOCKS.filter((b) => !b.available).findIndex((b) => b.key === block)
  for (let n = 0; n < i; n++) key(field, "ArrowDown")
  key(field, "Enter")
  if (text) typeInto(editor, text)
  const out = handle.markdown()
  cleanup()
  return out
}

describe("each block is stored as markdown and reads back the same", () => {
  const typed: Record<string, string> = {
    text: "Plain words",
    heading1: "Big",
    heading2: "Medium",
    heading3: "Small",
    taskList: "Call the carrier",
    bulletList: "One",
    orderedList: "First",
    quote: "Said",
    codeBlock: "const a = 1",
    table: "",
    divider: "",
  }
  for (const block of SLASH_BLOCKS.filter((b) => !b.available)) {
    it(block.key, () => {
      const out = insert(block.key, typed[block.key] ?? "")
      expect(out).toBe(SLASH_FIXTURES[block.key])
      // Opened again: the same text, written back byte for byte.
      const again = mount({ value: out })
      expect(again.handle.roundTrips).toBe(true)
      expect(again.handle.markdown()).toBe(out)
      again.editor.commands.focus("end")
      typeInto(again.editor, "")
      expect(again.handle.markdown()).toBe(out)
    })
  }
})

describe("checklists tick in place", () => {
  const LIST = "- [ ] Call the carrier\n- [ ] Pack the order"

  it("a click ticks the box: one edit, stored as [x]", () => {
    const { field, onEdit, handle } = mount({ value: LIST })
    const boxes = field.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(boxes.length).toBe(2)
    expect(boxes[0]!.getAttribute("aria-label")).toBe("Done: Call the carrier")
    fireEvent.click(boxes[0]!)
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(handle.markdown()).toBe("- [x] Call the carrier\n- [ ] Pack the order")
  })

  it("Mod-Enter ticks the item where the caret is, and again unticks it", () => {
    const { editor, field, onEdit, handle } = mount({ value: LIST })
    editor.commands.setTextSelection(6)
    key(field, "Enter", { ctrlKey: true })
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(handle.markdown()).toBe("- [x] Call the carrier\n- [ ] Pack the order")
    key(field, "Enter", { metaKey: true })
    expect(handle.markdown()).toBe(LIST)
  })

  it("outside a page, Mod-Enter sends: a task discussion or ticket note never ticks", () => {
    const onSubmit = vi.fn()
    const { editor, field, onEdit, handle } = mount({ preset: "full", value: LIST, onSubmit })
    editor.commands.setTextSelection(6)
    key(field, "Enter", { ctrlKey: true })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onEdit).not.toHaveBeenCalled()
    expect(handle.markdown()).toBe(LIST)
  })

  it("a field that cannot be edited does not tick, by mouse or key", () => {
    const { editor, field, onEdit, handle } = mount({ value: LIST, disabled: true })
    const box = field.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    fireEvent.click(box)
    editor.commands.setTextSelection(6)
    key(field, "Enter", { ctrlKey: true })
    expect(onEdit).not.toHaveBeenCalled()
    expect(handle.markdown()).toBe(LIST)
    expect(editor.state.doc.firstChild?.firstChild?.attrs.checked).toBe(false)
  })

  it("in French the box says so", () => {
    const { field } = mount({ value: LIST }, "fr")
    const box = field.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(box.getAttribute("aria-label")).toBe("Fait : Call the carrier")
  })
})
