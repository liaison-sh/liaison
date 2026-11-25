// SPDX-License-Identifier: FSL-1.1-ALv2
// Links to other pages in the page editor: `@` and `[[` open a picker of pages the
// writer may read, a pick stores the id-only token, chips show the title the
// resolver answers, and a page the writer cannot open is a neutral chip whose title
// is nowhere in the DOM. Other presets keep their mention chips as they were.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PickedPage } from "./PageSuggest"
import type { PageLinkDeps, PageLinkTitle } from "./page-link-view"
import { type EditorPages, RichEditor, type RichEditorProps } from "./RichEditor"
import { editorOf, typeInto } from "./test-helpers"

afterEach(cleanup)

const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"
const SECRET = "33333333-3333-4333-8333-333333333333"
const PAGES: PickedPage[] = [
  { id: A, title: "Return procedure" },
  { id: B, title: "Returns policy" },
]

/** A resolver: `titles` names what the writer may read; anything else is null. */
function pagesDeps(titles: Record<string, string> = { [A]: "Return procedure" }) {
  const watchers = new Map<string, Set<(t: PageLinkTitle) => void>>()
  const open = vi.fn()
  const pick = vi.fn(async (q: string) =>
    PAGES.filter((p) => p.title.toLowerCase().includes(q.toLowerCase())),
  )
  const link: PageLinkDeps = {
    watch: (id, fn) => {
      const set = watchers.get(id) ?? new Set()
      watchers.set(id, set)
      set.add(fn)
      fn(id in titles ? titles[id] : null)
      return () => set.delete(fn)
    },
    open,
    labels: { unavailable: "Page you cannot open", loading: "Page link" },
  }
  const rename = (id: string, title: string) => {
    titles[id] = title
    for (const fn of watchers.get(id) ?? []) fn(title)
  }
  return { pages: { link, pick } satisfies EditorPages, open, pick, rename }
}

function mount(props: Partial<RichEditorProps> = {}) {
  const onChange = vi.fn()
  render(() => (
    <RichEditor preset="document" value="" onChange={onChange} {...props} data-testid="field" />
  ))
  const field = screen.getByTestId("field")
  const editor = editorOf(field)
  editor.view.focus()
  editor.commands.focus("end")
  return { field, editor, onChange }
}

const picker = () => screen.queryByTestId("page-suggest")
const items = () => screen.queryAllByTestId("page-suggest-item")
const press = (field: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(field, { key, ...init })

describe("page picker", () => {
  it("`[[` opens at word start only, Escape closes and stays closed", async () => {
    const { pages, pick } = pagesDeps()
    const { editor, field } = mount({ pages })
    typeInto(editor, "word[[ret")
    expect(picker()).toBeNull()
    typeInto(editor, " [[ret")
    await waitFor(() => expect(items().length).toBe(2))
    expect(pick).toHaveBeenLastCalledWith("ret")
    press(field, "Escape")
    expect(picker()).toBeNull()
    typeInto(editor, "u")
    expect(picker()).toBeNull()
    // A new trigger opens it again.
    typeInto(editor, " [[r")
    await waitFor(() => expect(items().length).toBe(2))
  })

  it("`@` opens at word start, never inside an address", async () => {
    const { pages } = pagesDeps()
    const { editor } = mount({ pages })
    typeInto(editor, "write to ana@site")
    await new Promise((r) => setTimeout(r, 200))
    expect(picker()).toBeNull()
    typeInto(editor, " @Ret")
    await waitFor(() => expect(items().length).toBe(2))
  })

  it("Enter picks the active page: the text holds the id only, never the title", async () => {
    const { pages } = pagesDeps()
    const { editor, field, onChange } = mount({ pages })
    typeInto(editor, "See @ret")
    await waitFor(() => expect(items().length).toBe(2))
    press(field, "ArrowDown")
    press(field, "ArrowUp")
    press(field, "Enter")
    expect(picker()).toBeNull()
    const md = onChange.mock.calls.at(-1)?.[0] as string
    expect(md).toBe(`See [](knowledge:document:${A})`)
    expect(md).not.toContain("Return")
    // The chip shows the title the resolver gave.
    const chip = field.querySelector<HTMLElement>("[data-page-link]")
    expect(chip?.textContent).toBe("Return procedure")
  })

  it("points screen readers at the active option", async () => {
    const { pages } = pagesDeps()
    const { editor, field } = mount({ pages })
    typeInto(editor, "[[re")
    await waitFor(() => expect(items().length).toBe(2))
    const listbox = screen.getByRole("listbox")
    expect(field.getAttribute("aria-controls")).toBe(listbox.id)
    expect(field.getAttribute("aria-expanded")).toBe("true")
    press(field, "ArrowDown")
    const active = field.getAttribute("aria-activedescendant")
    expect(active).toBe(items()[1]?.id)
    expect(items()[1]?.getAttribute("aria-selected")).toBe("true")
    press(field, "Escape")
    expect(field.hasAttribute("aria-activedescendant")).toBe(false)
  })

  it("words after `@` that name no page close the list", async () => {
    const { pages } = pagesDeps()
    const { editor } = mount({ pages })
    typeInto(editor, "@zz")
    await waitFor(() => expect(screen.queryByTestId("page-suggest-empty")).not.toBeNull())
    typeInto(editor, " top")
    await waitFor(() => expect(picker()).toBeNull())
  })

  it("does not open without page links (another surface) or inside code", async () => {
    const a = mount({ preset: "full" })
    typeInto(a.editor, "[[re @re")
    await new Promise((r) => setTimeout(r, 200))
    expect(picker()).toBeNull()
    cleanup()
    const { pages } = pagesDeps()
    const b = mount({ pages })
    b.editor.commands.setCodeBlock()
    typeInto(b.editor, "[[re")
    await new Promise((r) => setTimeout(r, 200))
    expect(picker()).toBeNull()
  })

  it("keeps the emoji picker and Cmd-K's link row", async () => {
    const { pages } = pagesDeps()
    const { editor, field } = mount({ pages })
    typeInto(editor, "hi :sm")
    expect(screen.queryByTestId("emoji-suggest")).not.toBeNull()
    press(field, "Enter")
    expect(editor.getText()).toContain("😄")
    press(field, "k", { ctrlKey: true })
    expect(await screen.findByTestId("rich-editor.link-input")).not.toBeNull()
    expect(picker()).toBeNull()
  })
})

describe("page link chips", () => {
  it("a page the writer cannot open is a neutral chip, its title nowhere in the DOM", () => {
    const { pages } = pagesDeps()
    const body = `Ask @[Secret plan](knowledge:document:${SECRET}) or [Secret plan](knowledge:document:${SECRET}) or [](knowledge:document:${SECRET})`
    const { field } = mount({ pages, value: body })
    const chips = field.querySelectorAll<HTMLElement>("[data-page-link]")
    expect(chips.length).toBe(3)
    for (const chip of chips) {
      expect(chip.textContent).toBe("Page you cannot open")
      expect(chip.dataset.state).toBe("unavailable")
      expect(chip.hasAttribute("title")).toBe(false)
    }
    expect(document.body.innerHTML).not.toContain("Secret")
    expect(field.querySelector("[title]")).toBeNull()
  })

  it("a label with balanced brackets never reaches the DOM", () => {
    const { pages } = pagesDeps()
    const body = `See @[Q3 [draft] Zephyr](knowledge:document:${SECRET}) now`
    const { field } = mount({ pages, value: body })
    expect(field.querySelectorAll("[data-page-link]").length).toBe(1)
    expect(document.body.innerHTML).not.toContain("Zephyr")
    expect(document.body.innerHTML).not.toContain("draft")
  })

  it("an agent's token round-trips byte for byte", () => {
    const { pages } = pagesDeps()
    const body = `# Notes\n\nSee [](knowledge:document:${A}) and [](knowledge:document:${SECRET}).\n\n- item [](knowledge:document:${B})\n`
    let handle: { markdown: () => string; roundTrips: boolean } | undefined
    const { editor, onChange } = mount({
      pages,
      value: body,
      ref: (h) => {
        handle = h
      },
    })
    expect(handle?.roundTrips).toBe(true)
    expect(handle?.markdown()).toBe(body)
    // An edit elsewhere keeps the tokens as they were.
    editor.commands.setTextSelection(3)
    typeInto(editor, "X")
    const md = onChange.mock.calls.at(-1)?.[0] as string
    expect(md).toContain(`See [](knowledge:document:${A}) and [](knowledge:document:${SECRET}).`)
    expect(md).toContain(`- item [](knowledge:document:${B})`)
  })

  it("an edited block writes a labelled link as the bare token", () => {
    const { pages } = pagesDeps()
    const { editor, onChange } = mount({
      pages,
      value: `See @[Secret](knowledge:document:${SECRET})`,
    })
    editor.commands.setTextSelection(1)
    typeInto(editor, "Y")
    expect(onChange.mock.calls.at(-1)?.[0]).toBe(`YSee [](knowledge:document:${SECRET})`)
  })

  it("a rename updates the chip; a click on it opens the page", () => {
    const { pages, rename, open } = pagesDeps()
    const { field } = mount({ pages, value: `[](knowledge:document:${A})` })
    const chip = field.querySelector<HTMLElement>("[data-page-link]")!
    expect(chip.textContent).toBe("Return procedure")
    rename(A, "Returns, the procedure")
    expect(chip.textContent).toBe("Returns, the procedure")
    fireEvent.click(chip)
    expect(open).toHaveBeenCalledWith(A, "Returns, the procedure")
  })

  it("a click on a neutral chip opens nothing", () => {
    const { pages, open } = pagesDeps()
    const { field } = mount({ pages, value: `[](knowledge:document:${SECRET})` })
    fireEvent.click(field.querySelector<HTMLElement>("[data-page-link]")!)
    expect(open).not.toHaveBeenCalled()
  })

  it("other presets keep a knowledge mention as the mention it was", () => {
    const value = `See @[Spec](knowledge:document:${A})`
    const { field, editor } = mount({ preset: "full", value })
    expect(field.querySelector("[data-page-link]")).toBeNull()
    expect(field.querySelector("[data-mention-ref]")).not.toBeNull()
    editor.commands.setTextSelection(1)
    typeInto(editor, "Z")
    expect(editor.getMarkdown()).toContain(`@[Spec](knowledge:document:${A})`)
  })
})
