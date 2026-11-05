// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What is pinned here is the ORDER and the GATES, because both of them fail
// silently. A permission prompt shown before the app knows which server it
// talks to is a prompt the user answers once, for nothing, and iOS never asks
// again. A registration listener attached after `register()` is a listener
// that misses the token on the launch that mattered.

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createAccessTokenStore, installRefreshBridge } from "./auth/refresh-bridge"
import { createDeepLinkQueue } from "./deep-link"
import { PUSH_NOTICE_FALLBACK } from "./onboarding/mobile-copy"
import {
  armPushRegistration,
  BADGE_PATH,
  createPushClient,
  PUSH_NOTICE_ID,
  PUSH_NOTICE_MS,
  PUSH_TOKENS_PATH,
  type PushPlugin,
} from "./push-client"
import { createMemoryReceiptNative, createReceiptClient, RECEIPTS_PATH } from "./receipts"

interface Call {
  url: string
  method: string
  body: unknown
  authorization: string | null
}

/** The Capacitor plugin seam, driven by hand. */
function fakePlugin() {
  const handlers = new Map<string, (payload: unknown) => void>()
  const order: string[] = []
  let permission: string = "granted"
  return {
    order,
    setPermission(next: string) {
      permission = next
    },
    fire(event: string, payload: unknown) {
      const handler = handlers.get(event)
      if (!handler) throw new Error(`nothing is listening for ${event}`)
      handler(payload)
    },
    listening: () => [...handlers.keys()],
    plugin: {
      requestPermissions: async () => {
        order.push("requestPermissions")
        return { receive: permission }
      },
      register: async () => {
        order.push("register")
      },
      removeAllDeliveredNotifications: async () => {
        order.push("removeAllDeliveredNotifications")
      },
      addListener: async (event: string, handler: (payload: unknown) => void) => {
        order.push(`addListener:${event}`)
        handlers.set(event, handler)
        return { remove: async () => {} }
      },
    },
  }
}

function fakeFetch(calls: Call[], status = 201) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
      authorization: headers.get("authorization"),
    })
    return new Response(JSON.stringify({ data: { id: "row1" } }), {
      status,
      headers: { "content-type": "application/json" },
    })
  }
}

const SERVER = "https://liaison.example.com"

describe("the multi server flag on registration", () => {
  it("says whether the phone knows several servers, and says it again when the list changes", async () => {
    const calls: Call[] = []
    const native = fakePlugin()
    let servers = 1
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "android",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
      multiServer: async () => servers > 1,
    })
    await client.start()
    native.fire("registration", { value: "fcm-token-1" })
    await client.settled()
    const posts = () => calls.filter((c) => c.method === "POST").map((c) => c.body)
    expect(posts()).toEqual([{ platform: "android", token: "fcm-token-1", multiServer: false }])
    servers = 2
    await client.refreshRegistration()
    expect(posts().at(-1)).toEqual({ platform: "android", token: "fcm-token-1", multiServer: true })
    servers = 1
    await client.refreshRegistration()
    expect(posts().at(-1)).toEqual({
      platform: "android",
      token: "fcm-token-1",
      multiServer: false,
    })
  })
})

describe("push registration on launch", () => {
  let calls: Call[]
  beforeEach(() => {
    calls = []
  })

  it("registers the device token with the backend on the registration event", async () => {
    const native = fakePlugin()
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
    })
    expect(await client.start()).toBe("registering")

    native.fire("registration", { value: "device-token-1" })
    await client.settled()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${SERVER}${PUSH_TOKENS_PATH}`)
    expect(calls[0].method).toBe("POST")
    expect(calls[0].body).toEqual({ platform: "ios", token: "device-token-1" })
    expect(calls[0].authorization).toBe("Bearer bearer-abc")
  })

  it("listens for the registration event before it asks the platform to register", async () => {
    // register() can resolve with the token already delivered. A listener
    // attached afterwards misses exactly the cold start it exists for.
    const native = fakePlugin()
    await createPushClient({
      plugin: native.plugin,
      platform: () => "android",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
    }).start()
    expect(native.order.indexOf("addListener:registration")).toBeLessThan(
      native.order.indexOf("register"),
    )
    expect(native.order.indexOf("addListener:registrationError")).toBeLessThan(
      native.order.indexOf("register"),
    )
  })

  it("does not ask for permission before the server address is set", async () => {
    const native = fakePlugin()
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => null,
      fetchImpl: fakeFetch(calls),
    })
    expect(await client.start()).toBe("no-server")
    expect(native.order).toEqual([])
    expect(calls).toEqual([])
  })

  it("does not register before auth resolves", async () => {
    const native = fakePlugin()
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => null,
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
    })
    expect(await client.start()).toBe("not-authenticated")
    // The prompt is the irreversible part: iOS asks once per install.
    expect(native.order).toEqual([])
    expect(calls).toEqual([])
  })

  it("registers nothing on a platform that has no native push", async () => {
    const native = fakePlugin()
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "web",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
    })
    expect(await client.start()).toBe("unsupported-platform")
    expect(native.order).toEqual([])
  })

  it("does not register when permission is refused", async () => {
    const native = fakePlugin()
    native.setPermission("denied")
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
    })
    expect(await client.start()).toBe("permission-denied")
    expect(native.order).not.toContain("register")
    expect(calls).toEqual([])
  })

  it("re-registers when the platform hands back a different token", async () => {
    const native = fakePlugin()
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
    })
    await client.start()

    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    // The same token again is the normal case on every cold start: one row
    // per launch is one notification per launch on the same handset.
    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    expect(calls).toHaveLength(1)

    native.fire("registration", { value: "device-token-2" })
    await client.settled()
    expect(calls).toHaveLength(2)
    expect(calls[1].body).toEqual({ platform: "ios", token: "device-token-2" })
  })

  it("unregisters the token on logout", async () => {
    const native = fakePlugin()
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
    })
    await client.start()
    native.fire("registration", { value: "device-token-1" })
    await client.settled()

    await client.logout()
    expect(calls).toHaveLength(2)
    expect(calls[1].method).toBe("DELETE")
    expect(calls[1].body).toEqual({ platform: "ios", token: "device-token-1" })

    // Nothing left to delete: a second logout must not call again.
    await client.logout()
    expect(calls).toHaveLength(2)
  })

  it("keeps no token when the backend refuses the registration", async () => {
    // A refused POST that is remembered as registered means the retry on the
    // next launch never happens and the device is silently unreachable.
    const native = fakePlugin()
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls, 401),
    })
    await client.start()
    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    expect(client.registeredToken()).toBeNull()
    await client.logout()
    expect(calls).toHaveLength(1)
  })
})

describe("the boot sequence starts push", () => {
  it("starts push only after first launch has settled an address", async () => {
    const { startBoot } = await import("./main")
    const order: string[] = []
    await startBoot({
      queue: createDeepLinkQueue(() => {}),
      addUrlListener: () => {},
      whenAppReady: (cb) => cb(),
      firstLaunch: {
        start: async () => {
          order.push("first launch")
          return SERVER
        },
        boundAddress: async () => null,
        offerAddress: () => {},
      },
      startPush: async (address) => {
        order.push(`push:${address}`)
      },
    })
    expect(order).toEqual(["first launch", `push:${SERVER}`])
  })

  it("starts no push when there is no address yet", async () => {
    const { startBoot } = await import("./main")
    let started = false
    await startBoot({
      queue: createDeepLinkQueue(() => {}),
      addUrlListener: () => {},
      whenAppReady: (cb) => cb(),
      startPush: async () => {
        started = true
      },
    })
    expect(started).toBe(false)
  })
})

describe("the bearer comes from the bridge, never from a second refresh", () => {
  const REFRESH_URL = `${SERVER}/api/auth/refresh`

  it("makes no refresh call of its own, on any path through start", async () => {
    // The refresh token is single use and rotates. A refresh started here
    // races the app's own on every relaunch: one of the two gets a 401, and
    // the loser can be the app, which spends the session's token.
    const native = fakePlugin()
    const calls: Call[] = []
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
    })
    await client.start()
    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    await client.logout()
    expect(calls.map((c) => c.url)).not.toContain(REFRESH_URL)
  })

  it("registers after a login that happens long after boot, with no relaunch", async () => {
    // A first launch has no session: the bearer arrives when somebody signs
    // in. Sampling it once at boot is what left the prompt unasked forever.
    const native = fakePlugin()
    const calls: Call[] = []
    const tokens = createAccessTokenStore()
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => tokens.get(),
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
    })
    armPushRegistration({ accessTokens: tokens, start: () => client.start() })
    await client.settled()
    expect(native.order).toEqual([])

    tokens.set("bearer-from-login")
    await Promise.resolve()
    await Promise.resolve()
    await client.settled()
    expect(native.order).toContain("requestPermissions")
    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    expect(calls).toHaveLength(1)
    expect(calls[0].authorization).toBe("Bearer bearer-from-login")
  })

  it("re-asserts the registration under a rotated bearer, prompting only once", async () => {
    const native = fakePlugin()
    const calls: Call[] = []
    const tokens = createAccessTokenStore()
    tokens.set("bearer-one")
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => tokens.get(),
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
    })
    armPushRegistration({ accessTokens: tokens, start: () => client.start() })
    await client.settled()
    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    expect(calls).toHaveLength(1)

    tokens.set("bearer-two")
    await Promise.resolve()
    await Promise.resolve()
    await client.settled()
    expect(calls).toHaveLength(2)
    expect(calls[1].method).toBe("POST")
    expect(calls[1].authorization).toBe("Bearer bearer-two")
    expect(native.order.filter((entry) => entry === "requestPermissions")).toHaveLength(1)
    expect(native.listening()).toHaveLength(4)
  })

  it("takes the bearer the bridge read out of the login answer", async () => {
    const tokens = createAccessTokenStore()
    const bridged = installRefreshBridge({
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: { accessToken: "from-login", refreshToken: "rt" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      serverOrigin: () => SERVER,
      store: { load: async () => null, save: async () => {}, clear: async () => {} },
      accessTokens: tokens,
    })
    await bridged(`${SERVER}/api/auth/login`, { method: "POST" })
    expect(tokens.get()).toBe("from-login")
  })

  it("revokes this device push row on the way out of the session", async () => {
    // A row left behind keeps every push for the user who signed out landing
    // on the handset, including a readable title and body. The DELETE is
    // authenticated with the bearer the sign-out is about to drop, so the
    // order is the whole fix: run after the store is nulled, the call is
    // gated out (callTokens bails on a null bearer) and nothing is sent.
    const native = fakePlugin()
    const calls: Call[] = []
    const tokens = createAccessTokenStore()
    tokens.set("bearer-one")
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => tokens.get(),
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
    })
    // The SHELL's own hook registry, the one main.ts hands in: arming the
    // registration is what registers the revocation, so there is no wiring
    // for a later change to leave out.
    const hooks = new Set<() => Promise<void>>()
    armPushRegistration({
      accessTokens: tokens,
      start: () => client.start(),
      stop: () => client.logout(),
      onSessionEnd: (handler) => {
        hooks.add(handler)
        return () => {
          hooks.delete(handler)
        }
      },
    })
    await client.settled()
    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    expect(client.registeredToken()).toBe("device-token-1")
    expect(hooks.size).toBe(1)

    const bridged = installRefreshBridge({
      fetchImpl: fakeFetch(calls, 200),
      serverOrigin: () => SERVER,
      store: { load: async () => "rt", save: async () => {}, clear: async () => {} },
      accessTokens: tokens,
      onSessionEnd: async () => {
        for (const handler of hooks) await handler()
      },
    })
    await bridged(`${SERVER}/api/auth/logout`, { method: "POST" })

    const deletes = calls.filter((call) => call.method === "DELETE")
    expect(deletes).toHaveLength(1)
    expect(deletes[0].url).toBe(`${SERVER}${PUSH_TOKENS_PATH}`)
    expect(deletes[0].body).toEqual({ platform: "ios", token: "device-token-1" })
    expect(deletes[0].authorization).toBe("Bearer bearer-one")
    expect(tokens.get()).toBeNull()
  })

  it("forgets the bearer when a refused refresh ends the session", async () => {
    // A session can end without a sign-out: an invalid refresh token posts no
    // logout at all, and the bearer it minted stayed in memory behind a shell
    // that believed somebody was still signed in.
    const tokens = createAccessTokenStore()
    tokens.set("from-login")
    const bridged = installRefreshBridge({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: "invalid_session" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      serverOrigin: () => SERVER,
      store: { load: async () => "rt", save: async () => {}, clear: async () => {} },
      accessTokens: tokens,
    })
    const response = await bridged(`${SERVER}/api/auth/refresh`, { method: "POST" })
    expect(response.status).toBe(401)
    expect(tokens.get()).toBeNull()
  })

  it("forgets the bearer when the session ends", async () => {
    const tokens = createAccessTokenStore()
    tokens.set("from-login")
    const bridged = installRefreshBridge({
      fetchImpl: async () => new Response("", { status: 200 }),
      serverOrigin: () => SERVER,
      store: { load: async () => "rt", save: async () => {}, clear: async () => {} },
      accessTokens: tokens,
    })
    await bridged(`${SERVER}/api/auth/logout`, { method: "POST" })
    expect(tokens.get()).toBeNull()
  })
})

describe("a push tap opens the thread", () => {
  function client(routed: string[]) {
    const native = fakePlugin()
    const queue = createDeepLinkQueue((routePath) => routed.push(routePath))
    queue.markAppReady()
    return {
      native,
      client: createPushClient({
        plugin: native.plugin,
        platform: () => "ios",
        accessToken: async () => "bearer-abc",
        serverAddress: async () => SERVER,
        fetchImpl: fakeFetch([]),
        queue,
      }),
    }
  }

  it("navigates to the thread the payload names", async () => {
    const routed: string[] = []
    const { native, client: push } = client(routed)
    await push.start()
    native.fire("pushNotificationActionPerformed", {
      notification: {
        data: { type: "message", threadId: "abc123", deepLink: "liaison://thread/abc123" },
      },
    })
    expect(routed).toEqual(["/threads/abc123"])
  })

  it("routes a tap through the same fail closed handler an external link uses", async () => {
    // The payload arrives from a third party service. A deep link built out of
    // it and trusted is a router fed by whoever can send this device a push.
    const routed: string[] = []
    const { native, client: push } = client(routed)
    await push.start()
    for (const data of [
      { deepLink: "liaison://thread/../../settings" },
      { deepLink: "https://evil.example.com/threads/abc" },
      { deepLink: "javascript:alert(1)" },
      { threadId: "../../settings" },
      { threadId: "a b" },
      {},
      null,
    ]) {
      native.fire("pushNotificationActionPerformed", { notification: { data } })
    }
    expect(routed).toEqual([])
  })

  it("opens a thread-less attention item (an approval) through its route (LIF-18)", async () => {
    const routed: string[] = []
    const { native, client: push } = client(routed)
    await push.start()
    const route = "attention/kernel/approval_request/5f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
    native.fire("pushNotificationActionPerformed", {
      notification: {
        data: { type: "attention", threadId: "", deepLink: `liaison://${route}`, route },
      },
    })
    // A server that still sends the bare `liaison://attention` link names the route beside it.
    native.fire("pushNotificationActionPerformed", {
      notification: {
        data: { type: "attention", threadId: "", deepLink: "liaison://attention", route },
      },
    })
    // A hostile route is dropped by the same parser.
    native.fire("pushNotificationActionPerformed", {
      notification: {
        data: { type: "attention", deepLink: "liaison://attention", route: "attention/x/y/../" },
      },
    })
    expect(routed).toEqual([
      `/?route=${encodeURIComponent(route)}`,
      `/?route=${encodeURIComponent(route)}`,
    ])
  })

  it("opens a task comment's push on the task, with the message to bring into view", async () => {
    const routed: string[] = []
    const { native, client: push } = client(routed)
    await push.start()
    const thread = "5f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
    const message = "6a2d3b4c-5e6f-4a71-8b2c-3d4e5f6a7b8c"
    const route = "attention/projects/task/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
    native.fire("pushNotificationActionPerformed", {
      notification: {
        data: {
          type: "mention",
          threadId: thread,
          deepLink: `liaison://${route}`,
          route,
          messageId: message,
        },
      },
    })
    expect(routed).toEqual([
      `/?route=${encodeURIComponent(`${route}?thread=${thread}&message=${message}`)}`,
    ])
  })

  it("falls back to the threadId when the payload carries no deep link", async () => {
    const routed: string[] = []
    const { native, client: push } = client(routed)
    await push.start()
    native.fire("pushNotificationActionPerformed", {
      notification: { data: { type: "mention", threadId: "xyz789" } },
    })
    expect(routed).toEqual(["/threads/xyz789"])
  })

  // P4 (C9): a node session push opens that session.
  it("routes a node_session push to /sessions/<id> through the queue", async () => {
    const routed: string[] = []
    const { native, client: push } = client(routed)
    await push.start()
    native.fire("pushNotificationActionPerformed", {
      notification: {
        data: {
          type: "node_session",
          sessionId: "sess-1",
          deepLink: "liaison://session/sess-1",
        },
      },
    })
    expect(routed).toEqual(["/sessions/sess-1"])
  })

  it("routes a payload with only a sessionId the same", async () => {
    const routed: string[] = []
    const { native, client: push } = client(routed)
    await push.start()
    native.fire("pushNotificationActionPerformed", {
      notification: { data: { type: "node_session", sessionId: "sess-2" } },
    })
    native.fire("pushNotificationActionPerformed", {
      notification: { data: { type: "node_session", sessionId: "../../settings" } },
    })
    expect(routed).toEqual(["/sessions/sess-2"])
  })

  it("holds a tap taken during a cold start until the app can route", async () => {
    // The tap that launches the app is delivered while the web app is still
    // booting. Handled where it arrives, it is handled into nothing.
    const routed: string[] = []
    const native = fakePlugin()
    const queue = createDeepLinkQueue((routePath) => routed.push(routePath))
    const push = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch([]),
      queue,
    })
    await push.start()
    native.fire("pushNotificationActionPerformed", {
      notification: { data: { deepLink: "liaison://thread/cold1" } },
    })
    expect(routed).toEqual([])
    queue.markAppReady()
    expect(routed).toEqual(["/threads/cold1"])
  })
})

describe("a push that arrives with the app open, no native presenter (Android)", () => {
  // The notice lives on documentElement, outside body, so it survives a
  // body reset and would be found by any later test looking for a control.
  afterEach(() => {
    document.getElementById(PUSH_NOTICE_ID)?.remove()
  })

  function open(routed: string[] = [], threadOnScreen?: () => string | null) {
    const native = fakePlugin()
    const badges: number[] = []
    const queue = createDeepLinkQueue((routePath) => routed.push(routePath))
    queue.markAppReady()
    return {
      native,
      badges,
      client: createPushClient({
        plugin: native.plugin,
        platform: () => "ios",
        accessToken: async () => "bearer-abc",
        serverAddress: async () => SERVER,
        fetchImpl: fakeFetch([]),
        queue,
        setBadge: (count: number) => badges.push(count),
        document,
        ...(threadOnScreen ? { threadOnScreen } : {}),
      }),
    }
  }

  it("raises no notice for the conversation on screen, and still applies the badge", async () => {
    // The user is reading that conversation: the message is already in front
    // of them, and a banner announcing it covered the screen they were on.
    const { native, badges, client: push } = open([], () => "abc123")
    await push.start()
    native.fire("pushNotificationReceived", {
      data: { threadId: "abc123", badgeCount: 2, title: "Ops", body: "cf pj" },
    })
    expect(document.getElementById(PUSH_NOTICE_ID)).toBeNull()
    expect(badges).toEqual([2])
  })

  it("still raises the notice for any other conversation while one is on screen", async () => {
    const { native, client: push } = open([], () => "abc123")
    await push.start()
    native.fire("pushNotificationReceived", {
      data: { threadId: "other456", badgeCount: 1, title: "Ops", body: "hello" },
    })
    expect(document.getElementById(PUSH_NOTICE_ID)?.textContent).toContain("hello")
  })

  it("shows an in app notice carrying the payload text and applies the badge count", async () => {
    const { native, badges, client: push } = open()
    await push.start()
    native.fire("pushNotificationReceived", {
      data: {
        type: "message",
        threadId: "abc123",
        deepLink: "liaison://thread/abc123",
        badgeCount: 4,
        title: "Shipping",
        body: "the labels are printed",
      },
    })
    const notice = document.getElementById(PUSH_NOTICE_ID)
    expect(notice).not.toBeNull()
    expect(notice?.textContent).toContain("Shipping")
    expect(notice?.textContent).toContain("the labels are printed")
    expect(badges).toEqual([4])
  })

  it("shows the generic wording for a redacted payload", async () => {
    // A scope tagged message carries no title and no body by design
    // (apps/api/src/modules/push/redact.ts). The notice must say a message
    // exists without inventing any of its text.
    const { native, client: push } = open()
    await push.start()
    native.fire("pushNotificationReceived", {
      data: {
        type: "message",
        threadId: "abc123",
        deepLink: "liaison://thread/abc123",
        badgeCount: 1,
      },
    })
    const notice = document.getElementById(PUSH_NOTICE_ID)
    expect(notice?.textContent).toContain(PUSH_NOTICE_FALLBACK)
  })

  it("asks the platform for nothing else, so no second banner is shown", async () => {
    // Without a native presenter the OS raises nothing for a foregrounded
    // app, so the in app notice IS the notification. A client that also
    // scheduled a local one would show the user two of everything.
    const { native, client: push } = open()
    await push.start()
    const before = [...native.order]
    native.fire("pushNotificationReceived", {
      data: { threadId: "abc123", badgeCount: 1 },
    })
    expect(native.order).toEqual(before)
  })

  it("replaces the notice rather than stacking one per push", async () => {
    const { native, client: push } = open()
    await push.start()
    for (const badgeCount of [1, 2, 3]) {
      native.fire("pushNotificationReceived", { data: { threadId: "abc123", badgeCount } })
    }
    expect(document.querySelectorAll(`#${PUSH_NOTICE_ID}`)).toHaveLength(1)
  })

  it("opens the thread when the notice is tapped, through the same handler", async () => {
    const routed: string[] = []
    const { native, client: push } = open(routed)
    await push.start()
    native.fire("pushNotificationReceived", {
      data: { threadId: "abc123", deepLink: "liaison://thread/abc123", badgeCount: 1 },
    })
    const notice = document.getElementById(PUSH_NOTICE_ID) as HTMLElement
    notice.click()
    expect(routed).toEqual(["/threads/abc123"])
    // Tapped and gone: a notice about a thread the user is now reading is noise.
    expect(document.getElementById(PUSH_NOTICE_ID)).toBeNull()
  })

  // Regression smoke 0759b0f89 (2026-10-08): the notice had no end. On the
  // simulator it sat over the header (and its back button) for minutes until
  // tapped, through every later screen.
  it("the notice goes away by itself after a few seconds, like the system banner", async () => {
    const native = fakePlugin()
    const timers: Array<{ run: () => void; ms: number }> = []
    const queue = createDeepLinkQueue(() => {})
    queue.markAppReady()
    const push = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch([]),
      queue,
      setBadge: () => {},
      document,
      schedule: (run, ms) => {
        timers.push({ run, ms })
        return () => {}
      },
    })
    await push.start()
    native.fire("pushNotificationReceived", { data: { threadId: "abc123", badgeCount: 1 } })
    expect(document.getElementById(PUSH_NOTICE_ID)).not.toBeNull()
    const dismiss = timers.find((t) => t.ms === PUSH_NOTICE_MS)
    expect(dismiss).toBeDefined()
    dismiss?.run()
    expect(document.getElementById(PUSH_NOTICE_ID)).toBeNull()
  })

  it("applies no badge count the payload did not carry", async () => {
    const { native, badges, client: push } = open()
    await push.start()
    native.fire("pushNotificationReceived", { data: { threadId: "abc123" } })
    expect(badges).toEqual([])
  })
})

describe("iOS: the system banner presents a push that lands with the app open", () => {
  // TestFlight build 17 (2026-10-12): "Send me a test" with the app open
  // raised Liaison's own strip and no iOS banner, and the receipt still said
  // `shown`. On iOS the native presenter (ForegroundPushPresenter.swift)
  // decides and iOS draws the banner; the web app only reports the decision.
  const NID = "6f1d2c3b-0000-4000-8000-0000000000bb"

  afterEach(() => {
    document.getElementById(PUSH_NOTICE_ID)?.remove()
  })

  async function ios() {
    const native = fakePlugin()
    const badges: number[] = []
    const calls: Call[] = []
    let presented: ((event: unknown) => void) | null = null
    const receiptNative = createMemoryReceiptNative()
    await receiptNative.setCredential(SERVER, { credential: "lnr_one", deviceId: "device-row-1" })
    const fetchImpl = fakeFetch(calls)
    const push = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl,
      receipts: createReceiptClient({ native: receiptNative, fetchImpl }),
      setBadge: (count: number) => badges.push(count),
      document,
      threadOnScreen: () => null,
      onPresentation: (handler) => {
        presented = handler
      },
    })
    await push.start()
    const receipts = () => calls.filter((c) => c.url.endsWith(RECEIPTS_PATH)).map((c) => c.body)
    return {
      native,
      badges,
      push,
      receipts,
      present: (event: unknown) => {
        if (!presented) throw new Error("nothing is listening for the native presentation")
        presented(event)
      },
    }
  }

  it("raises no in-app notice and guesses no outcome: the badge is still applied", async () => {
    const { native, badges, push, receipts } = await ios()
    native.fire("pushNotificationReceived", {
      data: { notificationId: NID, threadId: "t-other", badgeCount: 3, title: "Ops", body: "hi" },
    })
    await push.settled()
    expect(document.getElementById(PUSH_NOTICE_ID)).toBeNull()
    expect(badges).toEqual([3])
    expect(receipts()).toEqual([])
  })

  it("posts the banner the native presenter showed as `shown`, app in the foreground", async () => {
    const { push, receipts, present } = await ios()
    present({ outcome: "shown", data: { notificationId: NID, threadId: "", server: SERVER } })
    await push.settled()
    expect(receipts()).toEqual([
      { notificationId: NID, outcome: "shown", appState: "foreground", deviceId: "device-row-1" },
    ])
  })

  it("posts the push it held back for the conversation on screen as `suppressed/on_screen`", async () => {
    const { push, receipts, present } = await ios()
    present({
      outcome: "suppressed",
      reason: "on_screen",
      data: { notificationId: NID, threadId: "t-open" },
    })
    await push.settled()
    expect(receipts()).toEqual([
      {
        notificationId: NID,
        outcome: "suppressed",
        reason: "on_screen",
        appState: "foreground",
        deviceId: "device-row-1",
      },
    ])
  })

  it("does not report a banner shown in the foreground again as a background one", async () => {
    // `.list` leaves the banner in the notification centre, and the next
    // return to the app reads that centre for pushes presented while away.
    const { native, push, receipts, present } = await ios()
    ;(native.plugin as PushPlugin).getDeliveredNotifications = async () => ({
      notifications: [{ data: { notificationId: NID, threadId: "t-other" } }],
    })
    present({ outcome: "shown", data: { notificationId: NID, threadId: "t-other" } })
    await push.settled()
    await push.foreground()
    expect(receipts().map((r) => (r as { appState: string }).appState)).toEqual(["foreground"])
  })
})

describe("the token carries its APNs environment (S11)", () => {
  let calls: Call[]
  beforeEach(() => {
    calls = []
  })

  function registered(platform: string, environment: () => Promise<string | null>) {
    const native = fakePlugin()
    const asked: string[] = []
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => platform,
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
      apsEnvironment: async () => {
        asked.push("apsEnvironment")
        return (await environment()) as "sandbox" | "production" | null
      },
    })
    return { native, client, asked }
  }

  it("posts the build's APNs environment with an iOS token", async () => {
    const { native, client } = registered("ios", async () => "sandbox")
    await client.start()
    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    expect(calls[0].body).toEqual({
      platform: "ios",
      token: "device-token-1",
      environment: "sandbox",
    })
  })

  it("sends no environment for an Android token", async () => {
    const { native, client, asked } = registered("android", async () => "production")
    await client.start()
    native.fire("registration", { value: "fcm-token-1" })
    await client.settled()
    expect(calls[0].body).toEqual({ platform: "android", token: "fcm-token-1" })
    expect(asked).toEqual([])
  })

  it("sends no environment when the native side cannot say, and still registers", async () => {
    const { native, client } = registered("ios", async () => {
      throw new Error("plugin missing")
    })
    await client.start()
    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    expect(calls[0].body).toEqual({ platform: "ios", token: "device-token-1" })
    expect(client.registeredToken()).toBe("device-token-1")
  })
})

describe("coming back to the foreground (S10, S12)", () => {
  let calls: Call[]
  beforeEach(() => {
    calls = []
  })

  function foregrounded() {
    const native = fakePlugin()
    const badges: number[] = []
    let onActive: (() => void) | null = null
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
      setBadge: (count: number) => badges.push(count),
      onForeground: (handler) => {
        onActive = handler
      },
    })
    return {
      native,
      badges,
      client,
      activate: async () => {
        if (onActive === null) throw new Error("nothing is listening for the foreground")
        onActive()
        await client.settled()
      },
    }
  }

  it("re-registers the same token on every foreground, so a row deleted server side comes back", async () => {
    const { native, client, activate } = foregrounded()
    await client.start()
    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    expect(calls).toHaveLength(1)

    await activate()
    await activate()
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.method).toBe("POST")
      expect(call.body).toEqual({ platform: "ios", token: "device-token-1" })
    }
  })

  it("clears the badge and the delivered notifications on foreground", async () => {
    const { native, badges, client, activate } = foregrounded()
    await client.start()
    await activate()
    expect(native.order).toContain("removeAllDeliveredNotifications")
    expect(badges).toEqual([0])
  })

  it("registers nothing on foreground before anybody is signed in or a token exists", async () => {
    const { native, client, activate } = foregrounded()
    await activate()
    expect(calls).toEqual([])
    expect(native.order).not.toContain("requestPermissions")
    await client.start()
    await activate()
    expect(calls).toEqual([])
  })

  it("survives a plugin that refuses to clear the delivered notifications", async () => {
    const { native, badges, client, activate } = foregrounded()
    native.plugin.removeAllDeliveredNotifications = async () => {
      throw new Error("capacitorDidRegisterForRemoteNotifications not called")
    }
    await client.start()
    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    await activate()
    expect(badges).toEqual([0])
    expect(calls).toHaveLength(2)
  })
})

// Rule 5, read once, read everywhere: opening the app withdraws only the
// notifications of conversations read on another device, and the badge takes
// the server's number instead of zero.
describe("foreground with a plugin that removes delivered notifications one by one", () => {
  // What the phone holds: a channel message read elsewhere, a reply in that
  // channel still unread (its threadId is the channel's), a message of a
  // task's thread still unread, an approval decided elsewhere, a critical
  // alert still open, a push from before the settle key existed, and another
  // server's push.
  const delivered = [
    { id: "n-read", data: { threadId: "t-chan", settle: "message/m-read" } },
    {
      id: "n-reply",
      data: { threadId: "t-chan", replyRootId: "m-root", settle: "message/m-reply" },
    },
    { id: "n-task", data: { threadId: "t-task", settle: "message/m-task" } },
    {
      id: "n-approval",
      data: {
        route: "attention/kernel/approval_request/a1",
        settle: "attention/kernel/approval_request/a1",
      },
    },
    { id: "n-alert", data: { settle: "attention/monitoring/incident/i1" } },
    { id: "n-old", data: { threadId: "t-chan" } },
    {
      id: "n-elsewhere",
      data: { threadId: "t-x", settle: "message/m-x", server: "https://other.example.com" },
    },
  ]

  function setup(answer: (asked: string[]) => { status: number; body: unknown }) {
    const native = fakePlugin()
    const removed: Array<{ id?: string }> = []
    const badges: number[] = []
    const asked: string[][] = []
    let onActive: (() => void) | null = null
    const plugin = {
      ...native.plugin,
      getDeliveredNotifications: async () => ({ notifications: delivered }),
      removeDeliveredNotifications: async (d: { notifications: Array<{ id?: string }> }) => {
        removed.push(...d.notifications)
      },
    }
    const client = createPushClient({
      plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: async (input: string, init?: RequestInit) => {
        if (String(input).endsWith(BADGE_PATH)) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { settle?: string[] }
          asked.push(body.settle ?? [])
          const reply = answer(body.settle ?? [])
          return new Response(JSON.stringify(reply.body), {
            status: reply.status,
            headers: { "content-type": "application/json" },
          })
        }
        return new Response(JSON.stringify({ data: { id: "row1" } }), { status: 201 })
      },
      setBadge: (count: number) => badges.push(count),
      onForeground: (handler) => {
        onActive = handler
      },
    })
    return {
      native,
      removed,
      badges,
      asked,
      client,
      activate: async () => {
        ;(onActive as unknown as () => void)()
        await client.settled()
      },
    }
  }

  it("asks the server about each notification's own key, this server's only", async () => {
    const s = setup(() => ({ status: 200, body: { data: { count: 3, settled: [] } } }))
    await s.client.start()
    await s.activate()
    expect(s.asked).toEqual([
      [
        "message/m-read",
        "message/m-reply",
        "message/m-task",
        "attention/kernel/approval_request/a1",
        "attention/monitoring/incident/i1",
      ],
    ])
    expect(s.removed).toEqual([])
    expect(s.badges).toEqual([3])
  })

  it("withdraws exactly what the server says was read or resolved, never a reply of a read channel", async () => {
    const s = setup(() => ({
      status: 200,
      body: {
        data: { count: 2, settled: ["message/m-read", "attention/kernel/approval_request/a1"] },
      },
    }))
    await s.client.start()
    await s.activate()
    expect(s.removed.map((n) => n.id)).toEqual(["n-read", "n-approval"])
    expect(s.native.order).not.toContain("removeAllDeliveredNotifications")
    expect(s.badges).toEqual([2])
  })

  it("withdraws a thread-less critical alert once it is read", async () => {
    const s = setup(() => ({
      status: 200,
      body: { data: { count: 0, settled: ["attention/monitoring/incident/i1"] } },
    }))
    await s.client.start()
    await s.activate()
    expect(s.removed.map((n) => n.id)).toEqual(["n-alert"])
  })

  it("leaves everything as it is when the server cannot answer", async () => {
    const s = setup(() => ({ status: 503, body: {} }))
    await s.client.start()
    await s.activate()
    expect(s.removed).toEqual([])
    expect(s.native.order).not.toContain("removeAllDeliveredNotifications")
    expect(s.badges).toEqual([])
  })
})

describe("a push from another server (payload `server`)", () => {
  afterEach(() => {
    document.getElementById(PUSH_NOTICE_ID)?.remove()
  })

  async function tapped(openOnServer?: (server: string, link: string) => Promise<unknown>) {
    const routed: string[] = []
    const native = fakePlugin()
    const queue = createDeepLinkQueue((routePath) => routed.push(routePath))
    queue.markAppReady()
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => `${SERVER}/`,
      fetchImpl: fakeFetch([]),
      queue,
      document,
      ...(openOnServer ? { openOnServer } : {}),
    })
    await client.start()
    return { routed, native }
  }

  it("ignores a tap whose payload names another server", async () => {
    const data = {
      threadId: "abc123",
      deepLink: "liaison://thread/abc123",
      server: "https://other.example.com",
    }
    const { routed, native } = await tapped()
    native.fire("pushNotificationActionPerformed", { notification: { data } })
    expect(routed).toEqual([])
  })

  it("a tap on another signed-in server's notification opens that server on the item", async () => {
    const opened: Array<[string, string]> = []
    const data = {
      threadId: "abc123",
      deepLink: "liaison://thread/abc123",
      server: "https://other.example.com",
    }
    const { routed, native } = await tapped(async (server, link) => {
      opened.push([server, link])
    })
    native.fire("pushNotificationActionPerformed", { notification: { data } })
    // Never routed against THIS server: the item belongs to the other one.
    expect(routed).toEqual([])
    expect(opened).toEqual([["https://other.example.com", "liaison://thread/abc123"]])
  })

  it("another server's in app notice names its organisation and opens that server", async () => {
    const opened: Array<[string, string]> = []
    const data = {
      threadId: "abc123",
      deepLink: "liaison://thread/abc123",
      title: "Alice",
      body: "hello",
      serverLabel: "Globex",
      server: "https://other.example.com",
    }
    const { routed, native } = await tapped(async (server, link) => {
      opened.push([server, link])
    })
    native.fire("pushNotificationReceived", { data })
    const notice = document.getElementById(PUSH_NOTICE_ID) as HTMLButtonElement
    expect(notice.textContent).toBe("Globex: Alice: hello")
    notice.click()
    expect(routed).toEqual([])
    expect(opened).toEqual([["https://other.example.com", "liaison://thread/abc123"]])
  })

  it("ignores a session push tap whose payload names another server", async () => {
    const data = {
      type: "node_session",
      sessionId: "sess-1",
      deepLink: "liaison://session/sess-1",
      server: "https://other.example.com",
    }
    const { routed, native } = await tapped()
    native.fire("pushNotificationActionPerformed", { notification: { data } })
    native.fire("pushNotificationActionPerformed", {
      notification: { data: { sessionId: "sess-1", server: "https://other.example.com" } },
    })
    expect(routed).toEqual([])
  })

  it("routes a tap whose payload names this server", async () => {
    const data = { threadId: "abc123", deepLink: "liaison://thread/abc123", server: SERVER }
    const { routed, native } = await tapped()
    native.fire("pushNotificationActionPerformed", { notification: { data } })
    expect(routed).toEqual(["/threads/abc123"])
  })

  it("routes a tap from a server that names no origin yet", async () => {
    const data = { threadId: "abc123", deepLink: "liaison://thread/abc123" }
    const { routed, native } = await tapped()
    native.fire("pushNotificationActionPerformed", { notification: { data } })
    expect(routed).toEqual(["/threads/abc123"])
  })

  it("ignores a tap whose server is not an origin at all", async () => {
    const data = { threadId: "abc123", deepLink: "liaison://thread/abc123", server: "not a url" }
    const { routed, native } = await tapped()
    native.fire("pushNotificationActionPerformed", { notification: { data } })
    expect(routed).toEqual([])
  })

  it("ignores a tap on the in app notice of a push from another server", async () => {
    const data = {
      threadId: "abc123",
      deepLink: "liaison://thread/abc123",
      title: "t",
      server: "https://other.example.com",
    }
    const { routed, native } = await tapped()
    native.fire("pushNotificationReceived", { data })
    ;(document.getElementById(PUSH_NOTICE_ID) as HTMLButtonElement).click()
    expect(routed).toEqual([])
  })
})

describe("delivery receipts and registration retries (S2, S3, A3, A7)", () => {
  const NID = "6f1d2c3b-0000-4000-8000-0000000000aa"

  /** A fetch that answers each call from a script, recording what it sent. */
  function scripted(answers: Array<number | "offline">, credential = "lnr_one") {
    const calls: Call[] = []
    let next = 0
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
        authorization: headers.get("authorization"),
      })
      const answer = answers[Math.min(next++, answers.length - 1)]
      if (answer === "offline") throw new TypeError("offline")
      return new Response(
        JSON.stringify({ data: { id: "device-row-1", receiptCredential: credential } }),
        { status: answer, headers: { "content-type": "application/json" } },
      )
    }
    return { calls, fetchImpl }
  }

  /** A hand-cranked timer: the test decides when a scheduled retry runs. */
  function manualTimers() {
    const pending: Array<{ ms: number; run: () => void; cancelled: boolean }> = []
    return {
      pending,
      schedule: (run: () => void, ms: number) => {
        const entry = { ms, run, cancelled: false }
        pending.push(entry)
        return () => {
          entry.cancelled = true
        }
      },
      fireNext: () => {
        const entry = pending.find((p) => !p.cancelled)
        if (!entry) throw new Error("no retry is scheduled")
        entry.cancelled = true
        entry.run()
      },
      live: () => pending.filter((p) => !p.cancelled).map((p) => p.ms),
    }
  }

  function client(
    overrides: Partial<Parameters<typeof createPushClient>[0]> & {
      answers?: Array<number | "offline">
    } = {},
  ) {
    const native = fakePlugin()
    const receiptNative = createMemoryReceiptNative()
    const net = scripted(overrides.answers ?? [201])
    const timers = manualTimers()
    const push = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => "bearer-abc",
      serverAddress: async () => SERVER,
      fetchImpl: net.fetchImpl,
      receipts: createReceiptClient({ native: receiptNative, fetchImpl: net.fetchImpl }),
      schedule: timers.schedule,
      document,
      ...overrides,
    })
    return { native, receiptNative, net, timers, push }
  }

  afterEach(() => {
    document.getElementById(PUSH_NOTICE_ID)?.remove()
  })

  it("stores the receipt credential the registration answer carries, under the server origin", async () => {
    const { native, receiptNative, push } = client()
    await push.start()
    native.fire("registration", { value: "device-token-1" })
    await push.settled()
    expect(await receiptNative.getCredential(SERVER)).toEqual({
      credential: "lnr_one",
      deviceId: "device-row-1",
    })
  })

  it("posts `shown` from the presentation delegate for a push it presents", async () => {
    const { native, net, push } = client()
    await push.start()
    native.fire("registration", { value: "device-token-1" })
    await push.settled()
    native.fire("pushNotificationReceived", {
      data: { notificationId: NID, threadId: "t-other", server: SERVER, title: "Ops" },
    })
    await push.settled()
    const receipt = net.calls.find((c) => c.url.endsWith(RECEIPTS_PATH))
    expect(receipt?.url).toBe(`${SERVER}${RECEIPTS_PATH}`)
    expect(receipt?.authorization).toBe("Bearer lnr_one")
    expect(receipt?.body).toEqual({
      notificationId: NID,
      outcome: "shown",
      appState: "foreground",
      deviceId: "device-row-1",
    })
  })

  it("posts `suppressed/on_screen` for the conversation on screen", async () => {
    const { native, net, push } = client({ threadOnScreen: () => "t-open" })
    await push.start()
    native.fire("registration", { value: "device-token-1" })
    await push.settled()
    native.fire("pushNotificationReceived", { data: { notificationId: NID, threadId: "t-open" } })
    await push.settled()
    const receipt = net.calls.find((c) => c.url.endsWith(RECEIPTS_PATH))
    expect(receipt?.body).toEqual({
      notificationId: NID,
      outcome: "suppressed",
      reason: "on_screen",
      appState: "foreground",
      deviceId: "device-row-1",
    })
  })

  it("posts no receipt for a payload without a notificationId", async () => {
    const { native, net, push } = client()
    await push.start()
    native.fire("registration", { value: "device-token-1" })
    await push.settled()
    native.fire("pushNotificationReceived", { data: { threadId: "t1", title: "x" } })
    await push.settled()
    expect(net.calls.filter((c) => c.url.endsWith(RECEIPTS_PATH))).toEqual([])
  })

  it("retries a failed registration POST on the backoff schedule until it is accepted", async () => {
    const { native, net, timers, push } = client({ answers: [503, "offline", 201] })
    await push.start()
    native.fire("registration", { value: "device-token-1" })
    await push.settled()
    expect(push.registeredToken()).toBeNull()
    expect(timers.live()).toEqual([2_000])

    timers.fireNext()
    await push.settled()
    expect(push.registeredToken()).toBeNull()
    expect(timers.live()).toEqual([4_000])

    timers.fireNext()
    await push.settled()
    expect(push.registeredToken()).toBe("device-token-1")
    expect(timers.live()).toEqual([])
    const posts = net.calls.filter((c) => c.url.endsWith(PUSH_TOKENS_PATH))
    expect(posts.map((c) => c.method)).toEqual(["POST", "POST", "POST"])
  })

  it("starts the schedule over after a success", async () => {
    let onActive: (() => void) | null = null
    const { native, timers, push } = client({
      answers: [503, 201, 503],
      onForeground: (handler) => {
        onActive = handler
      },
    })
    await push.start()
    native.fire("registration", { value: "device-token-1" })
    await push.settled()
    timers.fireNext()
    await push.settled()
    expect(push.registeredToken()).toBe("device-token-1")
    // The next failure (a foreground re-assertion) waits 2 s again, not 4 s.
    ;(onActive as unknown as () => void)()
    await push.settled()
    expect(timers.live()).toEqual([2_000])
  })

  it("does not retry a refusal that will not change (403)", async () => {
    const { native, timers, push } = client({ answers: [403] })
    await push.start()
    native.fire("registration", { value: "device-token-1" })
    await push.settled()
    expect(timers.live()).toEqual([])
  })

  it("the debug toggle fails the next register POST without sending it, and the retry registers (M5)", async () => {
    let forced = 1
    const { native, net, timers, push } = client({
      forceRegisterFailure: async () => forced-- > 0,
    })
    await push.start()
    native.fire("registration", { value: "device-token-1" })
    await push.settled()
    expect(net.calls.filter((c) => c.url.endsWith(PUSH_TOKENS_PATH))).toEqual([])
    expect(push.registeredToken()).toBeNull()
    expect(timers.live()).toEqual([2_000])

    timers.fireNext()
    await push.settled()
    expect(push.registeredToken()).toBe("device-token-1")
    expect(net.calls.filter((c) => c.url.endsWith(PUSH_TOKENS_PATH))).toHaveLength(1)
  })

  it("logout cancels a pending retry and forgets this server's credential", async () => {
    const { native, receiptNative, timers, push } = client({ answers: [201] })
    await push.start()
    native.fire("registration", { value: "device-token-1" })
    await push.settled()
    expect(await receiptNative.getCredential(SERVER)).not.toBeNull()
    await push.logout()
    expect(await receiptNative.getCredential(SERVER)).toBeNull()
    expect(timers.live()).toEqual([])
  })

  it("logout cancels a retry that is still waiting", async () => {
    const { native, timers, push } = client({ answers: [503] })
    await push.start()
    native.fire("registration", { value: "device-token-1" })
    await push.settled()
    expect(timers.live()).toEqual([2_000])
    await push.logout()
    expect(timers.live()).toEqual([])
  })

  it("on foreground, posts `shown` for what the OS presented, before clearing it, and flushes the queue", async () => {
    let onActive: (() => void) | null = null
    const N2 = "6f1d2c3b-0000-4000-8000-0000000000bb"
    const base = fakePlugin()
    const plugin = {
      ...base.plugin,
      getDeliveredNotifications: async () => {
        base.order.push("getDeliveredNotifications")
        return {
          notifications: [
            { id: "1", data: { notificationId: NID, server: SERVER, threadId: "t1" } },
            { id: "2", data: { threadId: "no-id" } },
          ],
        }
      },
    }
    const { net, push, receiptNative } = client({
      plugin,
      onForeground: (handler) => {
        onActive = handler
      },
    })
    await push.start()
    base.fire("registration", { value: "device-token-1" })
    await push.settled()
    // What the NSE left in the App Group while the phone was offline.
    await receiptNative.enqueue({
      origin: SERVER,
      notificationId: N2,
      outcome: "received",
      queuedAt: Date.now(),
    })

    ;(onActive as unknown as () => void)()
    await push.settled()

    const receipts = net.calls.filter((c) => c.url.endsWith(RECEIPTS_PATH))
    expect(receipts.map((c) => c.body)).toContainEqual({
      notificationId: NID,
      outcome: "shown",
      appState: "background",
      deviceId: "device-row-1",
    })
    expect(receipts.map((c) => (c.body as { notificationId: string }).notificationId)).toContain(N2)
    expect(receipts).toHaveLength(2)
    expect(await receiptNative.listQueue()).toEqual([])
    expect(base.order.indexOf("getDeliveredNotifications")).toBeLessThan(
      base.order.lastIndexOf("removeAllDeliveredNotifications"),
    )
  })

  it("a tap on a notification posts `shown`", async () => {
    const { native, net, push } = client()
    await push.start()
    native.fire("registration", { value: "device-token-1" })
    await push.settled()
    native.fire("pushNotificationActionPerformed", {
      notification: { data: { notificationId: NID, threadId: "t1" } },
    })
    await push.settled()
    const receipt = net.calls.find((c) => c.url.endsWith(RECEIPTS_PATH))
    expect(receipt?.body).toEqual({
      notificationId: NID,
      outcome: "shown",
      appState: "background",
      deviceId: "device-row-1",
    })
  })
})

describe("no token is never a resting state", () => {
  /** A hand-cranked timer: the test decides when a scheduled retry runs. */
  function manualTimers() {
    const pending: Array<{ ms: number; run: () => void; cancelled: boolean }> = []
    return {
      schedule: (run: () => void, ms: number) => {
        const entry = { ms, run, cancelled: false }
        pending.push(entry)
        return () => {
          entry.cancelled = true
        }
      },
      fireNext: () => {
        const entry = pending.find((p) => !p.cancelled)
        if (!entry) throw new Error("no retry is scheduled")
        entry.cancelled = true
        entry.run()
      },
      live: () => pending.filter((p) => !p.cancelled).map((p) => p.ms),
    }
  }

  function setup(bearer: () => string | null = () => "bearer-abc") {
    const calls: Call[] = []
    const native = fakePlugin()
    const timers = manualTimers()
    let onActive: (() => void) | null = null
    const client = createPushClient({
      plugin: native.plugin,
      platform: () => "ios",
      accessToken: async () => bearer(),
      serverAddress: async () => SERVER,
      fetchImpl: fakeFetch(calls),
      schedule: timers.schedule,
      onForeground: (handler) => {
        onActive = handler
      },
    })
    const count = (step: string) => native.order.filter((s) => s === step).length
    const posts = () => calls.filter((c) => c.method === "POST")
    return {
      calls,
      native,
      timers,
      client,
      count,
      posts,
      activate: async () => {
        if (onActive === null) throw new Error("nothing is listening for the foreground")
        onActive()
        await client.settled()
      },
    }
  }

  it("asks the platform for the token again on foreground when none arrived", async () => {
    const { native, client, count, posts, activate } = setup()
    expect(await client.start()).toBe("registering")
    expect(count("register")).toBe(1)
    await activate()
    expect(count("register")).toBe(2)
    // Permission is not asked twice once it was granted.
    expect(count("requestPermissions")).toBe(1)
    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    expect(posts().map((c) => c.body)).toEqual([{ platform: "ios", token: "device-token-1" }])
  })

  it("retries register() on a backoff after a registration error, and stops once a token arrives", async () => {
    const { native, timers, client, count, posts } = setup()
    await client.start()
    native.fire("registrationError", { error: "no network" })
    expect(timers.live()).toHaveLength(1)
    timers.fireNext()
    await client.settled()
    expect(count("register")).toBe(2)
    native.fire("registrationError", { error: "no network" })
    expect(timers.live()).toHaveLength(1)
    timers.fireNext()
    await client.settled()
    expect(count("register")).toBe(3)
    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    expect(timers.live()).toEqual([])
    expect(posts()).toHaveLength(1)
  })

  it("backs off longer after each consecutive registration error", async () => {
    const { native, timers, client } = setup()
    await client.start()
    native.fire("registrationError", {})
    const firstWait = timers.live()[0]
    timers.fireNext()
    await client.settled()
    native.fire("registrationError", {})
    expect(timers.live()[0]).toBeGreaterThan(firstWait)
  })

  it("a new bearer with no token yet asks the platform again", async () => {
    const { client, count } = setup()
    await client.start()
    expect(await client.start()).toBe("registering")
    expect(count("register")).toBe(2)
    expect(count("requestPermissions")).toBe(1)
  })

  it("a start whose register() threw is asked again by the next start", async () => {
    const { native, client, count } = setup()
    const register = native.plugin.register
    native.plugin.register = async () => {
      native.order.push("register")
      throw new Error("push service not ready")
    }
    await expect(client.start()).rejects.toThrow("push service not ready")
    native.plugin.register = register
    expect(await client.start()).toBe("registering")
    expect(count("register")).toBe(2)
  })

  it("a permission refused and later allowed in Settings registers on the next foreground", async () => {
    const { native, client, count, activate } = setup()
    native.setPermission("denied")
    expect(await client.start()).toBe("permission-denied")
    expect(count("register")).toBe(0)
    native.setPermission("granted")
    await activate()
    expect(count("register")).toBe(1)
  })

  it("logout cancels a register() retry still waiting", async () => {
    const { native, timers, client } = setup()
    await client.start()
    native.fire("registrationError", {})
    expect(timers.live()).toHaveLength(1)
    await client.logout()
    expect(timers.live()).toEqual([])
  })

  it("posts the token again when somebody signs in after a sign-out, with no relaunch", async () => {
    let bearer: string | null = "bearer-one"
    const { native, client, calls } = setup(() => bearer)
    await client.start()
    native.fire("registration", { value: "device-token-1" })
    await client.settled()
    await client.logout()
    bearer = null
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"])
    bearer = "bearer-two"
    expect(await client.start()).toBe("re-registered")
    await client.settled()
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE", "POST"])
    expect(calls.at(-1)?.authorization).toBe("Bearer bearer-two")
  })
})
