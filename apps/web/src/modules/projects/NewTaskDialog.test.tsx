// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { editorOf, typeInto } from "~/modules/editor/test-helpers"
import { NewTaskDialog } from "~/modules/projects/NewTaskDialog"
import { projectStore, type Task } from "~/modules/projects/project-store"
import { ApiContext } from "~/modules/shell/ApiContext"

describe("NewTaskDialog", () => {
  it("creates the task with its description written as markdown", async () => {
    const post = vi.fn().mockResolvedValue({ id: "t9" })
    const onOpenChange = vi.fn()
    render(() => (
      <ApiContext.Provider value={{} as ApiClient}>
        <NewTaskDialog
          open
          onOpenChange={onOpenChange}
          api={{ post } as unknown as ApiClient}
          projectId="p1"
          statuses={[]}
        />
      </ApiContext.Provider>
    ))
    fireEvent.input(screen.getByTestId("new-task-dialog.title"), {
      target: { value: "Relancer Cribbs" },
    })
    const field = await screen.findByTestId("new-task-dialog.description")
    typeInto(editorOf(field), "[ ] Vérifier le ++registre++")
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true })
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/projects/p1/tasks", {
        title: "Relancer Cribbs",
        description: "- [ ] Vérifier le ++registre++",
        statusId: undefined,
        parentTaskId: undefined,
      }),
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("NewTaskDialog merges the created row (LIF-12)", () => {
  const created = (): Task => ({
    id: "t9",
    number: 12,
    key: "BUG-12",
    projectId: "p1",
    parentTaskId: null,
    statusId: "s1",
    title: "Ship it",
    description: null,
    assigneeId: null,
    priority: "normal",
    dueDate: null,
    startDate: null,
    position: 1000,
    blocked: false,
    completedAt: null,
    threadId: "th9",
    createdBy: "u1",
    createdAt: "2026-10-15T10:00:00.000Z",
    updatedAt: "2026-10-15T10:00:00.000Z",
  })

  const submit = async (post: ReturnType<typeof vi.fn>) => {
    render(() => (
      <ApiContext.Provider value={{} as ApiClient}>
        <NewTaskDialog
          open
          onOpenChange={vi.fn()}
          api={{ post } as unknown as ApiClient}
          projectId="p1"
          statuses={[]}
        />
      </ApiContext.Provider>
    ))
    fireEvent.input(screen.getByTestId("new-task-dialog.title"), {
      target: { value: "Ship it" },
    })
    const field = await screen.findByTestId("new-task-dialog.description")
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true })
    await waitFor(() => expect(post).toHaveBeenCalled())
  }

  it("the key shows at once, and a later WS echo does not duplicate the row", async () => {
    projectStore._resetForTest()
    projectStore._setForTest({ projectId: "p1", tasks: [] })
    await submit(vi.fn().mockResolvedValue(created()))
    await waitFor(() => expect(projectStore.tasksFor("p1").map((t) => t.key)).toEqual(["BUG-12"]))
    projectStore.handleTaskEvent("created", created())
    expect(projectStore.tasksFor("p1")).toHaveLength(1)
  })

  it("an echo that arrived before the response does not duplicate the row", async () => {
    projectStore._resetForTest()
    projectStore._setForTest({ projectId: "p1", tasks: [] })
    projectStore.handleTaskEvent("created", created())
    await submit(vi.fn().mockResolvedValue(created()))
    await waitFor(() => expect(projectStore.tasksFor("p1").map((t) => t.key)).toEqual(["BUG-12"]))
    expect(projectStore.tasksFor("p1")).toHaveLength(1)
  })

  it("asks for the project's required fields and sends them with the task", async () => {
    const post = vi.fn().mockResolvedValue({ id: "t9" })
    render(() => (
      <ApiContext.Provider value={{} as ApiClient}>
        <NewTaskDialog
          open
          onOpenChange={vi.fn()}
          api={{ post } as unknown as ApiClient}
          projectId="p1"
          statuses={[]}
          fields={[
            { key: "serial", label: "Serial", type: "text", required: true },
            { key: "kind", label: "Kind", type: "choice", choices: ["A", "B"], required: true },
            { key: "note", label: "Note", type: "text" },
          ]}
        />
      </ApiContext.Provider>
    ))
    // Only the required ones are asked for.
    expect(screen.getByTestId("new-task-dialog.field-serial")).toBeTruthy()
    expect(screen.getByTestId("new-task-dialog.field-kind")).toBeTruthy()
    expect(screen.queryByTestId("new-task-dialog.field-note")).toBeNull()
    fireEvent.input(screen.getByTestId("new-task-dialog.title"), {
      target: { value: "Replace screen" },
    })
    fireEvent.click(screen.getByTestId("new-task-dialog.submit"))
    expect(screen.getByTestId("new-task-dialog.error").textContent).toBe(
      "Serial: This field is required.",
    )
    expect(post).not.toHaveBeenCalled()

    fireEvent.input(screen.getByTestId("new-task-dialog.field-input-serial"), {
      target: { value: "SN-42" },
    })
    fireEvent.click(screen.getByTestId("new-task-dialog.field-input-kind-choice-1"))
    fireEvent.click(screen.getByTestId("new-task-dialog.submit"))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/projects/p1/tasks", {
        title: "Replace screen",
        description: undefined,
        statusId: undefined,
        parentTaskId: undefined,
        fields: { serial: "SN-42", kind: "B" },
      }),
    )
  })
})
