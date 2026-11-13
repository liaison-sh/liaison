// SPDX-License-Identifier: FSL-1.1-ALv2
import { routineFlowSchema, routineNameSchema } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resetRoutinesStore } from "~/modules/agent/routines-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { ProjectAutomations } from "./ProjectAutomations"

const { openTab } = vi.hoisted(() => ({ openTab: vi.fn() }))
vi.mock("~/modules/shell/tab-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/tab-store")>()),
  openTab,
}))

afterEach(() => {
  cleanup()
  resetRoutinesStore()
})

const P_ID = "44444444-4444-4444-8444-444444444444"
const S_TODO = "11111111-1111-4111-8111-111111111111"
const S_DONE = "33333333-3333-4333-8333-333333333333"
const U_ANA = "55555555-5555-4555-8555-555555555555"

const PROJECT = {
  id: P_ID,
  name: "Website",
  statuses: [
    { id: S_TODO, label: "Todo", order: 0 },
    { id: S_DONE, label: "Done", order: 1 },
  ],
  fields: [],
}

const TEMPLATE = {
  appName: "projects",
  templateKey: "assign-on-status",
  description: "When a task reaches a status, assign it and tell the assignee.",
  kind: "event",
  enabled: false,
  event: "projects:task:status_changed",
  scopes: ["projects:tasks:read", "projects:tasks:write", "kernel:threads:write"],
  prompt: "Assign and tell the assignee.",
  eventFilter: { projectId: "{{projectId}}", toStatusId: "{{status:todo}}" },
  flow: {
    version: 1,
    steps: [
      { id: "assign", type: "action", action: "assign", args: { to: "{{owner}}" } },
      {
        id: "tell",
        type: "action",
        action: "message",
        args: { to: "{{task.assigneeId}}", text: "Yours: {{task.title}} {{task.url}}" },
      },
    ],
  },
}

const ROUTINE = {
  id: "r-1",
  orgId: "o",
  ownerUserId: "u",
  ownerAgentId: "a",
  name: "notify-on-status-website",
  description: "Tell people",
  kind: "event",
  cron: null,
  timezone: null,
  runAt: null,
  event: "projects:task:status_changed",
  prompt: "p",
  outputThreadId: null,
  scopes: [],
  visibility: "personal",
  eventFilter: { projectId: P_ID, toStatusId: S_DONE },
  flow: TEMPLATE.flow,
  enabled: true,
  status: "active",
  lastRunAt: null,
  lastRunStatus: null,
  lastRunError: null,
  createdAt: "2026-11-13T00:00:00Z",
  updatedAt: "2026-11-13T00:00:00Z",
}

function setup(routines: unknown[]) {
  const api = {
    get: vi.fn(async (path: string) => {
      if (path === `/projects/${P_ID}`) return PROJECT
      if (path === `/agent/routines?projectId=${P_ID}`) return routines
      if (path === "/agent/routines/templates") {
        return [
          TEMPLATE,
          {
            appName: "kernel",
            templateKey: "morning-brief",
            description: "x",
            kind: "recurring",
            enabled: false,
          },
        ]
      }
      return []
    }),
    getEnvelope: vi.fn(async () => ({ data: [{ id: U_ANA, name: "Ana Lima", email: "ana@x" }] })),
    post: vi.fn(async (_path: string, body: Record<string, unknown>) => ({
      ...ROUTINE,
      ...body,
      id: "r-2",
    })),
    put: vi.fn(async (_path: string, body: Record<string, unknown>) => ({ ...ROUTINE, ...body })),
    patch: vi.fn(),
    delete: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <ProjectAutomations entityId={P_ID} />
    </ApiContext.Provider>
  ))
  return api
}

describe("ProjectAutomations", () => {
  it("lists the project's routines by projectId, with the trigger in words and on/off", async () => {
    const api = setup([ROUTINE])
    await waitFor(() =>
      expect(screen.getByTestId("project-automations.row-r-1")).toBeInTheDocument(),
    )
    expect(api.get).toHaveBeenCalledWith(`/agent/routines?projectId=${P_ID}`)
    expect(screen.getByTestId("project-automations.row-r-1").textContent).toContain(
      "When a task in Website moves to Done",
    )
    expect(screen.getByTestId("project-automations.last-run-r-1").textContent).toBe(
      "Has not run yet",
    )
    fireEvent.click(screen.getByTestId("project-automations.toggle-r-1"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/agent/routines/r-1", { enabled: false }),
    )
  })

  it("a row shows the routine's human name and opens it on its owner agent's Routines tab", async () => {
    openTab.mockClear()
    setup([{ ...ROUTINE, title: "Tell people when done · Website" }])
    await waitFor(() =>
      expect(screen.getByTestId("project-automations.open-r-1")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("project-automations.open-r-1").textContent).toBe(
      "Tell people when done · Website",
    )
    fireEvent.click(screen.getByTestId("project-automations.open-r-1"))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Tell people when done · Website",
        routePath: expect.stringMatching(/^\/agents\/.+\/routines\?selected=r-1$/),
      }),
    )
  })

  it("a routine without a human name shows its identifier", async () => {
    setup([ROUTINE])
    await waitFor(() =>
      expect(screen.getByTestId("project-automations.open-r-1").textContent).toBe(
        "notify-on-status-website",
      ),
    )
  })

  it("explains an automation in one line when there is none", async () => {
    setup([])
    await waitFor(() => expect(screen.getByTestId("project-automations.empty")).toBeInTheDocument())
    expect(screen.getByTestId("project-automations.explainer").textContent).toMatch(/automation/i)
  })

  it("a template opens the prefilled editor (project and statuses resolved) and saves through create", async () => {
    const api = setup([])
    await waitFor(() => expect(screen.getByTestId("project-automations.empty")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("project-automations.new"))
    await waitFor(() =>
      expect(
        screen.getByTestId("project-automations.template-assign-on-status"),
      ).toBeInTheDocument(),
    )
    // Only the projects app's flow templates are offered.
    expect(screen.queryByTestId("project-automations.template-morning-brief")).toBeNull()
    fireEvent.click(screen.getByTestId("project-automations.template-assign-on-status"))
    await waitFor(() =>
      expect(screen.getByTestId("project-automations.editor")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("routine-flow-trigger-text").textContent).toBe(
      "When a task in Website moves to Todo",
    )
    // A human name, "<template> · <project>", never the routine's identifier.
    expect((screen.getByTestId("project-automations.name") as HTMLInputElement).value).toBe(
      "When a status is reached, assign · Website",
    )
    // The editor keeps the message's raw text, placeholders and all (view mode shows words).
    expect(screen.getByTestId("routine-flow-step-tell-text").textContent).toBe(
      "Yours: {{task.title}} {{task.url}}",
    )
    fireEvent.input(screen.getByTestId("project-automations.name"), {
      target: { value: "Assign new work · Website" },
    })
    // Assign to Ana instead of the owner.
    await waitFor(() => expect(api.getEnvelope).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId("routine-flow-step-assign-edit"))
    await waitFor(() =>
      expect(screen.getByTestId("flow-step-assign-person").querySelectorAll("option").length).toBe(
        3,
      ),
    )
    fireEvent.change(screen.getByTestId("flow-step-assign-person"), { target: { value: U_ANA } })
    fireEvent.click(screen.getByTestId("project-automations.save"))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    const [path, body] = api.post.mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toBe("/agent/routines")
    expect(body).toMatchObject({
      title: "Assign new work · Website",
      kind: "event",
      event: "projects:task:status_changed",
      enabled: true,
      eventFilter: { projectId: P_ID, toStatusId: S_TODO },
      scopes: TEMPLATE.scopes,
    })
    expect(body.flow).toEqual({
      version: 1,
      steps: [
        { id: "assign", type: "action", action: "assign", args: { to: U_ANA } },
        TEMPLATE.flow.steps[1],
      ],
    })
    expect(routineFlowSchema.safeParse(body.flow).success).toBe(true)
    // The identifier stays kebab-case, made from the template and project.
    expect(body.name).toMatch(/^assign-on-status-website-[a-z0-9]+$/)
    expect(routineNameSchema.safeParse(body.name).success).toBe(true)
    // Back on the list, which reads itself again.
    await waitFor(() => expect(screen.getByTestId("project-automations.list")).toBeInTheDocument())
  })

  it("a status the project lacks is left for the person to pick, and Save waits for it", async () => {
    PROJECT.statuses[0]!.label = "Inbox"
    try {
      const api = setup([])
      await waitFor(() =>
        expect(screen.getByTestId("project-automations.empty")).toBeInTheDocument(),
      )
      fireEvent.click(screen.getByTestId("project-automations.new"))
      await waitFor(() =>
        expect(
          screen.getByTestId("project-automations.template-assign-on-status"),
        ).toBeInTheDocument(),
      )
      fireEvent.click(screen.getByTestId("project-automations.template-assign-on-status"))
      await waitFor(() =>
        expect(screen.getByTestId("project-automations.missing")).toBeInTheDocument(),
      )
      expect(screen.getByTestId("project-automations.problem").textContent).toBe(
        "Choose the status that starts the automation.",
      )
      fireEvent.change(screen.getByTestId("routine-flow-trigger-to"), { target: { value: S_DONE } })
      await waitFor(() => expect(screen.queryByTestId("project-automations.problem")).toBeNull())
      fireEvent.click(screen.getByTestId("project-automations.save"))
      await waitFor(() => expect(api.post).toHaveBeenCalled())
    } finally {
      PROJECT.statuses[0]!.label = "Todo"
    }
  })
})
