// SPDX-License-Identifier: FSL-1.1-ALv2
// P1-T4 (S5, A7): the service worker (public/liaison-sw.js) shows the Web
// Push it receives, then posts a `shown` receipt with the browser device's
// credential, read from the IndexedDB record the page wrote. The file is a
// classic worker script, so the test runs it against a fake worker scope.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeBrowserDevice } from "./device-credential"
import { createFakeIndexedDb, type FakeIndexedDb } from "./fake-idb"

/** The server's Web Push user marker (apps/api web-push.ts `webPushUserTag`). */
const userTag = (userId: string) =>
  createHash("sha256").update(`liaison-push-user:${userId}`).digest("hex")

const SW_SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "../../../public/liaison-sw.js"),
  "utf8",
)

type Listener = (event: any) => void

interface Scope {
  listeners: Map<string, Listener[]>
  registration: { showNotification: ReturnType<typeof vi.fn> }
  clients: {
    matchAll: ReturnType<typeof vi.fn>
    openWindow: ReturnType<typeof vi.fn>
  }
  location: { origin: string }
  addEventListener: (type: string, fn: Listener) => void
  skipWaiting: () => Promise<void>
}

let idb: FakeIndexedDb
let fetchMock: ReturnType<typeof vi.fn>
let order: string[]

function loadWorker(): Scope {
  const scope: Scope = {
    listeners: new Map(),
    registration: {
      showNotification: vi.fn(async () => {
        order.push("show")
      }),
    },
    clients: { matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => null) },
    location: { origin: "https://app.test" },
    addEventListener(type, fn) {
      const list = scope.listeners.get(type) ?? []
      list.push(fn)
      scope.listeners.set(type, list)
    },
    skipWaiting: async () => {},
  }
  new Function("self", "indexedDB", "fetch", "clients", SW_SOURCE)(
    scope,
    idb,
    fetchMock,
    scope.clients,
  )
  return scope
}

async function dispatchPush(scope: Scope, payload: unknown): Promise<void> {
  const pending: Promise<unknown>[] = []
  const event = {
    data:
      payload === undefined ? null : { json: () => payload, text: () => JSON.stringify(payload) },
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  }
  for (const fn of scope.listeners.get("push") ?? []) fn(event)
  await Promise.all(pending)
}

const frame = {
  type: "notify",
  notifyId: "test:run:browser_push:dev-1",
  notificationId: "22222222-2222-4222-8222-222222222222",
  group: "system",
  title: "Liaison",
  body: "This is a test notification.",
  route: "settings/notifications",
  urgent: false,
}

beforeEach(async () => {
  order = []
  idb = createFakeIndexedDb()
  vi.stubGlobal("indexedDB", idb)
  fetchMock = vi.fn(async () => {
    order.push("receipt")
    return new Response(JSON.stringify({ data: {} }), { status: 200 })
  })
  await writeBrowserDevice({
    deviceId: "dev-1",
    credential: "lnr_swcred",
    userId: "u1",
    serverOrigin: "https://acme.example",
    receiptsUrl: "https://acme.example/api/notifications/receipts",
    endpoint: "https://push.example/sub/1",
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("liaison-sw.js push handler", () => {
  it("shows the notification, then posts a shown receipt with the device credential", async () => {
    const scope = loadWorker()
    await dispatchPush(scope, frame)
    expect(scope.registration.showNotification).toHaveBeenCalledWith(
      "Liaison",
      expect.objectContaining({ body: "This is a test notification.", tag: frame.notifyId }),
    )
    expect(order).toEqual(["show", "receipt"])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://acme.example/api/notifications/receipts")
    expect(init.method).toBe("POST")
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer lnr_swcred")
    expect(JSON.parse(init.body as string)).toMatchObject({
      notificationId: frame.notificationId,
      deviceId: "dev-1",
      surface: "browser_push",
      outcome: "shown",
    })
  })

  // The test send writes its delivery rows after the last device, so a receipt
  // can arrive first and read 404: the worker posts it once more a moment later.
  it("re-posts a receipt that beat its delivery row (404) once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let first = true
      fetchMock.mockImplementation(async () => {
        order.push("receipt")
        if (first) {
          first = false
          return new Response("{}", { status: 404 })
        }
        return new Response(JSON.stringify({ data: {} }), { status: 200 })
      })
      const scope = loadWorker()
      const done = dispatchPush(scope, frame)
      await vi.advanceTimersByTimeAsync(5000)
      await done
      expect(order).toEqual(["show", "receipt", "receipt"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("shows a push without a notificationId but posts no receipt", async () => {
    const scope = loadWorker()
    await dispatchPush(scope, { ...frame, notificationId: undefined })
    expect(scope.registration.showNotification).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("without a stored credential it still shows, and posts nothing", async () => {
    idb = createFakeIndexedDb()
    const scope = loadWorker()
    await dispatchPush(scope, frame)
    expect(scope.registration.showNotification).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("a failed receipt never fails the push event", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"))
    const scope = loadWorker()
    await expect(dispatchPush(scope, frame)).resolves.toBeUndefined()
    expect(scope.registration.showNotification).toHaveBeenCalledTimes(1)
  })

  // fix2-F1, defence in depth: a push addressed to another user than the one
  // whose credential this browser holds is never shown, nor receipted.
  it("drops a push whose user marker is another user's", async () => {
    const scope = loadWorker()
    await dispatchPush(scope, { ...frame, userTag: userTag("u2") })
    expect(scope.registration.showNotification).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows a push whose user marker is the credential's user", async () => {
    const scope = loadWorker()
    await dispatchPush(scope, { ...frame, userTag: userTag("u1") })
    expect(scope.registration.showNotification).toHaveBeenCalledTimes(1)
    expect(order).toEqual(["show", "receipt"])
  })

  it("a click focuses an open Liaison window, else opens one", async () => {
    const scope = loadWorker()
    const pending: Promise<unknown>[] = []
    const close = vi.fn()
    for (const fn of scope.listeners.get("notificationclick") ?? []) {
      fn({ notification: { close, data: {} }, waitUntil: (p: Promise<unknown>) => pending.push(p) })
    }
    await Promise.all(pending)
    expect(close).toHaveBeenCalled()
    expect(scope.clients.openWindow).toHaveBeenCalledWith("/")
  })

  async function click(scope: Scope, data: unknown): Promise<void> {
    const pending: Promise<unknown>[] = []
    for (const fn of scope.listeners.get("notificationclick") ?? []) {
      fn({
        notification: { close: vi.fn(), data },
        waitUntil: (p: Promise<unknown>) => pending.push(p),
      })
    }
    await Promise.all(pending)
  }

  function windowClient(url: string) {
    return { url, focus: vi.fn(async () => undefined), postMessage: vi.fn() }
  }

  it("a click with a route focuses the open Liaison window and hands it the route (LIF-18)", async () => {
    const scope = loadWorker()
    const open = windowClient("https://app.test/threads/x")
    scope.clients.matchAll.mockResolvedValue([open])
    await click(scope, { route: "attention/kernel/approval_request/a1" })
    expect(open.focus).toHaveBeenCalled()
    expect(open.postMessage).toHaveBeenCalledWith({
      type: "open-route",
      route: "attention/kernel/approval_request/a1",
    })
    expect(scope.clients.openWindow).not.toHaveBeenCalled()
  })

  it("with no open window, a click opens one on /?route=", async () => {
    const scope = loadWorker()
    await click(scope, { route: "thread/t-1?replyRoot=r-1" })
    expect(scope.clients.openWindow).toHaveBeenCalledWith(
      `/?route=${encodeURIComponent("thread/t-1?replyRoot=r-1")}`,
    )
  })

  it("a window of another origin is never handed the route", async () => {
    const scope = loadWorker()
    const foreign = windowClient("https://evil.test/")
    scope.clients.matchAll.mockResolvedValue([foreign])
    await click(scope, { route: "thread/t-1" })
    expect(foreign.postMessage).not.toHaveBeenCalled()
    expect(foreign.focus).not.toHaveBeenCalled()
    expect(scope.clients.openWindow).toHaveBeenCalledWith(
      `/?route=${encodeURIComponent("thread/t-1")}`,
    )
  })

  it("a route that is not a string opens the app at its root", async () => {
    const scope = loadWorker()
    await click(scope, { route: { evil: true } })
    expect(scope.clients.openWindow).toHaveBeenCalledWith("/")
  })
})
