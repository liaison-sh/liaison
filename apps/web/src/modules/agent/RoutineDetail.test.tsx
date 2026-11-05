// SPDX-License-Identifier: FSL-1.1-ALv2
import enKernel from "@liaison/shared/src/i18n/locales/en/kernel.json"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"
import RoutineDetail from "./RoutineDetail"
import { resetRoutinesStore } from "./routines-store"

// Only override hasScope; keep every other auth-store export real.
vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    hasScope: vi.fn(() => false),
    userFromToken: vi.fn(() => ({ userId: "user-1" }) as never),
  }
})

afterEach(() => {
  resetRoutinesStore()
  vi.mocked(hasScope).mockReturnValue(false)
  vi.mocked(userFromToken).mockReturnValue({ userId: "user-1" } as never)
})

const FIXTURE = {
  id: "rid-1",
  orgId: "org-1",
  ownerUserId: "user-1",
  ownerAgentId: "agent-1",
  name: "morning",
  description: "Morning routine",
  kind: "recurring" as const,
  cron: "0 8 * * *",
  timezone: "UTC",
  runAt: null,
  event: null,
  prompt: "say hi",
  outputThreadId: null,
  scopes: ["tickets:read"],
  visibility: "personal" as const,
  enabled: true,
  status: "active" as const,
  lastRunAt: null,
  lastRunStatus: null,
  lastRunError: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
}

function setup(rows: any[], runs: any[] = []) {
  const api = {
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/runs")) return runs
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
      <RoutineDetail entityId="rid-1" />
    </ApiContext.Provider>
  ))
  return api
}

describe("RoutineDetail", () => {
  it("renders prompt, schedule, next-fire times, allowed-scopes chips", async () => {
    setup([FIXTURE])
    await waitFor(() => expect(screen.getByTestId("routine-prompt")).toBeInTheDocument())
    expect(screen.getByTestId("routine-next-fires")).toBeInTheDocument()
    // A member reads the CATEGORY, never the scope (P4c FX-F3).
    expect(screen.getByTestId("routine-capability-tickets")).toBeInTheDocument()
  })

  it("an event routine says what fires it and shows NO next-run preview", async () => {
    setup([
      {
        ...FIXTURE,
        kind: "event",
        cron: null,
        timezone: null,
        runAt: null,
        event: "tickets:ticket:replied",
      },
    ])
    await waitFor(() => expect(screen.getByTestId("routine-prompt")).toBeInTheDocument())
    expect(screen.getByTestId("routine-schedule-text").textContent).toBe(
      "Runs when Tickets: ticket replied",
    )
    // An event routine has no cadence, so there is nothing to project: the
    // recurring pane's next-fire list must not be rendered for it.
    expect(screen.queryByTestId("routine-next-fires")).toBeNull()
  })

  it("a switched-off event routine never talks about a next run", async () => {
    setup([
      {
        ...FIXTURE,
        kind: "event",
        cron: null,
        timezone: null,
        runAt: null,
        event: "tickets:ticket:replied",
        enabled: false,
      },
    ])
    await waitFor(() => expect(screen.getByTestId("routine-prompt")).toBeInTheDocument())
    const off = screen.getByTestId("routine-schedule-off").textContent ?? ""
    expect(off).not.toMatch(/next run/i)
    expect(off).toBe("Switched off: it will not react to the event")
  })

  // A14: the routine row printed `scopes` verbatim under "Allowed scopes".
  it("a member sees categories, never a scope name, on a skill, a routine and a memory row", async () => {
    setup([{ ...FIXTURE, scopes: ["kernel:agents:read", "tickets:tickets:write"] }])
    await waitFor(() => expect(screen.getByTestId("routine-prompt")).toBeInTheDocument())
    expect(screen.getByTestId("routine-capability-kernel")).toBeInTheDocument()
    expect(screen.getByTestId("routine-capability-tickets")).toBeInTheDocument()
    expect(screen.queryByTestId("routine-scope-kernel:agents:read")).toBeNull()
    expect(document.body.textContent).not.toContain("kernel:agents:read")
  })

  // Charter agent.md, "A scope name on screen": the admin branch listed the
  // grants VERBATIM (23 rows of `app:resource:action` on production). The
  // admin still reads the per-grant detail, now as words, and the identifier
  // survives only in the row's title.
  it("an admin reads each grant as words, never as the identifier", async () => {
    vi.mocked(hasScope).mockImplementation((scope: string) => scope === "kernel:agents:admin")
    setup([{ ...FIXTURE, scopes: ["kernel:agents:read"] }])
    await waitFor(() => expect(screen.getByTestId("routine-prompt")).toBeInTheDocument())
    const chip = screen.getByTestId("routine-scope-kernel:agents:read")
    expect(chip.textContent).toBe("Workspace: read agents")
    expect(chip.getAttribute("title")).toContain("kernel:agents:read")
    expect(screen.queryByTestId("routine-capability-kernel")).toBeNull()
    expect(document.body.textContent).not.toContain("kernel:agents:read")
  })

  // The member branch printed the app SLUG under "Allowed scopes".
  it("a member reads the category by its app name", async () => {
    setup([{ ...FIXTURE, scopes: ["tickets:tickets:write"] }])
    await waitFor(() => expect(screen.getByTestId("routine-prompt")).toBeInTheDocument())
    expect(screen.getByTestId("routine-capability-tickets").textContent).toBe("Tickets")
  })

  it("Run now calls POST /api/agent/routines/:id/run-now", async () => {
    const api = setup([FIXTURE])
    await waitFor(() => expect(screen.getByTestId("routine-run-now")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("routine-run-now"))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/agent/routines/rid-1/run-now", {}))
  })

  it("Run now on a switched-off or paused routine says why in words and sends nothing (walk D20)", async () => {
    const api = setup([{ ...FIXTURE, enabled: false }])
    await waitFor(() => expect(screen.getByTestId("routine-run-now")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("routine-run-now"))
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "This routine is switched off. Switch it on to run it.",
      ),
    )
    expect(api.post).not.toHaveBeenCalledWith("/agent/routines/rid-1/run-now", {})
  })

  it("paused banner appears for non-active status", async () => {
    setup([{ ...FIXTURE, status: "paused_scope_mismatch", lastRunError: "tickets:write" }])
    await waitFor(() => expect(screen.getByTestId("routine-paused-banner")).toBeInTheDocument())
    expect(screen.getByTestId("routine-paused-banner").textContent).toMatch(/tickets:write/)
  })

  it("enters edit mode and saves changes via PUT", async () => {
    const api = setup([FIXTURE])
    api.put = vi.fn(async () => ({ ...FIXTURE, description: "edited" }))
    await waitFor(() => expect(screen.getByTestId("routine-edit")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("routine-edit"))
    expect(screen.getByTestId("routine-edit-form")).toBeInTheDocument()
    fireEvent.input(screen.getByTestId("routine-edit-description"), {
      target: { value: "edited" },
    })
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/agent/routines/rid-1",
        expect.objectContaining({ description: "edited" }),
      ),
    )
  })

  it("S17: shows the token budget and limit, and saves an edited limit", async () => {
    const api = setup([{ ...FIXTURE, tokenBudget: 20000, hardTokenLimit: 50000 }])
    api.put = vi.fn(async () => ({ ...FIXTURE, tokenBudget: 20000, hardTokenLimit: 60000 }))
    await waitFor(() =>
      expect(screen.getByTestId("routine-token-limits-text")).toHaveTextContent(
        "Budget: 20000 tokens · Hard limit: 50000 tokens",
      ),
    )
    fireEvent.click(screen.getByTestId("routine-edit"))
    expect(screen.getByTestId("routine-edit-token-budget")).toHaveValue("20000")
    fireEvent.input(screen.getByTestId("routine-edit-hard-token-limit"), {
      target: { value: "60000" },
    })
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/agent/routines/rid-1",
        expect.objectContaining({ tokenBudget: 20000, hardTokenLimit: 60000 }),
      ),
    )
  })

  it("S21: shows where the routine runs, and saves a change", async () => {
    const api = setup([{ ...FIXTURE, runsOn: "node" }])
    api.put = vi.fn(async () => ({ ...FIXTURE, runsOn: "cloud" }))
    await waitFor(() =>
      expect(screen.getByTestId("routine-runs-on-text")).toHaveTextContent("My computer"),
    )
    fireEvent.click(screen.getByTestId("routine-edit"))
    expect(screen.getByTestId("routine-edit-runs-on")).toHaveValue("node")
    fireEvent.change(screen.getByTestId("routine-edit-runs-on"), { target: { value: "cloud" } })
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/agent/routines/rid-1",
        expect.objectContaining({ runsOn: "cloud" }),
      ),
    )
  })

  it("L26, m7: a node routine reads its folder and model, and an edit saves the placement with the rest", async () => {
    const api = setup([
      { ...FIXTURE, runsOn: "node", folder: "liaison-walk-sample", repo: null, model: null },
    ])
    api.put = vi.fn(async (_path: string, body: any) => ({
      ...FIXTURE,
      runsOn: "node",
      folder: body.nodePlacement?.folder ?? null,
      repo: body.nodePlacement?.repo ?? null,
      model: body.nodePlacement?.model ?? null,
    }))
    await waitFor(() =>
      expect(screen.getByTestId("routine-node-placement-text")).toHaveTextContent(
        "Folder: liaison-walk-sample",
      ),
    )
    fireEvent.click(screen.getByTestId("routine-edit"))
    fireEvent.input(screen.getByTestId("routine-edit-runs-on-repo"), {
      target: { value: "https://github.com/team/app.git" },
    })
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/agent/routines/rid-1",
        expect.objectContaining({
          nodePlacement: { folder: null, repo: "https://github.com/team/app.git", model: null },
        }),
      ),
    )
    expect(api.put).toHaveBeenCalledTimes(1)
  })

  it("m7: someone editing another member's node routine sees the placement is the owner's, and sends none", async () => {
    vi.mocked(userFromToken).mockReturnValue({ userId: "admin-1" } as never)
    const api = setup([
      { ...FIXTURE, runsOn: "node", folder: "liaison-walk-sample", repo: null, model: null },
    ])
    api.put = vi.fn(async () => ({ ...FIXTURE, runsOn: "node", folder: "liaison-walk-sample" }))
    await waitFor(() => expect(screen.getByTestId("routine-edit")).toBeTruthy())
    fireEvent.click(screen.getByTestId("routine-edit"))
    expect(screen.queryByTestId("routine-edit-runs-on-folder")).toBeNull()
    expect(screen.getByTestId("routine-edit-runs-on-owner-only")).toHaveTextContent(
      "Only the routine's owner",
    )
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
    expect(api.put.mock.calls[0][1]).not.toHaveProperty("nodePlacement")
  })

  it("S26: a new-mail routine shows its sender filter, and clearing it saves null", async () => {
    const row = {
      ...FIXTURE,
      kind: "event" as const,
      cron: null,
      timezone: null,
      event: "mail:message:create",
      eventFilter: { fromGroupIds: ["g-prospects"] },
    }
    const api = setup([row])
    api.put = vi.fn(async () => ({ ...row, eventFilter: null }))
    await waitFor(() =>
      expect(screen.getByTestId("routine-sender-filter-text")).toHaveTextContent(
        "Only mail from 1 groups and 0 contacts",
      ),
    )
    api.get.mockImplementation(async (path: string) =>
      path === "/contacts/groups"
        ? [{ id: "g-prospects", name: "Prospects", memberCount: 3 }]
        : path.endsWith("/runs")
          ? []
          : [row],
    )
    fireEvent.click(screen.getByTestId("routine-edit"))
    const box = await screen.findByTestId("routine-edit-sender-group-g-prospects")
    expect(box).toBeChecked()
    fireEvent.click(box)
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/agent/routines/rid-1",
        expect.objectContaining({ event: "mail:message:create", eventFilter: null }),
      ),
    )
  })

  it("S29: shows who approves the drafts, and saves owner", async () => {
    const api = setup([FIXTURE])
    api.put = vi.fn(async () => ({ ...FIXTURE, approver: "owner" }))
    await waitFor(() =>
      expect(screen.getByTestId("routine-approver-text")).toHaveTextContent(
        "Whoever may approve them",
      ),
    )
    fireEvent.click(screen.getByTestId("routine-edit"))
    expect(screen.getByTestId("routine-edit-approver")).toHaveValue("default")
    fireEvent.change(screen.getByTestId("routine-edit-approver"), { target: { value: "owner" } })
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/agent/routines/rid-1",
        expect.objectContaining({ approver: "owner" }),
      ),
    )
  })

  it("S21: a routine with no runsOn reads as the cloud", async () => {
    setup([FIXTURE])
    await waitFor(() =>
      expect(screen.getByTestId("routine-runs-on-text")).toHaveTextContent("Cloud"),
    )
  })

  it("S17: a routine with neither field says so", async () => {
    setup([FIXTURE])
    await waitFor(() =>
      expect(screen.getByTestId("routine-token-limits-text")).toHaveTextContent(
        "No token budget or limit",
      ),
    )
  })

  it("renders the runs list when run history is present", async () => {
    setup(
      [FIXTURE],
      [
        {
          id: "run-1",
          routineId: "rid-1",
          ranAt: "2024-01-02T00:00:00Z",
          status: "succeeded",
          durationMs: 100,
          errorMessage: null,
        },
      ],
    )
    await waitFor(() => expect(screen.getByTestId("run-history-row-run-1")).toBeInTheDocument())
    expect(screen.getByTestId("run-status-succeeded")).toBeInTheDocument()
    expect(screen.getByTestId("run-status-succeeded")).toHaveTextContent("Ran")
  })

  // P8-FX2, SK-2's UI half: the banner and the run row say why, in words.
  it("names the missing scopes in the banner, without the enum", async () => {
    setup([
      {
        ...FIXTURE,
        status: "paused_scope_mismatch",
        lastRunError:
          "Paused: the owner agent's scope ceiling does not cover invoicing:documents:write, so the tools this routine needs are not in its catalog.",
      },
    ])
    await waitFor(() => expect(screen.getByTestId("routine-paused-banner")).toBeInTheDocument())
    const banner = screen.getByTestId("routine-paused-banner")
    expect(banner).toHaveTextContent("invoicing:documents:write")
    expect(banner.textContent).not.toContain("paused scope mismatch")
  })

  it("shows a skipped run's own reason under the run", async () => {
    setup(
      [FIXTURE],
      [
        {
          id: "run-2",
          routineId: "rid-1",
          ranAt: "2024-01-02T00:00:00Z",
          status: "skipped_scope_mismatch",
          durationMs: 0,
          errorMessage:
            "Paused: the owner agent's scope ceiling does not cover invoicing:documents:write, so the tools this routine needs are not in its catalog.",
        },
      ],
    )
    await waitFor(() => expect(screen.getByTestId("run-reason-run-2")).toBeInTheDocument())
    expect(screen.getByTestId("run-reason-run-2")).toHaveTextContent("invoicing:documents:write")
    expect(screen.getByTestId("run-status-skipped_scope_mismatch")).toHaveTextContent(
      "Skipped: missing access",
    )
  })
})

describe("RoutineDetail - output destination picker (P4b-T18)", () => {
  beforeEach(() => {
    resetThreadStore()
    addThread({
      id: "chan-general",
      handle: "@general",
      title: "General",
      discoverable: true,
      participants: [
        { id: "user-1", name: "Me", avatarUrl: null, participantType: "user", agentId: null },
        {
          id: "agent-1",
          name: "Support",
          avatarUrl: null,
          participantType: "agent",
          agentId: "agent-1",
        },
      ],
    })
    // A channel the owner is in with another agent: the routine's posts are
    // the owner's, so it may post here too.
    addThread({
      id: "chan-other",
      handle: "@finance",
      title: "Finance",
      discoverable: true,
      participants: [
        { id: "user-1", name: "Me", avatarUrl: null, participantType: "user", agentId: null },
        {
          id: "agent-2",
          name: "Finance",
          avatarUrl: null,
          participantType: "agent",
          agentId: "agent-2",
        },
      ],
    })
    addThread({
      id: "dm-agent",
      handle: "@dm-support",
      title: null,
      discoverable: false,
      participants: [
        { id: "user-1", name: "Me", avatarUrl: null, participantType: "user", agentId: null },
        {
          id: "agent-1",
          name: "Support",
          avatarUrl: null,
          participantType: "agent",
          agentId: "agent-1",
        },
      ],
    })
    // A room the routine's owner does not sit in: it can never post there.
    addThread({
      id: "room-elsewhere",
      handle: "@elsewhere",
      title: "Elsewhere",
      discoverable: true,
      participants: [
        { id: "u-2", name: "Ana", avatarUrl: null, participantType: "user", agentId: null },
      ],
    })
    // A routine's own run thread: never a place to post to.
    addThread({
      id: "own-log",
      handle: "@routine-x",
      title: "x",
      type: "routine",
      discoverable: false,
      participants: [
        { id: "user-1", name: "Me", avatarUrl: null, participantType: "user", agentId: null },
      ],
    })
  })
  afterEach(resetThreadStore)

  async function openEditor() {
    const api = setup([FIXTURE])
    await waitFor(() => expect(screen.getByTestId("routine-edit")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("routine-edit"))
    return api
  }

  /** Open the destination menu the way a keyboard does, and wait for it. */
  async function openDestinationMenu() {
    const trigger = screen.getByTestId("routine-output-thread")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    await screen.findByTestId("routine-output-thread-menu")
    return trigger
  }

  async function chooseDestination(testId: string, expected: string) {
    await openDestinationMenu()
    fireEvent.keyDown(screen.getByTestId(testId), { key: "Enter" })
    await waitFor(() => expect(chosenId()).toBe(expected))
  }

  function chosenId(): string {
    return screen.getByTestId("routine-output-thread-value").getAttribute("data-value") ?? ""
  }

  it("the destination picker is the shared menu, not a native select", async () => {
    // A native `<select>` draws its open list outside the document: the open
    // state could be neither captured nor styled, and an option is one flat
    // line of text.
    await openEditor()
    const trigger = screen.getByTestId("routine-output-thread")
    expect(trigger.tagName).not.toBe("SELECT")
    expect(document.querySelector("select[data-testid='routine-output-thread']")).toBeNull()
    await openDestinationMenu()
    expect(screen.getByRole("menu", { name: enKernel.agentForms.postTo })).toBeInTheDocument()
  })

  it("tells two destinations with the same display name apart", async () => {
    // Two rooms with the same members render the same display name, and the
    // picker offered both as "App, Support" with nothing to choose between.
    for (const id of ["room-a", "room-b"]) {
      addThread({
        id,
        handle: `@${id}`,
        title: null,
        discoverable: false,
        participants: [
          { id: "user-1", name: "App", avatarUrl: null, participantType: "user", agentId: null },
          {
            id: "agent-1",
            name: "Support",
            avatarUrl: null,
            participantType: "agent",
            agentId: "agent-1",
          },
          {
            id: "agent-3",
            name: "Ops",
            avatarUrl: null,
            participantType: "agent",
            agentId: "agent-3",
          },
        ],
      })
    }
    await openEditor()
    await openDestinationMenu()
    const a = screen.getByTestId("routine-output-option-room-a")
    const b = screen.getByTestId("routine-output-option-room-b")
    expect(a.textContent).toContain("App, Support")
    expect(b.textContent).toContain("App, Support")
    expect(a.textContent).toContain("Ops")
    expect(a.textContent).not.toBe(b.textContent)
    expect(a.textContent).toContain("@room-a")
    expect(b.textContent).toContain("@room-b")
    expect(a.textContent).toContain(enKernel.agentForms.destinationKindRoom)
  })

  it("a channel row is named by its handle and says its name underneath", async () => {
    await openEditor()
    await openDestinationMenu()
    const channel = screen.getByTestId("routine-output-option-chan-general")
    expect(channel.textContent).toContain("#general")
    expect(channel.textContent).toContain("General")
    const dm = screen.getByTestId("routine-output-option-dm-agent")
    expect(dm.textContent).toContain(enKernel.agentForms.destinationKindDm)
  })

  // One "where it posts" field (reportThreadId): any conversation the
  // routine's OWNER sits in (its posts are the owner's), never a routine's own
  // run thread, which is the "only its own run thread" choice.
  it("routine destination picker lists the conversations the routine's owner sits in", async () => {
    await openEditor()
    await openDestinationMenu()
    expect(screen.getByTestId("routine-output-option-chan-general")).toBeInTheDocument()
    expect(screen.getByTestId("routine-output-option-dm-agent")).toBeInTheDocument()
    expect(screen.getByTestId("routine-output-option-chan-other")).toBeInTheDocument()
    expect(screen.queryByTestId("routine-output-option-room-elsewhere")).not.toBeInTheDocument()
    expect(screen.queryByTestId("routine-output-option-own-log")).not.toBeInTheDocument()
    expect(screen.getByTestId("routine-output-option-none").textContent).toBe(
      enKernel.routineNoDestination,
    )
  })

  it("no destination is an option, and saving it detaches the routine", async () => {
    const api = await openEditor()
    api.put = vi.fn(async () => ({ ...FIXTURE, reportThreadId: null }))
    await chooseDestination("routine-output-option-chan-general", "chan-general")
    await chooseDestination("routine-output-option-none", "")
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/agent/routines/rid-1",
        expect.objectContaining({ reportThreadId: null }),
      ),
    )
  })

  it("a refused destination is reported next to the picker", async () => {
    const api = await openEditor()
    api.put = vi.fn(async () => {
      throw new ApiError(
        "the routine's owner is not a member of that conversation or channel",
        400,
        "invalid_report_thread",
      )
    })
    await chooseDestination("routine-output-option-chan-general", "chan-general")
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() =>
      expect(screen.getByTestId("routine-output-thread-error")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("routine-output-thread-error").textContent).toBe(
      "the routine's owner is not a member of that conversation or channel",
    )
  })

  // Inventory 20: a null destination is a state the form must be able to keep.
  // The picker used to preselect the first candidate, so a Save made for an
  // unrelated edit bound the routine to a room nobody had chosen.
  it("routine destination picker opens on the empty choice when none is chosen", async () => {
    const api = await openEditor()
    expect(chosenId()).toBe("")
    expect(screen.getByTestId("routine-output-thread").textContent).toContain(
      enKernel.routineNoDestination,
    )

    // An edit that never touched the picker keeps the destination null.
    api.put = vi.fn(async () => ({ ...FIXTURE, reportThreadId: null }))
    fireEvent.input(screen.getByTestId("routine-edit-prompt"), {
      target: { value: "say hi again" },
    })
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/agent/routines/rid-1",
        expect.objectContaining({ reportThreadId: null }),
      ),
    )
  })

  it("the read view names the destination, and says so when there is none", async () => {
    setup([FIXTURE])
    await waitFor(() => expect(screen.getByTestId("routine-destination-text")).toBeInTheDocument())
    expect(screen.getByTestId("routine-destination-text").textContent?.trim()).toBe(
      enKernel.routineNoDestination,
    )

    cleanup()
    resetRoutinesStore()
    setup([{ ...FIXTURE, reportThreadId: "chan-general" }])
    await waitFor(() => expect(screen.getByTestId("routine-destination-text")).toBeInTheDocument())
    expect(screen.getByTestId("routine-destination-text").textContent).toContain("General")
  })

  it("saving writes the chosen conversation to reportThreadId", async () => {
    const api = await openEditor()
    api.put = vi.fn(async () => ({ ...FIXTURE, reportThreadId: "chan-general" }))
    await chooseDestination("routine-output-option-chan-general", "chan-general")
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/agent/routines/rid-1",
        expect.objectContaining({ reportThreadId: "chan-general" }),
      ),
    )
  })

  it("a destination outside the owner's conversations stays selected, marked as unavailable", async () => {
    // room-elsewhere is a real thread the routine already posts to, and the
    // owner is NOT seated in it. The picker used to show "No destination" over
    // a signal still holding chan-other, so opening the editor and saving
    // anything else silently detached a destination nobody asked to change.
    const api = setup([{ ...FIXTURE, reportThreadId: "room-elsewhere" }])
    await waitFor(() => expect(screen.getByTestId("routine-edit")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("routine-edit"))

    expect(chosenId()).toBe("room-elsewhere")
    const value = screen.getByTestId("routine-output-thread-value")
    expect(value.getAttribute("data-current-destination")).toBe("true")
    expect(value.textContent).toMatch(/Elsewhere/)

    api.put = vi.fn(async () => ({ ...FIXTURE, reportThreadId: "room-elsewhere" }))
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/agent/routines/rid-1",
        expect.objectContaining({ reportThreadId: "room-elsewhere" }),
      ),
    )
  })

  it("a destination thread the user cannot see at all stays selected", async () => {
    const api = setup([{ ...FIXTURE, reportThreadId: "chan-gone" }])
    await waitFor(() => expect(screen.getByTestId("routine-edit")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("routine-edit"))
    expect(chosenId()).toBe("chan-gone")
    api.put = vi.fn(async () => ({ ...FIXTURE, reportThreadId: "chan-gone" }))
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/agent/routines/rid-1",
        expect.objectContaining({ reportThreadId: "chan-gone" }),
      ),
    )
  })

  it("a routine that already names a destination keeps it selected", async () => {
    const api = setup([{ ...FIXTURE, reportThreadId: "chan-general" }])
    await waitFor(() => expect(screen.getByTestId("routine-edit")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("routine-edit"))
    expect(chosenId()).toBe("chan-general")
    expect(api.put).not.toHaveBeenCalled()
  })
})

// Demo walk (P6-postto): "Post to" read "Destination unavailable" on an
// agent's Routines tab until the sidebar's thread list had loaded in that
// session, and for good when the destination was outside the list's 50 most
// recent threads. The label resolved from the thread store only.
describe("RoutineDetail - destination resolves before the thread list loads", () => {
  const SEATED = {
    id: "chan-late",
    handle: "@reports",
    title: "Reports",
    discoverable: true,
    participants: [
      { id: "user-1", name: "Me", avatarUrl: null, participantType: "user", agentId: null },
      {
        id: "agent-1",
        name: "Support",
        avatarUrl: null,
        participantType: "agent",
        agentId: "agent-1",
      },
    ],
  }

  beforeEach(resetThreadStore)
  afterEach(resetThreadStore)

  function setupWithThreads(row: any, threads: Record<string, any>) {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const api = {
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/runs")) return []
        const m = path.match(/^\/threads\/([^/?]+)$/)
        if (m) {
          await gate
          const t = threads[m[1]!]
          if (!t) throw new ApiError("Thread not found", 404)
          return t
        }
        return [row]
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
        <RoutineDetail entityId="rid-1" />
      </ApiContext.Provider>
    ))
    return { api, release }
  }

  // Until the server says what the destination is, the read view says it is
  // loading, and it is never called unavailable before the answer.
  it("the read view says loading while asking, then the thread's name, with an empty thread store", async () => {
    const { api, release } = setupWithThreads(
      { ...FIXTURE, reportThreadId: "chan-late" },
      { "chan-late": SEATED },
    )
    await waitFor(() => expect(screen.getByTestId("routine-prompt")).toBeInTheDocument())
    expect(screen.queryByText(enKernel.routineDestinationUnavailable)).toBeNull()
    const text = () => screen.queryByTestId("routine-destination-text")?.textContent ?? ""
    expect(text()).toBe(enKernel.loading)
    release()
    await waitFor(() => expect(text()).toBe("#Reports"))
    expect(api.get).toHaveBeenCalledWith("/threads/chan-late")
  })

  it("a destination that really is gone reads unavailable once the server says so", async () => {
    const { release } = setupWithThreads({ ...FIXTURE, reportThreadId: "chan-gone" }, {})
    await waitFor(() => expect(screen.getByTestId("routine-prompt")).toBeInTheDocument())
    release()
    await waitFor(() =>
      expect(screen.getByTestId("routine-destination-text").textContent).toBe(
        enKernel.routineDestinationUnavailable,
      ),
    )
  })

  // A routine that posts only in its own run thread says so; its run thread
  // (internal, `outputThreadId`) is never fetched or offered as a destination.
  it("a routine posting only in its own run thread reads so, and its run thread is not offered", async () => {
    addThread({
      id: "own-thread",
      handle: "@routine-rid-1",
      title: "morning",
      type: "routine",
      discoverable: false,
      participants: [
        { id: "user-1", name: "Me", avatarUrl: null, participantType: "user", agentId: null },
      ],
    } as never)
    const { api, release } = setupWithThreads(
      { ...FIXTURE, outputThreadId: "own-thread", reportThreadId: null },
      {},
    )
    release()
    await waitFor(() =>
      expect(screen.getByTestId("routine-destination-text").textContent?.trim()).toBe(
        enKernel.routineNoDestination,
      ),
    )
    expect(api.get).not.toHaveBeenCalledWith("/threads/own-thread")
    fireEvent.click(screen.getByTestId("routine-edit"))
    expect(screen.getByTestId("routine-output-thread-value").getAttribute("data-value")).toBe("")
  })

  it("the editor offers the fetched destination as a normal choice, not 'unavailable'", async () => {
    const { release } = setupWithThreads(
      { ...FIXTURE, reportThreadId: "chan-late" },
      { "chan-late": SEATED },
    )
    release()
    await waitFor(() =>
      expect(screen.getByTestId("routine-destination-text").textContent).toBe("#Reports"),
    )
    fireEvent.click(screen.getByTestId("routine-edit"))
    const value = screen.getByTestId("routine-output-thread-value")
    expect(value.getAttribute("data-current-destination")).toBeNull()
    expect(value.textContent).toContain("reports")
  })
})

// D20 (2026-10-12): a routine's scopes are explicit. The editor shows them as words and lets
// the owner add the scopes they hold and remove any; nothing is guessed from the prompt.
describe("RoutineDetail - scope picker (D20)", () => {
  const OPTIONS = [
    { scope: "tickets:tickets:read", app: "tickets", description: "Read tickets" },
    { scope: "kernel:contacts:read", app: "kernel", description: "Read contacts" },
    { scope: "kernel:threads:write", app: "kernel", description: "Write threads" },
  ]

  function setupWithOptions(rows: any[]) {
    const api = setup(rows)
    api.get = vi.fn(async (path: string) => {
      if (path.endsWith("/runs")) return []
      if (path.endsWith("/scope-options")) return OPTIONS
      return rows
    }) as never
    return api
  }

  it("shows the routine's scopes as words, offers held scopes, and saves one added and one removed", async () => {
    const api = setupWithOptions([
      { ...FIXTURE, scopes: ["tickets:tickets:read", "mail:conversations:read"] },
    ])
    api.put = vi.fn(async (_p: string, body: any) => ({ ...FIXTURE, ...body })) as never
    await waitFor(() => expect(screen.getByTestId("routine-edit")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("routine-edit"))
    const picker = await screen.findByTestId("routine-scopes-field")
    // Current scopes, by their words; the identifier stays in the title only.
    const chip = screen.getByTestId("routine-scope-chip-tickets:tickets:read")
    expect(chip.textContent).not.toContain("tickets:tickets:read")
    expect(chip.getAttribute("title")).toContain("tickets:tickets:read")
    expect(screen.getByTestId("routine-scope-chip-mail:conversations:read")).toBeInTheDocument()
    // Offered: what the editor holds and the routine lacks, never what it already has.
    await waitFor(() =>
      expect(screen.getByTestId("routine-scope-add-kernel:contacts:read")).toBeInTheDocument(),
    )
    expect(screen.queryByTestId("routine-scope-add-tickets:tickets:read")).toBeNull()
    expect(picker.textContent).not.toContain("kernel:contacts:read")

    fireEvent.click(screen.getByTestId("routine-scope-remove-mail:conversations:read"))
    fireEvent.click(screen.getByTestId("routine-scope-add-kernel:contacts:read"))
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/agent/routines/rid-1",
        expect.objectContaining({ scopes: ["tickets:tickets:read", "kernel:contacts:read"] }),
      ),
    )
  })

  it("an edit that leaves the scopes alone does not send them", async () => {
    const api = setupWithOptions([{ ...FIXTURE, scopes: ["tickets:tickets:read"] }])
    api.put = vi.fn(async () => FIXTURE) as never
    await waitFor(() => expect(screen.getByTestId("routine-edit")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("routine-edit"))
    fireEvent.input(screen.getByTestId("routine-edit-description"), {
      target: { value: "edited" },
    })
    fireEvent.click(screen.getByTestId("routine-edit-save"))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    const body = (api.put as any).mock.calls[0][1]
    expect("scopes" in body).toBe(false)
  })

  it("a routine with no scope says so in the editor", async () => {
    setupWithOptions([{ ...FIXTURE, scopes: [] }])
    await waitFor(() => expect(screen.getByTestId("routine-edit")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("routine-edit"))
    expect(await screen.findByTestId("routine-scopes-empty")).toHaveTextContent(
      enKernel.agentForms.scopesEmpty,
    )
  })

  it("a routine paused for a missing scope says how to fix it", async () => {
    setup([
      {
        ...FIXTURE,
        status: "paused_scope_mismatch",
        lastRunError: "Paused: the owner no longer holds tickets:tickets:write.",
      },
    ])
    await waitFor(() => expect(screen.getByTestId("routine-paused-banner")).toBeInTheDocument())
    expect(screen.getByTestId("routine-scope-fix-hint")).toHaveTextContent(
      enKernel.agentForms.scopeFixHint,
    )
  })
})

// The pane reads runs first: a Runs tab (the default) with a paged list, and a
// Settings tab with how the routine is set up. Run now stays apart from rows.
describe("RoutineDetail runs and settings tabs", () => {
  function run(i: number, extra: Record<string, unknown> = {}) {
    return {
      id: `run-${i}`,
      routineId: "rid-1",
      ranAt: new Date(Date.UTC(2026, 9, 16, 9, 0, 0) - i * 60_000).toISOString(),
      startedAt: null,
      status: "succeeded",
      durationMs: 125_000,
      error: null,
      trigger: null,
      triggerLabel: null,
      summary: `summary ${i}`,
      ...extra,
    }
  }

  function setupPaged(routine: Record<string, unknown>, pages: Record<string, any[]>) {
    const api = {
      get: vi.fn(async (path: string) => {
        if (path.includes("/runs")) {
          const before = /before=([^&]+)/.exec(path)?.[1]
          return pages[before ?? "first"] ?? []
        }
        return [routine]
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
        <RoutineDetail entityId="rid-1" />
      </ApiContext.Provider>
    ))
    return api
  }

  it("opens on Runs, and a run without a recorded trigger reads its routine's kind", async () => {
    setupPaged({ ...FIXTURE, kind: "event", event: "tickets:ticket:create" }, { first: [run(0)] })
    await waitFor(() => expect(screen.getByTestId("run-history-row-run-0")).toBeInTheDocument())
    expect(screen.getByTestId("routine-tab-runs")).toHaveAttribute("aria-selected", "true")
    expect(screen.getByTestId("routine-runs-panel")).not.toHaveAttribute("hidden")
    expect(screen.getByTestId("routine-settings-panel")).toHaveAttribute("hidden")
    expect(screen.getByTestId("run-trigger-run-0")).toHaveTextContent("On event")
    expect(screen.getByTestId("run-duration-run-0")).toHaveTextContent("2 min 5 sec")
    expect(screen.getByTestId("run-summary-run-0")).toHaveTextContent("summary 0")
    // Run now is the routine's action, in its header, never among the run rows.
    expect(screen.getByTestId("routine-run-history")).not.toContainElement(
      screen.getByTestId("routine-run-now"),
    )
    expect(screen.getByTestId("routine-runs-panel")).not.toContainElement(
      screen.getByTestId("routine-run-now"),
    )
  })

  it("a scheduled routine's older runs read Scheduled", async () => {
    setupPaged(FIXTURE, { first: [run(0)] })
    await waitFor(() =>
      expect(screen.getByTestId("run-trigger-run-0")).toHaveTextContent("Scheduled"),
    )
  })

  it("pages older runs on demand", async () => {
    const first = Array.from({ length: 50 }, (_, i) => run(i))
    const api = setupPaged(FIXTURE, { first, "run-49": [run(50)] })
    await waitFor(() => expect(screen.getByTestId("routine-runs-older")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("routine-runs-older"))
    await waitFor(() => expect(screen.getByTestId("run-history-row-run-50")).toBeInTheDocument())
    expect(api.get).toHaveBeenCalledWith("/agent/routines/rid-1/runs?limit=50&before=run-49")
    // The last page was short: nothing older is offered.
    expect(screen.queryByTestId("routine-runs-older")).toBeNull()
  })

  it("Settings holds the setup, with a long prompt collapsed until Show all", async () => {
    const prompt = Array.from({ length: 12 }, (_, i) => `step ${i}`).join("\n")
    setupPaged({ ...FIXTURE, prompt }, { first: [] })
    await waitFor(() => expect(screen.getByTestId("routine-tab-settings")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("routine-tab-settings"))
    expect(screen.getByTestId("routine-settings-panel")).not.toHaveAttribute("hidden")
    expect(screen.getByTestId("routine-prompt")).toHaveClass("line-clamp-4")
    fireEvent.click(screen.getByTestId("routine-prompt-toggle"))
    expect(screen.getByTestId("routine-prompt")).not.toHaveClass("line-clamp-4")
  })

  it("Edit brings the Settings tab forward", async () => {
    setupPaged({ ...FIXTURE, canWrite: true }, { first: [] })
    await waitFor(() => expect(screen.getByTestId("routine-edit")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("routine-edit"))
    await waitFor(() =>
      expect(screen.getByTestId("routine-tab-settings")).toHaveAttribute("aria-selected", "true"),
    )
    expect(screen.getByTestId("routine-edit-form")).toBeInTheDocument()
  })
})
