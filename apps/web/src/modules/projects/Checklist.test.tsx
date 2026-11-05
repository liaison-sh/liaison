// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { editorOf, setMarkdown, typeInto } from "~/modules/editor/test-helpers"
import { Checklist, ChecklistTestAccess } from "~/modules/projects/Checklist"
import { checklistStore, resetChecklistStore } from "~/modules/projects/checklist-store"
import type { ChecklistItem, ValidationLevel } from "~/modules/projects/checklist-types"
import { projectStore } from "~/modules/projects/project-store"

vi.mock("~/modules/shell/toast-store", () => ({ addToast: vi.fn() }))

const LEVELS: ValidationLevel[] = [
  { id: "lv-ai", name: "AI" },
  { id: "lv-dev", name: "Dev" },
]

const SOURCE = "https://claude.ai/artifact/qa-board"

const item = (id: string, title: string, validations: ChecklistItem["validations"] = {}) =>
  ({
    id,
    taskId: "t1",
    position: Number(id.replace(/\D/g, "")),
    title,
    details: null,
    checked: false,
    validations,
    createdBy: "u1",
    createdAt: "2026-09-20T00:00:00Z",
    updatedAt: "2026-09-20T00:00:00Z",
  }) as ChecklistItem

const rec = (
  state: "success" | "fail" | "na" | "not_done",
  via: "human" | "agent",
  source: string | null = null,
) => ({ state, by: "u-dev", via, source, at: "2026-09-24T10:00:00Z" })

function levelItems(): ChecklistItem[] {
  return [
    item("i1", "Pads light up", {
      "lv-ai": rec("success", "agent", SOURCE),
      "lv-dev": rec("fail", "human"),
    }),
    item("i2", "Pedal sustains"),
    item("i3", "Firmware boots", {
      "lv-ai": rec("success", "human"),
      "lv-dev": rec("na", "human"),
    }),
  ]
}

function makeApi(levels: ValidationLevel[], items: ChecklistItem[]) {
  return {
    get: vi.fn().mockImplementation(async (url: string) => {
      if (url === "/projects/p1/tasks/t1/checklist") return { levels, items }
      throw new Error(`unexpected GET ${url}`)
    }),
    getEnvelope: vi.fn().mockResolvedValue({ data: { name: "Dana Dev", email: null } }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as any
}

function mount(api: any) {
  render(() => <Checklist api={api} projectId="p1" taskId="t1" />)
}

const chip = (itemId: string, levelId: string) =>
  within(screen.getByTestId(`checklist.item-${itemId}`))
    .getAllByTestId("checklist.chip")
    .find((c) => c.getAttribute("data-level-id") === levelId)!

beforeEach(() => {
  resetChecklistStore()
  projectStore._resetForTest()
  ChecklistTestAccess.resetNames()
  vi.clearAllMocks()
})

describe("Checklist (task detail)", () => {
  it("header counts complete and failing items", async () => {
    mount(makeApi(LEVELS, levelItems()))
    await waitFor(() => expect(screen.getByTestId("checklist.item-i1")).toBeTruthy())
    const header = screen.getByTestId("checklist.header").textContent
    expect(header).toContain("Checklist")
    expect(header).toContain("1/3 complete")
    expect(header).toContain("1 failing")
    expect(screen.getByTestId("task-detail.checklist").id).toBe("task-checklist")
  })

  it("renders one named chip per level, named from the project's levels", async () => {
    mount(makeApi(LEVELS, levelItems()))
    await waitFor(() => expect(screen.getByTestId("checklist.item-i1")).toBeTruthy())
    const chips = within(screen.getByTestId("checklist.item-i1")).getAllByTestId("checklist.chip")
    expect(chips.map((c) => c.textContent)).toEqual(["AI", "Dev"])
    expect(chip("i1", "lv-ai").getAttribute("data-state")).toBe("success")
    expect(chip("i1", "lv-dev").getAttribute("data-state")).toBe("fail")
    expect(chip("i2", "lv-ai").getAttribute("data-state")).toBe("not_done")
    expect(screen.queryByTestId("checklist.checkbox")).toBeNull()
  })

  it("Fail requires a note before it can be submitted", async () => {
    const api = makeApi(LEVELS, levelItems())
    mount(api)
    await waitFor(() => expect(screen.getByTestId("checklist.item-i2")).toBeTruthy())

    fireEvent.click(chip("i2", "lv-dev"))
    const fail = screen
      .getAllByTestId("checklist.state-option")
      .find((o) => o.getAttribute("data-state") === "fail")!
    fireEvent.click(fail)

    expect(screen.getByText("Posted to the task discussion")).toBeTruthy()
    const submit = screen.getByTestId("checklist.fail-submit") as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    // A submit with an empty (or blank) note writes nothing.
    fireEvent.submit(screen.getByTestId("checklist.fail-form"))
    const note = screen.getByTestId("checklist.fail-note") as HTMLTextAreaElement
    note.value = "   "
    fireEvent.input(note)
    expect(submit.disabled).toBe(true)
    fireEvent.submit(screen.getByTestId("checklist.fail-form"))
    expect(api.post).not.toHaveBeenCalled()

    api.post.mockResolvedValue({
      items: [{ ...levelItems()[1]!, validations: { "lv-dev": rec("fail", "human") } }],
    })
    note.value = "Sustain drops after 3 s on build 1.4.2"
    fireEvent.input(note)
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/projects/p1/tasks/t1/checklist/validations", {
        validations: [
          {
            itemId: "i2",
            level: "lv-dev",
            state: "fail",
            note: "Sustain drops after 3 s on build 1.4.2",
          },
        ],
      }),
    )
    await waitFor(() => expect(chip("i2", "lv-dev").getAttribute("data-state")).toBe("fail"))
  })

  it("choosing Success calls the store and echoes the new state", async () => {
    const api = makeApi(LEVELS, levelItems())
    api.post.mockResolvedValue({
      items: [
        {
          ...levelItems()[1]!,
          validations: { "lv-ai": rec("success", "human") },
          updatedAt: "2026-09-25T00:00:00Z",
        },
      ],
    })
    mount(api)
    await waitFor(() => expect(screen.getByTestId("checklist.item-i2")).toBeTruthy())

    fireEvent.click(chip("i2", "lv-ai"))
    fireEvent.click(
      screen
        .getAllByTestId("checklist.state-option")
        .find((o) => o.getAttribute("data-state") === "success")!,
    )

    await waitFor(() => expect(chip("i2", "lv-ai").getAttribute("data-state")).toBe("success"))
    expect(api.post).toHaveBeenCalledWith("/projects/p1/tasks/t1/checklist/validations", {
      validations: [{ itemId: "i2", level: "lv-ai", state: "success" }],
    })
    expect(checklistStore.items("t1").find((i) => i.id === "i2")?.validations["lv-ai"]?.state).toBe(
      "success",
    )
    // Popover closed after the write.
    expect(screen.queryByTestId("checklist.chip-popover")).toBeNull()
  })

  it("chip tooltip attributes an agent-set state and shows its source link", async () => {
    const api = makeApi(LEVELS, levelItems())
    mount(api)
    await waitFor(() => expect(screen.getByTestId("checklist.item-i1")).toBeTruthy())

    const trigger = chip("i1", "lv-ai").parentElement as HTMLElement
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" })
    const hint = await screen.findByTestId("tooltip-content", undefined, { timeout: 2000 })
    await waitFor(() => expect(hint.textContent).toContain("Dana Dev"))
    expect(hint.textContent).toContain("Set by an agent for Dana Dev")
    expect(hint.textContent).toContain(`Source: ${SOURCE}`)
    expect(api.getEnvelope).toHaveBeenCalledWith("/users/u-dev/preview")

    // The popover repeats the attribution with a clickable source link.
    fireEvent.click(chip("i1", "lv-ai"))
    const popover = screen.getByTestId("checklist.chip-popover")
    expect(within(popover).getByTestId("checklist.popover-attribution").textContent).toContain(
      "agent",
    )
    expect(within(popover).getByTestId("checklist.source-link").getAttribute("href")).toBe(SOURCE)
  })

  it("the attribution ends its sentence before the source link, in the popover and the record line", async () => {
    mount(makeApi(LEVELS, levelItems()))
    await waitFor(() => expect(screen.getByTestId("checklist.item-i1")).toBeTruthy())
    const sentence = /Set by an agent for Dana Dev, [^.]+\. Source$/

    fireEvent.click(chip("i1", "lv-ai"))
    const popover = screen.getByTestId("checklist.chip-popover")
    const header = within(popover).getByTestId("checklist.source-link").parentElement!
    await waitFor(() => expect(header.textContent).toMatch(sentence))

    fireEvent.click(within(screen.getByTestId("checklist.item-i1")).getByTestId("checklist.caret"))
    const lines = await screen.findAllByTestId("checklist.record")
    const withSource = lines.find((l) => l.querySelector("[data-testid='checklist.source-link']"))!
    await waitFor(() => expect(withSource.textContent).toMatch(sentence))
  })

  it("a source that is not an https URL renders as plain text, never a link", async () => {
    const evil = "javascript:alert(1)"
    const items = [item("i1", "Pads light up", { "lv-ai": rec("success", "agent", evil) })]
    mount(makeApi(LEVELS, items))
    await waitFor(() => expect(screen.getByTestId("checklist.item-i1")).toBeTruthy())
    fireEvent.click(chip("i1", "lv-ai"))
    const popover = screen.getByTestId("checklist.chip-popover")
    expect(popover.querySelector("a")).toBeNull()
    expect(within(popover).getByTestId("checklist.source-link").textContent).toContain(evil)
  })

  it("a human-set state is not attributed to an agent", async () => {
    mount(makeApi(LEVELS, levelItems()))
    await waitFor(() => expect(screen.getByTestId("checklist.item-i3")).toBeTruthy())
    fireEvent.click(chip("i3", "lv-ai"))
    const text = screen.getByTestId("checklist.popover-attribution").textContent ?? ""
    expect(text).toContain("Set by")
    expect(text).not.toContain("agent")
  })

  it("plain mode renders a checkbox per item and writes checked", async () => {
    const items = [item("i1", "Write notes"), { ...item("i2", "Ship"), checked: true }]
    const api = makeApi([], items)
    api.post.mockResolvedValue({ items: [{ ...items[0]!, checked: true }] })
    mount(api)
    await waitFor(() => expect(screen.getAllByTestId("checklist.checkbox")).toHaveLength(2))
    expect(screen.queryByTestId("checklist.chip")).toBeNull()
    expect(screen.getByTestId("checklist.header").textContent).toContain("1/2 complete")

    fireEvent.click(screen.getAllByTestId("checklist.checkbox")[0]!)
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/projects/p1/tasks/t1/checklist/validations", {
        validations: [{ itemId: "i1", checked: true }],
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("checklist.header").textContent).toContain("2/2 complete"),
    )
  })

  it("adds an item inline and removes one after an in-page confirmation", async () => {
    const api = makeApi([], [item("i1", "Write notes")])
    api.post.mockResolvedValue({ items: [item("i2", "Ship it")] })
    api.delete.mockResolvedValue({ deleted: true })
    mount(api)
    await waitFor(() => expect(screen.getByTestId("checklist.item-i1")).toBeTruthy())

    fireEvent.click(screen.getByTestId("checklist.add"))
    const input = await screen.findByTestId("checklist.add-input")
    const editor = editorOf(input)
    typeInto(editor, "Ship it")
    editor.commands.setTextSelection({ from: 1, to: 5 })
    fireEvent.keyDown(input, { key: "b", ctrlKey: true })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.getByTestId("checklist.item-i2")).toBeTruthy())
    expect(api.post).toHaveBeenCalledWith("/projects/p1/tasks/t1/checklist", {
      items: [{ title: "**Ship** it" }],
    })
    // The field stays open, emptied, for the next item.
    await waitFor(() => expect(input.textContent).toBe(""))

    const row = screen.getByTestId("checklist.item-i1")
    fireEvent.click(within(row).getByTestId("checklist.remove"))
    expect(api.delete).not.toHaveBeenCalled()
    fireEvent.click(within(row).getByTestId("checklist.remove-confirm"))
    await waitFor(() => expect(screen.queryByTestId("checklist.item-i1")).toBeNull())
    expect(api.delete).toHaveBeenCalledWith("/projects/p1/tasks/t1/checklist/i1")
  })

  it("renames an item inline and shows details as markdown when expanded", async () => {
    const api = makeApi([], [{ ...item("i1", "Write notes"), details: "**bold** step" }])
    api.patch.mockResolvedValue({ ...item("i1", "Write release notes") })
    mount(api)
    await waitFor(() => expect(screen.getByTestId("checklist.item-i1")).toBeTruthy())

    fireEvent.click(screen.getByTestId("checklist.caret"))
    const rendered = await screen.findByTestId("checklist.details-rendered")
    expect(rendered.querySelector("strong")?.textContent).toBe("bold")

    fireEvent.click(screen.getByTestId("checklist.title"))
    const input = await screen.findByTestId("checklist.title-input")
    setMarkdown(input, "Write release notes")
    fireEvent.focusOut(input)
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/projects/p1/tasks/t1/checklist/i1", {
        title: "Write release notes",
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("checklist.title").textContent).toBe("Write release notes"),
    )
  })

  it("shows a formatted title, edits it in one line, and saves nothing when untouched", async () => {
    const stored = "Relire **le** ++rapport++ de __juin__"
    const api = makeApi([], [{ ...item("i1", stored), details: "* un\n* deux" }])
    api.patch.mockResolvedValue({ ...item("i1", stored), details: "Note" })
    mount(api)
    const title = await screen.findByTestId("checklist.title")
    expect(title.querySelector("strong")?.textContent).toBe("le")
    expect(title.querySelector("u")?.textContent).toBe("rapport")

    fireEvent.click(title)
    let input = await screen.findByTestId("checklist.title-input")
    expect(input.querySelector("u")?.textContent).toBe("rapport")
    fireEvent.keyDown(input, { key: "Enter" })
    await screen.findByTestId("checklist.title")
    fireEvent.click(screen.getByTestId("checklist.title"))
    input = await screen.findByTestId("checklist.title-input")
    fireEvent.focusOut(input)
    await screen.findByTestId("checklist.title")

    // Details: untouched saves nothing, an edit saves markdown.
    fireEvent.click(screen.getByTestId("checklist.caret"))
    fireEvent.click(await screen.findByTestId("checklist.details-edit"))
    let details = await screen.findByTestId("checklist.details-input")
    expect(details.querySelectorAll("li")).toHaveLength(2)
    fireEvent.focusOut(details)
    await screen.findByTestId("checklist.details-edit")
    expect(api.patch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("checklist.details-edit"))
    details = await screen.findByTestId("checklist.details-input")
    setMarkdown(details, "Voir ++la note++")
    fireEvent.keyDown(details, { key: "Enter", ctrlKey: true })
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/projects/p1/tasks/t1/checklist/i1", {
        details: "Voir ++la note++",
      }),
    )
  })

  it("an open chip popover, a typed Fail note and an inline title edit survive a realtime echo", async () => {
    mount(makeApi(LEVELS, levelItems()))
    await waitFor(() => expect(screen.getByTestId("checklist.item-i2")).toBeTruthy())
    const row2 = screen.getByTestId("checklist.item-i2")

    fireEvent.click(chip("i2", "lv-dev"))
    fireEvent.click(
      screen
        .getAllByTestId("checklist.state-option")
        .find((o) => o.getAttribute("data-state") === "fail")!,
    )
    const note = screen.getByTestId("checklist.fail-note") as HTMLTextAreaElement
    note.value = "Sustain drops"
    fireEvent.input(note)

    fireEvent.click(within(screen.getByTestId("checklist.item-i3")).getByTestId("checklist.title"))
    const title = await screen.findByTestId("checklist.title-input")
    setMarkdown(title, "Firmware boots cold")

    // Echo of the same item (another level changed), then of each sibling.
    checklistStore.handleChecklistItemEvent("updated", {
      ...levelItems()[1]!,
      validations: { "lv-ai": rec("success", "agent") },
      updatedAt: "2026-09-25T00:00:00Z",
    })
    checklistStore.handleChecklistItemEvent("updated", {
      ...levelItems()[0]!,
      updatedAt: "2026-09-25T00:00:01Z",
    })
    checklistStore.handleChecklistItemEvent("updated", {
      ...levelItems()[2]!,
      updatedAt: "2026-09-25T00:00:02Z",
    })

    expect(chip("i2", "lv-ai").getAttribute("data-state")).toBe("success")
    expect(screen.getByTestId("checklist.item-i2")).toBe(row2)
    expect(screen.getByTestId("checklist.chip-popover")).toBeTruthy()
    const noteAfter = screen.getByTestId("checklist.fail-note") as HTMLTextAreaElement
    expect(noteAfter).toBe(note)
    expect(noteAfter.value).toBe("Sustain drops")
    const titleAfter = screen.getByTestId("checklist.title-input")
    expect(titleAfter).toBe(title)
    expect(titleAfter.textContent).toBe("Firmware boots cold")
  })

  it("reorders by drag: dropping below a sibling sends both neighbours", async () => {
    const api = makeApi([], [item("i1", "A"), item("i2", "B"), item("i3", "C")])
    api.patch.mockResolvedValue({ ...item("i1", "A"), position: 2.5 })
    mount(api)
    await waitFor(() => expect(screen.getByTestId("checklist.item-i3")).toBeTruthy())

    const handle = within(screen.getByTestId("checklist.item-i1")).getByTestId(
      "checklist.drag-handle",
    )
    fireEvent.dragStart(handle)
    const target = screen.getByTestId("checklist.item-i2")
    target.getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40 }) as DOMRect
    fireEvent.dragOver(target, { clientY: 39 })
    fireEvent.drop(target, { clientY: 39 })
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/projects/p1/tasks/t1/checklist/i1", {
        afterItemId: "i2",
        beforeItemId: "i3",
      }),
    )
  })
})
