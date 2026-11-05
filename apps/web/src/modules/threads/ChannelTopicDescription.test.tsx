// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Slack/Buzz pair in the product: a channel gets a TOPIC (one line, beside
// the name) and a DESCRIPTION (a few lines, in the channel details), both
// editable by a member from the channel menu.
//
// What is pinned here, on both tiers and for the same reasons the Discoverable
// switch pins its own rules: the entries belong to a CHANNEL and never to a DM
// (a DM has neither field, and the API refuses it), saving actually reaches the
// PATCH with the field rather than only moving a local signal, and the topic is
// RENDERED where it is supposed to be read, which is the only reason it exists.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import type { ComponentProps } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    hasScope: () => true,
    userFromToken: () => ({ userId: "me", name: "Tester" }),
  }
})

const pushNavState = vi.hoisted(() => ({
  popDetail: vi.fn(),
  backLabel: vi.fn(() => "Chats" as string | null),
}))
vi.mock("~/primitives/createPushNav", () => ({
  createPushNav: () => ({ detailOpen: () => true, ...pushNavState }),
}))

import { ApiContext, ApiProvider } from "~/modules/shell/ApiContext"
import { resetTabStore } from "~/modules/shell/tab-store"
import { resetToastStore } from "~/modules/shell/toast-store"
import ThreadHeader from "~/modules/threads/ThreadHeader"
import ThreadPhoneHeader from "~/modules/threads/ThreadPhoneHeader"
import { addThread, getThread, resetThreadStore } from "~/modules/threads/thread-store"

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

const HUMANS = [
  { id: "me", name: "Tester", avatarUrl: null },
  { id: "u-2", name: "Alice Chen", avatarUrl: null },
]

type HeaderProps = ComponentProps<typeof ThreadHeader>

function desktopProps(overrides: Partial<HeaderProps> = {}): HeaderProps {
  return {
    threadId: "t1",
    title: "Growth lab",
    handle: "@growth-lab",
    participants: HUMANS,
    isPinned: false,
    isPinnedByUser: false,
    isMuted: false,
    isArchived: false,
    discoverable: false,
    topic: null,
    description: null,
    currentUserId: "me",
    canAdminThreads: true,
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

function renderDesktop(overrides: Partial<HeaderProps> = {}) {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <ThreadHeader {...desktopProps(overrides)} />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

function makeApi(overrides: Record<string, any> = {}): any {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    getEnvelope: vi.fn(),
    ...overrides,
  }
}

function renderPhone(entityId: string, api: any = makeApi()) {
  return render(() => (
    <ApiContext.Provider value={api}>
      <ThreadPhoneHeader entityId={entityId} />
    </ApiContext.Provider>
  ))
}

function seed(row: Record<string, any>) {
  addThread({
    handle: "@seeded",
    lastMessage: null,
    unreadCount: 0,
    updatedAt: new Date().toISOString(),
    ...row,
  } as any)
}

describe("channel topic and description, desktop thread header", () => {
  afterEach(() => {
    cleanup()
    resetTabStore()
  })

  it("offers Set topic and Edit description on a titled channel", () => {
    renderDesktop()
    screen.getByLabelText("Thread actions").click()

    expect(screen.getByTestId("thread-set-topic").textContent).toContain("Set topic")
    expect(screen.getByTestId("thread-edit-description").textContent).toContain("Edit description")
  })

  it("does NOT offer either on a DM", () => {
    renderDesktop({ title: null })
    screen.getByLabelText("Thread actions").click()

    expect(screen.queryByTestId("thread-set-topic")).toBeNull()
    expect(screen.queryByTestId("thread-edit-description")).toBeNull()
  })

  it("does NOT offer either on an agent DM (agent_chat), which is a DM whatever its title", () => {
    renderDesktop({
      threadType: "agent_chat",
      title: "Local session walk",
      participants: [
        { id: "me", name: "Tester", avatarUrl: null },
        { id: "a-1", name: "Liaison", avatarUrl: null, participantType: "agent", agentId: "a-1" },
      ],
    })
    screen.getByLabelText("Thread actions").click()

    expect(screen.queryByTestId("thread-set-topic")).toBeNull()
  })

  it("offers either on a titled channel whose only other seat is an agent (A35 amended 2026-10-12)", () => {
    renderDesktop({
      threadType: "thread",
      title: "s11-cloud-walk",
      participants: [
        { id: "me", name: "Tester", avatarUrl: null },
        { id: "a-1", name: "Liaison", avatarUrl: null, participantType: "agent", agentId: "a-1" },
      ],
    })
    screen.getByLabelText("Thread actions").click()

    expect(screen.queryByTestId("thread-set-topic")).not.toBeNull()
  })

  it("Set topic opens a dialog seeded with the current topic and saves the edited one", async () => {
    const onSaveDetails = vi.fn()
    renderDesktop({ topic: "Shipping the beta", onSaveDetails })
    screen.getByLabelText("Thread actions").click()
    fireEvent.click(screen.getByTestId("thread-set-topic"))

    const input = (await screen.findByTestId("channel-details-input")) as HTMLInputElement
    expect(input.value).toBe("Shipping the beta")

    fireEvent.input(input, { target: { value: "On call: Alex" } })
    fireEvent.click(screen.getByTestId("channel-details-save"))

    expect(onSaveDetails).toHaveBeenCalledWith("topic", "On call: Alex")
  })

  it("Edit description opens the multi line field and saves it", async () => {
    const onSaveDetails = vi.fn()
    renderDesktop({ description: "Old blurb", onSaveDetails })
    screen.getByLabelText("Thread actions").click()
    fireEvent.click(screen.getByTestId("thread-edit-description"))

    const area = (await screen.findByTestId("channel-details-textarea")) as HTMLTextAreaElement
    expect(area.value).toBe("Old blurb")

    fireEvent.input(area, { target: { value: "Where the beta gets cut." } })
    fireEvent.click(screen.getByTestId("channel-details-save"))

    expect(onSaveDetails).toHaveBeenCalledWith("description", "Where the beta gets cut.")
  })

  it("emptying the field saves null, which is the clear and not an empty line", async () => {
    const onSaveDetails = vi.fn()
    renderDesktop({ topic: "Going away", onSaveDetails })
    screen.getByLabelText("Thread actions").click()
    fireEvent.click(screen.getByTestId("thread-set-topic"))

    const input = (await screen.findByTestId("channel-details-input")) as HTMLInputElement
    fireEvent.input(input, { target: { value: "   " } })
    fireEvent.click(screen.getByTestId("channel-details-save"))

    expect(onSaveDetails).toHaveBeenCalledWith("topic", null)
  })

  it("Cancel closes the dialog without saving", async () => {
    const onSaveDetails = vi.fn()
    renderDesktop({ onSaveDetails })
    screen.getByLabelText("Thread actions").click()
    fireEvent.click(screen.getByTestId("thread-set-topic"))

    const input = (await screen.findByTestId("channel-details-input")) as HTMLInputElement
    fireEvent.input(input, { target: { value: "never mind" } })
    fireEvent.click(screen.getByTestId("channel-details-cancel"))

    expect(onSaveDetails).not.toHaveBeenCalled()
  })

  it("renders the topic beside the channel name, with the full text on hover", () => {
    renderDesktop({ topic: "Shipping the 0.9 beta" })
    const el = screen.getByTestId("thread-header-topic")
    expect(el.textContent).toBe("Shipping the 0.9 beta")
    expect(el.getAttribute("title")).toBe("Shipping the 0.9 beta")
  })

  it("renders nothing at all when the channel has no topic", () => {
    renderDesktop({ topic: null })
    expect(screen.queryByTestId("thread-header-topic")).toBeNull()
  })

  it("shows the description in the channel details, not in the header line", () => {
    renderDesktop({ description: "Where the beta gets cut and shipped." })
    expect(screen.queryByTestId("thread-header-description")).toBeNull()

    screen.getByLabelText("Thread actions").click()
    expect(screen.getByTestId("thread-header-description").textContent).toBe(
      "Where the beta gets cut and shipped.",
    )
  })
})

describe("channel topic and description, phone thread header", () => {
  afterEach(() => {
    cleanup()
    resetThreadStore()
    resetToastStore()
    resetTabStore()
  })

  it("offers both entries on a channel and neither on a DM", () => {
    seed({ id: "t-eng", title: "Engineering", participants: HUMANS })
    renderPhone("t-eng")
    screen.getByTestId("phone-thread-actions").click()
    expect(screen.getByTestId("phone-thread-action-set-topic")).toBeInTheDocument()
    expect(screen.getByTestId("phone-thread-action-edit-description")).toBeInTheDocument()

    cleanup()
    resetThreadStore()
    seed({ id: "t-dm", title: null, participants: HUMANS })
    renderPhone("t-dm")
    screen.getByTestId("phone-thread-actions").click()
    expect(screen.queryByTestId("phone-thread-action-set-topic")).toBeNull()
    expect(screen.queryByTestId("phone-thread-action-edit-description")).toBeNull()
  })

  it("PATCHes the thread with the topic and keeps the store in step", async () => {
    seed({ id: "t-eng", title: "Engineering", topic: null, participants: HUMANS })
    const api = makeApi()
    renderPhone("t-eng", api)
    screen.getByTestId("phone-thread-actions").click()
    fireEvent.click(screen.getByTestId("phone-thread-action-set-topic"))

    const input = (await screen.findByTestId("channel-details-input")) as HTMLInputElement
    fireEvent.input(input, { target: { value: "Cutting 0.9" } })
    fireEvent.click(screen.getByTestId("channel-details-save"))
    await vi.waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith("/threads/t-eng", { topic: "Cutting 0.9" })
    })
    expect(getThread("t-eng")?.topic).toBe("Cutting 0.9")
  })

  it("a refused PATCH rolls the topic back", async () => {
    seed({ id: "t-eng", title: "Engineering", topic: "Before", participants: HUMANS })
    const api = makeApi({ patch: vi.fn().mockRejectedValue(new Error("nope")) })
    renderPhone("t-eng", api)
    screen.getByTestId("phone-thread-actions").click()
    fireEvent.click(screen.getByTestId("phone-thread-action-set-topic"))

    const input = (await screen.findByTestId("channel-details-input")) as HTMLInputElement
    fireEvent.input(input, { target: { value: "After" } })
    fireEvent.click(screen.getByTestId("channel-details-save"))

    await vi.waitFor(() => {
      expect(getThread("t-eng")?.topic).toBe("Before")
    })
  })

  it("shows the description IN the menu, the phone's only place to read it", () => {
    seed({
      id: "t-eng",
      title: "Engineering",
      description: "Where the beta gets cut and shipped.",
      participants: HUMANS,
    })
    renderPhone("t-eng")
    // Not in the bar: a 390px header has no room for a paragraph.
    expect(screen.queryByTestId("phone-thread-description")).toBeNull()

    screen.getByTestId("phone-thread-actions").click()
    const el = screen.getByTestId("phone-thread-description")
    expect(el.textContent).toBe("Where the beta gets cut and shipped.")
    // Wrapped, not truncated: the whole point is that it can be READ.
    expect(el.className).toContain("whitespace-pre-wrap")
    expect(el.className).not.toContain("truncate")
  })

  it("shows no description block on a channel that has none, nor on a DM", () => {
    seed({ id: "t-eng", title: "Engineering", description: null, participants: HUMANS })
    renderPhone("t-eng")
    screen.getByTestId("phone-thread-actions").click()
    expect(screen.queryByTestId("phone-thread-description")).toBeNull()

    cleanup()
    resetThreadStore()
    seed({ id: "t-dm", title: null, description: "Not a channel field.", participants: HUMANS })
    renderPhone("t-dm")
    screen.getByTestId("phone-thread-actions").click()
    expect(screen.queryByTestId("phone-thread-description")).toBeNull()
  })

  it("renders the topic under the title", () => {
    seed({ id: "t-eng", title: "Engineering", topic: "On call: Alex", participants: HUMANS })
    renderPhone("t-eng")
    const el = screen.getByTestId("phone-thread-topic")
    expect(el.textContent).toBe("On call: Alex")
    expect(el.getAttribute("title")).toBe("On call: Alex")
  })
})
