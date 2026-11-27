// SPDX-License-Identifier: FSL-1.1-ALv2
// A CLICK ON A DESKTOP NOTIFICATION OPENS THE RIGHT TAB, for every kind of
// notification the server raises. Each route is built by the server's own
// route functions (@liaison/shared notifications/routes.ts and
// threads/thread-anchor.ts, which push/fanout-consumer.ts, notifications/
// dispatch.ts, notifications/burst.ts and push/node-session-notify.ts call),
// never typed by hand. The click comes through a fake desktop shell that keeps
// the native shell's contract (src-tauri/src/desktop_notifications.rs): one
// pending click slot, taken when the page subscribes (a click that launched
// the app, or one made while the page was loading) and on every later click
// event. The page side is real: the kernel's tab types and entity openers
// (bootstrapKernelApps), open-route.ts, entity-opener.ts, the reply panel and
// approval focus stores; only the tab store's openTab is observed.
import {
  attentionNotificationRoute,
  burstSummaryNotificationRoute,
  HOME_NOTIFICATION_ROUTE,
  threadAnchorMessageRoute,
  threadNotificationRoute,
} from "@liaison/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerTabType, resetRegistry, setManifestAppsSettled } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { clearApprovalFocus, focusedApproval } from "~/modules/shell/approval-focus"
import {
  channelJumpRequest,
  consumeChannelJump,
  getOpenReplyPanel,
  resetReplyPanels,
} from "~/modules/threads/reply-panel-store"
import { installNotificationRoutes, NotificationRouteTestAccess } from "./open-route"

const openTabMock = vi.fn()
vi.mock("~/modules/shell/tab-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/tab-store")>()),
  openTab: (opts: unknown) => openTabMock(opts),
}))

/** The API: mark-read posts are recorded and never answer (no feed reload). */
const post = vi.fn((_path: string, _body: unknown) => new Promise<never>(() => {}))
const api = { post, get: vi.fn(() => new Promise<never>(() => {})) } as never

const THREAD = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const ROOT = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"
const MESSAGE = "6a2d3b4c-5e6f-4a71-8b2c-3d4e5f6a7b8c"
const TASK = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f"
const TICKET = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a"
const APPROVAL = "5f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
const SESSION = "1e2d3c4b-5a69-4788-9a0b-c1d2e3f4a5b6"
const INCIDENT = "2a3b4c5d-6e7f-4801-9a2b-3c4d5e6f7a8b"
const MAILBOX = "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d"

/**
 * The native shell's click contract, in memory: a click fills the one pending
 * slot (the latest wins) and emits; the page takes the slot on the event and
 * once when it subscribes.
 */
function fakeShell() {
  let pending: string | null = null
  const listeners = new Set<(route: string) => void>()
  const take = (): string | null => {
    const route = pending
    pending = null
    return route
  }
  return {
    /** A click while the page is not listening yet (cold start, page loading). */
    clickBeforeListening(route: string): void {
      pending = route
    },
    /** A click with the page up: the shell stores it and emits the click event. */
    click(route: string): void {
      pending = route
      for (const listener of listeners) {
        const taken = take()
        if (taken) listener(taken)
      }
    },
    bridge: {
      onNotificationClick(listener: (route: string) => void): () => void {
        listeners.add(listener)
        const taken = take()
        if (taken) listener(taken)
        return () => listeners.delete(listener)
      },
    },
  }
}

const Dummy = () => null

/** Tab types the bundled apps' manifests register (`views.tabTypes.<t>` → `<app>:<t>`). */
function registerManifestTabs(): void {
  for (const [type, pattern] of [
    ["projects:task", "/projects/tasks/:entityId"],
    ["tickets:ticket", "/tickets/:entityId"],
    ["monitoring:incident", "/monitoring/incident/:entityId"],
  ] as const) {
    registerTabType(type, {
      component: Dummy,
      sidebar: null,
      icon: Dummy,
      urlPattern: pattern,
      defaultLabel: type,
    })
  }
}

let stop: (() => void) | null = null
let shell = fakeShell()

beforeEach(() => {
  resetRegistry()
  resetBootstrap()
  bootstrapKernelApps()
  registerManifestTabs()
  setManifestAppsSettled(true)
  resetReplyPanels()
  const jump = channelJumpRequest()
  if (jump) consumeChannelJump(jump)
  clearApprovalFocus(focusedApproval() ?? "")
  openTabMock.mockReset()
  post.mockClear()
  NotificationRouteTestAccess.reset()
  shell = fakeShell()
})

afterEach(() => {
  stop?.()
  stop = null
  NotificationRouteTestAccess.reset()
  resetRegistry()
  resetBootstrap()
})

function install(): void {
  stop = installNotificationRoutes(api, {
    desktop: shell.bridge,
    serviceWorker: null,
    hasFocus: () => true,
  })
}

/** The last tab the click opened. */
async function openedTab(): Promise<{ type: string; entityId: string }> {
  await vi.waitFor(() => expect(openTabMock).toHaveBeenCalled())
  const last = openTabMock.mock.calls.at(-1)?.[0] as { type: string; entityId: string }
  return { type: last.type, entityId: last.entityId }
}

function markedRead(app: string, entityType: string, entityId: string): boolean {
  return post.mock.calls.some(
    ([path, body]) =>
      path === "/attention-items/mark-read" &&
      JSON.stringify(body) === JSON.stringify({ app, entityType, entityId }),
  )
}

/** Every source: the route the server writes for it, and where a click must land. */
const SOURCES: {
  source: string
  route: string
  tab: { type: string; entityId: string }
  check?: () => void
}[] = [
  {
    source: "direct message / group DM / agent chat / channel message",
    route: threadNotificationRoute(THREAD),
    tab: { type: "thread", entityId: THREAD },
    check: () => expect(getOpenReplyPanel(THREAD)).toBeNull(),
  },
  {
    source: "mention in a conversation",
    route: threadNotificationRoute(THREAD, null),
    tab: { type: "thread", entityId: THREAD },
  },
  {
    source: "reply in a reply thread (a followup, a mention in a reply)",
    route: threadNotificationRoute(THREAD, ROOT),
    tab: { type: "thread", entityId: THREAD },
    check: () => expect(getOpenReplyPanel(THREAD)?.rootId).toBe(ROOT),
  },
  {
    source: "task comment (a message in a task's discussion)",
    route: threadAnchorMessageRoute(
      { app: "projects", entityType: "task", entityId: TASK },
      THREAD,
      MESSAGE,
    ),
    tab: { type: "projects:task", entityId: TASK },
    check: () => {
      expect(channelJumpRequest()).toMatchObject({ threadId: THREAD, messageId: MESSAGE })
      expect(markedRead("projects", "task", TASK)).toBe(true)
      expect(markedRead("kernel", "thread", THREAD)).toBe(true)
    },
  },
  {
    source: "ticket conversation message",
    route: threadAnchorMessageRoute(
      { app: "tickets", entityType: "ticket", entityId: TICKET },
      THREAD,
      MESSAGE,
    ),
    tab: { type: "tickets:ticket", entityId: TICKET },
    check: () => expect(channelJumpRequest()).toMatchObject({ messageId: MESSAGE }),
  },
  {
    source: "message in an entity thread the reader may not see (no anchor)",
    route: threadNotificationRoute(THREAD),
    tab: { type: "thread", entityId: THREAD },
  },
  {
    source: "approval to decide",
    route: attentionNotificationRoute({
      app: "kernel",
      entityType: "approval_request",
      entityId: APPROVAL,
    }),
    tab: { type: "kernel:home", entityId: "home" },
    check: () => expect(focusedApproval()).toBe(APPROVAL),
  },
  {
    source: "approval decided (asked from a conversation)",
    route: attentionNotificationRoute({
      app: "kernel",
      entityType: "approval_request",
      entityId: APPROVAL,
      threadId: THREAD,
    }),
    tab: { type: "thread", entityId: THREAD },
  },
  {
    source: "attention row about a conversation",
    route: attentionNotificationRoute({ app: "kernel", entityType: "thread", entityId: THREAD }),
    tab: { type: "thread", entityId: THREAD },
  },
  {
    source: "computer session needs you / done / failed",
    route: attentionNotificationRoute({
      app: "kernel",
      entityType: "node_session",
      entityId: SESSION,
    }),
    tab: { type: "kernel:session", entityId: SESSION },
    check: () => expect(markedRead("kernel", "node_session", SESSION)).toBe(true),
  },
  {
    source: "new email",
    route: attentionNotificationRoute({ app: "mail", entityType: "new_email", entityId: MAILBOX }),
    tab: { type: "mail:inbox", entityId: "inbox" },
  },
  {
    source: "agent / routine notify_user",
    route: attentionNotificationRoute({
      app: "kernel",
      entityType: "agent_notification",
      entityId: "n-1",
    }),
    tab: { type: "kernel:home", entityId: "home" },
  },
  {
    source: "monitoring incident (an app-defined attention type)",
    route: attentionNotificationRoute({
      app: "monitoring",
      entityType: "incident",
      entityId: INCIDENT,
    }),
    tab: { type: "monitoring:incident", entityId: INCIDENT },
  },
  {
    source: "task item (overdue, blocked: an app-defined attention type)",
    route: attentionNotificationRoute({ app: "projects", entityType: "task", entityId: TASK }),
    tab: { type: "projects:task", entityId: TASK },
  },
  {
    source: "access request / system alert (decided or read on Home)",
    route: attentionNotificationRoute({
      app: "kernel",
      entityType: "scope_request",
      entityId: "s-1",
    }),
    tab: { type: "kernel:home", entityId: "home" },
  },
  {
    source: "item of an app this client lacks",
    route: attentionNotificationRoute({ app: "nope", entityType: "widget", entityId: "w-1" }),
    tab: { type: "kernel:home", entityId: "home" },
  },
  {
    source: "burst summary of one conversation",
    route: burstSummaryNotificationRoute([
      { conversation: THREAD, route: threadNotificationRoute(THREAD) },
      { conversation: THREAD, route: threadNotificationRoute(THREAD) },
    ]),
    tab: { type: "thread", entityId: THREAD },
  },
  {
    source: "burst summary of one task's comments",
    route: burstSummaryNotificationRoute([
      {
        conversation: THREAD,
        route: threadAnchorMessageRoute(
          { app: "projects", entityType: "task", entityId: TASK },
          THREAD,
          MESSAGE,
        ),
      },
    ]),
    tab: { type: "projects:task", entityId: TASK },
  },
  {
    source: "burst summary of one thread-less item (stored before routes were kept)",
    route: burstSummaryNotificationRoute([
      { conversation: `attention/projects/task/${TASK}`, route: null },
    ]),
    tab: { type: "projects:task", entityId: TASK },
  },
  {
    source: "burst summary of several conversations",
    route: burstSummaryNotificationRoute([
      { conversation: THREAD, route: threadNotificationRoute(THREAD) },
      { conversation: ROOT, route: threadNotificationRoute(ROOT) },
    ]),
    tab: { type: "kernel:home", entityId: "home" },
  },
]

describe("a desktop notification click opens the right tab", () => {
  it("the burst summary of several conversations carries the Home route", () => {
    expect(
      burstSummaryNotificationRoute([
        { conversation: "a", route: null },
        { conversation: "b", route: null },
      ]),
    ).toBe(HOME_NOTIFICATION_ROUTE)
  })

  for (const { source, route, tab, check } of SOURCES) {
    it(`${source}: window up (click event)`, async () => {
      install()
      shell.click(route)
      expect(await openedTab()).toEqual(tab)
      check?.()
    })

    it(`${source}: cold start (the click launched the app)`, async () => {
      shell.clickBeforeListening(route)
      install()
      expect(await openedTab()).toEqual(tab)
      check?.()
    })
  }

  it("a second click opens its own item, not the first one again", async () => {
    install()
    shell.click(threadNotificationRoute(THREAD))
    await vi.waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(1))
    shell.click(attentionNotificationRoute({ app: "projects", entityType: "task", entityId: TASK }))
    await vi.waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(2))
    expect(openTabMock.mock.calls[1]?.[0]).toMatchObject({ type: "projects:task", entityId: TASK })
  })
})
