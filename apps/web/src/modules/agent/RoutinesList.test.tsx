// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import RoutinesList from "./RoutinesList"
import { resetRoutinesStore } from "./routines-store"

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  closeTab: vi.fn(),
  makeTabId: vi.fn(() => "tab-id"),
}))

// Mine/Shared sub-tabs filter client-side by ownerUserId — supply a fixed
// "current user" so the Mine filter matches the fixtures' ownerUserId.
// Only override userFromToken; keep every other auth-store export real (a
// module-level `onAuthCleared` subscriber elsewhere needs the real export).
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => ({ userId: "user-1" }),
}))

afterEach(() => {
  resetRoutinesStore()
  vi.mocked(openTab).mockClear()
})

const FIXTURE = {
  id: "11111111-1111-1111-1111-111111111111",
  orgId: "org-1",
  ownerUserId: "user-1",
  name: "daily-digest",
  description: "Daily digest",
  kind: "recurring" as const,
  cron: "0 8 * * *",
  timezone: "UTC",
  runAt: null,
  prompt: "say hi",
  outputThreadId: null,
  scopes: [],
  visibility: "personal" as const,
  enabled: true,
  status: "active" as const,
  lastRunAt: null,
  lastRunStatus: null,
  lastRunError: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
}

function cleanupAndRender(api: unknown) {
  cleanup()
  render(() => (
    <ApiContext.Provider value={api as never}>
      <RoutinesList />
    </ApiContext.Provider>
  ))
}

function setup(rows: any[] = []) {
  const api = {
    get: vi.fn(async () => rows),
    post: vi.fn(async (_p: string, b: any) => ({ ...FIXTURE, ...b, id: "new-id" })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    rawPost: vi.fn(),
    rawGet: vi.fn(),
    getEnvelope: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <RoutinesList />
    </ApiContext.Provider>
  ))
  return api
}

describe("RoutinesList", () => {
  it("S28: lists the kernel Morning brief as a built-in template and enables it", async () => {
    const api = setup()
    ;(
      api.get as unknown as { mockImplementation: (f: (p: string) => unknown) => void }
    ).mockImplementation(async (path: string) =>
      path === "/agent/routines/templates"
        ? [
            {
              appName: "kernel",
              templateKey: "morning-brief",
              description: "Morning brief",
              kind: "recurring",
              enabled: false,
            },
          ]
        : [],
    )
    resetRoutinesStore()
    cleanupAndRender(api)
    const row = await screen.findByTestId("routine-template-kernel-morning-brief")
    expect(row).toHaveTextContent("Built in")
    expect(row).not.toHaveTextContent(/\bkernel\b/)
    fireEvent.click(screen.getByTestId("routine-template-enable-kernel-morning-brief"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/agent/routines/templates/kernel/morning-brief/enable",
        {},
      ),
    )
  })

  it("renders Mine and Shared sub-tabs and loads both buckets once on mount", async () => {
    const api = setup()
    expect(screen.getByTestId("routines-subtab-mine")).toBeInTheDocument()
    expect(screen.getByTestId("routines-subtab-shared")).toBeInTheDocument()
    // Both visibility buckets are fetched in parallel on mount; sub-tab clicks
    // filter client-side and never re-trigger an API call.
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith("/agent/routines")
      expect(api.get).toHaveBeenCalledWith("/agent/routines?visibility=shared")
    })
    api.get.mockClear()
    fireEvent.click(screen.getByTestId("routines-subtab-shared"))
    fireEvent.click(screen.getByTestId("routines-subtab-mine"))
    expect(api.get).not.toHaveBeenCalled()
  })

  it("a row shows the routine's human name and, with no onSelect, opens it on its owner agent's Routines tab", async () => {
    setup([{ ...FIXTURE, title: "Morning digest", ownerAgentId: "agent-9" }])
    await waitFor(() =>
      expect(screen.getByTestId("routine-title-daily-digest")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("routine-title-daily-digest")).toHaveTextContent("Morning digest")
    fireEvent.click(screen.getByTestId("routine-open-daily-digest"))
    expect(openTab).toHaveBeenCalledTimes(1)
    const tab = vi.mocked(openTab).mock.calls[0]?.[0]
    // Never the removed agents:routine tab type: the agent page, Routines tab, routine selected.
    expect(tab?.type).toBe("agents:agent")
    expect(tab?.label).toBe("Morning digest")
    expect(tab?.routePath).toMatch(new RegExp(`^/agents/[^/]+/routines\\?selected=${FIXTURE.id}$`))
  })

  it("each row shows name + schedule + enable toggle", async () => {
    setup([FIXTURE])
    await waitFor(() => expect(screen.getByTestId("routine-row-daily-digest")).toBeInTheDocument())
    expect(screen.getByTestId("routine-schedule-daily-digest")).toHaveTextContent(
      "Every day at 8 AM",
    )
    expect(screen.getByTestId("routine-enable-toggle-daily-digest")).toBeInTheDocument()
  })

  // A guided tour's "switch it on" skips a toggle already on (`unlessActive`
  // reads aria-pressed): without it, playing the beat again switched it off.
  it("the On/Off toggle says whether the routine is on", async () => {
    setup([
      { ...FIXTURE, enabled: true },
      { ...FIXTURE, id: "r-off", name: "weekly-report", enabled: false },
    ])
    await waitFor(() =>
      expect(screen.getByTestId("routine-enable-toggle-daily-digest")).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    )
    expect(screen.getByTestId("routine-enable-toggle-weekly-report")).toHaveAttribute(
      "aria-pressed",
      "false",
    )
  })

  it("paused rows show a warning chip with the status name", async () => {
    setup([{ ...FIXTURE, status: "paused_scope_mismatch" }])
    await waitFor(() =>
      expect(screen.getByTestId("routine-paused-daily-digest")).toBeInTheDocument(),
    )
  })

  it("shows the completed one-shot routines in a dimmed/'Done' treatment", async () => {
    setup([
      {
        ...FIXTURE,
        name: "one-shot-done",
        kind: "scheduled",
        cron: null,
        timezone: null,
        runAt: "2024-02-01T09:00:00Z",
        status: "completed",
      },
    ])
    await waitFor(() => expect(screen.getByTestId("routine-row-one-shot-done")).toBeInTheDocument())
    expect(screen.getByTestId("routine-row-one-shot-done")).toHaveAttribute(
      "data-status",
      "completed",
    )
    expect(screen.getByTestId("routine-done-one-shot-done")).toBeInTheDocument()
  })

  it("+ New routine opens a routine create tab, not a modal", () => {
    setup()
    fireEvent.click(screen.getByTestId("routines-new-routine"))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: expect.stringContaining("routine"), entityId: "new" }),
    )
    // No modal is rendered — creation is a full tab surface.
    expect(screen.queryByTestId("routines-new-modal")).toBeNull()
  })

  it("the empty-state CTA also opens the create tab", () => {
    setup()
    fireEvent.click(screen.getByTestId("routines-empty-cta"))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: expect.stringContaining("routine"), entityId: "new" }),
    )
  })
})

// A routine that stopped says WHY, in the row, in words (P8-FX2, SK-2). The
// status is a database enum: rendering it with its underscores opened up told
// a person "paused scope mismatch" and never which scope was missing, while
// the worker's own sentence sat unread on the routine row.
describe("RoutinesList: a stopped routine explains itself", () => {
  const PAUSED = {
    ...FIXTURE,
    name: "invoice-chaser",
    status: "paused_scope_mismatch" as const,
    lastRunStatus: "skipped_scope_mismatch",
    lastRunError:
      "Paused: the owner agent's scope ceiling does not cover invoicing:documents:write, so the tools this routine needs are not in its catalog.",
  }

  it("names the missing scope in the row, not the enum", async () => {
    setup([PAUSED])
    await waitFor(() =>
      expect(screen.getByTestId("routine-paused-reason-invoice-chaser")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("routine-paused-reason-invoice-chaser")).toHaveTextContent(
      "invoicing:documents:write",
    )
    expect(document.body.textContent).not.toContain("paused scope mismatch")
    expect(document.body.textContent).not.toContain("skipped_scope_mismatch")
  })

  it("labels both chips in words", async () => {
    setup([PAUSED])
    await waitFor(() =>
      expect(screen.getByTestId("routine-paused-invoice-chaser")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("routine-paused-invoice-chaser")).toHaveTextContent(
      "Paused: missing access",
    )
    expect(screen.getByTestId("routine-last-status-invoice-chaser")).toHaveTextContent(
      "Skipped: missing access",
    )
  })

  it("falls back to the status label when the worker wrote no reason", async () => {
    setup([{ ...PAUSED, lastRunError: null }])
    await waitFor(() =>
      expect(screen.getByTestId("routine-paused-reason-invoice-chaser")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("routine-paused-reason-invoice-chaser")).toHaveTextContent(
      "Paused: missing access",
    )
  })
})

// A screenshot pass of the deployed app: the schedule chip wrapped to three
// lines inside the row's single flex line and rode up over the title, and a
// routine switched Off still advertised a next run the scheduler will never
// fire.
describe("RoutinesList: the row layout and the Off projection", () => {
  it("keeps the title on its own truncating line, apart from the schedule chip", async () => {
    setup([{ ...FIXTURE, cron: "0 8 * * 1-5", timezone: "Europe/Paris" }])
    await waitFor(() => expect(screen.getByTestId("routine-row-daily-digest")).toBeInTheDocument())
    const title = screen.getByTestId("routine-title-daily-digest")
    const chip = screen.getByTestId("routine-schedule-daily-digest")
    // One line, clipped: the name never wraps behind a chip.
    expect(title.className).toContain("truncate")
    // And the chip is NOT a sibling of the title in one flex row.
    expect(chip.parentElement).not.toBe(title.parentElement)
    expect(screen.getByTestId("routine-chips-daily-digest")).toContainElement(chip)
    expect(chip.className).toContain("truncate")
  })

  it("shows no next-run projection for a routine switched off", async () => {
    setup([{ ...FIXTURE, enabled: false }])
    await waitFor(() => expect(screen.getByTestId("routine-row-daily-digest")).toBeInTheDocument())
    expect(screen.getByTestId("routine-row-daily-digest").textContent).not.toContain("Next run")
    // The row falls back to the routine's own description.
    expect(screen.getByTestId("routine-row-daily-digest").textContent).toContain("Daily digest")
  })

  it("still projects the next run for a routine that is on", async () => {
    setup([FIXTURE])
    await waitFor(() => expect(screen.getByTestId("routine-row-daily-digest")).toBeInTheDocument())
    expect(screen.getByTestId("routine-row-daily-digest").textContent).toContain("Next run")
  })
})
