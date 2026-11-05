// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerTabType, resetRegistry } from "~/framework/app-registry"
import {
  DESKTOP_BRIDGE_KEY,
  DESKTOP_BRIDGE_VERSION,
  emptyDesktopSessionState,
} from "~/lib/desktop-shell-contract"
import { parseServedModels, setServedModels } from "~/lib/model-groups"
import { SERVED_MODELS_FIXTURE } from "~/lib/model-groups.fixture"
import { attachDesktopBridge, resetDesktopStore } from "~/modules/desktop/desktop-store"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { BillingStateTestAccess } from "~/modules/settings/BillingState"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { makeTabId, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { provideThreadModelControl } from "~/modules/threads/InvokedModelMenu"
import ThreadHeader from "~/modules/threads/ThreadHeader"

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
    }),
  ),
)

const noop = () => {}
const noopAdd = (_id: string, _name: string, _url: string | null) => {}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "t1",
    title: "Test Thread",
    handle: "@thread-1",
    participants: [
      { id: "creator", name: "Creator", avatarUrl: null },
      { id: "member", name: "Member", avatarUrl: null },
      { id: "other", name: "Other", avatarUrl: null },
    ],
    isPinned: false,
    isPinnedByUser: false,
    isMuted: false,
    isArchived: false,
    discoverable: false,
    topic: null,
    description: null,
    currentUserId: "member",
    createdBy: "creator",
    canAdminThreads: false,
    onTogglePin: noop,
    onTogglePinForAll: noop,
    onToggleMute: noop,
    onToggleDiscoverable: noop,
    onSaveDetails: noop,
    onArchive: noop,
    onLeave: noop,
    onAddParticipant: noopAdd,
    onRemoveParticipant: noop,
    ...overrides,
  }
}

function renderHeader(overrides: Record<string, unknown> = {}) {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <ThreadHeader {...makeProps(overrides)} />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

// The expanded stack unrolled OVER the channel title and hid half of it. The
// header row is the other half of the fix: the stack grows in flow, so the
// title has to be a shrinkable flex sibling that gives way instead of sitting
// underneath it.
describe("ThreadHeader gives the expanded stack room instead of letting it overlay", () => {
  afterEach(() => cleanup())

  it("the stack and the title are flex siblings, and the title can shrink", () => {
    renderHeader()
    const stack = screen.getByTestId("avatar-stack")
    const title = screen.getByTestId("thread-header-title")
    const row = stack.parentElement!
    expect(row.className).toContain("flex")
    // The title block is the stack's own sibling in that row.
    const titleBlock = title.closest("[data-testid='thread-header-title-block']")!
    expect(titleBlock.parentElement).toBe(row)
    // min-w-0 is what lets it truncate rather than push, so a widening stack
    // shifts it instead of being drawn on top of it.
    expect(titleBlock.className).toContain("min-w-0")
    expect(title.className).toContain("truncate")
  })
})

describe("ThreadHeader — participant removal authorization", () => {
  afterEach(() => cleanup())

  it("does not show remove buttons for a regular participant (not creator, not admin)", async () => {
    renderHeader({ currentUserId: "member", createdBy: "creator", canAdminThreads: false })
    // Open the actions menu
    const actionsBtn = screen.getByLabelText("Thread actions")
    actionsBtn.click()
    // Wait for participant list to render
    await screen.findByText("Participants")
    // Should see other participants listed but no remove (X) buttons
    expect(screen.getByText("Creator")).toBeInTheDocument()
    expect(screen.getByText("Other")).toBeInTheDocument()
    expect(screen.queryAllByLabelText(/^Remove /)).toHaveLength(0)
  })

  it("shows remove buttons when current user is the thread creator", async () => {
    renderHeader({ currentUserId: "creator", createdBy: "creator", canAdminThreads: false })
    const actionsBtn = screen.getByLabelText("Thread actions")
    actionsBtn.click()
    await screen.findByText("Participants")
    // Creator should see remove buttons for other participants (not for self)
    const removeButtons = screen.queryAllByLabelText(/^Remove /)
    expect(removeButtons.length).toBe(2) // Member and Other, not Creator
    expect(screen.getByLabelText("Remove Member")).toBeInTheDocument()
    expect(screen.getByLabelText("Remove Other")).toBeInTheDocument()
  })

  it("shows remove buttons when current user is admin (not creator)", async () => {
    renderHeader({ currentUserId: "member", createdBy: "creator", canAdminThreads: true })
    const actionsBtn = screen.getByLabelText("Thread actions")
    actionsBtn.click()
    await screen.findByText("Participants")
    // Admin should see remove buttons for others (not self)
    const removeButtons = screen.queryAllByLabelText(/^Remove /)
    expect(removeButtons.length).toBe(2) // Creator and Other, not Member
    expect(screen.getByLabelText("Remove Creator")).toBeInTheDocument()
    expect(screen.getByLabelText("Remove Other")).toBeInTheDocument()
  })
})

describe("ThreadHeader - real agent participants (P4b-T03)", () => {
  afterEach(() => cleanup())

  it("displayParticipants returns the real agent participant row, not a synthetic one", () => {
    renderHeader({
      title: null,
      currentUserId: "member",
      tainted: true,
      hasAgentMessages: true,
      participants: [
        { id: "member", name: "Member", avatarUrl: null },
        {
          id: "55555555-5555-4555-8555-555555555555",
          name: "Support",
          avatarUrl: null,
          participantType: "agent",
          agentId: "55555555-5555-4555-8555-555555555555",
        },
      ],
    })
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Support")
    expect(screen.queryByText("Liaison")).not.toBeInTheDocument()
    expect(screen.getByTestId("participant-count").textContent).toBe("2")
  })

  it("a tainted thread with no agent participant shows only its real members", () => {
    renderHeader({
      title: null,
      currentUserId: "member",
      tainted: true,
      hasAgentMessages: true,
      participants: [
        { id: "member", name: "Member", avatarUrl: null },
        { id: "other", name: "Other Person", avatarUrl: null },
      ],
    })
    expect(screen.getByTestId("participant-count").textContent).toBe("2")
    expect(screen.queryByText("Liaison")).not.toBeInTheDocument()
  })
})

describe("ThreadHeader - add-member hidden-history warning (P4b-T26)", () => {
  afterEach(() => cleanup())

  function stubFetch(wouldHideHistory: boolean) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input)
        const body = url.includes("hidden-history-check")
          ? { data: { wouldHideHistory } }
          : { data: [{ type: "user", id: "u-quinn", label: "Quinn" }] }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "application/json" : null,
          },
          text: () => Promise.resolve(JSON.stringify(body)),
        })
      }),
    )
  }

  async function searchAndPick() {
    screen.getByLabelText("Add participant").click()
    const input = await screen.findByPlaceholderText("Search people...")
    ;(input as HTMLInputElement).value = "Nic"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    const row = await screen.findByText("Quinn", {}, { timeout: 2000 })
    row.click()
  }

  it("shows the exact add-member warning string with the candidate name substituted", async () => {
    stubFetch(true)
    const added: string[] = []
    renderHeader({ onAddParticipant: (id: string) => added.push(id) })
    await searchAndPick()
    expect(
      await screen.findByText(
        "This room has earlier messages Quinn will not be able to see. Add anyway?",
      ),
    ).toBeInTheDocument()
    expect(added).toEqual([])
  })

  it("shows no warning when wouldHideHistory is false", async () => {
    stubFetch(false)
    const added: string[] = []
    renderHeader({ onAddParticipant: (id: string) => added.push(id) })
    await searchAndPick()
    await vi.waitFor(() => expect(added).toEqual(["u-quinn"]))
    expect(
      screen.queryByText(
        "This room has earlier messages Quinn will not be able to see. Add anyway?",
      ),
    ).not.toBeInTheDocument()
  })

  it("confirming the warning adds the member", async () => {
    stubFetch(true)
    const added: string[] = []
    renderHeader({ onAddParticipant: (id: string) => added.push(id) })
    await searchAndPick()
    const confirm = await screen.findByTestId("add-member-confirm")
    confirm.click()
    await vi.waitFor(() => expect(added).toEqual(["u-quinn"]))
  })

  it("cancelling the warning adds nobody", async () => {
    stubFetch(true)
    const added: string[] = []
    renderHeader({ onAddParticipant: (id: string) => added.push(id) })
    await searchAndPick()
    const cancel = await screen.findByTestId("add-member-cancel")
    cancel.click()
    await Promise.resolve()
    expect(added).toEqual([])
    expect(
      screen.queryByText(
        "This room has earlier messages Quinn will not be able to see. Add anyway?",
      ),
    ).not.toBeInTheDocument()
  })
})

describe("ThreadHeader - add-member warning comes from the kernel dictionary (P4b-E1)", () => {
  afterEach(() => cleanup())

  it("renders the French warning and confirm label when the provider is French", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input)
        const body = url.includes("hidden-history-check")
          ? { data: { wouldHideHistory: true } }
          : { data: [{ type: "user", id: "u-quinn", label: "Quinn" }] }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "application/json" : null,
          },
          text: () => Promise.resolve(JSON.stringify(body)),
        })
      }),
    )
    render(() => (
      <I18nProvider initialLocale="fr">
        <Router>
          <Route
            path="/*"
            component={() => (
              <ApiProvider>
                <ThreadHeader {...(makeProps() as ReturnType<typeof makeProps>)} />
              </ApiProvider>
            )}
          />
        </Router>
      </I18nProvider>
    ))
    screen.getByLabelText("Ajouter un participant").click()
    const input = await screen.findByPlaceholderText("Rechercher des personnes…")
    ;(input as HTMLInputElement).value = "Nic"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    const row = await screen.findByText("Quinn", {}, { timeout: 2000 })
    row.click()
    expect(
      await screen.findByText(
        "Cette discussion contient des messages antérieurs que Quinn ne pourra pas voir. Ajouter quand même ?",
      ),
    ).toBeInTheDocument()
    expect(screen.getByTestId("add-member-confirm").textContent).toBe("Ajouter quand même")
  })
})

describe("ThreadHeader - agent participants open the agent profile (P4m-T31)", () => {
  afterEach(() => {
    cleanup()
    resetTabStore()
  })

  const AGENT_ID = "99999999-9999-4999-8999-999999999999"

  function renderWithAgent() {
    return renderHeader({
      participants: [
        { id: "member", name: "Member", avatarUrl: null },
        {
          id: "seat-support",
          name: "Support",
          avatarUrl: null,
          participantType: "agent",
          agentId: AGENT_ID,
        },
      ],
    })
  }

  it("an agent participant row opens the agent page", () => {
    resetTabStore()
    renderWithAgent()
    screen.getByLabelText("Thread actions").click()
    const open = screen.getByTestId(`thread-header-agent-profile-${AGENT_ID}`)
    open.click()
    // P4c-T39: one page per agent, addressed by handle when the directory can
    // name it and by id until then.
    expect(tabStore.activeTabId).toBe(makeTabId("agents:agent", AGENT_ID))
    const tab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
    expect(tab?.label).toBe("Support")
  })

  it("a human participant row has no profile control", () => {
    resetTabStore()
    renderWithAgent()
    screen.getByLabelText("Thread actions").click()
    expect(screen.queryByTestId("thread-header-agent-profile-member")).not.toBeInTheDocument()
  })
})

// THE DESKTOP SHELL'S CONTRACT (lib/desktop-shell-contract.ts). The shell
// offers "Run this on my machine" for the agent the user is talking to and
// reads it off this header. It used to scrape the participant SEATS, which
// live inside a popover apps/web mounts only while it is open, so the offer
// was unreachable unless the user had opened a list they had no reason to
// open. The header itself says it now, always, while it is on screen.
describe("ThreadHeader publishes the DM's agent for the desktop shell", () => {
  afterEach(() => cleanup())

  const AGENT_ID = "11111111-1111-4111-8111-111111111111"

  function agentSeat(id: string, name: string) {
    return {
      id: `seat-${id}`,
      name,
      avatarUrl: null,
      participantType: "agent" as const,
      agentId: id,
    }
  }

  // THE PREDICATE STAYS, THE ATTRIBUTES ARE GONE (P6d-T16b). This header used
  // to publish `data-liaison-*` so the overlay could guess from outside which
  // agent it was looking at. The page renders the runtime control itself now,
  // so there is nothing to announce, and `dmAgent()` is proved where it is
  // used: the three gating cases below.
  it("names nobody through a DOM attribute any more", () => {
    renderHeader({
      participants: [
        { id: "member", name: "Member", avatarUrl: null },
        agentSeat(AGENT_ID, "Support"),
      ],
    })
    expect(document.querySelector("[data-liaison-agent-id]")).toBeNull()
    // And no popover was opened to find that out.
    expect(screen.queryByText("Participants")).not.toBeInTheDocument()
  })
})

// P6d-T07: the runtime control lives where the user already looks to see who
// is in a conversation. It is the desktop's ONE offer to run this agent's
// turns on this machine, and it replaces a floating button, a full width
// banner and a duplicated folder picker drawn over the page.
describe("ThreadHeader mounts the runtime control on the desktop", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    resetDesktopStore()
  })

  const AGENT_ID = "11111111-1111-4111-8111-111111111111"

  function agentSeat(id: string, name: string) {
    return {
      id: `seat-${id}`,
      name,
      avatarUrl: null,
      participantType: "agent" as const,
      agentId: id,
    }
  }

  function installBridge(): void {
    vi.stubGlobal(DESKTOP_BRIDGE_KEY, {
      version: DESKTOP_BRIDGE_VERSION,
      platform: "macos",
      pickFolder: async () => null,
      getServerAddress: () => null,
      setServerAddress: async () => {},
      startSession: async () => true,
      stopSession: async () => {},
      sendTurn: async () => {},
      interruptTurn: async () => {},
      respondToPermission: async () => {},
      readLocalFile: async () => null,
      setPermissionMode: () => {},
      setRuntimeLocation: () => {},
      getState: () => emptyDesktopSessionState(),
      subscribe: () => () => {},
    })
    attachDesktopBridge()
  }

  const RUNTIME_LABEL = "Where the turns of this conversation run"

  it("thread header offers the runtime control for a DM with one agent", () => {
    installBridge()
    renderHeader({
      threadType: "agent_chat",
      participants: [
        { id: "member", name: "Member", avatarUrl: null },
        agentSeat(AGENT_ID, "Support"),
      ],
    })
    const control = screen.getByLabelText(RUNTIME_LABEL)
    expect(control).toBeInTheDocument()
    // In the header itself, not in a popover the user has to open first: the
    // participants list was never rendered.
    expect(screen.queryByText("Participants")).not.toBeInTheDocument()
  })

  it("thread header offers no runtime control in a channel with two agents", () => {
    installBridge()
    renderHeader({
      participants: [
        { id: "member", name: "Member", avatarUrl: null },
        agentSeat(AGENT_ID, "Support"),
        agentSeat("22222222-2222-4222-8222-222222222222", "Logistics"),
      ],
    })
    expect(screen.queryByLabelText(RUNTIME_LABEL)).not.toBeInTheDocument()
  })

  // P6d-FX7 (SK-8): the header's rule and the sidebar's classifier were two
  // different rules wearing one comment. A titled room with two humans in it
  // is a CHANNEL, and "run this on my machine" belongs to none of them.
  it("thread header offers no runtime control in a titled channel with a second human", () => {
    installBridge()
    renderHeader({
      participants: [
        { id: "member", name: "Member", avatarUrl: null },
        { id: "other", name: "Other", avatarUrl: null },
        agentSeat(AGENT_ID, "Support"),
      ],
    })
    expect(screen.queryByLabelText(RUNTIME_LABEL)).not.toBeInTheDocument()
  })

  // The pin: a browser renders exactly what it rendered before this slice.
  // The numbers are the pre task values, measured at slice head, and a change
  // to either is a desktop surface leaking into the browser.
  it("thread header is unchanged in a browser", () => {
    resetDesktopStore()
    const { container } = renderHeader({
      // A 1:1 with an agent is an `agent_chat` (POST /threads/dm). A titled
      // plain `thread` is a channel named by its title whoever sits in it
      // (A35 amended 2026-10-12, 68b985824), so it would read "Test Thread".
      threadType: "agent_chat",
      participants: [
        { id: "member", name: "Member", avatarUrl: null },
        agentSeat(AGENT_ID, "Support"),
      ],
    })
    expect(screen.queryByLabelText(RUNTIME_LABEL)).not.toBeInTheDocument()
    expect(container.querySelectorAll("button").length).toBe(2)
    // A 1:1 with an agent is headed by the AGENT, so a stray row title is not
    // what this reads: "Support", not "Test Thread" (card 60).
    expect(container.textContent).toBe("MEMESupport2")
  })
})

describe("ThreadHeader names the conversation by its shape", () => {
  // Card 60: a personal agent DM had picked up a title along the way, and the
  // header printed it ("System Test Confirmation") while the tab beside it
  // still read "Personal agent".
  it("heads a DM with an agent by the AGENT, even when the row carries a title", () => {
    renderHeader({
      title: "System Test Confirmation",
      threadType: "agent_chat",
      participants: [
        { id: "member", name: "Member", avatarUrl: null },
        {
          id: "agent-seat",
          name: "Personal agent",
          avatarUrl: null,
          participantType: "agent",
          agentId: "agent-1",
        },
      ],
    })
    expect(screen.getByTestId("thread-header-title").textContent).toBe("Personal agent")
  })

  it("still heads a real channel by its title", () => {
    renderHeader({ title: "Q2 Marketing Plan" })
    expect(screen.getByTestId("thread-header-title").textContent).toBe("Q2 Marketing Plan")
  })

  it("still heads an untitled people DM by the other first names", () => {
    renderHeader({ title: null })
    expect(screen.getByTestId("thread-header-title").textContent).toBe("Creator, Other")
  })
})

// Between PEOPLE the conversation's model choice is a menu entry, "Invoked
// model", not a composer pill. ThreadView publishes the control whenever the
// room has an agent seat; the entry appears only in a person-to-person DM.
describe("ThreadHeader offers Invoked model in a person-to-person DM only", () => {
  const cleanups: Array<() => void> = []
  // Model names come from the served list (GET /credits/models, S6).
  beforeEach(() => setServedModels(parseServedModels(SERVED_MODELS_FIXTURE)))
  afterEach(() => {
    setServedModels(null)
    cleanup()
    while (cleanups.length) cleanups.pop()?.()
  })

  const agentSeat = { id: "agent-1", name: "Assistant", avatarUrl: null, participantType: "agent" }
  const people = [
    { id: "member", name: "Member", avatarUrl: null, participantType: "user" },
    { id: "other", name: "Other", avatarUrl: null, participantType: "user" },
  ]

  function publish(
    onSelect = vi.fn(),
    balance: { included: string; purchased: string; currency: string; tier?: string } | null = null,
  ) {
    cleanups.push(
      provideThreadModelControl("t1", () => ({
        threadId: "t1",
        balance,
        availableModelIds: null,
        agentModelId: null,
        agentDefaultModelId: "gemini-flash-lite-latest",
        reasoningLevel: "off",
        onSelect,
      })),
    )
    return onSelect
  }

  async function openMenu() {
    screen.getByLabelText("Thread actions").click()
    await screen.findByText("Participants")
  }

  it("a DM between people with an agent seat lists it, and it opens the model selector", async () => {
    const onSelect = publish()
    renderHeader({ title: null, participants: [...people, agentSeat] })
    await openMenu()
    const entry = screen.getByTestId("thread-invoked-model")
    expect(entry.textContent).toContain("Invoked model")
    expect(screen.getByTestId("thread-invoked-model-label").textContent).toBe("Flash-Lite")

    fireEvent.click(entry)
    const menu = await screen.findByRole("menu")
    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Default (Gemini Flash-Lite)" }), {
      key: "Enter",
    })
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it("closing the selector hands focus back to the actions button", async () => {
    publish()
    renderHeader({ title: null, participants: [...people, agentSeat] })
    await openMenu()
    fireEvent.click(screen.getByTestId("thread-invoked-model"))
    const menu = await screen.findByRole("menu")
    fireEvent.keyDown(menu, { key: "Escape" })
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Thread actions")),
    )
  })

  // A managed org below the team tier and without credits cannot change models:
  // the entry still names the model, and says why instead of doing nothing.
  it("a locked org sees the entry disabled, with the reason", async () => {
    BillingStateTestAccess.setMode("managed")
    cleanups.push(() => BillingStateTestAccess.reset())
    publish(vi.fn(), { included: "0", purchased: "0", currency: "EUR", tier: "starter" })
    renderHeader({ title: null, participants: [...people, agentSeat] })
    await openMenu()
    const entry = screen.getByTestId("thread-invoked-model") as HTMLButtonElement
    expect(entry.disabled).toBe(true)
    expect(entry.title).toBe("Upgrade to change model")
  })

  it("a channel does not", async () => {
    publish()
    renderHeader({ title: "Engineering", participants: [...people, agentSeat] })
    await openMenu()
    expect(screen.queryByTestId("thread-invoked-model")).toBeNull()
  })

  it("an agent chat does not", async () => {
    publish()
    renderHeader({
      title: null,
      threadType: "agent_chat",
      participants: [people[0], agentSeat],
    })
    await openMenu()
    expect(screen.queryByTestId("thread-invoked-model")).toBeNull()
  })

  it("a DM between people without an agent does not", async () => {
    renderHeader({ title: null, participants: people })
    await openMenu()
    expect(screen.queryByTestId("thread-invoked-model")).toBeNull()
  })
})

describe("ThreadHeader copy link", () => {
  afterEach(() => cleanup())

  it("the actions menu copies this server's address of the thread", async () => {
    resetRegistry()
    registerTabType("kernel:thread", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/threads/:entityId",
      defaultLabel: "x",
    })
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    renderHeader()
    screen.getByLabelText("Thread actions").click()
    fireEvent.click(await screen.findByTestId("thread-header.copy-link"))
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/threads/t1`),
    )
  })
})
