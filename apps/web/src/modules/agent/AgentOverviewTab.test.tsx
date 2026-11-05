// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * P4c-T35: the agent page's Overview tab.
 *
 * The two claims that are easy to break by accident: the instructions stay
 * COLLAPSED until asked for (the charter is a disclosure, not a greeting), and
 * `Add to channel` is the existing thread add member call with the AGENT's id,
 * not a new route of its own.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import AgentOverviewTab, { type AgentDetail } from "~/modules/agent/AgentOverviewTab"
import { ApiContext } from "~/modules/shell/ApiContext"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

const AGENT = "11111111-1111-4111-8111-111111111111"
const VIEWER = "33333333-3333-4333-8333-333333333333"

const grants = new Set<string>()

/** What the roles listing answers: the org's roles, by their own name. */
let orgRoles: Array<{ roleId: string; name: string }> = []
/** A viewer who holds neither roles read: both listings refuse. */
let rolesRefused = false

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: (scope: string) => grants.has(scope),
  userFromToken: () => ({
    userId: VIEWER,
    orgId: "org",
    scopes: [],
    roles: [],
    dimensionGrants: {},
    exp: 0,
    name: "Me",
  }),
}))

function detail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: AGENT,
    handle: "@logistics",
    displayName: "Logistics",
    kind: "role",
    ownerUserId: null,
    purpose: "Keeps the shipping queue moving.",
    avatarUrl: null,
    state: "active",
    lastActivityAt: "2026-09-13T10:00:00.000Z",
    channels: [{ id: "c-1", handle: "@shipping", name: "Shipping" }],
    counts: { skills: 2, routines: 1, memoryFiles: 3, knowledgePointers: 0 },
    capabilityCategories: ["kernel", "tickets"],
    runsOn: "liaison",
    ...over,
  }
}

function setup(over: Partial<AgentDetail> = {}, systemPrompt = "Ship it carefully.") {
  const api: any = {
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/definition")) return { data: { systemPrompt } }
      if (path.endsWith("/roles")) {
        if (rolesRefused) throw new ApiError("Forbidden", 403)
        return { data: orgRoles }
      }
      return null
    }),
    post: vi.fn(async () => ({ data: { ok: true } })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <AgentOverviewTab agentId={AGENT} agentName="Logistics" detail={detail(over)} />
    </ApiContext.Provider>
  ))
  return api
}

describe("AgentOverviewTab (P4c-T35)", () => {
  beforeEach(() => {
    grants.clear()
    orgRoles = []
    rolesRefused = false
    resetThreadStore()
  })
  afterEach(() => cleanup())

  it("the purpose and the channels are on the page and the instructions are not", async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId("agent-overview-purpose")).toBeInTheDocument())
    expect(screen.getByTestId("agent-overview-purpose").textContent).toBe(
      "Keeps the shipping queue moving.",
    )
    expect(screen.getByTestId("agent-overview-channel-c-1").textContent).toBe("Shipping")
    expect(screen.queryByTestId("agent-overview-instructions")).toBeNull()
  })

  it("Show instructions reveals the system prompt, read only", async () => {
    setup()
    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-toggle-instructions")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId("agent-overview-toggle-instructions"))
    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-instructions")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("agent-overview-instructions").textContent).toBe("Ship it carefully.")
    // Read only: no editor, no save.
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  // The candidates rendered as bare text under the channel list, with no
  // surface of their own and nothing the keyboard could reach.
  it("the candidates live in a menu that is closed until it is asked for", async () => {
    grants.add("kernel:threads:admin")
    addThread({
      id: "c-9",
      handle: "@returns",
      title: "Returns",
      type: "thread",
      discoverable: true,
      createdBy: "someone-else",
      participants: [
        { id: VIEWER, name: "Me" },
        { id: "other", name: "Other" },
      ],
      updatedAt: "2026-09-13T10:00:00.000Z",
    })
    setup()
    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-add-to-channel")).toBeInTheDocument(),
    )
    // Closed by default: no menu, and no candidate row loose on the page.
    expect(screen.queryByRole("menu")).toBeNull()
    expect(screen.queryByTestId("agent-overview-add-c-9")).toBeNull()

    const trigger = screen.getByTestId("agent-overview-add-to-channel")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })

    const menu = await screen.findByRole("menu")
    expect(menu).toBeInTheDocument()
    const candidate = screen.getByTestId("agent-overview-add-c-9")
    expect(menu.contains(candidate)).toBe(true)
    expect(candidate.getAttribute("role")).toBe("menuitem")
  })

  it("Add to channel posts the agent to the existing participants route", async () => {
    grants.add("kernel:threads:admin")
    addThread({
      id: "c-2",
      handle: "@returns",
      title: "Returns",
      type: "thread",
      discoverable: true,
      createdBy: "someone-else",
      participants: [
        { id: VIEWER, name: "Me" },
        { id: "other", name: "Other" },
      ],
      updatedAt: "2026-09-13T10:00:00.000Z",
    })
    const api = setup()
    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-add-to-channel")).toBeInTheDocument(),
    )
    // The candidates are a menu now: the keyboard opens it, and selecting a
    // row is a menuitem select, not a click on bare text under the list.
    const trigger = screen.getByTestId("agent-overview-add-to-channel")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    await waitFor(() => expect(screen.getByTestId("agent-overview-add-c-2")).toBeInTheDocument())
    fireEvent.keyDown(screen.getByTestId("agent-overview-add-c-2"), { key: "Enter" })
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/threads/c-2/participants", { agentId: AGENT }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-channel-c-2")).toBeInTheDocument(),
    )
  })

  // Surface 35: the call went out as `{ userId: <agentId> }`, the route
  // resolved it as a user and answered 404, and the component listed the
  // channel as added regardless.
  it("a refused Add to channel adds nothing and says why", async () => {
    grants.add("kernel:threads:admin")
    addThread({
      id: "c-4",
      handle: "@returns",
      title: "Returns",
      type: "thread",
      discoverable: true,
      createdBy: "someone-else",
      participants: [
        { id: VIEWER, name: "Me" },
        { id: "other", name: "Other" },
      ],
      updatedAt: "2026-09-13T10:00:00.000Z",
    })
    const api = setup()
    api.post = vi.fn(async () => {
      throw new ApiError("Not found", 404, "not_found")
    })
    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-add-to-channel")).toBeInTheDocument(),
    )
    const trigger = screen.getByTestId("agent-overview-add-to-channel")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    await waitFor(() => expect(screen.getByTestId("agent-overview-add-c-4")).toBeInTheDocument())
    fireEvent.keyDown(screen.getByTestId("agent-overview-add-c-4"), { key: "Enter" })

    await waitFor(() => expect(screen.getByTestId("agent-overview-add-error")).toBeInTheDocument())
    expect(screen.getByTestId("agent-overview-add-error").textContent).toContain("Not found")
    expect(screen.queryByTestId("agent-overview-channel-c-4")).toBeNull()
  })

  it("a viewer who may add to no channel is offered no Add to channel control", async () => {
    addThread({
      id: "c-3",
      handle: "@finance",
      title: "Finance",
      type: "thread",
      discoverable: true,
      createdBy: "someone-else",
      participants: [
        { id: VIEWER, name: "Me" },
        { id: "other", name: "Other" },
      ],
      updatedAt: "2026-09-13T10:00:00.000Z",
    })
    setup()
    await waitFor(() => expect(screen.getByTestId("agent-overview")).toBeInTheDocument())
    expect(screen.queryByTestId("agent-overview-add-to-channel")).toBeNull()
  })
  // Charter agent.md, "A scope name on screen": the CAPABILITIES row printed
  // the raw slugs (`clevel`, `kernel`, `mcp-manager`) beside one human
  // sentence. Each chip reads as the app or the role it names now, and the
  // wildcard phrase is left alone.
  it("the capability chips read as app and role names, never as slugs", async () => {
    orgRoles = [{ roleId: "r-1", name: "C-Level" }]
    setup({
      capabilityCategories: [
        "clevel",
        "everything this workspace allows",
        "mcp-manager",
        "tickets",
      ],
    })
    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-capability-tickets")).toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-capability-clevel").textContent).toBe("C-Level"),
    )
    expect(screen.getByTestId("agent-overview-capability-tickets").textContent).toBe("Tickets")
    expect(screen.getByTestId("agent-overview-capability-mcp-manager").textContent).toBe(
      "Connected services",
    )
    // The phrase that is already a sentence stays exactly as it is.
    expect(
      screen.getByTestId("agent-overview-capability-everything this workspace allows").textContent,
    ).toBe("everything this workspace allows")
    const chips = screen.getByTestId("agent-overview-capabilities").textContent ?? ""
    expect(chips).not.toContain("mcp-manager")
    expect(chips).not.toContain("clevel")
  })

  // @base is a TEMPLATE, never a correspondent: the system agent's page offers
  // no Add to channel at all, absent from the DOM rather than disabled.
  it("the system agent is offered no Add to channel, even with candidates", async () => {
    grants.add("kernel:threads:admin")
    addThread({
      id: "c-7",
      handle: "@ops",
      title: "Ops",
      type: "thread",
      discoverable: true,
      createdBy: "someone-else",
      participants: [
        { id: VIEWER, name: "Me" },
        { id: "other", name: "Other" },
      ],
      updatedAt: "2026-09-13T10:00:00.000Z",
    })
    setup({ kind: "system", handle: "@base", displayName: "base" })
    await waitFor(() => expect(screen.getByTestId("agent-overview")).toBeInTheDocument())
    expect(screen.queryByTestId("agent-overview-add-to-channel")).toBeNull()
    expect(screen.queryByTestId("agent-overview-channel-picker")).toBeNull()
  })
  // A member may hold neither roles read, and the chip used to de-slug the
  // category into "Clevel": a mangled word that claims to be a name. It reads
  // as a neutral one instead, with the identifier kept for a hover.
  it("a category nothing can name reads as a neutral word, never as a mangled slug", async () => {
    rolesRefused = true
    setup({ capabilityCategories: ["clevel", "tickets"] })
    const chip = await waitFor(() => screen.getByTestId("agent-overview-capability-clevel"))
    await waitFor(() => expect(chip.textContent).toBe("Role"))
    expect(chip.textContent).not.toBe("Clevel")
    expect(chip.getAttribute("title")).toBe("clevel")
    // A real app is still named, refusal or not.
    expect(screen.getByTestId("agent-overview-capability-tickets").textContent).toBe("Tickets")
  })
})
