// SPDX-License-Identifier: FSL-1.1-ALv2
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  userFromToken: () => ({ userId: "u1", name: "Test" }),
}))

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]) => {}),
  openConversation: vi.fn(),
  collapse: vi.fn(),
  openTab: vi.fn(),
  dockAvailable: true,
  dockTabs: [] as { threadId: string; expanded: boolean }[],
  dockActiveThreadId: null as string | null,
  tabStore: {
    tabs: [] as { id: string; type: string; entityId?: string }[],
    activeTabId: null as string | null,
  },
}))

vi.mock("~/modules/threads/message-store", () => ({
  sendMessage: (...args: unknown[]) => mocks.sendMessage(...args),
}))

vi.mock("~/modules/shell/dock-store", () => ({
  openConversation: (...args: unknown[]) => mocks.openConversation(...args),
  collapse: (...args: unknown[]) => mocks.collapse(...args),
  dockAvailable: () => mocks.dockAvailable,
  tabs: () => mocks.dockTabs,
  activeThreadId: () => mocks.dockActiveThreadId,
}))

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: (...args: unknown[]) => mocks.openTab(...args),
  get tabStore() {
    return mocks.tabStore
  },
}))

vi.mock("~/modules/shell/attention-store", () => ({
  getAttentionApi: () => null,
}))

import { DESKTOP_QUERY, PHONE_QUERY, syncShellTier } from "~/modules/shell/shell-tier"
import { resetAgentDirectory } from "~/modules/threads/agent-directory"
import {
  discussionMessage,
  discussWithPersonalAgent,
  dmWithAgent,
  ensurePersonalAgentDm,
  openDmWithAgent,
  personalAgentDmId,
  resetPersonalDmStore,
  togglePersonalAgentChat,
} from "~/modules/threads/personal-dm-store"

const PERSONAL_AGENT_ID = "a-mine"

/** The shell tier is a module signal read from matchMedia; these suites run in
 *  plain jsdom, where it answers desktop. */
function setPhoneTier(on: boolean) {
  const answer = on ? PHONE_QUERY : DESKTOP_QUERY
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === answer,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
  syncShellTier()
}

function fakeApi() {
  const posts: { path: string; body: unknown }[] = []
  return {
    posts,
    get: vi.fn(async () => ({
      data: [
        {
          id: PERSONAL_AGENT_ID,
          handle: "@mine",
          displayName: "Liaison",
          kind: "personal",
          ownerUserId: "u1",
        },
        {
          id: "a-role",
          handle: "@ops",
          displayName: "Ops",
          kind: "role",
          ownerUserId: null,
        },
      ],
    })),
    post: vi.fn(async (path: string, body: unknown) => {
      posts.push({ path, body })
      return { data: { id: "thread-dm-1" } }
    }),
  }
}

describe("personal DM store (P4c-T03)", () => {
  beforeEach(() => {
    resetPersonalDmStore()
    resetAgentDirectory()
  })

  it("personal agent DM resolves once and is reused", async () => {
    const api = fakeApi()

    const id1 = await personalAgentDmId(api)
    const id2 = await ensurePersonalAgentDm(api)
    const id3 = await personalAgentDmId(api)

    expect(id1).toBe("thread-dm-1")
    expect(id2).toBe("thread-dm-1")
    expect(id3).toBe("thread-dm-1")
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it("resolution never posts type agent_chat", async () => {
    const api = fakeApi()

    await personalAgentDmId(api)

    expect(api.posts).toHaveLength(1)
    const [call] = api.posts
    expect(call.path).toBe("/threads/dm")
    expect(call.body).toEqual({ agentId: PERSONAL_AGENT_ID })
    expect((call.body as Record<string, unknown>).type).toBeUndefined()
    expect(api.post).not.toHaveBeenCalledWith("/threads", expect.anything())
  })

  it("teardown clears the cached id so the next resolution posts again", async () => {
    const api = fakeApi()

    await ensurePersonalAgentDm(api)
    expect(api.post).toHaveBeenCalledTimes(1)

    resetPersonalDmStore()
    resetAgentDirectory()

    await ensurePersonalAgentDm(api)
    expect(api.post).toHaveBeenCalledTimes(2)
  })
})

describe("DM with any agent (P4c-T34)", () => {
  /** One thread id per agent, so a second POST for the same agent is visible. */
  function perAgentApi() {
    return {
      get: vi.fn(async () => ({ data: [] })),
      post: vi.fn(async (_path: string, body: unknown) => ({
        data: { id: `dm-${(body as { agentId: string }).agentId}` },
      })),
    }
  }

  beforeEach(() => {
    resetPersonalDmStore()
    resetAgentDirectory()
    mocks.openConversation.mockClear()
    mocks.openTab.mockClear()
    mocks.dockAvailable = true
    mocks.tabStore.tabs = [{ id: "mail:conversation:conv-1", type: "mail:conversation" }]
    mocks.tabStore.activeTabId = "mail:conversation:conv-1"
  })

  it("resolves one DM per agent and reuses it", async () => {
    const api = perAgentApi()

    expect(await dmWithAgent(api, "a-ops")).toBe("dm-a-ops")
    expect(await dmWithAgent(api, "a-ops")).toBe("dm-a-ops")
    expect(api.post).toHaveBeenCalledTimes(1)

    expect(await dmWithAgent(api, "a-support")).toBe("dm-a-support")
    expect(api.post).toHaveBeenCalledTimes(2)
    expect(api.post).toHaveBeenLastCalledWith("/threads/dm", { agentId: "a-support" })
  })

  it("opening a DM follows the surface rule and names the tab after the agent", async () => {
    const api = perAgentApi()

    await openDmWithAgent("a-ops", "Ops", api)
    expect(mocks.openConversation).toHaveBeenCalledWith("dm-a-ops")
    expect(mocks.openTab).not.toHaveBeenCalled()

    mocks.tabStore.tabs = [{ id: "kernel:home:home", type: "kernel:home" }]
    mocks.tabStore.activeTabId = "kernel:home:home"
    await openDmWithAgent("a-support", "Support", api)
    expect(mocks.openTab).toHaveBeenCalledWith({
      type: "thread",
      entityId: "dm-a-support",
      label: "Support",
    })
  })
})

describe("discuss with the personal agent (P4c-T12)", () => {
  beforeEach(() => {
    resetPersonalDmStore()
    resetAgentDirectory()
    mocks.sendMessage.mockClear()
    mocks.openConversation.mockClear()
    mocks.collapse.mockClear()
    mocks.openTab.mockClear()
    mocks.dockAvailable = true
    mocks.dockTabs = []
    mocks.dockActiveThreadId = null
    mocks.tabStore.tabs = [{ id: "mail:conversation:conv-1", type: "mail:conversation" }]
    mocks.tabStore.activeTabId = "mail:conversation:conv-1"
  })

  it("discussing a mail posts the injected message into the personal DM and creates no thread", async () => {
    const api = fakeApi()

    await discussWithPersonalAgent({ title: "Order 1234", link: "/mail/conv-1" }, api)

    // No discussion thread is created: the only POST is the DM resolution.
    expect(api.posts.map((p) => p.path)).toEqual(["/threads/dm"])
    expect(api.post).not.toHaveBeenCalledWith("/threads", expect.anything())
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.sendMessage.mock.calls[0]![1]).toBe("thread-dm-1")
    expect(mocks.sendMessage.mock.calls[0]![2]).toBe("I want to discuss Order 1234: /mail/conv-1")
    expect(mocks.sendMessage.mock.calls[0]![3]).toEqual({ id: "u1", name: "Test" })
    // Off a Home surface the DM opens as a dock tab.
    expect(mocks.openConversation).toHaveBeenCalledWith("thread-dm-1")
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it("discussing from a Home surface opens the DM as a thread tab", async () => {
    const api = fakeApi()
    mocks.tabStore.tabs = [{ id: "kernel:home:home", type: "kernel:home" }]
    mocks.tabStore.activeTabId = "kernel:home:home"

    await discussWithPersonalAgent({ title: "Order 1234", link: "/mail/conv-1" }, api)

    expect(mocks.openTab).toHaveBeenCalledWith({
      type: "thread",
      entityId: "thread-dm-1",
      label: "Liaison",
    })
    expect(mocks.openConversation).not.toHaveBeenCalled()
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
  })

  it("discussing at phone tier opens the thread route rather than the Chats sheet", async () => {
    const api = fakeApi()
    // Phone: no dock, and Chats is a root screen whose conversations are
    // routes, so the sheet must not be what a Discuss lands on (F3).
    mocks.dockAvailable = false
    setPhoneTier(true)
    try {
      await discussWithPersonalAgent({ title: "Order 1234", link: "/mail/conv-1" }, api)
    } finally {
      setPhoneTier(false)
    }

    expect(mocks.openTab).toHaveBeenCalledWith({
      type: "thread",
      entityId: "thread-dm-1",
      label: "Liaison",
    })
    expect(mocks.openConversation).not.toHaveBeenCalled()
  })

  it("the toggle opens the personal DM dock tab and collapses it when it is already in front", async () => {
    const api = fakeApi()

    await togglePersonalAgentChat(api)
    expect(mocks.openConversation).toHaveBeenCalledWith("thread-dm-1")
    expect(mocks.collapse).not.toHaveBeenCalled()

    mocks.dockActiveThreadId = "thread-dm-1"
    mocks.dockTabs = [{ threadId: "thread-dm-1", expanded: true }]
    await togglePersonalAgentChat(api)
    expect(mocks.collapse).toHaveBeenCalledWith("thread-dm-1")
    expect(mocks.openConversation).toHaveBeenCalledTimes(1)
  })

  /**
   * THE CARET GOES WHERE THE USER IS LOOKING, or nowhere.
   *
   * An expanded dock tab sits over the main panel, so the conversation in
   * front of the user is that one, not whatever tab is active behind it. The
   * gesture used to take a shortcut on "the active tab is a thread tab" and
   * focus the MAIN tab's composer: with the personal agent DM as the main tab
   * and another DM expanded in the dock, it armed the personal DM's composer
   * while the user was reading the other conversation, so the next thing they
   * typed was sent to the personal agent DM and nothing appeared in the
   * conversation they were in.
   */
  it("does not arm the main tab composer while another conversation is expanded in the dock", async () => {
    const api = fakeApi()
    mocks.tabStore = {
      tabs: [{ id: "thread:thread-dm-1", type: "thread", entityId: "thread-dm-1" }],
      activeTabId: "thread:thread-dm-1",
    }
    mocks.dockActiveThreadId = "thread-ops"
    mocks.dockTabs = [{ threadId: "thread-ops", expanded: true }]

    document.body.innerHTML =
      '<div data-tab-active="true">' +
      '<div data-testid="compose-editor" contenteditable="true" tabindex="0"></div>' +
      "</div>"
    const editor = document.querySelector<HTMLElement>('[data-testid="compose-editor"]')

    await togglePersonalAgentChat(api)

    expect(document.activeElement).not.toBe(editor)
    expect(mocks.openConversation).toHaveBeenCalledWith("thread-dm-1")
  })
})

// P4c FX-B3 (D4): `POST /threads { type: "agent_chat" }` is retired and the api
// answers it 400 `agent_chat_retired`. Two live callers were still on it (the
// mailbox agent host and the retired panel's chat store), each failing only at runtime,
// in a browser, on a path no unit test drove. This walks the shipped sources so
// a third one cannot be written back in silently.
describe("no source file still creates a thread with type agent_chat", () => {
  // vitest runs from apps/web (vitest.config.ts lives there).
  const sourceRoot = join(process.cwd(), "src")

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // e2e scenarios drive the api as a black box and may assert the
        // retirement itself; they are not shipped app code.
        if (entry.name === "node_modules" || entry.name === "e2e") continue
        out.push(...sourceFiles(full))
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      if (/\.test\.tsx?$/.test(entry.name)) continue
      out.push(full)
    }
    return out
  }

  /** Line comments and block-comment bodies: the retirement is DOCUMENTED in
   *  several files, and documenting it is the opposite of the defect. */
  function stripComments(source: string): string {
    return source
      .split("\n")
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")
      })
      .join("\n")
  }

  // Test-only render helpers that are not `.test` files: they seed the thread
  // store with an existing agent_chat row (legacy rows still load from the
  // api), never POST one. Each must stay unimported by shipped source.
  const TEST_SUPPORT = new Set([join(sourceRoot, "modules/desktop/baseline-render.tsx")])

  it("no POST body under apps/web/src carries type: agent_chat", () => {
    const offenders = sourceFiles(sourceRoot).filter(
      (file) =>
        !TEST_SUPPORT.has(file) &&
        /type:\s*["']agent_chat["']/.test(stripComments(readFileSync(file, "utf8"))),
    )
    expect(offenders).toEqual([])
  })

  it("the test support files it skips are imported by tests only", () => {
    const importers = sourceFiles(sourceRoot).filter((file) => {
      const src = readFileSync(file, "utf8")
      return [...TEST_SUPPORT].some((support) => {
        const stem = support.slice(support.lastIndexOf("/") + 1).replace(/\.tsx?$/, "")
        return new RegExp(`from\\s+["'][^"']*/${stem}["']`).test(src)
      })
    })
    expect(importers).toEqual([])
  })

  it("the guard can see the files it claims to walk", () => {
    const files = sourceFiles(sourceRoot)
    expect(files.length).toBeGreaterThan(200)
    expect(files.some((f) => f.endsWith("/modules/mailbox/MailboxAgentHost.tsx"))).toBe(true)
    expect(files.some((f) => f.endsWith("/modules/threads/personal-dm-store.ts"))).toBe(true)
  })
})

// F6. "Discuss this" posted a bare path ("/mail/af05...") that named nothing
// and opened nothing, and the agent's answer came back as raw markdown.
describe("discussionMessage", () => {
  it("carries an entity reference when the caller has one", () => {
    expect(
      discussionMessage({
        title: "Client Feedback",
        link: "/mail/conv-1",
        ref: "mail:conversation:conv-1",
      }),
    ).toBe("I want to discuss @[Client Feedback](mail:conversation:conv-1)")
  })

  it("escapes a title that would close the reference early", () => {
    expect(
      discussionMessage({ title: "Re: [urgent]", link: "/x", ref: "mail:conversation:c2" }),
    ).toBe("I want to discuss @[Re: [urgent\\]](mail:conversation:c2)")
  })

  it("keeps the plain link form for a caller with no entity reference", () => {
    expect(discussionMessage({ title: "Knowledge", link: "/knowledge" })).toBe(
      "I want to discuss Knowledge: /knowledge",
    )
  })
})
