// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { resetThreadStore } from "~/modules/threads/thread-store"
import AgentRoutinesTab from "./AgentRoutinesTab"
import { resetRoutinesStore } from "./routines-store"

afterEach(() => {
  resetRoutinesStore()
  resetThreadStore()
})

const OWNED = {
  id: "rt-1",
  orgId: "org-1",
  ownerUserId: "user-1",
  ownerAgentId: "agent-1",
  name: "morning-digest",
  description: "Digest every weekday",
  kind: "recurring" as const,
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  runAt: null,
  prompt: "summarize",
  outputThreadId: "thr-9",
  scopes: [],
  visibility: "personal" as const,
  agentModelId: null,
  agentReasoningLevel: null,
  enabled: true,
  status: "active" as const,
  lastRunAt: null,
  lastRunStatus: null,
  lastRunError: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  canWrite: true,
}

const OFF = {
  ...OWNED,
  id: "rt-2",
  name: "weekly-sweep",
  description: "Sweeps on Sundays",
  enabled: false,
}

function setup(rows: any[] = [OWNED]) {
  const api = {
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/runs")) return []
      return rows
    }),
    post: vi.fn(async () => ({ queued: true })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    rawPost: vi.fn(),
    rawGet: vi.fn(),
    getEnvelope: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <AgentRoutinesTab agentId="agent-1" canCreate={true} />
    </ApiContext.Provider>
  ))
  return api
}

describe("AgentRoutinesTab", () => {
  it("the Routines tab runs a routine now and opens on its runs", async () => {
    const api = setup()

    await waitFor(() =>
      expect(screen.getByTestId("routine-row-morning-digest")).toBeInTheDocument(),
    )
    expect(api.get).toHaveBeenCalledWith("/agent/routines?ownerAgentId=agent-1")
    // Ownership IS the filter here, so the Mine/Shared split is gone.
    expect(screen.queryByTestId("routines-subtab-shared")).toBeNull()

    fireEvent.click(screen.getByTestId("routine-open-morning-digest"))
    await waitFor(() => expect(screen.getByTestId("routine-detail")).toBeInTheDocument())

    // Runs is the pane's first tab, and the output thread is no longer offered
    // from the routine: a run opens its own transcript instead.
    expect(screen.getByTestId("routine-tab-runs")).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByTestId("routine-output-thread-link")).toBeNull()

    fireEvent.click(screen.getByTestId("routine-run-now"))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/agent/routines/rt-1/run-now", {}))
  })

  // The tab is a master/detail surface like Memory, so its right half is never
  // empty on arrival: an empty detail pane beside a narrow list is what read as
  // a mobile column that had lost its content.
  it("the first routine is selected on arrival, so the detail pane is never empty", async () => {
    setup([OWNED, OFF])
    await waitFor(() => expect(screen.getByTestId("routine-detail")).toBeInTheDocument())
    // Without a single click.
    expect(screen.getByTestId("routine-row-morning-digest")).toHaveClass("bg-surface-active")
    expect(screen.queryByTestId("agent-routines-no-selection")).toBeNull()
  })

  it("New routine after a row was selected opens the create form, not Routine not found", async () => {
    setup()
    // The first row is selected on arrival, so the detail pane already holds a
    // routine when New routine is pressed: the pane must remount as the form.
    await waitFor(() => expect(screen.getByTestId("routine-detail")).toBeTruthy())
    fireEvent.click(screen.getByTestId("routines-new-routine"))
    await waitFor(() => expect(screen.getByTestId("routine-create")).toBeTruthy())
    expect(screen.queryByText("Routine not found.")).toBeNull()
  })

  it("the list groups what runs apart from what is switched off", async () => {
    setup([OWNED, OFF])
    await waitFor(() => expect(screen.getByTestId("routine-row-weekly-sweep")).toBeInTheDocument())
    expect(screen.getByTestId("routines-group-on")).toBeInTheDocument()
    expect(screen.getByTestId("routines-group-off")).toBeInTheDocument()
  })

  it("one group draws no header", async () => {
    setup([OWNED])
    await waitFor(() =>
      expect(screen.getByTestId("routine-row-morning-digest")).toBeInTheDocument(),
    )
    expect(screen.queryByTestId("routines-group-on")).toBeNull()
    expect(screen.queryByTestId("routines-group-off")).toBeNull()
  })
})

// A routine's run log is read here, under the agent that runs it: a run of the
// history opens that run's own transcript, never a chat row.
describe("AgentRoutinesTab run history", () => {
  const RUNS = [
    {
      id: "run-2",
      routineId: "rt-1",
      ranAt: "2026-10-16T09:00:10Z",
      startedAt: "2026-10-16T09:00:00Z",
      status: "succeeded",
      durationMs: 10000,
      error: null,
      trigger: "event",
      triggerLabel: "tickets.ticket.create",
      summary: "Triaged 2 tickets",
      messageCount: 2,
      hasTranscript: true,
      outputThreadId: "thr-9",
    },
    {
      id: "run-1",
      routineId: "rt-1",
      ranAt: "2026-10-15T09:00:10Z",
      startedAt: "2026-10-15T09:00:00Z",
      status: "failed",
      durationMs: 10000,
      error: "boom",
      trigger: "schedule",
      triggerLabel: null,
      summary: null,
      messageCount: 0,
      hasTranscript: false,
      outputThreadId: "thr-9",
    },
  ]
  const TRANSCRIPT = {
    run: RUNS[0],
    outputThreadId: "thr-9",
    messages: [
      {
        id: "m-1",
        threadId: "thr-9",
        authorId: "user-1",
        authorName: "Sam",
        authorType: "user",
        content: "New ticket arrived",
        createdAt: "2026-10-16T09:00:01Z",
        deletedAt: null,
        metadata: null,
      },
      {
        id: "m-2",
        threadId: "thr-9",
        authorId: "user-1",
        authorName: "Support",
        authorType: "agent",
        content: "Triaged 2 tickets",
        createdAt: "2026-10-16T09:00:05Z",
        deletedAt: null,
        metadata: null,
      },
    ],
  }

  function setupRuns(props: { selected?: string; run?: string } = {}) {
    const onRunChanged = vi.fn()
    const api = {
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/runs/run-2/messages")) return TRANSCRIPT
        if (path.endsWith("/runs")) return RUNS
        return [OWNED]
      }),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      rawPost: vi.fn(),
      rawGet: vi.fn(),
      getEnvelope: vi.fn(),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <AgentRoutinesTab
          agentId="agent-1"
          canCreate={true}
          selected={props.selected}
          run={props.run}
          onRunChanged={onRunChanged}
        />
      </ApiContext.Provider>
    ))
    return { api, onRunChanged }
  }

  it("each run names its trigger, outcome and summary", async () => {
    setupRuns()
    await waitFor(() => expect(screen.getByTestId("run-history-row-run-2")).toBeInTheDocument())
    expect(screen.getByTestId("run-trigger-run-2")).toHaveTextContent("On event")
    expect(screen.getByTestId("run-trigger-run-1")).toHaveTextContent("Scheduled")
    expect(screen.getByTestId("run-summary-run-2")).toHaveTextContent("Triaged 2 tickets")
    expect(screen.getByTestId("run-status-failed")).toBeInTheDocument()
    expect(screen.getByTestId("run-reason-run-1")).toHaveTextContent("boom")
  })

  it("a run opens its own transcript in the pane, and Back returns to the routine", async () => {
    const { api, onRunChanged } = setupRuns()
    await waitFor(() => expect(screen.getByTestId("run-history-row-run-2")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("run-history-row-run-2"))
    await waitFor(() => expect(screen.getByTestId("routine-run-message-m-2")).toBeInTheDocument())
    expect(api.get).toHaveBeenCalledWith("/agent/routines/rt-1/runs/run-2/messages")
    expect(screen.getByTestId("routine-run-message-m-1")).toHaveTextContent("New ticket arrived")
    expect(screen.getByTestId("routine-run-trigger")).toHaveTextContent("On event")
    expect(onRunChanged).toHaveBeenLastCalledWith("rt-1", "run-2")

    fireEvent.click(screen.getByTestId("routine-run-back"))
    await waitFor(() => expect(screen.getByTestId("routine-detail")).toBeInTheDocument())
    expect(onRunChanged).toHaveBeenLastCalledWith("rt-1", null)
  })

  it("a direct link to a run opens its transcript", async () => {
    setupRuns({ selected: "rt-1", run: "run-2" })
    await waitFor(() => expect(screen.getByTestId("routine-run-message-m-2")).toBeInTheDocument())
    expect(screen.queryByTestId("routine-detail")).toBeNull()
  })
})
