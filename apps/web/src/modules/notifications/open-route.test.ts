// SPDX-License-Identifier: FSL-1.1-ALv2
// LIF-18: a notification click opens the item it is about, through ONE
// resolver. Only the two route grammars the server writes are accepted;
// anything else (a raw path, a URL, a traversal, an unknown tab type) is
// ignored and navigates nowhere.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  registerEntityOpener,
  registerTabType,
  resetRegistry,
  setManifestAppsSettled,
} from "~/framework/app-registry"
import {
  captureNotificationRouteFromUrl,
  installNotificationRoutes,
  NotificationRouteTestAccess,
  offerShellNotificationRoute,
  openNotificationRoute,
  parseNotificationRoute,
} from "./open-route"

const openTabMock = vi.fn()
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: (opts: unknown) => openTabMock(opts),
}))

const openEntityMock = vi.fn(async () => {})
const markAttentionReadMock = vi.fn()
vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: (...args: unknown[]) => openEntityMock(...(args as [])),
  markAttentionRead: (...args: unknown[]) => markAttentionReadMock(...args),
}))

const openThreadWithReplyPanelMock = vi.fn()
const requestChannelJumpMock = vi.fn()
vi.mock("~/modules/threads/reply-panel-store", () => ({
  openThreadWithReplyPanel: (...args: unknown[]) => openThreadWithReplyPanelMock(...args),
  requestChannelJump: (...args: unknown[]) => requestChannelJumpMock(...args),
}))

const focusApprovalMock = vi.fn()
vi.mock("~/modules/shell/approval-focus", () => ({
  focusApproval: (id: string) => focusApprovalMock(id),
}))

const addToastMock = vi.fn()
vi.mock("~/modules/shell/toast-store", () => ({
  addToast: (input: unknown) => addToastMock(input),
}))

const api = { post: vi.fn() } as never

const APPROVAL = "5f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
const THREAD = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const ROOT = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"

const Dummy = () => null

function registerKernelTabs(): void {
  registerTabType("thread", {
    component: Dummy,
    sidebar: null,
    icon: Dummy,
    urlPattern: "/threads/:entityId",
    defaultLabel: "Thread",
    resolveLabel: (id) => (id === THREAD ? "General" : undefined),
  })
  registerTabType("kernel:home", {
    component: Dummy,
    sidebar: null,
    icon: Dummy,
    urlPattern: "/",
    defaultLabel: "Home",
    localType: "home",
    singleton: true,
  })
}

beforeEach(() => {
  resetRegistry()
  registerKernelTabs()
  setManifestAppsSettled(true)
  openTabMock.mockReset()
  openEntityMock.mockReset()
  openThreadWithReplyPanelMock.mockReset()
  requestChannelJumpMock.mockReset()
  markAttentionReadMock.mockReset()
  focusApprovalMock.mockReset()
  addToastMock.mockReset()
  NotificationRouteTestAccess.reset()
})

afterEach(() => {
  NotificationRouteTestAccess.reset()
  window.history.replaceState(null, "", "/")
})

describe("parseNotificationRoute", () => {
  it("accepts exactly the two grammars", () => {
    expect(parseNotificationRoute(`thread/${THREAD}`)).toEqual({
      kind: "thread",
      threadId: THREAD,
      replyRootId: null,
    })
    expect(parseNotificationRoute(`thread/${THREAD}?replyRoot=${ROOT}`)).toEqual({
      kind: "thread",
      threadId: THREAD,
      replyRootId: ROOT,
    })
    expect(parseNotificationRoute(`attention/kernel/approval_request/${APPROVAL}`)).toEqual({
      kind: "attention",
      app: "kernel",
      entityType: "approval_request",
      entityId: APPROVAL,
    })
  })

  it("accepts ids with dots, colons and escapes, decoded once", () => {
    expect(parseNotificationRoute("attention/monitoring/incident/inc.42")).toMatchObject({
      entityId: "inc.42",
    })
    expect(parseNotificationRoute("attention/mail/conversation/gmail:18f3a@x")).toMatchObject({
      entityId: "gmail:18f3a@x",
    })
    expect(parseNotificationRoute("attention/mail/conversation/a%3Ab")).toMatchObject({
      entityId: "a:b",
    })
    expect(parseNotificationRoute(`thread/${THREAD}?replyRoot=m.1`)).toMatchObject({
      replyRootId: "m.1",
    })
  })

  it("refuses hostile and malformed input", () => {
    for (const route of [
      "//evil.com",
      "https://evil.com",
      "/settings",
      "javascript:alert(1)",
      "attention/x/y/../",
      "attention/x/y/..",
      "attention/x/y",
      "attention/x/y/z/w",
      "attention/X/y/z",
      "attention/x/y/a%2Fb",
      "attention/x/y/a%5Cb",
      "attention/x/y/%2E%2E",
      "attention/x/y/a..b",
      "attention/x/y/.",
      "attention/x/y/%252F",
      "attention/x/y/%E0%A4%A",
      "attention/x/y/a b",
      `attention/x/y/${"a".repeat(129)}`,
      "thread/a%2F..%2Fsettings",
      "thread/../../settings",
      `thread/${THREAD}?replyRoot=`,
      `thread/${THREAD}?replyRoot=${ROOT}&x=1`,
      `thread/${THREAD}#top`,
      `thread/${THREAD}/extra`,
      `thread/${"a".repeat(200)}`,
      "",
      null,
      42,
      { route: `thread/${THREAD}` },
    ]) {
      expect(parseNotificationRoute(route)).toBeNull()
    }
  })
})

describe("openNotificationRoute", () => {
  it("opens the thread tab", async () => {
    expect(await openNotificationRoute(`thread/${THREAD}`, api)).toBe(true)
    expect(openTabMock).toHaveBeenCalledWith({ type: "thread", entityId: THREAD, label: "General" })
  })

  it("opens the thread with the reply panel on the root", async () => {
    expect(await openNotificationRoute(`thread/${THREAD}?replyRoot=${ROOT}`, api)).toBe(true)
    expect(openThreadWithReplyPanelMock).toHaveBeenCalledWith(THREAD, ROOT)
    expect(openTabMock).not.toHaveBeenCalled()
  })

  it("an approval opens Home with the approval brought into view, never its thread", async () => {
    registerEntityOpener("kernel", "approval_request", async () => ({
      tabType: "thread",
      entityId: THREAD,
    }))
    expect(await openNotificationRoute(`attention/kernel/approval_request/${APPROVAL}`, api)).toBe(
      true,
    )
    expect(openTabMock).toHaveBeenCalledWith({
      type: "kernel:home",
      entityId: "home",
      label: "Home",
    })
    expect(focusApprovalMock).toHaveBeenCalledWith(APPROVAL)
    expect(openEntityMock).not.toHaveBeenCalled()
  })

  it("an attention item opens through openEntity and is marked read", async () => {
    registerEntityOpener("projects", "task", (_api, id) => ({
      tabType: "projects:task",
      entityId: id,
    }))
    expect(await openNotificationRoute("attention/projects/task/t-42", api)).toBe(true)
    expect(openEntityMock).toHaveBeenCalledWith(api, "projects", "task", "t-42", undefined, {
      markAttentionRead: true,
    })
  })

  it("a message in a task's comments opens the task with that message brought into view", async () => {
    registerEntityOpener("projects", "task", (_api, id) => ({
      tabType: "projects:task",
      entityId: id,
    }))
    const MESSAGE = "6a2d3b4c-5e6f-4a71-8b2c-3d4e5f6a7b8c"
    const route = `attention/projects/task/t-42?thread=${THREAD}&message=${MESSAGE}`
    expect(parseNotificationRoute(route)).toEqual({
      kind: "attention",
      app: "projects",
      entityType: "task",
      entityId: "t-42",
      focus: { threadId: THREAD, messageId: MESSAGE },
    })
    expect(await openNotificationRoute(route, api)).toBe(true)
    expect(requestChannelJumpMock).toHaveBeenCalledWith(THREAD, MESSAGE)
    expect(openEntityMock).toHaveBeenCalledWith(api, "projects", "task", "t-42", undefined, {
      markAttentionRead: true,
    })
    // The conversation's own notification row is read with it.
    expect(markAttentionReadMock).toHaveBeenCalledWith(api, "kernel", "thread", THREAD)
  })

  it("refuses any other query on an attention route", () => {
    for (const route of [
      `attention/projects/task/t-42?message=${THREAD}`,
      `attention/projects/task/t-42?thread=${THREAD}&message=`,
      `attention/projects/task/t-42?thread=${THREAD}&message=a%2Fb`,
      `attention/projects/task/t-42?thread=${THREAD}&message=${THREAD}&x=1`,
    ]) {
      expect(parseNotificationRoute(route)).toBeNull()
    }
  })

  it("an attention item whose app registers the tab type directly opens", async () => {
    registerTabType("monitoring:incident", {
      component: Dummy,
      sidebar: null,
      icon: Dummy,
      urlPattern: "/monitoring/incident/:entityId",
      defaultLabel: "Incident",
    })
    expect(await openNotificationRoute("attention/monitoring/incident/i-1", api)).toBe(true)
    expect(openEntityMock).toHaveBeenCalledTimes(1)
  })

  it("a well-formed route nothing here can open lands on Home", async () => {
    expect(await openNotificationRoute("attention/nope/widget/w-1", api)).toBe(true)
    expect(openEntityMock).not.toHaveBeenCalled()
    expect(openTabMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "kernel:home", entityId: "home" }),
    )
  })

  it("an item whose opener fails lands on Home", async () => {
    registerEntityOpener("projects", "task", (_api, id) => ({
      tabType: "projects:task",
      entityId: id,
    }))
    openEntityMock.mockRejectedValueOnce(new Error("gone"))
    expect(await openNotificationRoute("attention/projects/task/t.42", api)).toBe(true)
    expect(openEntityMock).toHaveBeenCalledTimes(1)
    expect(openTabMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "kernel:home", entityId: "home" }),
    )
  })

  it("hostile input navigates nowhere", async () => {
    for (const route of ["//evil.com", "attention/x/y/../", "/settings/admin"]) {
      expect(await openNotificationRoute(route, api)).toBe(false)
    }
    expect(openTabMock).not.toHaveBeenCalled()
    expect(openEntityMock).not.toHaveBeenCalled()
  })

  it("waits for the apps to load before deciding an app's route is unknown", async () => {
    setManifestAppsSettled(false)
    const opened = openNotificationRoute("attention/monitoring/incident/i-1", api)
    registerTabType("monitoring:incident", {
      component: Dummy,
      sidebar: null,
      icon: Dummy,
      urlPattern: "/monitoring/incident/:entityId",
      defaultLabel: "Incident",
    })
    setManifestAppsSettled(true)
    expect(await opened).toBe(true)
    expect(openEntityMock).toHaveBeenCalledTimes(1)
  })

  it("a route that arrives before the shell is ready opens once it is", async () => {
    expect(await openNotificationRoute(`thread/${THREAD}`)).toBe(false)
    expect(openTabMock).not.toHaveBeenCalled()
    const stop = installNotificationRoutes(api)
    await vi.waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(1))
    stop()
  })
})

describe("boot ?route= consumer", () => {
  it("opens the route and strips the parameter, keeping the rest of the URL", async () => {
    window.history.replaceState(
      null,
      "",
      `/?keep=1&route=${encodeURIComponent(`thread/${THREAD}`)}#frag`,
    )
    const stop = installNotificationRoutes(api)
    captureNotificationRouteFromUrl()
    expect(window.location.search).toBe("?keep=1")
    expect(window.location.hash).toBe("#frag")
    await vi.waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith({
        type: "thread",
        entityId: THREAD,
        label: "General",
      }),
    )
    stop()
  })

  it("strips a hostile ?route= and navigates nowhere", async () => {
    window.history.replaceState(null, "", "/?route=%2F%2Fevil.com")
    const stop = installNotificationRoutes(api)
    captureNotificationRouteFromUrl()
    expect(window.location.search).toBe("")
    expect(window.location.pathname).toBe("/")
    await new Promise((r) => setTimeout(r, 0))
    expect(openTabMock).not.toHaveBeenCalled()
    stop()
  })

  it("a page with no ?route= is left alone", () => {
    window.history.replaceState(null, "", "/threads/abc?x=1")
    captureNotificationRouteFromUrl()
    expect(`${window.location.pathname}${window.location.search}`).toBe("/threads/abc?x=1")
  })
})

describe("service worker message", () => {
  it("an open-route message from the worker opens the route", async () => {
    const target = new EventTarget()
    const stop = installNotificationRoutes(api, { serviceWorker: target })
    target.dispatchEvent(
      new MessageEvent("message", { data: { type: "open-route", route: `thread/${THREAD}` } }),
    )
    await vi.waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(1))
    target.dispatchEvent(new MessageEvent("message", { data: { type: "other", route: "x" } }))
    target.dispatchEvent(
      new MessageEvent("message", { data: { type: "open-route", route: "//evil.com" } }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(openTabMock).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe("desktop shell click (LIF-18)", () => {
  function fakeShell() {
    let listener: ((route: string) => void) | null = null
    const unsubscribe = vi.fn(() => {
      listener = null
    })
    return {
      desktop: {
        onNotificationClick: (cb: (route: string) => void) => {
          listener = cb
          return unsubscribe
        },
      },
      click: (route: string) => listener?.(route),
      unsubscribe,
    }
  }

  it("a click on the shell's notification opens its route", async () => {
    const shell = fakeShell()
    const stop = installNotificationRoutes(api, { desktop: shell.desktop })
    shell.click(`thread/${THREAD}`)
    await vi.waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith({
        type: "thread",
        entityId: THREAD,
        label: "General",
      }),
    )
    expect(addToastMock).not.toHaveBeenCalled()
    stop()
    expect(shell.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("a hostile route from the shell opens nothing", async () => {
    const shell = fakeShell()
    const stop = installNotificationRoutes(api, { desktop: shell.desktop })
    shell.click("//evil.com")
    await new Promise((r) => setTimeout(r, 0))
    expect(openTabMock).not.toHaveBeenCalled()
    stop()
  })
})

describe("desktop shell fallback: an Open toast", () => {
  it("a notification raised while the window is focused offers Open at once", async () => {
    const stop = installNotificationRoutes(api, { hasFocus: () => true })
    offerShellNotificationRoute(`thread/${THREAD}`, "Alice")
    expect(addToastMock).toHaveBeenCalledTimes(1)
    const toast = addToastMock.mock.calls[0][0] as {
      message: string
      action: { onClick: () => void }
    }
    expect(toast.message).toBe("Alice")
    toast.action.onClick()
    await vi.waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(1))
    stop()
  })

  it("raised in the background, the Open toast waits for the window to come back", () => {
    const stop = installNotificationRoutes(api, { hasFocus: () => false })
    offerShellNotificationRoute(`thread/${THREAD}`, "Alice")
    expect(addToastMock).not.toHaveBeenCalled()
    window.dispatchEvent(new Event("focus"))
    expect(addToastMock).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event("focus"))
    expect(addToastMock).toHaveBeenCalledTimes(1)
    stop()
  })

  it("an invalid route offers nothing", () => {
    const stop = installNotificationRoutes(api, { hasFocus: () => true })
    offerShellNotificationRoute("//evil.com", "Alice")
    expect(addToastMock).not.toHaveBeenCalled()
    stop()
  })
})
