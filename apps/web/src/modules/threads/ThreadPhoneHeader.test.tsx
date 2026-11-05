// SPDX-License-Identifier: FSL-1.1-ALv2
//
// F6. ThreadPhoneHeader (F4's phone nav bar for a thread) had no test file at
// all: title/state rendering for a DM and a channel, the actions menu's
// contents, one mutation actually reaching the API, and the failure path's
// toast were all unverified.
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    hasScope: () => true,
    userFromToken: () => ({ userId: "me", name: "Tester" }),
  }
})

// K1: this header now drives its own back control through the SAME push-nav
// primitive the shell's generic bar used to (real browser back / master-route
// fallback, the "came from" label) — mocked here so this file tests only what
// ThreadPhoneHeader itself wires up; `createPushNav`'s own behavior is
// covered by its dedicated test file.
const pushNavState = vi.hoisted(() => ({
  popDetail: vi.fn(),
  backLabel: vi.fn(() => "Chats" as string | null),
}))
vi.mock("~/primitives/createPushNav", () => ({
  createPushNav: () => ({ detailOpen: () => true, ...pushNavState }),
}))

import { parseServedModels, setServedModels } from "~/lib/model-groups"
import { SERVED_MODELS_FIXTURE } from "~/lib/model-groups.fixture"
import { ApiContext } from "~/modules/shell/ApiContext"
import { openTab, resetTabStore } from "~/modules/shell/tab-store"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import { provideThreadModelControl } from "~/modules/threads/InvokedModelMenu"
import {
  closeReplyPanel,
  getOpenReplyPanel,
  openReplyPanel,
} from "~/modules/threads/reply-panel-store"
import ThreadPhoneHeader from "~/modules/threads/ThreadPhoneHeader"
import {
  addThread,
  handleTypingEvent,
  removeThread,
  resetThreadStore,
} from "~/modules/threads/thread-store"
import { resetThreadTabNames, startThreadTabNames } from "~/modules/threads/thread-tab-names"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeApi(overrides: Record<string, any> = {}) {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    getEnvelope: vi.fn(),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderHeader(entityId: string, api: any = makeApi()) {
  return render(() => (
    <ApiContext.Provider value={api}>
      <ThreadPhoneHeader entityId={entityId} />
    </ApiContext.Provider>
  ))
}

describe("ThreadPhoneHeader", () => {
  afterEach(() => {
    cleanup()
    resetThreadStore()
    resetToastStore()
    resetTabStore()
    pushNavState.popDetail.mockClear()
    pushNavState.backLabel.mockClear()
  })

  // K1: this header owns the ENTIRE bar once registered — the shell renders no
  // back control of its own for a tab type with a registered header — so this
  // component carries exactly one back control, driven by the same push-nav
  // mechanics the shell used to own (real back, "came from" label).
  it("K1: carries its own single back control, wired to popDetail", () => {
    addThread({
      id: "t-dm",
      handle: "@dm",
      title: null,
      participants: [
        { id: "me", name: "Tester", avatarUrl: null },
        { id: "u-2", name: "Alice Chen", avatarUrl: null },
      ],
      lastMessage: null,
      unreadCount: 0,
      updatedAt: new Date().toISOString(),
    })
    renderHeader("t-dm")

    const backControls = screen.getAllByTestId("phone-thread-back")
    expect(backControls).toHaveLength(1)
    expect(screen.getByTestId("phone-thread-back-label").textContent).toBe("Chats")
    fireEvent.click(backControls[0])
    expect(pushNavState.popDetail).toHaveBeenCalledTimes(1)
  })

  // Reported 2026-10-01: in a reply thread, back skipped the channel and landed
  // on the Chats list, the panel's cross being the only way back to it.
  it("back from an open reply thread returns to its channel, not to Chats", () => {
    addThread({
      id: "t-chan",
      handle: "#general",
      title: "general",
      participants: [{ id: "me", name: "Tester", avatarUrl: null }],
      lastMessage: null,
      unreadCount: 0,
      updatedAt: new Date().toISOString(),
    })
    openReplyPanel("t-chan", "root-1")
    try {
      renderHeader("t-chan")
      expect(screen.queryByTestId("phone-thread-back-label")).toBeNull()
      fireEvent.click(screen.getByTestId("phone-thread-back"))
      expect(getOpenReplyPanel("t-chan")).toBeNull()
      expect(pushNavState.popDetail).not.toHaveBeenCalled()
      // From the channel itself, back leaves as before.
      expect(screen.getByTestId("phone-thread-back-label").textContent).toBe("Chats")
      fireEvent.click(screen.getByTestId("phone-thread-back"))
      expect(pushNavState.popDetail).toHaveBeenCalledTimes(1)
    } finally {
      closeReplyPanel("t-chan")
    }
  })

  it("titles a DM by the other participant, with no state label when idle", () => {
    addThread({
      id: "t-dm",
      handle: "@dm",
      title: null,
      participants: [
        { id: "me", name: "Tester", avatarUrl: null },
        { id: "u-2", name: "Alice Chen", avatarUrl: null },
      ],
      lastMessage: null,
      unreadCount: 0,
      updatedAt: new Date().toISOString(),
    })
    renderHeader("t-dm")

    expect(screen.getByTestId("phone-thread-title").textContent).toContain("Alice")
    expect(screen.queryByTestId("phone-thread-state")).toBeNull()
  })

  it("titles a channel by its own title, with a live agent state label", () => {
    addThread({
      id: "t-eng",
      handle: "@eng",
      title: "Engineering",
      discoverable: true,
      participants: [{ id: "me", name: "Tester", avatarUrl: null }],
      lastMessage: null,
      unreadCount: 0,
      updatedAt: new Date().toISOString(),
    })
    handleTypingEvent({
      type: "typing:start",
      threadId: "t-eng",
      userId: "a-1",
      authorType: "agent",
      agentId: "a-1",
    })
    renderHeader("t-eng")

    expect(screen.getByTestId("phone-thread-title").textContent).toBe("Engineering")
    expect(screen.getByTestId("phone-thread-state").textContent).toBe("Queued")
  })

  // Walk 2026-10-12: a channel archived while open on the phone lost its name,
  // the bar falling back to the "Thread title" placeholder. The tab keeps the
  // copy the list held (thread-tab-names.ts), and so does this bar.
  it("keeps a channel's name once it is archived while open", () => {
    const channel = {
      id: "t-arch",
      handle: "#arch",
      title: "tabs-walk",
      participants: [{ id: "me", name: "Tester", avatarUrl: null }],
      lastMessage: null,
      unreadCount: 0,
      updatedAt: new Date().toISOString(),
    }
    addThread(channel)
    openTab({ type: "thread", entityId: "t-arch", label: "tabs-walk" })
    startThreadTabNames({ get: vi.fn(async () => ({ data: channel })) })
    try {
      renderHeader("t-arch")
      expect(screen.getByTestId("phone-thread-title").textContent).toBe("tabs-walk")
      removeThread("t-arch") // archived
      expect(screen.getByTestId("phone-thread-title").textContent).toBe("tabs-walk")
    } finally {
      resetThreadTabNames()
    }
  })

  it("the actions menu lists pin, pin for all, mute, archive and leave", async () => {
    addThread({
      id: "t-eng",
      handle: "@eng",
      title: "Engineering",
      discoverable: true,
      participants: [{ id: "me", name: "Tester", avatarUrl: null }],
      lastMessage: null,
      unreadCount: 0,
      updatedAt: new Date().toISOString(),
    })
    renderHeader("t-eng")

    fireEvent.click(screen.getByTestId("phone-thread-actions"))

    expect(await screen.findByTestId("phone-thread-action-pin")).toBeTruthy()
    expect(screen.getByTestId("phone-thread-action-pin-all")).toBeTruthy()
    expect(screen.getByTestId("phone-thread-action-mute")).toBeTruthy()
    expect(screen.getByTestId("phone-thread-action-archive")).toBeTruthy()
    expect(screen.getByTestId("phone-thread-action-leave")).toBeTruthy()
  })

  it("picking Mute PATCHes the thread's mute state", async () => {
    addThread({
      id: "t-eng",
      handle: "@eng",
      title: "Engineering",
      discoverable: true,
      participants: [{ id: "me", name: "Tester", avatarUrl: null }],
      lastMessage: null,
      unreadCount: 0,
      isMuted: false,
      updatedAt: new Date().toISOString(),
    })
    const patch = vi.fn().mockResolvedValue({})
    renderHeader("t-eng", makeApi({ patch }))

    fireEvent.click(screen.getByTestId("phone-thread-actions"))
    fireEvent.click(await screen.findByTestId("phone-thread-action-mute"))

    await vi.waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/threads/t-eng/state", { isMuted: true }),
    )
  })

  it("a failed Mute rolls back and shows the mute-failed toast", async () => {
    addThread({
      id: "t-eng",
      handle: "@eng",
      title: "Engineering",
      discoverable: true,
      participants: [{ id: "me", name: "Tester", avatarUrl: null }],
      lastMessage: null,
      unreadCount: 0,
      isMuted: false,
      updatedAt: new Date().toISOString(),
    })
    const patch = vi.fn().mockRejectedValue(new Error("network"))
    renderHeader("t-eng", makeApi({ patch }))

    fireEvent.click(screen.getByTestId("phone-thread-actions"))
    fireEvent.click(await screen.findByTestId("phone-thread-action-mute"))

    await vi.waitFor(() => expect(toasts()).toHaveLength(1))
    expect(toasts()[0]?.message).toBe("Couldn't update thread notification settings.")
    expect(toasts()[0]?.type).toBe("error")
  })
})

// Between PEOPLE the conversation's model choice is a menu entry, "Invoked
// model", not a composer pill. ThreadView publishes the control whenever the
// room has an agent seat; this header shows it in a person-to-person DM only.
describe("ThreadPhoneHeader Invoked model", () => {
  const unpublish: Array<() => void> = []
  // Model names come from the served list (GET /credits/models, S6).
  beforeEach(() => setServedModels(parseServedModels(SERVED_MODELS_FIXTURE)))
  afterEach(() => {
    setServedModels(null)
    cleanup()
    resetThreadStore()
    while (unpublish.length) unpublish.pop()?.()
  })

  const me = { id: "me", name: "Tester", avatarUrl: null, participantType: "user" as const }
  const alice = { id: "u-2", name: "Alice Chen", avatarUrl: null, participantType: "user" as const }
  const agent = { id: "ag", name: "Data", avatarUrl: null, participantType: "agent" as const }

  function seed(
    id: string,
    over: { title?: string | null; type?: string; participants: (typeof me | typeof agent)[] },
  ) {
    addThread({
      id,
      handle: `@${id}`,
      title: over.title ?? null,
      type: over.type,
      participants: over.participants,
      lastMessage: null,
      unreadCount: 0,
      updatedAt: new Date().toISOString(),
    })
  }

  function publish(id: string, onSelect = vi.fn()) {
    unpublish.push(
      provideThreadModelControl(id, () => ({
        threadId: id,
        balance: null,
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
    fireEvent.click(screen.getByTestId("phone-thread-actions"))
    await screen.findByTestId("phone-thread-action-pin")
  }

  it("a DM between people with an agent seat lists it, and it opens the model selector", async () => {
    seed("t-dm", { participants: [me, alice, agent] })
    const onSelect = publish("t-dm")
    renderHeader("t-dm")
    await openMenu()
    const entry = screen.getByTestId("thread-invoked-model")
    expect(entry.textContent).toContain("Invoked model")
    expect(screen.getByTestId("thread-invoked-model-label").textContent).toBe("Flash-Lite")
    // On a 224px phone menu the model name gives way, never the entry's own
    // name ("Invoked mo..." beside "GPT-5.4 Nano" was the walk's finding).
    expect(entry.querySelector("span")?.className).not.toContain("truncate")
    expect(screen.getByTestId("thread-invoked-model-label").className).toContain("min-w-0")

    fireEvent.click(entry)
    const menu = await screen.findByRole("menu")
    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Default (Gemini Flash-Lite)" }), {
      key: "Enter",
    })
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it("a channel does not", async () => {
    seed("t-chan", { title: "Engineering", participants: [me, alice, agent] })
    publish("t-chan")
    renderHeader("t-chan")
    await openMenu()
    expect(screen.queryByTestId("thread-invoked-model")).toBeNull()
  })

  it("an agent chat does not", async () => {
    seed("t-agent", { type: "agent_chat", participants: [me, agent] })
    publish("t-agent")
    renderHeader("t-agent")
    await openMenu()
    expect(screen.queryByTestId("thread-invoked-model")).toBeNull()
  })

  it("a DM between people without an agent does not", async () => {
    seed("t-plain", { participants: [me, alice] })
    renderHeader("t-plain")
    await openMenu()
    expect(screen.queryByTestId("thread-invoked-model")).toBeNull()
  })
})
