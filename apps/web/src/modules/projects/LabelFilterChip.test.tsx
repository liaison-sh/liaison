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
    displayName: (entry: TaskLabel) => ({
      groupName: entry.groupName,
      valueName: entry.valueName,
      archived: entry.archived,
    }),
  },
  ensureLabelCatalog: vi.fn(async () => {}),
  loadLabelCatalog: vi.fn(async () => {}),
  handleLabelEvent: vi.fn(),
  resetLabelCatalogStore: vi.fn(),
}))

import { LabelFilterChip } from "~/modules/projects/LabelFilterChip"
import { projectsFilterStore } from "~/modules/projects/projects-filter-store"

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

const NATURE: LabelGroup = {
  id: "g-nature",
  name: "Nature",
  sortOrder: 0,
  archivedAt: null,
  values: [
    value("g-nature", "v-bug", "bug"),
    value("g-nature", "v-evo", "evolution"),
    value("g-nature", "v-old", "legacy", true),
  ],
}
const DOMAIN: LabelGroup = {
  id: "g-domain",
  name: "Domain",
  sortOrder: 1,
  archivedAt: null,
  values: [value("g-domain", "v-sec", "security")],
}
const TEAM_ARCHIVED: LabelGroup = {
  id: "g-team",
  name: "Team",
  sortOrder: 2,
  archivedAt: "2026-10-02T00:00:00Z",
  values: [value("g-team", "v-core", "core", true)],
}

function renderChip(
  tasks: { id: string; parentTaskId: string | null; labels?: TaskLabel[] }[] = [],
) {
  return render(() => (
    <I18nProvider initialLocale="en">
      <LabelFilterChip tasks={tasks} />
    </I18nProvider>
  ))
}

async function openMenu() {
  const trigger = screen.getByTestId("project-workspace.label-filter")
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  await screen.findAllByTestId("label-filter.section")
}

function optionsOf(groupId: string): HTMLElement[] {
  const section = screen
    .getAllByTestId("label-filter.section")
    .find((el) => el.getAttribute("data-group") === groupId)
  if (!section) throw new Error(`no section ${groupId}`)
  return [...section.querySelectorAll<HTMLElement>("[data-testid='label-filter.option']")]
}

function option(groupId: string, text: string): HTMLElement {
  const el = optionsOf(groupId).find((o) => o.textContent?.trim() === text)
  if (!el) throw new Error(`no option ${groupId}/${text}`)
  return el
}

describe("LabelFilterChip", () => {
  beforeEach(() => {
    projectsFilterStore.clearAll()
    catalog.groups = [NATURE, DOMAIN, TEAM_ARCHIVED]
    catalog.loaded = true
    catalog.loading = false
    catalog.failed = false
  })
  afterEach(() => cleanup())

  it("lists one section per live group, archived values marked", async () => {
    renderChip()
    expect(screen.getByTestId("project-workspace.label-filter").textContent).toBe("Labels")
    await openMenu()
    const sections = screen.getAllByTestId("label-filter.section")
    // The archived Team group is used by no loaded task: not listed.
    expect(sections.map((s) => s.getAttribute("data-group"))).toEqual(["g-nature", "g-domain"])
    const natureOptions = optionsOf("g-nature").map((o) => o.textContent?.trim())
    expect(natureOptions).toEqual(["bug", "evolution", "legacy (archived)", "No label"])
  })

  it("an archived group used by a loaded task gets its section", async () => {
    renderChip([
      {
        id: "t1",
        parentTaskId: null,
        labels: [
          {
            groupId: "g-team",
            groupName: "Team",
            groupArchived: true,
            valueId: "v-core",
            valueName: "core",
            archived: true,
            inherited: false,
            inheritedFromKey: null,
          },
        ],
      },
    ])
    await openMenu()
    expect(
      screen.getAllByTestId("label-filter.section").map((s) => s.getAttribute("data-group")),
    ).toEqual(["g-nature", "g-domain", "g-team"])
  })

  it("one value per group, groups combine, the trigger counts them", async () => {
    renderChip()
    await openMenu()
    fireEvent.keyDown(option("g-nature", "bug"), { key: "Enter" })
    await openMenu()
    fireEvent.keyDown(option("g-domain", "No label"), { key: "Enter" })
    expect(projectsFilterStore.taskLabels).toEqual({ "g-nature": "v-bug", "g-domain": "__none__" })
    expect(screen.getByTestId("project-workspace.label-filter").textContent).toBe("Labels · 2")

    await openMenu()
    fireEvent.keyDown(option("g-nature", "evolution"), { key: "Enter" })
    expect(projectsFilterStore.taskLabels).toEqual({ "g-nature": "v-evo", "g-domain": "__none__" })

    // Picking the selected value again clears that group.
    await openMenu()
    fireEvent.keyDown(option("g-nature", "evolution"), { key: "Enter" })
    expect(projectsFilterStore.taskLabels).toEqual({ "g-domain": "__none__" })

    fireEvent.click(screen.getByTestId("project-workspace.label-filter-clear"))
    expect(projectsFilterStore.taskLabels).toEqual({})
    expect(screen.queryByTestId("project-workspace.label-filter-clear")).toBeNull()
  })

  it("is hidden when the catalog has no groups", () => {
    catalog.groups = []
    renderChip()
    expect(screen.queryByTestId("project-workspace.label-filter")).toBeNull()
  })

  it("is hidden when every group is archived and no loaded task uses one", () => {
    catalog.groups = [TEAM_ARCHIVED]
    renderChip()
    expect(screen.queryByTestId("project-workspace.label-filter")).toBeNull()
  })

  it("is disabled while the catalog loads, and when it failed", () => {
    catalog.loaded = false
    catalog.loading = true
    const first = renderChip()
    expect(screen.getByTestId("project-workspace.label-filter")).toBeDisabled()
    first.unmount()
    catalog.loading = false
    catalog.failed = true
    renderChip()
    expect(screen.getByTestId("project-workspace.label-filter")).toBeDisabled()
  })
})
