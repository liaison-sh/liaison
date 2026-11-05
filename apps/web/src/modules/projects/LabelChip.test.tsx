// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import type { LabelGroup } from "~/modules/projects/label-catalog-store"
import type { TaskLabel } from "~/modules/projects/task-labels"

const catalog = vi.hoisted(() => ({
  groups: [] as LabelGroup[],
  loaded: true,
  loading: false,
  failed: false,
}))

vi.mock("~/modules/projects/label-catalog-store", () => ({
  labelCatalog: {
    get groups() {
      return catalog.groups
    },
    get loaded() {
      return catalog.loaded
    },
    get loading() {
      return catalog.loading
    },
    get failed() {
      return catalog.failed
    },
    liveGroups: () =>
      catalog.groups
        .filter((g) => g.archivedAt === null)
        .map((g) => ({ ...g, values: g.values.filter((v) => !v.archived) })),
    groupOrder: () => catalog.groups.map((g) => g.id),
    group: (id: string) => catalog.groups.find((g) => g.id === id),
    value: (groupId: string, valueId: string) =>
      catalog.groups.find((g) => g.id === groupId)?.values.find((v) => v.id === valueId),
    displayName: (entry: TaskLabel) => {
      const g = catalog.groups.find((x) => x.id === entry.groupId)
      const v = g?.values.find((x) => x.id === entry.valueId)
      return {
        groupName: g?.name ?? entry.groupName,
        valueName: v?.name ?? entry.valueName,
        archived: v?.archived ?? entry.archived,
      }
    },
  },
  ensureLabelCatalog: vi.fn(async () => {}),
  loadLabelCatalog: vi.fn(async () => {}),
  handleLabelEvent: vi.fn(),
  resetLabelCatalogStore: vi.fn(),
}))

import { TaskLabelChips } from "~/modules/projects/LabelChip"

function value(groupId: string, id: string, name: string, archived = false) {
  return {
    id,
    groupId,
    name,
    sortOrder: 0,
    archivedAt: archived ? "2026-10-01T00:00:00Z" : null,
    archived,
  }
}

function nature(archivedAt: string | null = null): LabelGroup {
  return {
    id: "g-nature",
    name: "Nature",
    sortOrder: 0,
    archivedAt,
    values: [
      value("g-nature", "v-bug", "bug", archivedAt !== null),
      value("g-nature", "v-evo", "evolution", archivedAt !== null),
      value("g-nature", "v-old", "legacy", true),
    ],
  }
}

function domain(): LabelGroup {
  return {
    id: "g-domain",
    name: "Domain",
    sortOrder: 1,
    archivedAt: null,
    values: [value("g-domain", "v-sec", "security")],
  }
}

function entry(groupId: string, valueId: string, over: Partial<TaskLabel> = {}): TaskLabel {
  const names: Record<string, string> = {
    "v-bug": "bug",
    "v-evo": "evolution",
    "v-old": "legacy",
    "v-sec": "security",
  }
  return {
    groupId,
    groupName: groupId === "g-nature" ? "Nature" : "Domain",
    groupArchived: false,
    valueId,
    valueName: names[valueId] ?? valueId,
    archived: false,
    inherited: false,
    inheritedFromKey: null,
    ...over,
  }
}

function renderChips(labels: TaskLabel[], opts: { disabled?: boolean } = {}) {
  const onChange = vi.fn()
  const result = render(() => (
    <I18nProvider initialLocale="en">
      <TaskLabelChips labels={labels} disabled={opts.disabled ?? false} onChange={onChange} />
    </I18nProvider>
  ))
  return { onChange, ...result }
}

/** Open the chip's menu from its trigger (keyboard, as Kobalte answers it in jsdom). */
function openMenu(groupId: string) {
  const chip = screen.getByTestId(`task-detail.label-${groupId}`)
  const trigger = chip.closest("button") as HTMLElement
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
}

/** Hover every ancestor: the tooltip's trigger is a wrapper around the chip. */
function hover(el: HTMLElement) {
  for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
    fireEvent.pointerEnter(cur, { pointerType: "mouse" })
  }
}

describe("TaskLabelChips", () => {
  beforeEach(() => {
    catalog.groups = [nature(), domain()]
    catalog.loaded = true
    catalog.loading = false
    catalog.failed = false
  })
  afterEach(() => cleanup())

  it("selecting a value sends its id; None sends null", async () => {
    const { onChange } = renderChips([entry("g-nature", "v-bug")])
    openMenu("g-nature")
    const options = await screen.findAllByTestId("task-detail.label-option")
    // Live values only: the archived "legacy" is not offered.
    expect(options.map((o) => o.textContent)).toEqual(["bug", "evolution"])
    fireEvent.keyDown(options[1] as HTMLElement, { key: "Enter" })
    expect(onChange).toHaveBeenCalledWith("g-nature", "v-evo")

    openMenu("g-nature")
    fireEvent.keyDown(await screen.findByTestId("task-detail.label-none"), { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith("g-nature", null)
  })

  it("an inherited entry is marked and explains where it comes from", async () => {
    renderChips([
      entry("g-nature", "v-bug", { inherited: true, inheritedFromKey: "PRJ-12" }),
      entry("g-domain", "v-sec"),
    ])
    const inherited = screen.getByTestId("task-detail.label-g-nature")
    expect(inherited.getAttribute("data-inherited")).toBe("true")
    expect(screen.getByTestId("task-detail.label-g-domain").getAttribute("data-inherited")).toBe(
      "false",
    )
    expect(screen.queryByText("Inherited from PRJ-12")).toBeNull()
    hover(inherited)
    expect(await screen.findByText("Inherited from PRJ-12")).toBeTruthy()
  })

  it("an archived value reads (archived); a group with no entry reads not set", () => {
    renderChips([entry("g-nature", "v-old", { archived: true })])
    const chip = screen.getByTestId("task-detail.label-g-nature")
    expect(chip.textContent).toBe("Nature: legacy (archived)")
    expect(chip.getAttribute("data-archived")).toBe("true")
    expect(screen.getByTestId("task-detail.label-g-domain").textContent).toBe("Domain: not set")
  })

  it("the (archived) mark follows the catalog, not the task payload", () => {
    // Archived by an admin since the task row was read: the payload still says live.
    catalog.groups = [{ ...nature(), values: [value("g-nature", "v-bug", "bug", true)] }, domain()]
    const first = renderChips([entry("g-nature", "v-bug", { archived: false })])
    let chip = screen.getByTestId("task-detail.label-g-nature")
    expect(chip.textContent).toBe("Nature: bug (archived)")
    expect(chip.getAttribute("data-archived")).toBe("true")
    first.unmount()

    // Restored since: the payload's stale mark goes.
    catalog.groups = [nature(), domain()]
    renderChips([entry("g-nature", "v-bug", { archived: true })])
    chip = screen.getByTestId("task-detail.label-g-nature")
    expect(chip.textContent).toBe("Nature: bug")
    expect(chip.getAttribute("data-archived")).toBe("false")
  })

  it("an archived group offers only None on an own entry, nothing on an inherited one", async () => {
    catalog.groups = [nature("2026-10-02T00:00:00Z"), domain()]
    const own = renderChips([entry("g-nature", "v-bug", { archived: true, groupArchived: true })])
    openMenu("g-nature")
    expect(await screen.findByTestId("task-detail.label-none")).toBeTruthy()
    expect(screen.queryAllByTestId("task-detail.label-option")).toHaveLength(0)
    own.unmount()

    renderChips([
      entry("g-nature", "v-bug", {
        archived: true,
        groupArchived: true,
        inherited: true,
        inheritedFromKey: "PRJ-3",
      }),
    ])
    const chip = screen.getByTestId("task-detail.label-g-nature")
    expect(chip.closest("button")).toBeNull()
  })

  it("an archived group without an entry is not shown", () => {
    catalog.groups = [nature("2026-10-02T00:00:00Z"), domain()]
    renderChips([])
    expect(screen.queryByTestId("task-detail.label-g-nature")).toBeNull()
    expect(screen.getByTestId("task-detail.label-g-domain")).toBeTruthy()
  })

  it("renders nothing with an empty catalog and no entries", () => {
    catalog.groups = []
    const { container } = renderChips([])
    expect(container.textContent).toBe("")
    expect(container.querySelector("[data-testid^='task-detail.label-']")).toBeNull()
  })

  for (const state of ["failed", "not loaded"] as const) {
    it(`catalog ${state}: payload entries render read-only with the payload's names`, () => {
      catalog.groups = []
      if (state === "failed") catalog.failed = true
      else catalog.loaded = false
      renderChips([entry("g-nature", "v-bug"), entry("g-domain", "v-sec")])
      expect(screen.getByTestId("task-detail.label-g-nature").textContent).toBe("Nature: bug")
      expect(screen.getByTestId("task-detail.label-g-domain").textContent).toBe("Domain: security")
      expect(screen.queryAllByRole("button")).toHaveLength(0)
    })
  }

  it("disabled: every trigger is disabled and opens no menu", () => {
    renderChips([entry("g-nature", "v-bug")], { disabled: true })
    const buttons = screen.getAllByRole("button")
    expect(buttons.length).toBe(2)
    for (const b of buttons) expect(b).toBeDisabled()
    openMenu("g-nature")
    fireEvent.click(buttons[0] as HTMLElement)
    expect(screen.queryAllByTestId("task-detail.label-option")).toHaveLength(0)
  })
})
