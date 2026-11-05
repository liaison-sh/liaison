// SPDX-License-Identifier: FSL-1.1-ALv2
// The inline "Edit project" form's group field: prefilled, trimmed on save,
// emptied = null (ungrouped), and the org's existing groups offered as
// suggestions.
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  updateProjectFields: vi.fn(async (..._args: unknown[]) => ({})),
  projects: [] as Array<{
    id: string
    name: string
    group?: string | null
    archivedAt: string | null
  }>,
  archived: [] as Array<{
    id: string
    name: string
    group?: string | null
    archivedAt: string | null
  }>,
}))

vi.mock("~/modules/projects/project-edit", () => ({
  updateProjectFields: state.updateProjectFields,
}))
vi.mock("~/modules/projects/projects-store", () => ({
  projectsStore: {
    get items() {
      return state.projects
    },
    get archivedItems() {
      return state.archived
    },
  },
}))

import type { ApiClient } from "~/lib/api-client"
import type { ProjectDetail } from "~/modules/projects/project-store"
import { ProjectEditForm } from "./ProjectEditForm"

const api = {} as ApiClient

function project(group: string | null): ProjectDetail {
  return {
    id: "p1",
    key: "ALP",
    keyLocked: false,
    name: "Alpha",
    description: null,
    icon: null,
    color: null,
    group,
    ownerId: "u1",
    archivedAt: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    statuses: [],
  }
}

describe("ProjectEditForm group", () => {
  beforeEach(() => {
    state.updateProjectFields.mockClear()
    state.projects = [
      { id: "p1", name: "Alpha", group: "Tech", archivedAt: null },
      { id: "p2", name: "Beta", group: "Product", archivedAt: null },
      { id: "p3", name: "Gamma", group: "Product", archivedAt: null },
      { id: "p4", name: "Delta", group: null, archivedAt: null },
    ]
    state.archived = [{ id: "p9", name: "Old", group: "Legal", archivedAt: "2026-01-01" }]
  })

  it("is prefilled and saves the trimmed group", async () => {
    render(() => <ProjectEditForm api={api} project={project("Tech")} onDone={() => {}} />)
    const input = screen.getByTestId("project-edit.group") as HTMLInputElement
    expect(input.value).toBe("Tech")
    fireEvent.input(input, { target: { value: "  Product " } })
    fireEvent.click(screen.getByTestId("project-edit.save"))
    await vi.waitFor(() =>
      expect(state.updateProjectFields).toHaveBeenCalledWith(api, "p1", { group: "Product" }),
    )
  })

  it("emptying the field ungroups the project", async () => {
    render(() => <ProjectEditForm api={api} project={project("Tech")} onDone={() => {}} />)
    fireEvent.input(screen.getByTestId("project-edit.group"), { target: { value: "  " } })
    fireEvent.click(screen.getByTestId("project-edit.save"))
    await vi.waitFor(() =>
      expect(state.updateProjectFields).toHaveBeenCalledWith(api, "p1", { group: null }),
    )
  })

  it("an unchanged group is not sent", async () => {
    const onDone = vi.fn()
    render(() => <ProjectEditForm api={api} project={project(null)} onDone={onDone} />)
    fireEvent.click(screen.getByTestId("project-edit.save"))
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(state.updateProjectFields).not.toHaveBeenCalled()
  })

  it("offers the existing group names, once each and sorted", () => {
    render(() => <ProjectEditForm api={api} project={project(null)} onDone={() => {}} />)
    const input = screen.getByTestId("project-edit.group") as HTMLInputElement
    const list = document.getElementById(input.getAttribute("list") ?? "")
    expect(list?.getAttribute("data-testid")).toBe("project-edit.group-suggestions")
    const options = Array.from(list?.querySelectorAll("option") ?? []).map((o) => o.value)
    expect(options).toEqual(["Legal", "Product", "Tech"])
  })

  it("caps the field at 60 characters", () => {
    render(() => <ProjectEditForm api={api} project={project(null)} onDone={() => {}} />)
    expect((screen.getByTestId("project-edit.group") as HTMLInputElement).maxLength).toBe(60)
  })
})
