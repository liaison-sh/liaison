// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A conversation tab shows the conversation's CURRENT name, also when the
// conversation is not in the loaded list (archived, or reclassified): four
// channels opened while misread as the "Personal agent" DM kept that label
// after the fix, because a tab was only ever re-named from the list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { dispatchWsEventMessage, resetRegistry, tabDisplayLabel } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { openTab, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { addThread, removeThread, resetThreadStore } from "~/modules/threads/thread-store"
import {
  resetThreadTabNames,
  startThreadTabNames,
  threadForTab,
} from "~/modules/threads/thread-tab-names"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal("fetch", vi.fn())

const ME = "u-me"
const ctx = { currentUserId: ME, activeTabId: null, isDocumentVisible: true, isOwnAction: false }
const ID = "11111111-1111-4111-8111-111111111111"
const t = (key: string) => key

function channel(title: string) {
  return {
    id: ID,
    title,
    type: "thread",
    participants: [
      { id: ME, type: "user", name: "Matrix Recipient" },
      { id: "agent-1", type: "agent", name: "Personal agent" },
    ],
  }
}

function label(): string {
  const tab = tabStore.tabs.find((x) => x.entityId === ID)
  if (!tab) throw new Error("no tab")
  return tabDisplayLabel(t, tab)
}

function storedLabel(): string | undefined {
  return tabStore.tabs.find((x) => x.entityId === ID)?.label
}

function wsEvent(entity: string, action: string, data: unknown) {
  dispatchWsEventMessage(
    { type: "event", payload: { app: "kernel", entity, action, actorId: "other", data } },
    ctx,
  )
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

describe("conversation tab names", () => {
  let current = channel("s11-cloud-walk")
  const api = { get: vi.fn(async (_path: string) => ({ data: current })) }

  beforeEach(() => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    resetTabStore()
    resetThreadStore()
    resetThreadTabNames()
    current = channel("s11-cloud-walk")
    api.get.mockClear()
    // A tab opened (and persisted) before the classification fix.
    openTab({ type: "thread", entityId: ID, label: "Personal agent" })
  })
  afterEach(() => resetThreadTabNames())

  it("a tab whose conversation is not in the list reads it by id and shows its name", async () => {
    startThreadTabNames(api)
    expect(label()).toBe("Personal agent") // nothing answered yet: the stored label stands
    await flush()
    expect(api.get).toHaveBeenCalledWith(`/threads/${ID}`)
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(label()).toBe("s11-cloud-walk")
    // Written back, so a restored tab starts with it.
    expect(storedLabel()).toBe("s11-cloud-walk")
    label()
    await flush()
    expect(api.get).toHaveBeenCalledTimes(1) // read once, not on every render
  })

  it("follows a rename made elsewhere while the conversation is out of the list", async () => {
    startThreadTabNames(api)
    label()
    await flush()
    current = channel("renamed-walk")
    wsEvent("thread", "update", { id: ID, changes: { title: "renamed-walk" } })
    await flush()
    expect(label()).toBe("renamed-walk")
    expect(storedLabel()).toBe("renamed-walk")
  })

  it("keeps the current name when the conversation is archived on another device", async () => {
    startThreadTabNames(api)
    addThread(channel("s11-cloud-walk"))
    expect(label()).toBe("s11-cloud-walk")
    current = channel("renamed-walk")
    wsEvent("thread", "update", { id: ID, changes: { title: "renamed-walk" } })
    expect(label()).toBe("renamed-walk")
    wsEvent("read_state", "update", {
      kind: "thread_state",
      threadId: ID,
      isArchived: true,
      isMuted: false,
      isPinned: false,
    })
    expect(label()).toBe("renamed-walk")
    await flush()
    expect(label()).toBe("renamed-walk")
    // And a rename after the archive still reaches the tab.
    current = channel("after-archive")
    wsEvent("thread", "update", { id: ID, changes: { title: "after-archive" } })
    await flush()
    expect(label()).toBe("after-archive")
  })
})

describe("the open conversation after it leaves the list", () => {
  let current = channel("s11-cloud-walk")
  const api = { get: vi.fn(async (_path: string) => ({ data: current })) }

  beforeEach(() => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    resetTabStore()
    resetThreadStore()
    resetThreadTabNames()
    current = channel("s11-cloud-walk")
    api.get.mockClear()
    openTab({ type: "thread", entityId: ID, label: "s11-cloud-walk" })
  })
  afterEach(() => resetThreadTabNames())

  it("keeps the list's last copy the moment it is archived here, then follows renames", async () => {
    startThreadTabNames(api)
    addThread(channel("s11-cloud-walk"))
    current = channel("renamed-walk")
    wsEvent("thread", "update", { id: ID, changes: { title: "renamed-walk" } })
    removeThread(ID) // archived on this device
    // No gap: the view and the tab read the copy the list held, not a stale detail.
    expect(threadForTab(ID)?.title).toBe("renamed-walk")
    expect(label()).toBe("renamed-walk")
    current = channel("after-archive")
    wsEvent("thread", "update", { id: ID, changes: { title: "after-archive" } })
    expect(threadForTab(ID)?.title).toBe("after-archive") // applied at once
    await flush()
    expect(threadForTab(ID)?.title).toBe("after-archive")
    expect(label()).toBe("after-archive")
  })
})
