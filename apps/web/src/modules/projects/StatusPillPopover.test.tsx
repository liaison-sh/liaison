// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { projectStore, type Task } from "~/modules/projects/project-store"
import { StatusPillPopover } from "./StatusPillPopover"

const baseTask: Task = {
  id: "t1",
  number: 1,
  projectId: "p1",
  parentTaskId: null,
  statusId: "s1",
  title: "First task",
  description: null,
  assigneeId: null,
  priority: "normal",
  dueDate: null,
  startDate: null,
  position: 1,
  blocked: false,
  completedAt: null,
  threadId: "thread-1",
  createdBy: "u1",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
}

const statuses = [
  { id: "s1", projectId: "p1", label: "todo", color: null, order: 1, terminal: false },
  { id: "s2", projectId: "p1", label: "done", color: null, order: 2, terminal: true },
]

describe("StatusPillPopover", () => {
  beforeEach(() => {
    projectStore._resetForTest()
    projectStore._setForTest({
      projectId: "p1",
      current: {
        id: "p1",
        name: "Alpha",
        description: null,
        icon: null,
        color: null,
        ownerId: "u1",
        archivedAt: null,
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
        statuses,
      },
      tasks: [baseTask],
    })
  })

  it("echoes a successful status change into the project store immediately", async () => {
    const api = {
      patch: vi.fn().mockResolvedValue({
        ...baseTask,
        statusId: "s2",
        updatedAt: "2026-05-02T00:00:00.000Z",
      }),
    } as any

    render(() => (
      <StatusPillPopover
        api={api}
        projectId="p1"
        taskId="t1"
        current={statuses[0]!}
        statuses={statuses}
      />
    ))

    fireEvent.click(screen.getByTestId("status-pill-popover.trigger"))
    const items = screen.getAllByTestId("status-pill-popover.item")
    fireEvent.click(items.find((i) => i.getAttribute("data-status-id") === "s2")!)

    await waitFor(() => {
      expect(projectStore.task("t1")?.statusId).toBe("s2")
    })
    expect(projectStore.task("t1")?.updatedAt).toBe("2026-05-02T00:00:00.000Z")
    expect(api.patch).toHaveBeenCalledWith("/projects/p1/tasks/t1", { statusId: "s2" })
  })
})
