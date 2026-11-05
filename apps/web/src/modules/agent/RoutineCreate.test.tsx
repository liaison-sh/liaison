// SPDX-License-Identifier: FSL-1.1-ALv2

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SERVED_MODELS_FIXTURE, SERVED_OPENROUTER_MODEL } from "~/lib/model-groups.fixture"
import { resetCreditsStore } from "~/modules/agent/credits/credits-store"
import { resetNodesStore } from "~/modules/nodes/nodes-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import RoutineCreate from "./RoutineCreate"
import { resetRoutinesStore } from "./routines-store"

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  closeTab: vi.fn(),
  makeTabId: vi.fn(() => "tab-id"),
}))

afterEach(() => {
  resetRoutinesStore()
  resetCreditsStore()
  resetNodesStore()
  vi.mocked(openTab).mockClear()
})

const ENABLED_NODE = {
  id: "n1",
  name: "Studio Mac",
  enabled: true,
  online: true,
  lastSeenAt: null,
  os: "macos",
  appVersion: "0.1.20",
  deviceId: "d1",
  queue: { queued: 0, running: 0 },
  sharedFolderNames: ["liaison-walk-sample"],
  models: [{ id: "claude-haiku-4-5", label: "Haiku 4.5" }],
  levelPins: [],
}

function setup(extra: Record<string, unknown> = {}) {
  const api = {
    // The workspace can run these (GET /credits/models): the picker offers only them.
    get: vi.fn(
      async (path: string): Promise<unknown> =>
        path === "/credits/models"
          ? {
              autoModelKey: null,
              autoResolvedKey: "gemini-flash-latest",
              models: [
                ...SERVED_MODELS_FIXTURE.models.filter(
                  (m) => m.key === "gemini-flash-latest" || m.key === "claude-haiku-4-5",
                ),
                SERVED_OPENROUTER_MODEL,
              ],
            }
          : extra[path],
    ),
    post: vi.fn(async (_p: string, b: any) => ({
      ...b,
      id: "new-routine-id",
      ownerUserId: "u1",
      orgId: "org-1",
      outputThreadId: null,
      enabled: true,
      status: "active",
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    rawPost: vi.fn(),
    rawGet: vi.fn(),
    getEnvelope: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <RoutineCreate />
    </ApiContext.Provider>
  ))
  return api
}

describe("RoutineCreate", () => {
  it("renders a full-surface form, not a modal", () => {
    setup()
    expect(screen.getByTestId("routine-create")).toBeInTheDocument()
    expect(screen.getByTestId("routine-form")).toBeInTheDocument()
    expect(screen.queryByTestId("routines-new-modal")).toBeNull()
  })

  it("defaults to recurring with the schedule picker visible", () => {
    setup()
    expect(screen.getByTestId("routine-kind-recurring")).toHaveAttribute("data-selected", "true")
    expect(screen.getByTestId("schedule-picker")).toBeInTheDocument()
  })

  it("offers a visibility toggle (personal / shared)", () => {
    setup()
    expect(screen.getByTestId("routine-visibility-personal")).toBeInTheDocument()
    expect(screen.getByTestId("routine-visibility-shared")).toBeInTheDocument()
  })

  it("creates a recurring routine and settles onto its tab", async () => {
    const api = setup()
    fireEvent.input(screen.getByTestId("routines-new-name"), {
      target: { value: "Morning Digest" },
    })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), { target: { value: "Hi" } })
    fireEvent.click(screen.getByTestId("routines-new-save"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/agent/routines",
        expect.objectContaining({
          name: "morning-digest",
          kind: "recurring",
          visibility: "personal",
          prompt: "Hi",
        }),
      ),
    )
    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ entityId: "new-routine-id" })),
    )
  })

  // D20: the create form has the same scope picker; nothing is added from the prompt's words.
  it("D20: sends exactly the scopes picked, and none when none are picked", async () => {
    const api = setup({
      "/agent/routines/scope-options": [
        { scope: "boxtal:shipments:read", app: "boxtal", description: "Read shipments" },
        { scope: "tickets:tickets:read", app: "tickets", description: "Read tickets" },
      ],
    })
    fireEvent.input(screen.getByTestId("routines-new-name"), { target: { value: "Returns" } })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), {
      target: { value: "List the inbound returns." },
    })
    fireEvent.click(await screen.findByTestId("routine-scope-add-tickets:tickets:read"))
    fireEvent.click(screen.getByTestId("routines-new-save"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/agent/routines",
        expect.objectContaining({ scopes: ["tickets:tickets:read"] }),
      ),
    )
  })

  it("offers exactly the served models, grouped by provider, an added OpenRouter one included", async () => {
    setup()
    const select = screen.getByTestId("routine-model-select") as HTMLSelectElement
    await waitFor(() =>
      expect([...select.options].map((o) => o.value)).toEqual([
        "",
        "claude-haiku-4-5",
        "gemini-flash-latest",
        SERVED_OPENROUTER_MODEL.key,
      ]),
    )
    expect([...select.querySelectorAll("optgroup")].map((g) => g.label)).toEqual([
      "Anthropic",
      "Google",
      "OpenRouter",
    ])
    expect(select.options[0].textContent).toBe("Auto · Gemini Flash")
    expect([...select.options].some((o) => o.value === "claude-opus-4-6")).toBe(false)
  })

  it("defaults the agent model to Auto (null) with no reasoning row shown", () => {
    setup()
    expect(screen.getByTestId("routine-model-select")).toHaveValue("")
    expect(screen.queryByTestId("reasoning-row")).toBeNull()
  })

  it("creates a routine pinned to a specific model + reasoning level", async () => {
    const api = setup()
    fireEvent.input(screen.getByTestId("routines-new-name"), {
      target: { value: "Model Pinned Digest" },
    })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), { target: { value: "Hi" } })
    // The options are the served list: wait for it before choosing one.
    await screen.findByRole("option", { name: "Gemini Flash" })
    fireEvent.change(screen.getByTestId("routine-model-select"), {
      target: { value: "gemini-flash-latest" },
    })
    fireEvent.click(await screen.findByTestId("reasoning-level-medium"))
    fireEvent.click(screen.getByTestId("routines-new-save"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/agent/routines",
        expect.objectContaining({
          agentModelId: "gemini-flash-latest",
          agentReasoningLevel: "medium",
        }),
      ),
    )
  })

  it("S17: sends the token budget and hard limit when set, and neither when empty", async () => {
    const api = setup()
    fireEvent.input(screen.getByTestId("routines-new-name"), { target: { value: "Budgeted" } })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), { target: { value: "Hi" } })
    fireEvent.input(screen.getByTestId("routine-token-budget"), { target: { value: "20000" } })
    fireEvent.input(screen.getByTestId("routine-hard-token-limit"), { target: { value: "50000" } })
    fireEvent.click(screen.getByTestId("routines-new-save"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/agent/routines",
        expect.objectContaining({ tokenBudget: 20000, hardTokenLimit: 50000 }),
      ),
    )
  })

  it("S17: an empty budget sends no token fields at all", async () => {
    const api = setup()
    fireEvent.input(screen.getByTestId("routines-new-name"), { target: { value: "Plain" } })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), { target: { value: "Hi" } })
    fireEvent.click(screen.getByTestId("routines-new-save"))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    const body = api.post.mock.calls[0]?.[1] as Record<string, unknown>
    expect("tokenBudget" in body).toBe(false)
    expect("hardTokenLimit" in body).toBe(false)
  })

  it("S17: refuses a token budget that is not a whole number above zero", async () => {
    const api = setup()
    fireEvent.input(screen.getByTestId("routines-new-name"), { target: { value: "Bad" } })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), { target: { value: "Hi" } })
    fireEvent.input(screen.getByTestId("routine-token-budget"), { target: { value: "12.5" } })
    fireEvent.click(screen.getByTestId("routines-new-save"))
    expect(await screen.findByTestId("routines-new-error")).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })

  it("S21: sends where the routine runs when changed, and nothing when left on the cloud", async () => {
    // The picker shows only to someone with an enabled node (L27).
    const api = setup({ "/nodes/me": { nodes: [ENABLED_NODE] } })
    fireEvent.input(screen.getByTestId("routines-new-name"), { target: { value: "On my Mac" } })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), { target: { value: "Hi" } })
    expect(await screen.findByTestId("routine-runs-on")).toHaveValue("cloud")
    fireEvent.change(screen.getByTestId("routine-runs-on"), {
      target: { value: "node_else_cloud" },
    })
    fireEvent.click(screen.getByTestId("routines-new-save"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/agent/routines",
        expect.objectContaining({ runsOn: "node_else_cloud" }),
      ),
    )
  })

  it("L26, m7: a node routine's folder and model travel with the create, in one request", async () => {
    const api = setup({ "/nodes/me": { nodes: [ENABLED_NODE] } })
    api.put = vi.fn(async (_p: string, b: any) => ({ id: "new-routine-id", ...b }))
    fireEvent.input(screen.getByTestId("routines-new-name"), { target: { value: "On my Mac" } })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), { target: { value: "Hi" } })
    fireEvent.change(await screen.findByTestId("routine-runs-on"), { target: { value: "node" } })
    fireEvent.change(await screen.findByTestId("routine-runs-on-folder"), {
      target: { value: "liaison-walk-sample" },
    })
    fireEvent.change(screen.getByTestId("routine-runs-on-model"), {
      target: { value: "claude-haiku-4-5" },
    })
    fireEvent.click(screen.getByTestId("routines-new-save"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/agent/routines",
        expect.objectContaining({
          runsOn: "node",
          nodePlacement: { folder: "liaison-walk-sample", repo: null, model: "claude-haiku-4-5" },
        }),
      ),
    )
    // No second call that could fail after the routine exists.
    expect(api.put).not.toHaveBeenCalled()
  })

  it("S21: a routine left on the cloud sends no runsOn", async () => {
    const api = setup()
    fireEvent.input(screen.getByTestId("routines-new-name"), { target: { value: "Cloud" } })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), { target: { value: "Hi" } })
    fireEvent.click(screen.getByTestId("routines-new-save"))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    const body = api.post.mock.calls[0]?.[1] as Record<string, unknown>
    expect("runsOn" in body).toBe(false)
  })

  it("offers an event kind beside the two schedule kinds", () => {
    setup()
    expect(screen.getByTestId("routine-kind-recurring")).toBeInTheDocument()
    expect(screen.getByTestId("routine-kind-scheduled")).toBeInTheDocument()
    expect(screen.getByTestId("routine-kind-event")).toBeInTheDocument()
  })

  it("the picker is labelled Trigger, not Schedule, once the event kind is chosen", async () => {
    setup()
    expect(screen.getByText("Schedule")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("routine-kind-event"))
    await waitFor(() => expect(screen.getByText("Trigger")).toBeInTheDocument())
    expect(screen.queryByText("Schedule")).toBeNull()
  })

  it("creates an event routine with the chosen event and no cron", async () => {
    const api = setup()
    api.get.mockResolvedValue([
      { event: "tickets:ticket:replied", app: "tickets", entity: "ticket", action: "replied" },
      {
        event: "monitoring:incident:opened",
        app: "monitoring",
        entity: "incident",
        action: "opened",
      },
    ])
    fireEvent.click(screen.getByTestId("routine-kind-event"))
    // The catalog is fetched when the event kind is chosen, not before.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/agent/routines/events"))
    const option = await screen.findByTestId("event-option-tickets:ticket:replied")
    // The row reads as a sentence AND carries the raw string support asks for.
    expect(option.textContent).toContain("Tickets: ticket replied")
    expect(option.textContent).toContain("tickets:ticket:replied")
    fireEvent.click(option)
    fireEvent.input(screen.getByTestId("routines-new-name"), { target: { value: "reply watch" } })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), { target: { value: "look" } })
    fireEvent.click(screen.getByTestId("routines-new-save"))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    const body = api.post.mock.calls[0][1]
    expect(body.kind).toBe("event")
    expect(body.event).toBe("tickets:ticket:replied")
    expect(body.cron).toBeUndefined()
    expect(body.timezone).toBeUndefined()
    expect(body.runAt).toBeUndefined()
  })

  it("S26: a new-mail routine offers a sender filter and sends the chosen group", async () => {
    const api = setup()
    api.get.mockImplementation(async (path: string) =>
      path === "/contacts/groups"
        ? [{ id: "g-prospects", name: "Prospects", memberCount: 3 }]
        : [{ event: "mail:message:create", app: "mail", entity: "message", action: "create" }],
    )
    fireEvent.click(screen.getByTestId("routine-kind-event"))
    expect(screen.queryByTestId("routine-sender-filter")).toBeNull()
    fireEvent.click(await screen.findByTestId("event-option-mail:message:create"))
    fireEvent.click(await screen.findByTestId("routine-sender-group-g-prospects"))
    fireEvent.input(screen.getByTestId("routines-new-name"), { target: { value: "prospects" } })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), { target: { value: "draft" } })
    fireEvent.click(screen.getByTestId("routines-new-save"))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    const body = api.post.mock.calls[0][1]
    expect(body.event).toBe("mail:message:create")
    expect(body.eventFilter).toEqual({ fromGroupIds: ["g-prospects"] })
  })

  it("S29: sends approver owner only when chosen", async () => {
    const api = setup()
    fireEvent.input(screen.getByTestId("routines-new-name"), { target: { value: "drafts" } })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), { target: { value: "draft" } })
    expect(screen.getByTestId("routine-approver")).toHaveValue("default")
    fireEvent.change(screen.getByTestId("routine-approver"), { target: { value: "owner" } })
    fireEvent.click(screen.getByTestId("routines-new-save"))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1].approver).toBe("owner")
  })

  it("refuses to create an event routine with no event chosen", async () => {
    const api = setup()
    api.get.mockResolvedValue([])
    fireEvent.click(screen.getByTestId("routine-kind-event"))
    fireEvent.input(screen.getByTestId("routines-new-name"), { target: { value: "no event" } })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), { target: { value: "look" } })
    fireEvent.click(screen.getByTestId("routines-new-save"))
    await waitFor(() => expect(screen.getByTestId("routines-new-error")).toBeInTheDocument())
    expect(api.post).not.toHaveBeenCalled()
  })

  it("filters the event list by the search box", async () => {
    const api = setup()
    api.get.mockResolvedValue([
      { event: "tickets:ticket:replied", app: "tickets", entity: "ticket", action: "replied" },
      {
        event: "monitoring:incident:opened",
        app: "monitoring",
        entity: "incident",
        action: "opened",
      },
    ])
    fireEvent.click(screen.getByTestId("routine-kind-event"))
    await screen.findByTestId("event-option-tickets:ticket:replied")
    fireEvent.input(screen.getByTestId("event-search"), { target: { value: "incident" } })
    await waitFor(() =>
      expect(screen.queryByTestId("event-option-tickets:ticket:replied")).toBeNull(),
    )
    expect(screen.getByTestId("event-option-monitoring:incident:opened")).toBeInTheDocument()
  })

  it("creates a one-shot routine with a runAt", async () => {
    const api = setup()
    fireEvent.click(screen.getByTestId("routine-kind-scheduled"))
    fireEvent.input(screen.getByTestId("schedule-datetime"), {
      target: { value: "2099-06-01T09:00" },
    })
    fireEvent.input(screen.getByTestId("routines-new-name"), { target: { value: "dentist" } })
    fireEvent.input(screen.getByTestId("routines-new-prompt"), {
      target: { value: "remind me" },
    })
    fireEvent.click(screen.getByTestId("routines-new-save"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/agent/routines",
        expect.objectContaining({ kind: "scheduled", visibility: "personal" }),
      ),
    )
    expect(api.post.mock.calls[0][1].runAt).toContain("2099-06-01")
  })
})
