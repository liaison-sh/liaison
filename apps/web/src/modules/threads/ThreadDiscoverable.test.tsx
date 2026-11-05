// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A35, the product half of "discoverable channels": Surface 3 could LIST and
// JOIN a discoverable channel, but nothing in the UI could make one, so the
// only way to publish a channel was an UPDATE on the box.
//
// Two things are pinned here, on both tiers: the switch belongs to a CHANNEL
// and never to a DM (publishing a DM to the whole workspace is the one thing
// the flag must not be able to do), and flipping it actually reaches the API
// with the flag rather than only moving a local signal.
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
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
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
    onSaveDetails: noop,
    onToggleDiscoverable: noop,
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

describe("Discoverable switch, desktop thread header", () => {
  afterEach(() => {
    cleanup()
    resetTabStore()
  })

  it("offers the switch on a titled channel, with the help line", () => {
    renderDesktop()
    screen.getByLabelText("Thread actions").click()

    expect(screen.getByTestId("thread-discoverable-switch")).toBeInTheDocument()
    expect(screen.getByTestId("thread-discoverable-row").textContent).toContain(
      "Members of the workspace can find and join this channel",
    )
  })

  it("does NOT offer it on a DM", () => {
    renderDesktop({ title: null })
    screen.getByLabelText("Thread actions").click()

    expect(screen.queryByTestId("thread-discoverable-switch")).toBeNull()
  })

  it("does NOT offer it on an agent DM (agent_chat), which is a DM whatever its title", () => {
    renderDesktop({
      threadType: "agent_chat",
      title: "Local session walk",
      participants: [
        { id: "me", name: "Tester", avatarUrl: null },
        { id: "a-1", name: "Liaison", avatarUrl: null, participantType: "agent", agentId: "a-1" },
      ],
    })
    screen.getByLabelText("Thread actions").click()

    expect(screen.queryByTestId("thread-discoverable-switch")).toBeNull()
  })

  it("offers it on a titled channel whose only other seat is an agent (A35 amended 2026-10-12)", () => {
    renderDesktop({
      threadType: "thread",
      title: "s11-cloud-walk",
      participants: [
        { id: "me", name: "Tester", avatarUrl: null },
        { id: "a-1", name: "Liaison", avatarUrl: null, participantType: "agent", agentId: "a-1" },
      ],
    })
    screen.getByLabelText("Thread actions").click()

    expect(screen.queryByTestId("thread-discoverable-switch")).not.toBeNull()
  })

  it("reflects the current value and asks for the opposite one", () => {
    const onToggleDiscoverable = vi.fn()
    renderDesktop({ discoverable: true, onToggleDiscoverable })
    screen.getByLabelText("Thread actions").click()

    const control = screen.getByTestId("thread-discoverable-switch")
    expect(control.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(control)
    expect(onToggleDiscoverable).toHaveBeenCalledWith(false)
  })
})

// Notification etiquette rule 2: a channel interrupts its members only for a
// mention by default; being told of every post is a per-channel opt-in.
describe("Every-message switch, desktop thread header", () => {
  afterEach(() => {
    cleanup()
    resetTabStore()
  })

  it("is offered on a channel, off by default, and asks for the new value", () => {
    const onToggleNotifyAllPosts = vi.fn()
    renderDesktop({ onToggleNotifyAllPosts })
    screen.getByLabelText("Thread actions").click()

    const control = screen.getByTestId("thread-notify-all-switch")
    expect(control.getAttribute("aria-checked")).toBe("false")
    expect(screen.getByTestId("thread-notify-all-help").textContent).toContain("only mentions")
    fireEvent.click(control)
    expect(onToggleNotifyAllPosts).toHaveBeenCalledWith(true)
  })

  it("reflects an opted-in channel", () => {
    renderDesktop({ notifyAllPosts: true, onToggleNotifyAllPosts: vi.fn() })
    screen.getByLabelText("Thread actions").click()
    expect(screen.getByTestId("thread-notify-all-switch").getAttribute("aria-checked")).toBe("true")
  })

  it("is NOT offered on a DM, where every message already notifies", () => {
    renderDesktop({ title: null, onToggleNotifyAllPosts: vi.fn() })
    screen.getByLabelText("Thread actions").click()
    expect(screen.queryByTestId("thread-notify-all-switch")).toBeNull()
  })
})

describe("Discoverable switch, phone thread header", () => {
  afterEach(() => {
    cleanup()
    resetThreadStore()
    resetToastStore()
    resetTabStore()
  })

  it("PATCHes the thread with the flag and keeps the store in step", async () => {
    seed({ id: "t-eng", title: "Engineering", discoverable: false, participants: HUMANS })
    const api = makeApi()
    renderPhone("t-eng", api)
    screen.getByTestId("phone-thread-actions").click()

    fireEvent.click(screen.getByTestId("phone-thread-discoverable-switch"))
    await Promise.resolve()

    expect(api.patch).toHaveBeenCalledWith("/threads/t-eng", { discoverable: true })
    expect(getThread("t-eng")?.discoverable).toBe(true)
  })

  it("rolls the switch back and toasts when the API refuses", async () => {
    seed({ id: "t-eng", title: "Engineering", discoverable: false, participants: HUMANS })
    const api = makeApi({ patch: vi.fn().mockRejectedValue(new Error("nope")) })
    renderPhone("t-eng", api)
    screen.getByTestId("phone-thread-actions").click()

    fireEvent.click(screen.getByTestId("phone-thread-discoverable-switch"))
    await Promise.resolve()
    await Promise.resolve()

    expect(getThread("t-eng")?.discoverable).toBe(false)
    expect(toasts().some((t) => t.type === "error")).toBe(true)
  })

  it("does NOT offer the switch on a DM", () => {
    seed({ id: "t-dm", title: null, participants: HUMANS })
    renderPhone("t-dm")
    screen.getByTestId("phone-thread-actions").click()

    expect(screen.queryByTestId("phone-thread-discoverable-switch")).toBeNull()
    expect(screen.queryByTestId("phone-thread-notify-all-switch")).toBeNull()
  })

  it("the every-message switch PATCHes the reader's state and keeps the store in step", async () => {
    seed({ id: "t-eng", title: "Engineering", participants: HUMANS })
    const api = makeApi()
    renderPhone("t-eng", api)
    screen.getByTestId("phone-thread-actions").click()

    const control = screen.getByTestId("phone-thread-notify-all-switch")
    expect(control.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(control)
    await Promise.resolve()

    expect(api.patch).toHaveBeenCalledWith("/threads/t-eng/state", { notifyAllPosts: true })
    expect(getThread("t-eng")?.notifyAllPosts).toBe(true)
  })
})

// The help line is what tells a member what "Discoverable" does, so it reads
// as a sentence across the whole menu row. Nested beside the switch it kept
// the track's width reserved on every line and wrapped about 60px narrower
// than the description block above it. What decides that width is the DOM
// shape: the help paragraph must sit under the label-and-switch line, not
// inside it.
describe("Discoverable help line spans the menu row", () => {
  afterEach(() => {
    cleanup()
    resetThreadStore()
    resetTabStore()
  })

  const HELP = "Members of the workspace can find and join this channel"

  it("keeps the help line out of the switch's line, desktop", () => {
    renderDesktop()
    screen.getByLabelText("Thread actions").click()

    const help = screen.getByText(HELP)
    const control = screen.getByTestId("thread-discoverable-switch")
    const row = screen.getByTestId("thread-discoverable-row")

    // The line holding the switch must not hold the help text, or the help
    // text inherits the switch's reserved width.
    expect(control.parentElement?.contains(help)).toBe(false)
    // And it is a direct child of the row, so it spans the row's full width.
    expect(help.parentElement).toBe(row)
  })

  it("keeps the help line out of the switch's line, phone", () => {
    seed({ id: "t-eng", title: "Engineering", discoverable: false, participants: HUMANS })
    renderPhone("t-eng")
    screen.getByTestId("phone-thread-actions").click()

    const help = screen.getByText(HELP)
    const control = screen.getByTestId("phone-thread-discoverable-switch")
    const row = screen.getByTestId("phone-thread-discoverable-row")

    expect(control.parentElement?.contains(help)).toBe(false)
    expect(help.parentElement).toBe(row)
  })
})
