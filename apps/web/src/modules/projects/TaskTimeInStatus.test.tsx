// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import type { ProjectStatus } from "./project-store"
import type { TaskTransition } from "./TaskStatusHistory"
import { TaskAutomationRuns, TaskStatusSince, TaskTimeStrip } from "./TaskTimeInStatus"
import { type EntityRun, shortDuration, taskDeadline, timeInStatuses } from "./task-time"

afterEach(cleanup)

const DAY = 86_400_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const t = (k: string, p?: Record<string, unknown>) => `${k}:${JSON.stringify(p ?? {})}`

const STATUSES: ProjectStatus[] = [
  { id: "in", projectId: "p", label: "Inbound", color: "#64748b", order: 0, terminal: false },
  { id: "rx", projectId: "p", label: "Received", color: "#3b82f6", order: 1, terminal: false },
]

function tr(id: string, from: string | null, to: string, at: string): TaskTransition {
  return {
    id,
    fromStatusId: from,
    fromStatusLabel: null,
    toStatusId: to,
    toStatusLabel: to,
    actorType: "user",
    actorId: null,
    actorName: null,
    agentId: null,
    routineId: null,
    at,
  }
}

describe("task time", () => {
  it("sums the time in each status, in the order first entered", () => {
    const now = Date.parse("2026-11-13T12:00:00Z")
    const segs = timeInStatuses(
      [
        tr("3", "rx", "in", "2026-11-13T00:00:00Z"),
        tr("2", "in", "rx", "2026-11-12T00:00:00Z"),
        tr("1", null, "in", "2026-11-11T12:00:00Z"),
      ],
      now,
    )
    expect(segs).toEqual([
      { statusId: "in", label: "in", ms: 0.5 * DAY + 0.5 * DAY },
      { statusId: "rx", label: "rx", ms: DAY },
    ])
  })

  it("says a duration in minutes, hours or days", () => {
    expect(shortDuration(5 * 60_000, t, "en")).toBe('projects.taskTime.minutes:{"n":"5"}')
    expect(shortDuration(5 * 3_600_000, t, "en")).toBe('projects.taskTime.hours:{"n":"5"}')
    expect(shortDuration(1.5 * DAY, t, "en")).toBe('projects.taskTime.days:{"n":"1.5"}')
    expect(shortDuration(12 * DAY, t, "en")).toBe('projects.taskTime.days:{"n":"12"}')
  })

  it("an automation's wait on the task is its deadline: ahead while it waits, passed once it held", () => {
    const run = (state: "waiting" | "done" | "skipped", ranAt = ago(DAY)): EntityRun => ({
      id: "r",
      routineId: "x",
      routineTitle: "Deadline",
      ranAt,
      status: state === "waiting" ? "waiting" : "succeeded",
      steps: [{ id: "w", type: "wait", state, output: { deadline: "2026-11-20T09:00:00Z" } }],
    })
    expect(taskDeadline([run("waiting")], ago(2 * DAY))?.kind).toBe("ahead")
    expect(taskDeadline([run("done")], ago(2 * DAY))?.kind).toBe("passed")
    expect(taskDeadline([run("skipped")], ago(2 * DAY))).toBeNull()
    // A run from before the task entered its status says nothing about this stay.
    expect(taskDeadline([run("waiting", ago(5 * DAY))], ago(2 * DAY))).toBeNull()
    expect(taskDeadline(undefined, null)).toBeNull()
  })
})

describe("TaskTimeInStatus", () => {
  it("says how long in the status, and the SLA only when an automation keeps one", () => {
    render(() => <TaskStatusSince since={ago(6 * DAY)} deadline={null} />)
    expect(screen.getByTestId("task-detail.status-since").textContent).toBe("for 6 d")
    expect(screen.queryByTestId("task-detail.sla")).toBeNull()
    cleanup()
    render(() => (
      <TaskStatusSince
        since={ago(6 * DAY)}
        deadline={{ kind: "passed", at: ago(DAY), routineTitle: "Deadline" }}
      />
    ))
    const line = screen.getByTestId("task-detail.status-since")
    expect(line.className).toContain("text-error")
    expect(screen.getByTestId("task-detail.sla").textContent).toMatch(/SLA passed/)
  })

  it("an ahead deadline whose time is past reads as passed, in the error tone", () => {
    render(() => (
      <TaskStatusSince
        since={ago(6 * DAY)}
        deadline={{ kind: "ahead", at: ago(2 * 3_600_000), routineTitle: "Deadline" }}
      />
    ))
    expect(screen.getByTestId("task-detail.status-since").className).toContain("text-error")
    expect(screen.getByTestId("task-detail.sla").dataset.sla).toBe("passed")
    expect(screen.getByTestId("task-detail.sla").textContent).toMatch(/SLA passed/)
  })

  it("a near deadline keeps its words in the text colour, with a warning dot", () => {
    render(() => (
      <TaskStatusSince
        since={ago(6 * DAY)}
        deadline={{
          kind: "ahead",
          at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
          routineTitle: "Deadline",
        }}
      />
    ))
    const line = screen.getByTestId("task-detail.status-since")
    expect(line.className).not.toContain("text-warning")
    expect(line.className).toContain("text-text-primary")
    expect(screen.getByTestId("task-detail.sla-soon")).toBeTruthy()
  })

  it("draws where the time went in the statuses' colours", () => {
    render(() => (
      <TaskTimeStrip
        statuses={STATUSES}
        transitions={[tr("2", "in", "rx", ago(DAY)), tr("1", null, "in", ago(1.5 * DAY))]}
      />
    ))
    expect(screen.getByTestId("task-time-strip.segment-rx").getAttribute("style")).toContain(
      "rgb(59, 130, 246)",
    )
    expect(screen.getByTestId("task-time-strip.label-in").textContent).toBe("Inbound 12 h")
  })

  it("lists the automations that ran on the task, hidden when none did", () => {
    render(() => <TaskAutomationRuns runs={[]} />)
    expect(screen.queryByTestId("task-detail.automations")).toBeNull()
    cleanup()
    render(() => (
      <TaskAutomationRuns
        runs={[
          { id: "a", routineId: "x", routineTitle: "Route it", ranAt: ago(DAY), status: "failed" },
        ]}
      />
    ))
    const row = screen.getByTestId("task-detail.automation-run-a")
    expect(row.textContent).toContain("Route it")
    expect(row.querySelector(".bg-error")).not.toBeNull()
  })
})
