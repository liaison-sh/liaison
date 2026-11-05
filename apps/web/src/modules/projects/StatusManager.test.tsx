// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-client"
import { resetChecklistStore } from "~/modules/projects/checklist-store"
import type { ValidationLevel, ValidationLevelInput } from "~/modules/projects/checklist-types"
import { type ProjectStatus, projectStore, type Task } from "~/modules/projects/project-store"
import { StatusManager } from "~/modules/projects/StatusManager"

function makeStatus(i: number, label: string): ProjectStatus {
  return {
    id: `s${i}`,
    projectId: "p1",
    label,
    color: null,
    order: i,
    terminal: false,
  }
}

describe("StatusManager", () => {
  it("projects.status-ui.add-reorder-delete-migrate", async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const del = vi.fn().mockImplementation(async (path: string) => {
      if (path.endsWith("/s1") && del.mock.calls.length === 1) {
        throw new ApiError("In use", 409, "status_in_use", undefined, {
          count: 3,
          taskIds: ["t1", "t2", "t3"],
        })
      }
      return undefined
    })
    const api = { post, delete: del, get: vi.fn(), patch: vi.fn(), getEnvelope: vi.fn() } as any
    const statuses = [makeStatus(1, "Todo"), makeStatus(2, "Doing"), makeStatus(3, "Done")]

    const { getByTestId, getAllByTestId } = render(() => (
      <StatusManager api={api} projectId="p1" statuses={statuses} />
    ))

    // Add status: open form, type, confirm
    fireEvent.click(getByTestId("status-manager.add-trigger"))
    const input = getByTestId("status-manager.add-input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "Review" } })
    fireEvent.click(getByTestId("status-manager.add-confirm"))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/projects/p1/statuses", { label: "Review" }),
    )

    // Reorder: move first row down
    const moveDown = getAllByTestId("status-manager.move-down")[0]!
    fireEvent.click(moveDown)
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/projects/p1/statuses/reorder", {
        orderedStatusIds: ["s2", "s1", "s3"],
      }),
    )

    // Delete a status that's in use → migrate dialog renders count + select → migrate-and-delete retries
    const firstDelete = getAllByTestId("status-manager.delete")[0]!
    fireEvent.click(firstDelete)
    await waitFor(() => expect(screen.getByTestId("delete-status-dialog.delete")).toBeTruthy())
    fireEvent.click(screen.getByTestId("delete-status-dialog.delete"))
    await waitFor(() =>
      expect(screen.getByTestId("delete-status-dialog.count").textContent).toBe("3"),
    )

    const select = screen.getByTestId("delete-status-dialog.migrate-target") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "s2" } })
    fireEvent.click(screen.getByTestId("delete-status-dialog.migrate-and-delete"))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/projects/p1/statuses/s1/migrate", {
        targetStatusId: "s2",
      }),
    )
    await waitFor(() => expect(del).toHaveBeenCalledWith("/projects/p1/statuses/s1"))
    expect(screen.queryByTestId("delete-status-dialog.in-use")).toBeNull()
  })

  it("projects.status-ui.archived-project-disabled", () => {
    const api = {
      post: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
      getEnvelope: vi.fn(),
    } as any
    const statuses = [makeStatus(1, "Todo"), makeStatus(2, "Doing")]
    const { queryByTestId, queryAllByTestId } = render(() => (
      <StatusManager api={api} projectId="p1" statuses={statuses} archived={true} />
    ))
    expect(queryByTestId("status-manager.add-trigger")).toBeNull()
    expect(queryAllByTestId("status-manager.move-up").length).toBe(0)
    expect(queryAllByTestId("status-manager.delete").length).toBe(0)
  })

  it("projects.status-ui.a-column-can-be-marked-as-done", async () => {
    // A custom board ("Idea … Done") has to be able to say which column
    // counts as done; the PATCH already accepted `terminal`, only the UI lacked it.
    const patch = vi.fn().mockResolvedValue(undefined)
    const api = { patch, post: vi.fn(), delete: vi.fn(), get: vi.fn(), getEnvelope: vi.fn() } as any
    const statuses = [makeStatus(1, "Idea"), makeStatus(2, "Done")]
    const { getAllByTestId } = render(() => (
      <StatusManager api={api} projectId="p1" statuses={statuses} />
    ))
    const boxes = getAllByTestId("status-manager.terminal") as HTMLInputElement[]
    expect(boxes.map((b) => b.checked)).toEqual([false, false])
    fireEvent.click(boxes[1]!)
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/projects/p1/statuses/s2", { terminal: true }),
    )
  })
})

// --- Checklist validation levels (S21) ---

const LEVELS: ValidationLevel[] = [
  { id: "l1", name: "AI" },
  { id: "l2", name: "Dev" },
  { id: "l3", name: "Beta" },
]

function levelsApi() {
  const put = vi
    .fn()
    .mockImplementation(async (_path: string, body: { levels: ValidationLevelInput[] }) => ({
      levels: body.levels.map((l, i) => ({ ...l, id: l.id ?? `new${i}` })),
    }))
  return {
    put,
    api: {
      put,
      post: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
      getEnvelope: vi.fn(),
    } as any,
  }
}

function seedProject(
  levels: ValidationLevel[],
  tasks: Partial<Task>[] = [],
  extra: { checklistOnCards?: boolean } = {},
) {
  projectStore._setForTest({
    projectId: "p1",
    current: {
      id: "p1",
      name: "Roadmap",
      description: null,
      icon: null,
      color: null,
      ownerId: "u1",
      archivedAt: null,
      createdAt: "",
      updatedAt: "",
      statuses: [],
      validationLevels: levels,
      ...extra,
    },
    tasks: tasks as Task[],
  })
}

function renderLevels(api: any) {
  return render(() => <StatusManager api={api} projectId="p1" statuses={[makeStatus(1, "Todo")]} />)
}

const nameInputs = () => screen.getAllByTestId("levels.name") as HTMLInputElement[]

describe("StatusManager checklist validation levels", () => {
  beforeEach(() => {
    projectStore._resetForTest()
    resetChecklistStore()
  })

  it("projects.levels-ui.lists-levels-in-order-with-hint", () => {
    seedProject(LEVELS)
    const { api } = levelsApi()
    renderLevels(api)
    expect(screen.getByTestId("levels.section").textContent).toContain("Checklist validations")
    expect(nameInputs().map((i) => i.value)).toEqual(["AI", "Dev", "Beta"])
    // Agents are trusted on every level: no per-level agent setting.
    expect(screen.queryAllByTestId("levels.agents")).toHaveLength(0)
    expect(screen.getByTestId("levels.section").textContent).not.toContain("Agents")
    expect(screen.getByTestId("levels.hint").textContent).toBe(
      "Without levels, each item is a simple checkbox.",
    )
  })

  it("projects.levels-ui.add-rename-reorder-then-save-once-with-the-whole-list", async () => {
    seedProject(LEVELS)
    const { api, put } = levelsApi()
    renderLevels(api)

    // Rename Dev -> QA
    fireEvent.input(nameInputs()[1]!, { target: { value: "QA" } })
    // Move Beta up (above QA)
    fireEvent.click(screen.getAllByTestId("levels.move-up")[2]!)
    // Add a level named Release
    fireEvent.click(screen.getByTestId("levels.add"))
    fireEvent.input(nameInputs()[3]!, { target: { value: "Release" } })

    expect(put).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("levels.save"))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    expect(put).toHaveBeenCalledWith("/projects/p1/validation-levels", {
      levels: [
        { id: "l1", name: "AI" },
        { id: "l3", name: "Beta" },
        { id: "l2", name: "QA" },
        { name: "Release" },
      ],
    })
    // The saved list reaches the project and the section shows it.
    await waitFor(() =>
      expect(projectStore.project("p1")?.validationLevels?.map((l) => l.name)).toEqual([
        "AI",
        "Beta",
        "QA",
        "Release",
      ]),
    )
  })

  it("projects.levels-ui.a-single-change-still-sends-the-whole-ordered-list", async () => {
    seedProject(LEVELS)
    const { api, put } = levelsApi()
    renderLevels(api)
    fireEvent.input(nameInputs()[0]!, { target: { value: "Bot" } })
    fireEvent.click(screen.getByTestId("levels.save"))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    expect(put.mock.calls[0]![1]).toEqual({
      levels: [
        { id: "l1", name: "Bot" },
        { id: "l2", name: "Dev" },
        { id: "l3", name: "Beta" },
      ],
    })
  })

  it("projects.levels-ui.remove-with-recorded-states-asks-confirmation-naming-the-count", async () => {
    // Dev has recorded states: task t1 has 1 success + 1 fail, task t2 has 1 N/A.
    // Untouched levels: every item applicable, none recorded.
    const perLevel = (success: number, fail: number, applicable: number, total: number) => [
      { levelId: "l1", name: "AI", applicable: total, success: 0, fail: 0 },
      { levelId: "l2", name: "Dev", applicable, success, fail },
      { levelId: "l3", name: "Beta", applicable: total, success: 0, fail: 0 },
    ]
    seedProject(LEVELS, [
      {
        id: "t1",
        projectId: "p1",
        checklist: {
          total: 3,
          complete: 0,
          failing: 1,
          perLevel: perLevel(1, 1, 3, 3),
          blocking: [],
        },
      },
      {
        id: "t2",
        projectId: "p1",
        checklist: {
          total: 2,
          complete: 0,
          failing: 0,
          perLevel: perLevel(0, 0, 1, 2),
          blocking: [],
        },
      },
    ])
    const { api, put } = levelsApi()
    renderLevels(api)

    // Beta has no recorded state: removed without a question.
    fireEvent.click(screen.getAllByTestId("levels.remove")[2]!)
    expect(screen.queryByTestId("levels.confirm-remove")).toBeNull()
    expect(nameInputs().map((i) => i.value)).toEqual(["AI", "Dev"])

    // Dev has 3 recorded states: confirmation names the count; cancel keeps it.
    fireEvent.click(screen.getAllByTestId("levels.remove")[1]!)
    expect(screen.getByTestId("levels.confirm-remove").textContent).toContain("3")
    fireEvent.click(screen.getByTestId("levels.confirm-remove.cancel"))
    expect(nameInputs().map((i) => i.value)).toEqual(["AI", "Dev"])

    fireEvent.click(screen.getAllByTestId("levels.remove")[1]!)
    fireEvent.click(screen.getByTestId("levels.confirm-remove.confirm"))
    expect(nameInputs().map((i) => i.value)).toEqual(["AI"])

    fireEvent.click(screen.getByTestId("levels.save"))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    expect(put.mock.calls[0]![1]).toEqual({
      levels: [{ id: "l1", name: "AI" }],
    })
  })

  it("projects.levels-ui.duplicate-and-invalid-names-block-save", async () => {
    seedProject(LEVELS)
    const { api, put } = levelsApi()
    renderLevels(api)
    fireEvent.input(nameInputs()[2]!, { target: { value: " ai " } })
    expect(screen.getAllByTestId("levels.error")[0]!.textContent).toContain("already")
    expect((screen.getByTestId("levels.save") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId("levels.save"))

    fireEvent.input(nameInputs()[2]!, { target: { value: "x".repeat(25) } })
    expect(screen.getAllByTestId("levels.error")[0]!.textContent).toContain("24")
    expect((screen.getByTestId("levels.save") as HTMLButtonElement).disabled).toBe(true)

    fireEvent.input(nameInputs()[2]!, { target: { value: "  " } })
    expect(screen.getAllByTestId("levels.error").length).toBe(1)
    expect((screen.getByTestId("levels.save") as HTMLButtonElement).disabled).toBe(true)

    fireEvent.input(nameInputs()[2]!, { target: { value: "Beta 2" } })
    expect(screen.queryAllByTestId("levels.error").length).toBe(0)
    expect((screen.getByTestId("levels.save") as HTMLButtonElement).disabled).toBe(false)
    expect(put).not.toHaveBeenCalled()
  })

  it("projects.levels-ui.a-ninth-level-is-blocked", () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({
      id: `l${i}`,
      name: `L${i}`,
    }))
    seedProject(eight)
    const { api } = levelsApi()
    renderLevels(api)
    const add = screen.getByTestId("levels.add") as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.click(add)
    expect(nameInputs().length).toBe(8)
    expect(screen.getByTestId("levels.max").textContent).toContain("8")
  })

  it("projects.levels-ui.archived-project-is-read-only", () => {
    seedProject(LEVELS)
    const { api } = levelsApi()
    render(() => (
      <StatusManager api={api} projectId="p1" statuses={[makeStatus(1, "Todo")]} archived />
    ))
    expect(screen.queryByTestId("levels.add")).toBeNull()
    expect(screen.queryByTestId("levels.save")).toBeNull()
    expect(screen.queryAllByTestId("levels.remove").length).toBe(0)
  })

  it("projects.levels-ui.show-on-cards-defaults-on-and-patches-the-project", async () => {
    seedProject(LEVELS)
    const { api } = levelsApi()
    api.patch.mockResolvedValue({})
    renderLevels(api)
    const box = screen.getByTestId("levels.show-on-cards") as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(box.closest("label")?.textContent).toContain("Show checklist on cards")
    fireEvent.click(box)
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/projects/p1", { checklistOnCards: false }),
    )
    expect(projectStore.project("p1")?.checklistOnCards).toBe(false)
    expect(box.checked).toBe(false)
  })

  it("projects.levels-ui.show-on-cards-reads-the-project-and-reverts-on-failure", async () => {
    seedProject(LEVELS, [], { checklistOnCards: false })
    const { api } = levelsApi()
    api.patch.mockRejectedValue(new Error("nope"))
    renderLevels(api)
    const box = screen.getByTestId("levels.show-on-cards") as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    await waitFor(() => expect(screen.getByTestId("levels.show-on-cards-error")).toBeTruthy())
    expect(api.patch).toHaveBeenCalledWith("/projects/p1", { checklistOnCards: true })
    expect(projectStore.project("p1")?.checklistOnCards).toBe(false)
    expect(box.checked).toBe(false)
  })
})
