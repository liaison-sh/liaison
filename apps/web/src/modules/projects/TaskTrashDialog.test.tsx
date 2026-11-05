// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { type ProjectDetail, projectStore } from "~/modules/projects/project-store"
import { TaskTrashDialog } from "~/modules/projects/TaskTrashDialog"
import { ApiContext } from "~/modules/shell/ApiContext"

vi.mock("~/modules/shell/toast-store", () => ({
  addToast: vi.fn(),
}))

const project = (): ProjectDetail => ({
  id: "p1",
  name: "Bug Tracker",
  description: null,
  icon: null,
  color: null,
  ownerId: "u1",
  archivedAt: null,
  createdAt: "2026-05-06T00:00:00Z",
  updatedAt: "2026-05-06T00:00:00Z",
  statuses: [],
})

function binnedTask(id: string, title: string) {
  return {
    id,
    projectId: "p1",
    title,
    description: null,
    statusId: "s1",
    threadId: `thread-${id}`,
    parentTaskId: null,
    assigneeId: null,
    priority: "normal",
    dueDate: null,
    startDate: null,
    blocked: false,
    createdBy: "u1",
    createdAt: "2026-05-06T00:00:00Z",
    updatedAt: "2026-05-06T00:00:00Z",
  }
}

beforeEach(() => {
  projectStore._resetForTest()
  projectStore._setForTest({ projectId: "p1", current: project(), tasks: [] })
  vi.clearAllMocks()
})

describe("TaskTrashDialog", () => {
  it("lists only the binned tasks, asking the API for archived=only", async () => {
    const get = vi.fn().mockResolvedValue({ items: [binnedTask("t1", "deleted one")] })
    const api = { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn(), getEnvelope: vi.fn() } as any

    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <TaskTrashDialog projectId="p1" refreshKey={1} />
      </ApiContext.Provider>
    ))

    await waitFor(() => expect(getByTestId("task-trash.row-t1")).toBeTruthy())
    expect(get).toHaveBeenCalledWith("/projects/p1/tasks?archived=only")
  })

  it("says so when the bin is empty rather than rendering a blank panel", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({ items: [] }),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any

    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <TaskTrashDialog projectId="p1" refreshKey={1} />
      </ApiContext.Provider>
    ))

    await waitFor(() => expect(getByTestId("task-trash.empty")).toBeTruthy())
  })

  it("puts a task back and drops it from the bin", async () => {
    const post = vi.fn().mockResolvedValue({ id: "t1" })
    const api = {
      get: vi.fn().mockResolvedValue({ items: [binnedTask("t1", "deleted one")] }),
      post,
      patch: vi.fn(),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any

    const { getByTestId, queryByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <TaskTrashDialog projectId="p1" refreshKey={1} />
      </ApiContext.Provider>
    ))

    await waitFor(() => expect(getByTestId("task-trash.restore-t1")).toBeTruthy())
    fireEvent.click(getByTestId("task-trash.restore-t1"))

    await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/p1/tasks/t1/restore", {}))
    await waitFor(() => expect(queryByTestId("task-trash.row-t1")).toBeNull())
  })

  it("surfaces a failed restore instead of pretending the task came back", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({ items: [binnedTask("t1", "deleted one")] }),
      post: vi.fn().mockRejectedValue(new Error("500")),
      patch: vi.fn(),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any

    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <TaskTrashDialog projectId="p1" refreshKey={1} />
      </ApiContext.Provider>
    ))

    await waitFor(() => expect(getByTestId("task-trash.restore-t1")).toBeTruthy())
    fireEvent.click(getByTestId("task-trash.restore-t1"))

    const { addToast } = await import("~/modules/shell/toast-store")
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })),
    )
    // The row stays: it is still in the bin.
    expect(getByTestId("task-trash.row-t1")).toBeTruthy()
  })
})
