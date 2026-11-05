// SPDX-License-Identifier: FSL-1.1-ALv2
// P1-T4 (S5, A6, A7, A12): the browser device. Only a real browser registers a
// service worker and a Web Push subscription (never the Tauri desktop or the
// Capacitor webviews); the browser device's receipt credential lives in
// IndexedDB, where the service worker reads it; receipts carry that credential,
// never the session; sign-out forgets the device and names it to the server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApiClient } from "~/lib/api-client"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import { setTokens } from "~/modules/auth/auth-store"
import { createAuthManager } from "~/modules/auth/createAuthManager"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import {
  BrowserPushTestAccess,
  enableBrowserPush,
  ensureBrowserDevice,
  isRealBrowser,
  postBrowserReceipt,
  SW_URL,
  signOutBrowserDevice,
} from "./browser-push"
import { readBrowserDevice } from "./device-credential"
import { createFakeIndexedDb } from "./fake-idb"

const VAPID =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U"

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: any
}

let calls: Call[]
let respond: (call: Call) => Response | undefined
let permission: NotificationPermission
let subscription: {
  endpoint: string
  toJSON: () => unknown
  unsubscribe: ReturnType<typeof vi.fn>
} | null
let register: ReturnType<typeof vi.fn>
let subscribe: ReturnType<typeof vi.fn>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {}
  new Headers(init?.headers).forEach((v, k) => {
    out[k.toLowerCase()] = v
  })
  return out
}

let credentialSeq = 0

function defaultRespond(call: Call): Response {
  if (call.url.endsWith("/notifications/web-push/config"))
    return json({ data: { publicKey: VAPID } })
  if (call.url.endsWith("/notifications/browser-subscriptions") && call.method === "POST") {
    credentialSeq++
    return json(
      { data: { deviceId: call.body.deviceId, receiptCredential: `lnr_cred${credentialSeq}` } },
      201,
    )
  }
  if (call.url.endsWith("/notifications/receipts")) {
    return json({ data: { notificationId: call.body.notificationId, outcome: call.body.outcome } })
  }
  if (call.method === "DELETE") return new Response(null, { status: 204 })
  return json({ data: null }, 404)
}

function installRealBrowser(): void {
  const pushManager = {
    getSubscription: vi.fn(async () => subscription),
    subscribe,
  }
  const registration = { pushManager, scope: "http://localhost:3000/" }
  register = vi.fn(async () => registration)
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register,
      ready: Promise.resolve(registration),
      getRegistration: async () => registration,
    },
  })
  vi.stubGlobal("PushManager", function PushManager() {})
  // A live getter (Object.assign would freeze the value at stub time).
  const FakeNotification = Object.defineProperty(function Notification() {}, "permission", {
    configurable: true,
    get: () => permission,
  }) as unknown as Record<string, unknown>
  FakeNotification.requestPermission = vi.fn(async () => {
    permission = "granted"
    return permission
  })
  vi.stubGlobal("Notification", FakeNotification)
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true })
}

const api = () =>
  createApiClient({ getAccessToken: () => "session-token", onUnauthorized: () => {} })

beforeEach(() => {
  localStorage.clear()
  credentialSeq = 0
  calls = []
  respond = defaultRespond
  permission = "default"
  subscription = null
  subscribe = vi.fn(async () => {
    subscription = {
      endpoint: "https://push.example/sub/1",
      toJSON: () => ({
        endpoint: "https://push.example/sub/1",
        keys: { p256dh: "p256", auth: "auth1" },
      }),
      unsubscribe: vi.fn(async () => true),
    }
    return subscription
  })
  vi.stubGlobal("indexedDB", createFakeIndexedDb())
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url
      const call: Call = {
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        headers: headersOf(init),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      }
      calls.push(call)
      return respond(call) ?? defaultRespond(call)
    }),
  )
  installRealBrowser()
  BrowserPushTestAccess.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (navigator as unknown as Record<string, unknown>).serviceWorker
  delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
  delete (globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__
})

describe("platform guard (A12)", () => {
  it("a real browser with service workers and Push qualifies", () => {
    expect(isRealBrowser()).toBe(true)
  })

  it("the Tauri desktop webview never does", async () => {
    installFakeBridge()
    try {
      expect(isRealBrowser()).toBe(false)
      expect(await ensureBrowserDevice(api(), "u1")).toBeNull()
      expect(await enableBrowserPush(api(), "u1")).toBe("unsupported")
      expect(register).not.toHaveBeenCalled()
      expect(calls).toHaveLength(0)
    } finally {
      uninstallFakeBridge()
    }
  })

  it("the Capacitor webview never does", async () => {
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = {}
    expect(isRealBrowser()).toBe(false)
    expect(await ensureBrowserDevice(api(), "u1")).toBeNull()
    expect(register).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it("a page whose server address is injected by a shell never does", () => {
    ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = "https://acme.example"
    expect(isRealBrowser()).toBe(false)
  })

  it("a browser without service workers or Push does not", () => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker
    expect(isRealBrowser()).toBe(false)
  })
})

describe("registration", () => {
  it("without the permission: registers the browser device only (in-tab receipts), no service worker", async () => {
    const rec = await ensureBrowserDevice(api(), "u1")
    expect(register).not.toHaveBeenCalled()
    const post = calls.find((c) => c.url.endsWith("/notifications/browser-subscriptions"))
    expect(post?.method).toBe("POST")
    expect(post?.body.deviceId).toBe(localStorage.getItem("liaison:deviceId"))
    expect(post?.body.subscription).toBeUndefined()
    expect(rec?.credential).toBe("lnr_cred1")
    const stored = await readBrowserDevice()
    expect(stored).toMatchObject({ userId: "u1", credential: "lnr_cred1", endpoint: null })
    expect(stored?.receiptsUrl).toMatch(/\/api\/notifications\/receipts$/)
  })

  it("does not register again while the stored credential is this user's", async () => {
    await ensureBrowserDevice(api(), "u1")
    await ensureBrowserDevice(api(), "u1")
    expect(calls.filter((c) => c.url.endsWith("/browser-subscriptions"))).toHaveLength(1)
  })

  it("another user on the same browser registers again", async () => {
    await ensureBrowserDevice(api(), "u1")
    await ensureBrowserDevice(api(), "u2")
    expect(calls.filter((c) => c.url.endsWith("/browser-subscriptions"))).toHaveLength(2)
    expect((await readBrowserDevice())?.userId).toBe("u2")
  })

  it("with the permission: registers the service worker and subscribes with the server's VAPID key", async () => {
    permission = "granted"
    await ensureBrowserDevice(api(), "u1")
    expect(register).toHaveBeenCalledWith(SW_URL, { scope: "/" })
    expect(subscribe).toHaveBeenCalledTimes(1)
    const opts = subscribe.mock.calls[0]![0] as {
      userVisibleOnly: boolean
      applicationServerKey: Uint8Array
    }
    expect(opts.userVisibleOnly).toBe(true)
    expect(opts.applicationServerKey).toBeInstanceOf(Uint8Array)
    expect(opts.applicationServerKey.length).toBe(65)
    const post = calls.find((c) => c.url.endsWith("/browser-subscriptions"))
    expect(post?.body.subscription).toEqual({
      endpoint: "https://push.example/sub/1",
      keys: { p256dh: "p256", auth: "auth1" },
    })
    expect((await readBrowserDevice())?.endpoint).toBe("https://push.example/sub/1")
  })

  it("the server has no VAPID key: the device is registered without Web Push", async () => {
    permission = "granted"
    respond = (c) =>
      c.url.endsWith("/web-push/config") ? json({ data: { publicKey: null } }) : undefined
    await ensureBrowserDevice(api(), "u1")
    expect(subscribe).not.toHaveBeenCalled()
    expect(
      calls.find((c) => c.url.endsWith("/browser-subscriptions"))?.body.subscription,
    ).toBeUndefined()
  })

  it("'Turn on browser notifications' asks the permission, then subscribes and registers", async () => {
    expect(await enableBrowserPush(api(), "u1")).toBe("enabled")
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect((await readBrowserDevice())?.endpoint).toBe("https://push.example/sub/1")
  })

  it("a refused permission answers denied and subscribes nothing", async () => {
    ;(Notification as unknown as { requestPermission: () => Promise<string> }).requestPermission =
      vi.fn(async () => {
        permission = "denied"
        return "denied"
      })
    expect(await enableBrowserPush(api(), "u1")).toBe("denied")
    expect(subscribe).not.toHaveBeenCalled()
  })
})

describe("receipts", () => {
  it("post with the device credential, never the session, and name the device", async () => {
    await ensureBrowserDevice(api(), "u1")
    const ok = await postBrowserReceipt({
      notificationId: "11111111-1111-4111-8111-111111111111",
      surface: "browser_tab",
      outcome: "shown",
    })
    expect(ok).toBe(true)
    const receipt = calls.find((c) => c.url.endsWith("/notifications/receipts"))!
    expect(receipt.method).toBe("POST")
    expect(receipt.headers.authorization).toBe("Bearer lnr_cred1")
    expect(receipt.body).toMatchObject({
      notificationId: "11111111-1111-4111-8111-111111111111",
      deviceId: localStorage.getItem("liaison:deviceId"),
      surface: "browser_tab",
      outcome: "shown",
    })
  })

  it("without a registered device there is nothing to post", async () => {
    expect(
      await postBrowserReceipt({
        notificationId: "11111111-1111-4111-8111-111111111111",
        surface: "browser_tab",
        outcome: "shown",
      }),
    ).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it("a revoked credential (401) re-registers once and retries", async () => {
    await ensureBrowserDevice(api(), "u1")
    let first = true
    respond = (c) => {
      if (c.url.endsWith("/notifications/receipts") && first) {
        first = false
        return json({ error: { code: "UNAUTHORIZED" } }, 401)
      }
      return undefined
    }
    const ok = await postBrowserReceipt({
      notificationId: "11111111-1111-4111-8111-111111111111",
      surface: "browser_tab",
      outcome: "suppressed",
      reason: "on_screen",
    })
    expect(ok).toBe(true)
    const receipts = calls.filter((c) => c.url.endsWith("/notifications/receipts"))
    expect(receipts.map((r) => r.headers.authorization)).toEqual([
      "Bearer lnr_cred1",
      "Bearer lnr_cred2",
    ])
    expect(receipts[1]!.body).toMatchObject({ outcome: "suppressed", reason: "on_screen" })
  })
})

describe("receipts racing their delivery row", () => {
  // The server writes the delivery row right AFTER handing the frame over (the
  // test send even after every device), so a tab that answers at once can be
  // early: 404 "no delivery of this notification to this device". One later
  // retry lands it (Settings > Send me a test showed this browser's tab as
  // "No confirmation within 30 seconds" every time).
  it("a 404 is retried once after a moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await ensureBrowserDevice(api(), "u1")
      let first = true
      respond = (c) => {
        if (c.url.endsWith("/notifications/receipts") && first) {
          first = false
          return json({ error: { code: "NOT_FOUND" } }, 404)
        }
        return undefined
      }
      const pending = postBrowserReceipt({
        notificationId: "11111111-1111-4111-8111-111111111111",
        surface: "browser_tab",
        outcome: "shown",
      })
      await vi.advanceTimersByTimeAsync(5000)
      expect(await pending).toBe(true)
      expect(calls.filter((c) => c.url.endsWith("/notifications/receipts"))).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("sign-out", () => {
  it("forgets the browser device on the server, unsubscribes and clears the credential", async () => {
    permission = "granted"
    await ensureBrowserDevice(api(), "u1")
    const deviceId = localStorage.getItem("liaison:deviceId")
    const sub = subscription!
    await signOutBrowserDevice("session-token")
    const del = calls.find((c) => c.method === "DELETE")
    expect(del?.url).toMatch(new RegExp(`/api/notifications/browser-subscriptions/${deviceId}$`))
    expect(del?.headers.authorization).toBe("Bearer session-token")
    expect(sub.unsubscribe).toHaveBeenCalled()
    expect(await readBrowserDevice()).toBeNull()
  })

  it("does nothing in a shell", async () => {
    installFakeBridge()
    try {
      await signOutBrowserDevice("session-token")
      expect(calls).toHaveLength(0)
    } finally {
      uninstallFakeBridge()
    }
  })
})

// fix2-F1: a session can end without the sign-out button (refresh token
// rejected, another account signing in). Each end runs the local cleanup, or
// the next user of this browser inherits the previous user's Web Push.
describe("every end of session forgets the browser device (fix2-F1)", () => {
  function expiredJwt(): string {
    const enc = (o: unknown) => btoa(JSON.stringify(o))
    return `${enc({ alg: "HS256" })}.${enc({ userId: "u1", orgId: "o1", exp: Math.floor(Date.now() / 1000) - 60 })}.sig`
  }

  it("a rejected refresh token unsubscribes Web Push and clears the credential and device id", async () => {
    permission = "granted"
    await ensureBrowserDevice(api(), "u1")
    const sub = subscription!
    expect(await readBrowserDevice()).not.toBeNull()
    expect(localStorage.getItem("liaison:deviceId")).not.toBeNull()

    setTokens(expiredJwt())
    respond = (c) => (c.url.endsWith("/refresh") ? json({ error: "invalid" }, 401) : undefined)
    await expect(createAuthManager().ensureFreshToken()).rejects.toThrow()

    await vi.waitFor(async () => {
      expect(sub.unsubscribe).toHaveBeenCalled()
      expect(await readBrowserDevice()).toBeNull()
      expect(localStorage.getItem("liaison:deviceId")).toBeNull()
    })
  })

  it("another account signing in drops the previous user's subscription before registering", async () => {
    let n = 0
    subscribe.mockImplementation(async () => {
      n++
      const endpoint = `https://push.example/sub/${n}`
      subscription = {
        endpoint,
        toJSON: () => ({ endpoint, keys: { p256dh: "p256", auth: `auth${n}` } }),
        unsubscribe: vi.fn(async () => {
          subscription = null
          return true
        }),
      }
      return subscription
    })
    permission = "granted"
    await ensureBrowserDevice(api(), "u1")
    const first = subscription!
    await ensureBrowserDevice(api(), "u2")
    expect(first.unsubscribe).toHaveBeenCalled()
    const posts = calls.filter((c) => c.url.endsWith("/browser-subscriptions"))
    expect(posts).toHaveLength(2)
    expect(posts[1]!.body.subscription.endpoint).toBe("https://push.example/sub/2")
    expect(await readBrowserDevice()).toMatchObject({
      userId: "u2",
      endpoint: "https://push.example/sub/2",
    })
  })
})
