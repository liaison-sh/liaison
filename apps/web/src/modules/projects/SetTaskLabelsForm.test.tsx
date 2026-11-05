// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import type { LabelGroup } from "~/modules/projects/label-catalog-store"

const catalog = vi.hoisted(() => ({ groups: [] as LabelGroup[] }))
const ensureLabelCatalog = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("~/modules/projects/label-catalog-store", () => ({
  labelCatalog: {
    get groups() {
      return catalog.groups
    },
    loaded: true,
    loading: false,
    failed: false,
    liveGroups: () =>
      catalog.groups
        .filter((g) => g.archivedAt === null)
        .map((g) => ({ ...g, values: g.values.filter((v) => !v.archived) })),
    groupOrder: () => catalog.groups.map((g) => g.id),
    group: (id: string) => catalog.groups.find((g) => g.id === id),
    value: () => undefined,
    displayName: (e: { groupName: string; valueName: string; archived: boolean }) => ({
      groupName: e.groupName,
      valueName: e.valueName,
      archived: e.archived,
    }),
  },
  ensureLabelCatalog,
  loadLabelCatalog: vi.fn(async () => {}),
  handleLabelEvent: vi.fn(),
  resetLabelCatalogStore: vi.fn(),
}))

import { ApiContext } from "~/modules/shell/ApiContext"
import { SetTaskLabelsForm } from "./SetTaskLabelsForm"

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

const GROUPS: LabelGroup[] = [
  {
    id: "g-nature",
    name: "Nature",
    sortOrder: 0,
    archivedAt: null,
    values: [value("g-nature", "v-bug", "bug"), value("g-nature", "v-old", "legacy", true)],
  },
  {
    id: "g-domain",
    name: "Domain",
    sortOrder: 1,
    archivedAt: null,
    values: [value("g-domain", "v-sec", "security")],
  },
  {
    id: "g-team",
    name: "Team",
    sortOrder: 2,
    archivedAt: "2026-10-02T00:00:00Z",
    values: [value("g-team", "v-core", "core", true)],
  },
]

const api = {} as never

function renderForm(ids = ["t1", "t2"]) {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api}>
        <SetTaskLabelsForm ids={ids} onSubmit={onSubmit} onCancel={onCancel} />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return { onSubmit, onCancel }
}

function choose(groupId: string, valueId: string) {
  const select = screen.getByTestId(`projects-set-labels.group-${groupId}`) as HTMLSelectElement
  fireEvent.change(select, { target: { value: valueId } })
}

describe("SetTaskLabelsForm", () => {
  beforeEach(() => {
    catalog.groups = GROUPS
    ensureLabelCatalog.mockClear()
  })
  afterEach(() => cleanup())

  it("loads the catalog and offers one picker per live group, live values only", () => {
    renderForm()
    expect(ensureLabelCatalog).toHaveBeenCalledWith(api)
    expect(screen.queryByTestId("projects-set-labels.group-g-team")).toBeNull()
    const nature = screen.getByTestId("projects-set-labels.group-g-nature") as HTMLSelectElement
    expect([...nature.options].map((o) => o.textContent)).toEqual(["Unchanged", "bug", "None"])
    expect(nature.value).toBe("")
  })

  it("submits only the changed groups, None as null", () => {
    const { onSubmit } = renderForm()
    choose("g-nature", "v-bug")
    choose("g-domain", "__none__")
    fireEvent.click(screen.getByTestId("projects-set-labels.submit"))
    expect(onSubmit).toHaveBeenCalledWith({ labels: { "g-nature": "v-bug", "g-domain": null } })

    choose("g-domain", "")
    fireEvent.click(screen.getByTestId("projects-set-labels.submit"))
    expect(onSubmit).toHaveBeenLastCalledWith({ labels: { "g-nature": "v-bug" } })
  })

  it("submit stays disabled until a group changes, and with no selection", () => {
    renderForm()
    const submit = screen.getByTestId("projects-set-labels.submit")
    expect(submit).toBeDisabled()
    choose("g-nature", "v-bug")
    expect(submit).not.toBeDisabled()
    cleanup()
    renderForm([])
    choose("g-nature", "v-bug")
    expect(screen.getByTestId("projects-set-labels.submit")).toBeDisabled()
  })

  it("with no label group: says so and offers only Cancel", () => {
    catalog.groups = []
    const { onCancel } = renderForm()
    expect(screen.getByText("No label groups")).toBeTruthy()
    expect(screen.queryByTestId("projects-set-labels.submit")).toBeNull()
    fireEvent.click(screen.getByTestId("projects-set-labels.cancel"))
    expect(onCancel).toHaveBeenCalled()
  })
})
