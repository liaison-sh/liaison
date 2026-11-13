// SPDX-License-Identifier: FSL-1.1-ALv2
import type { RoutineFlow } from "@liaison/shared"
import { routineFlowSchema } from "@liaison/shared"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import FlowList from "./FlowList"
import type { FlowEventFilter, FlowProject } from "./flow-model"

afterEach(cleanup)

const S_TODO = "11111111-1111-4111-8111-111111111111"
const S_DOING = "22222222-2222-4222-8222-222222222222"
const S_DONE = "33333333-3333-4333-8333-333333333333"
const P_ID = "44444444-4444-4444-8444-444444444444"
const U_ANA = "55555555-5555-4555-8555-555555555555"

const PROJECT: FlowProject = {
  id: P_ID,
  name: "Website",
  statuses: [
    { id: S_TODO, label: "To do" },
    { id: S_DOING, label: "Doing" },
    { id: S_DONE, label: "Done" },
  ],
  fields: [{ key: "kind", label: "Kind", type: "choice", choices: ["Bug", "Idea"] }],
}
const PEOPLE = [{ id: U_ANA, name: "Ana Lima" }]

const FILTER: FlowEventFilter = { projectId: P_ID, fromStatusId: S_TODO, toStatusId: S_DOING }

const FLOW: RoutineFlow = {
  version: 1,
  steps: [
    { id: "assign", type: "action", action: "assign", args: { to: U_ANA } },
    {
      id: "tell",
      type: "action",
      action: "message",
      args: { to: "{{task.assigneeId}}", text: "Yours: {{task.title}}" },
      if: { field: "fields.kind", op: "eq", value: "Bug" },
    },
    {
      id: "late",
      type: "wait",
      for: { amount: 2, unit: "working_days" },
      until: { op: "status_unchanged_since_trigger" },
      if: { field: "fields.kind", op: "eq", value: "Bug" },
    },
    {
      id: "agent",
      type: "agent",
      prompt: "Write the customer an update",
      outcomes: [
        { kind: "message_posted", to: "{{task.assigneeId}}" },
        { kind: "field_set", field: "kind" },
      ],
    },
  ],
}

function renderList(mode: "view" | "edit" | "run", extra: Record<string, unknown> = {}) {
  const [flow, setFlow] = createSignal<RoutineFlow>(structuredClone(FLOW))
  const [filter, setFilter] = createSignal<FlowEventFilter | null>({ ...FILTER })
  render(() => (
    <ApiContext.Provider value={{} as never}>
      <FlowList
        flow={flow()}
        event="projects:task:status_changed"
        eventFilter={filter()}
        project={PROJECT}
        people={PEOPLE}
        mode={mode}
        onChange={setFlow}
        onFilterChange={setFilter}
        {...extra}
      />
    </ApiContext.Provider>
  ))
  return { flow, filter }
}

describe("FlowList", () => {
  it("says the trigger in words, one card per step, the shared if indented once, outcome badges", () => {
    renderList("view")
    expect(screen.getByTestId("routine-flow-trigger-text").textContent).toBe(
      "When a task in Website moves from To do to Doing",
    )
    expect(screen.getByTestId("routine-flow-step-assign-title").textContent).toBe(
      "Assign to Ana Lima",
    )
    expect(screen.getByTestId("routine-flow-step-tell-title").textContent).toBe(
      "Send the task's assignee a message",
    )
    expect(screen.getByTestId("routine-flow-step-late-title").textContent).toBe(
      "Wait 2 working days",
    )
    // The two steps sharing the same `if` are indented under ONE "If" line.
    expect(screen.getByTestId("routine-flow-step-tell").dataset.indented).toBe("true")
    expect(screen.getByTestId("routine-flow-step-late").dataset.indented).toBe("true")
    expect(screen.getByTestId("routine-flow-step-assign").dataset.indented).toBe("false")
    expect(screen.getByTestId("routine-flow-if-tell").textContent).toBe("If Kind is Bug")
    expect(screen.queryByTestId("routine-flow-if-late")).toBeNull()
    expect(screen.getByTestId("routine-flow-step-agent-outcome-0").textContent).toBe(
      "Message to the task's assignee",
    )
    expect(screen.getByTestId("routine-flow-step-agent-outcome-1").textContent).toBe("Kind set")
    // View mode has no edit controls.
    expect(screen.queryByTestId("routine-flow-step-assign-edit")).toBeNull()
  })

  it("view mode names a message's placeholders as words; edit mode keeps the raw text", () => {
    renderList("view")
    const text = screen.getByTestId("routine-flow-step-tell-text")
    expect(text.textContent).toBe("Yours: task title")
    const tokens = screen.getAllByTestId("routine-flow-step-tell-token")
    expect(tokens.map((t) => t.dataset.token)).toEqual(["{{task.title}}"])
    expect(text.textContent).not.toContain("{{")
    cleanup()
    renderList("edit")
    expect(screen.getByTestId("routine-flow-step-tell-text").textContent).toBe(
      "Yours: {{task.title}}",
    )
  })

  it("every known placeholder has words, a project field by its label, an unknown one stays", () => {
    const flow: RoutineFlow = {
      version: 1,
      steps: [
        {
          id: "tell",
          type: "action",
          action: "comment",
          args: {
            text: "{{task.key}} {{task.url}} {{task.assigneeName}} {{task.fields.kind}} {{task.nope}}",
          },
        },
      ],
    }
    render(() => (
      <ApiContext.Provider value={{} as never}>
        <FlowList flow={flow} event={null} eventFilter={null} project={PROJECT} mode="view" />
      </ApiContext.Provider>
    ))
    expect(screen.getByTestId("routine-flow-step-tell-text").textContent).toBe(
      "task key task link assignee field: Kind {{task.nope}}",
    )
  })

  it("the Insert menu puts a placeholder in at the caret", () => {
    const { flow } = renderList("edit")
    fireEvent.click(screen.getByTestId("routine-flow-step-tell-edit"))
    const area = screen.getByTestId("flow-step-tell-text") as HTMLTextAreaElement
    area.setSelectionRange(6, 6) // after "Yours:"
    const menu = screen.getByTestId("flow-step-tell-text-insert") as HTMLSelectElement
    const offered = [...menu.querySelectorAll("option")].map((o) => o.textContent)
    expect(offered).toEqual([
      "Insert…",
      "task title",
      "task key",
      "task link",
      "assignee",
      "field: Kind",
    ])
    fireEvent.change(menu, { target: { value: "{{task.url}}" } })
    const tell = flow().steps[1]
    expect(tell?.type === "action" && tell.action === "message" ? tell.args.text : null).toBe(
      "Yours: {{task.url}} {{task.title}}",
    )
    expect(menu.value).toBe("")
  })

  it("a field filter on the trigger reads as its own 'and <field> is <value>' line", () => {
    renderList("view", {
      eventFilter: { projectId: P_ID, toStatusId: S_DONE, fields: { kind: ["Bug", "Idea"] } },
    })
    expect(screen.getByTestId("routine-flow-trigger-text").textContent).toBe(
      "When a task in Website moves to Done",
    )
    expect(screen.getByTestId("routine-flow-trigger-field-0").textContent).toBe(
      "and Kind is Bug or Idea",
    )
  })

  it("edits produce the right flow JSON: action kind, status pick, wait amount, move, remove, add", () => {
    const { flow, filter } = renderList("edit")
    // Change the first step to "Change its status" -> Done.
    fireEvent.click(screen.getByTestId("routine-flow-step-assign-edit"))
    fireEvent.change(screen.getByTestId("flow-step-assign-action"), {
      target: { value: "set_status" },
    })
    fireEvent.change(screen.getByTestId("flow-step-assign-status"), { target: { value: S_DONE } })
    expect(flow().steps[0]).toEqual({
      id: "assign",
      type: "action",
      action: "set_status",
      args: { statusId: S_DONE },
    })
    // The wait: 3 working hours.
    fireEvent.click(screen.getByTestId("routine-flow-step-late-edit"))
    fireEvent.input(screen.getByTestId("flow-step-late-amount"), { target: { value: "3" } })
    fireEvent.change(screen.getByTestId("flow-step-late-unit"), {
      target: { value: "working_hours" },
    })
    expect(flow().steps[2]).toMatchObject({ for: { amount: 3, unit: "working_hours" } })
    // Move the agent step up, remove the message step.
    fireEvent.click(screen.getByTestId("routine-flow-step-agent-up"))
    expect(flow().steps.map((s) => s.id)).toEqual(["assign", "tell", "agent", "late"])
    fireEvent.click(screen.getByTestId("routine-flow-step-tell-remove"))
    expect(flow().steps.map((s) => s.id)).toEqual(["assign", "agent", "late"])
    // Add a notify action, pick Ana, write the text.
    fireEvent.click(screen.getByTestId("routine-flow-add-action"))
    const added = flow().steps[3]
    expect(added?.id).toBe("action-1")
    fireEvent.click(screen.getByTestId(`flow-step-action-1-people-${U_ANA}`))
    fireEvent.input(screen.getByTestId("flow-step-action-1-text"), {
      target: { value: "Heads up" },
    })
    expect(flow().steps[3]).toEqual({
      id: "action-1",
      type: "action",
      action: "notify",
      args: { to: ["{{owner}}", U_ANA], text: "Heads up" },
    })
    // The trigger's target status.
    fireEvent.change(screen.getByTestId("routine-flow-trigger-to"), { target: { value: S_DONE } })
    expect(filter()?.toStatusId).toBe(S_DONE)
    fireEvent.change(screen.getByTestId("routine-flow-trigger-from"), {
      target: { value: "__new" },
    })
    expect(filter()?.fromStatusId).toBeNull()
    // The result is a valid flow for the server.
    expect(routineFlowSchema.safeParse(flow()).success).toBe(true)
  })

  it("an agent step's outcomes are edited in place", () => {
    const { flow } = renderList("edit")
    fireEvent.click(screen.getByTestId("routine-flow-step-agent-edit"))
    fireEvent.click(screen.getByTestId("flow-step-agent-outcome-1-remove"))
    fireEvent.click(screen.getByTestId("flow-step-agent-outcome-add"))
    fireEvent.change(screen.getByTestId("flow-step-agent-outcome-1-kind"), {
      target: { value: "status_is" },
    })
    fireEvent.change(screen.getByTestId("flow-step-agent-outcome-1-status"), {
      target: { value: S_DONE },
    })
    const agent = flow().steps[3]
    expect(agent?.type === "agent" ? agent.outcomes : null).toEqual([
      { kind: "message_posted", to: "{{task.assigneeId}}" },
      { kind: "status_is", status: S_DONE },
    ])
  })

  it("the run overlay shows each step's state, note and time; a step never reached is pending", () => {
    renderList("run", {
      runSteps: [
        {
          id: "assign",
          state: "done",
          startedAt: "2026-11-13T09:00:00Z",
          endedAt: "2026-11-13T09:00:01Z",
          note: "Assigned to Ana Lima",
        },
        { id: "tell", state: "skipped", note: "The condition did not hold" },
        { id: "late", state: "waiting", startedAt: "2026-11-13T09:00:02Z", note: null },
        { id: "agent", state: "flagged", note: "Missing: Kind set" },
      ],
    })
    expect(screen.getByTestId("routine-flow-step-assign-state").textContent).toBe("Done")
    expect(screen.getByTestId("routine-flow-step-assign-note").textContent).toBe(
      "Assigned to Ana Lima",
    )
    expect(screen.getByTestId("routine-flow-step-assign-time")).toBeInTheDocument()
    expect(screen.getByTestId("routine-flow-step-tell-state").textContent).toBe("Skipped")
    expect(screen.getByTestId("routine-flow-step-late-state").textContent).toBe("Waiting")
    expect(screen.getByTestId("routine-flow-step-agent-state").textContent).toBe("Flagged")
    cleanup()
    renderList("run", { runSteps: [] })
    expect(screen.getByTestId("routine-flow-step-agent-state").textContent).toBe("Not reached")
  })
})
