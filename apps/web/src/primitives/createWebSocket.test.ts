// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  url: string
  readyState = MockWebSocket.CONNECTING
  onopen: ((e: Event) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  sent: string[] = []
  /** Answers a `ping` with a `pong` at once, as a live server does. */
  autoPong = true

  constructor(url: string) {
    this.url = url
  }

  send(data: string) {
    this.sent.push(data)
    if (this.autoPong && JSON.parse(data).type === "ping") this._message('{"type":"pong"}')
  }

  /** A half-open socket: nothing comes back, and `close()` never reports a close. */
  _goDead() {
    this.autoPong = false
    this.close = () => {
      this.readyState = MockWebSocket.CLOSED
    }
  }

  pings(): number {
    return this.sent.filter((f) => JSON.parse(f).type === "ping").length
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent("close"))
  }

  _open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event("open"))
  }

  _message(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }))
  }
}

describe("createWebSocket", () => {
  let instances: MockWebSocket[]

  beforeEach(() => {
    vi.resetModules()
    instances = []
    vi.stubGlobal(
      "WebSocket",
      class extends MockWebSocket {
        constructor(url: string) {
          super(url)
          instances.push(this)
        }
      },
    )
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    })
    vi.stubGlobal("navigator", { onLine: true })
    // Mock fetch for WS ticket exchange (POST /api/auth/ws-ticket)
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { ticket: "mock-ticket-abc" } }),
        }),
      ),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  /** Wait for the ticket exchange promise to resolve and WebSocket to be created */
  async function waitForInstance() {
    // Flush microtask queue so the .then(ticket => new WebSocket(...)) resolves
    await vi.waitFor(() => expect(instances.length).toBeGreaterThan(0))
  }

  it("connects with ticket exchange", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ws = createWebSocket({ getToken: () => "my-token" })
    ws.connect()
    await waitForInstance()

    expect(instances).toHaveLength(1)
    expect(instances[0].url).toContain("/ws?ticket=mock-ticket-abc")
  })

  it("a shell whose server answered the client policy names itself on the ticket exchange (S4)", async () => {
    const global = globalThis as Record<string, unknown>
    global.__LIAISON_DESKTOP__ = { version: 1, platform: "macos", appVersion: async () => "0.1.35" }
    try {
      const fetchMock = vi.fn((url: string, _init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              url.endsWith("/client-policy")
                ? { data: { desktop: "0.1.33", ios: "1.0.34", android: "0.0.0" } }
                : { data: { ticket: "mock-ticket-abc" } },
            ),
        }),
      )
      vi.stubGlobal("fetch", fetchMock)
      const { startClientPolicy } = await import("~/lib/client-version")
      await startClientPolicy()
      const { createWebSocket } = await import("~/primitives/createWebSocket")
      createWebSocket({ getToken: () => "my-token" }).connect()
      await waitForInstance()
      const ticketCall = fetchMock.mock.calls.find(([url]) => url.endsWith("/auth/ws-ticket"))
      const init = ticketCall?.[1] as { headers: Record<string, string> }
      expect(init.headers["X-Liaison-Client"]).toBe("desktop/0.1.35")
      expect(init.headers.Authorization).toBe("Bearer my-token")
    } finally {
      global.__LIAISON_DESKTOP__ = undefined
    }
  })

  it("a browser's ticket exchange carries no client header", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    createWebSocket({ getToken: () => "my-token" }).connect()
    await waitForInstance()
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers["X-Liaison-Client"]).toBeUndefined()
  })

  it("transitions to connected on open", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ws = createWebSocket({ getToken: () => "token" })
    ws.connect()
    await waitForInstance()

    expect(ws.status()).toBe("connecting")
    instances[0]._open()
    expect(ws.status()).toBe("connected")
  })

  it("sends hello message on open", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ws = createWebSocket({ getToken: () => "token" })
    ws.connect()
    await waitForInstance()
    instances[0]._open()

    const sent = JSON.parse(instances[0].sent[0])
    expect(sent.type).toBe("hello")
  })

  it("S53 (D29): the hello asks for the sessions' main-thread events only (nodeSessionEvents top)", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const plain = createWebSocket({ getToken: () => "token" })
    plain.connect()
    await waitForInstance()
    instances[0]._open()
    expect(JSON.parse(instances[0].sent[0])).toMatchObject({
      type: "hello",
      nodeSessionEvents: "top",
    })
  })

  it("hello carries the client kind and the last activity (S6)", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ws = createWebSocket({
      getToken: () => "token",
      getClientKind: () => "desktop_app",
      getLastActiveAt: () => 1234,
    })
    ws.connect()
    await waitForInstance()
    instances[0]._open()

    const sent = JSON.parse(instances[0].sent[0])
    expect(sent).toMatchObject({ type: "hello", clientKind: "desktop_app", lastActiveAt: 1234 })
  })

  it("hello carries a stable per-browser device id, shared by every tab (F1)", async () => {
    const store = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    })
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const first = createWebSocket({ getToken: () => "token", getClientKind: () => "browser" })
    first.connect()
    await waitForInstance()
    instances[0]._open()
    const a = JSON.parse(instances[0].sent[0])
    expect(typeof a.deviceId).toBe("string")
    expect(a.deviceId.length).toBeGreaterThan(0)

    const second = createWebSocket({ getToken: () => "token", getClientKind: () => "browser" })
    second.connect()
    await vi.waitFor(() => expect(instances.length).toBe(2))
    instances[1]._open()
    expect(JSON.parse(instances[1].sent[0]).deviceId).toBe(a.deviceId)
  })

  it("a node's hello presents its node credential, and only a node's (P4 N-D T4)", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    let credential: string | null = "lnn_node"
    const ws = createWebSocket({
      getToken: () => "token",
      getClientKind: () => "desktop_app",
      getDeviceId: () => "d.0123",
      getNodeCredential: () => credential,
    })
    ws.connect()
    await waitForInstance()
    instances[0]._open()
    expect(JSON.parse(instances[0].sent[0])).toMatchObject({
      type: "hello",
      deviceId: "d.0123",
      nodeCredential: "lnn_node",
    })
    ws.disconnect()
    credential = null
    ws.connect()
    await vi.waitFor(() => expect(instances.length).toBe(2))
    instances[1]._open()
    expect(JSON.parse(instances[1].sent[0])).not.toHaveProperty("nodeCredential")
    ws.disconnect()
  })

  it("the desktop app's hello names its install and the OS permission it reports (A6, P1-T6)", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    let permission: "granted" | "denied" | "not_determined" | undefined = "denied"
    const ws = createWebSocket({
      getToken: () => "token",
      getClientKind: () => "desktop_app",
      getDeviceId: () => "d.0123",
      getNotificationPermission: () => permission,
    })
    ws.connect()
    await waitForInstance()
    instances[0]._open()
    expect(JSON.parse(instances[0].sent[0])).toMatchObject({
      type: "hello",
      clientKind: "desktop_app",
      deviceId: "d.0123",
      notificationPermission: "denied",
    })
    // On change, the heartbeat carries the new word at once.
    permission = "granted"
    ws.sendPresence()
    const presence = instances[0].sent
      .map((f) => JSON.parse(f))
      .filter((f) => f.type === "presence")
    expect(presence.at(-1)).toMatchObject({ type: "presence", notificationPermission: "granted" })
    // Nothing known yet: the field is left out rather than guessed.
    permission = undefined
    ws.sendPresence()
    const last = instances[0].sent.map((f) => JSON.parse(f)).filter((f) => f.type === "presence")
    expect(last.at(-1)).not.toHaveProperty("notificationPermission")
    ws.disconnect()
  })

  it("sends a presence heartbeat with the last activity every 30 s", async () => {
    vi.useFakeTimers()
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    let active = 1000
    const ws = createWebSocket({
      getToken: () => "token",
      getClientKind: () => "browser",
      getLastActiveAt: () => active,
    })
    ws.connect()
    await vi.waitFor(() => expect(instances.length).toBeGreaterThan(0))
    instances[0]._open()
    active = 5000
    vi.advanceTimersByTime(30_000)
    const frames = instances[0].sent.map((f) => JSON.parse(f))
    expect(frames.filter((f) => f.type === "presence")).toEqual([
      { type: "presence", lastActiveAt: 5000 },
    ])
    ws.sendPresence()
    expect(
      instances[0].sent.map((f) => JSON.parse(f)).filter((f) => f.type === "presence"),
    ).toHaveLength(2)
    ws.disconnect()
  })

  it("tracks lastEventId from incoming events", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ws = createWebSocket({ getToken: () => "token" })
    ws.connect()
    await waitForInstance()
    instances[0]._open()

    instances[0]._message(
      JSON.stringify({
        type: "event",
        eventId: 42,
        payload: { app: "kernel", entity: "user", action: "created" },
      }),
    )

    expect(ws.lastEventId()).toBe(42)
  })

  it("calls event handlers registered via on()", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ws = createWebSocket({ getToken: () => "token" })
    const handler = vi.fn()
    ws.on("event", handler)
    ws.connect()
    await waitForInstance()
    instances[0]._open()

    const payload = { app: "kernel", entity: "user", action: "created" }
    instances[0]._message(JSON.stringify({ type: "event", eventId: 1, payload }))

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ payload }))
  })

  it("transitions to disconnected on disconnect", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ws = createWebSocket({ getToken: () => "token" })
    ws.connect()
    await waitForInstance()
    instances[0]._open()
    ws.disconnect()

    expect(ws.status()).toBe("disconnected")
  })

  it("emits sync handler when sync message received", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const onSyncRequired = vi.fn()
    const syncHandler = vi.fn()
    const ws = createWebSocket({ getToken: () => "token", onSyncRequired })
    ws.on("sync", syncHandler)
    ws.connect()
    await waitForInstance()
    instances[0]._open()

    instances[0]._message(JSON.stringify({ type: "sync" }))

    expect(onSyncRequired).toHaveBeenCalled()
    expect(syncHandler).toHaveBeenCalled()
  })

  it("transitions to reconnecting on unexpected close", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ws = createWebSocket({ getToken: () => "token" })
    ws.connect()
    await waitForInstance()
    const idx = instances.length - 1
    instances[idx]._open()

    expect(ws.status()).toBe("connected")

    // Close the connection (simulates server-side close)
    instances[idx].onclose?.(new CloseEvent("close", { code: 1006 }))

    expect(ws.status()).toBe("reconnecting")
    ws.disconnect()
  })

  it("a 1012 close says the server is restarting; an abrupt close says nothing about the server", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const { restartSignalAt } = await import("~/lib/server-pause")
    const ws = createWebSocket({ getToken: () => "token" })
    ws.connect()
    await waitForInstance()
    instances[instances.length - 1]._open()

    // A dropped connection (1006) is the network, never an update.
    instances[instances.length - 1].onclose?.(new CloseEvent("close", { code: 1006 }))
    expect(restartSignalAt()).toBeNull()
    ws.disconnect()

    ws.connect()
    await vi.waitFor(() => expect(instances.length).toBe(2))
    instances[1]._open()
    instances[1].onclose?.(new CloseEvent("close", { code: 1012 }))
    expect(restartSignalAt()).not.toBeNull()

    // The next socket that opens means the server is back.
    await vi.waitFor(() => expect(instances.length).toBe(3))
    instances[2]._open()
    expect(restartSignalAt()).toBeNull()
    ws.disconnect()
  })

  it("calls ensureFreshToken on close code 4001", async () => {
    vi.useFakeTimers()
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ensureFreshToken = vi.fn().mockResolvedValue(undefined)
    const ws = createWebSocket({ getToken: () => "token", ensureFreshToken })
    ws.connect()
    await waitForInstance()
    const lastIdx = instances.length - 1
    instances[lastIdx]._open()

    // Close with 4001
    instances[lastIdx].onclose?.(new CloseEvent("close", { code: 4001 }))

    expect(ensureFreshToken).toHaveBeenCalled()

    // Cleanup — prevent async reconnect from leaking into next test
    ws.disconnect()
    vi.useRealTimers()
  })

  it("uses exponential backoff for successive reconnect attempts", async () => {
    vi.useFakeTimers()
    // Jitter factor 0.7 + 0.5 * 0.6 = 1: the bare exponential delay.
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ws = createWebSocket({ getToken: () => "token" })
    ws.connect()
    await waitForInstance()
    instances[0]._open()

    // First close: attempt 0 → delay 0
    instances[0].onclose?.(new CloseEvent("close", { code: 1006 }))
    await vi.advanceTimersByTimeAsync(0)
    // Wait for ticket exchange to resolve and create second WebSocket
    await vi.waitFor(() => expect(instances.length).toBeGreaterThan(1))

    // Second close WITHOUT opening — reconnectAttempt stays at 1 → delay 1000ms
    instances[1].onclose?.(new CloseEvent("close", { code: 1006 }))
    const beforeCount = instances.length
    await vi.advanceTimersByTimeAsync(999)
    expect(instances.length).toBe(beforeCount) // not yet
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(instances.length).toBeGreaterThan(beforeCount))

    ws.disconnect()
    vi.useRealTimers()
  })

  it("pauses reconnection when navigator.onLine is false", async () => {
    vi.useFakeTimers()
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ws = createWebSocket({ getToken: () => "token" })
    ws.connect()
    await waitForInstance()
    instances[0]._open()

    // Go offline before closing
    vi.stubGlobal("navigator", { onLine: false })
    instances[0].onclose?.(new CloseEvent("close", { code: 1006 }))

    // Advance well past any backoff delay — should not reconnect while offline
    await vi.advanceTimersByTimeAsync(10_000)
    expect(instances.length).toBe(1)

    // Coming online should trigger reconnect
    vi.stubGlobal("navigator", { onLine: true })
    window.dispatchEvent(new Event("online"))
    // The online handler calls scheduleReconnect with delay=0; advance to fire it
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(instances.length).toBeGreaterThan(1))

    ws.disconnect()
    vi.useRealTimers()
  })

  describe("lastEventId clamping (S-4)", () => {
    async function wsWithStoredId(value: string) {
      vi.stubGlobal("localStorage", {
        getItem: vi.fn(() => value),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      })
      const { createWebSocket } = await import("~/primitives/createWebSocket")
      return createWebSocket({ getToken: () => "token" })
    }

    it("clamps negative lastEventId to 0", async () => {
      const ws = await wsWithStoredId("-1")
      expect(ws.lastEventId()).toBe(0)
    })

    it("clamps NaN lastEventId to 0", async () => {
      const ws = await wsWithStoredId("NaN")
      expect(ws.lastEventId()).toBe(0)
    })

    it("clamps non-numeric string to 0", async () => {
      const ws = await wsWithStoredId("abc")
      expect(ws.lastEventId()).toBe(0)
    })

    it("clamps overflow lastEventId (>= INT_MAX) to 0", async () => {
      const ws = await wsWithStoredId("2147483647")
      expect(ws.lastEventId()).toBe(0)
    })

    it("accepts a valid lastEventId", async () => {
      const ws = await wsWithStoredId("42")
      expect(ws.lastEventId()).toBe(42)
    })
  })

  it("calls ensureFreshToken before reconnect", async () => {
    vi.useFakeTimers()
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ensureFreshToken = vi.fn().mockResolvedValue(undefined)
    const ws = createWebSocket({ getToken: () => "token", ensureFreshToken })
    ws.connect()
    await waitForInstance()
    instances[0]._open()

    // Close normally (not 4001)
    instances[0].onclose?.(new CloseEvent("close", { code: 1006 }))

    // First reconnect is immediate
    await vi.advanceTimersByTimeAsync(0)

    expect(ensureFreshToken).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("awaits ensureFreshToken before reconnecting (no connect with a stale token)", async () => {
    vi.useFakeTimers()
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    let resolveRefresh: () => void = () => {}
    const refreshDone = new Promise<void>((r) => {
      resolveRefresh = r
    })
    const ensureFreshToken = vi.fn(() => refreshDone)
    const ws = createWebSocket({ getToken: () => "token", ensureFreshToken })
    ws.connect()
    await waitForInstance()
    instances[0]._open()

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const ticketCallsBefore = fetchMock.mock.calls.length

    instances[0].onclose?.(new CloseEvent("close", { code: 1006 }))
    // Fire the (immediate) reconnect timer. The refresh promise is still
    // pending, so NO ticket exchange may have happened yet.
    await vi.advanceTimersByTimeAsync(0)
    expect(ensureFreshToken).toHaveBeenCalled()
    expect(fetchMock.mock.calls.length).toBe(ticketCallsBefore)
    expect(instances.length).toBe(1)

    // Once the refresh resolves, the connect proceeds.
    resolveRefresh()
    await vi.waitFor(() => expect(instances.length).toBe(2))

    ws.disconnect()
    vi.useRealTimers()
  })

  it("forces a token refresh and retries once when the ticket exchange 401s", async () => {
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { ticket: "fresh-ticket" } }),
      })
    vi.stubGlobal("fetch", fetchMock)
    const ensureFreshToken = vi.fn().mockResolvedValue(undefined)
    const ws = createWebSocket({ getToken: () => "token", ensureFreshToken })
    ws.connect()
    await waitForInstance()

    expect(ensureFreshToken).toHaveBeenCalledWith({ force: true, rejected: "token" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(instances[0].url).toContain("/ws?ticket=fresh-ticket")

    ws.disconnect()
  })

  it("does not retry the ticket exchange on non-401 failures", async () => {
    vi.useFakeTimers()
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) })
    vi.stubGlobal("fetch", fetchMock)
    const ensureFreshToken = vi.fn().mockResolvedValue(undefined)
    const ws = createWebSocket({ getToken: () => "token", ensureFreshToken })
    ws.connect()
    // Let the rejected exchange settle
    await vi.advanceTimersByTimeAsync(0)

    expect(ensureFreshToken).not.toHaveBeenCalledWith({ force: true })
    expect(instances.length).toBe(0)

    ws.disconnect()
    vi.useRealTimers()
  })

  it("forces a token refresh on close code 4010 (permissionVersion bump)", async () => {
    vi.useFakeTimers()
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ensureFreshToken = vi.fn().mockResolvedValue(undefined)
    const ws = createWebSocket({ getToken: () => "token", ensureFreshToken })
    ws.connect()
    await waitForInstance()
    instances[0]._open()

    instances[0].onclose?.(new CloseEvent("close", { code: 4010 }))

    // A near-expiry-only refresh would no-op and loop 4010 forever.
    expect(ensureFreshToken).toHaveBeenCalledWith({ force: true })

    ws.disconnect()
    vi.useRealTimers()
  })

  it("does not force the refresh on close code 4001", async () => {
    vi.useFakeTimers()
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const ensureFreshToken = vi.fn().mockResolvedValue(undefined)
    const ws = createWebSocket({ getToken: () => "token", ensureFreshToken })
    ws.connect()
    await waitForInstance()
    instances[0]._open()

    instances[0].onclose?.(new CloseEvent("close", { code: 4001 }))

    expect(ensureFreshToken).toHaveBeenCalledWith({ force: false })

    ws.disconnect()
    vi.useRealTimers()
  })

  describe("unstable-connection detector", () => {
    type Ws = { connect: () => void; disconnect: () => void; unstable: () => boolean }

    async function setup(): Promise<Ws> {
      vi.useFakeTimers()
      const { createWebSocket } = await import("~/primitives/createWebSocket")
      const ws = createWebSocket({ getToken: () => "token" })
      ws.connect()
      await waitForInstance()
      return ws
    }

    /** The newest socket opens, lives `liveMs`, then closes with `code`; waits for the reconnect. */
    async function cycle(liveMs: number, code = 1006) {
      const sock = instances[instances.length - 1]
      sock._open()
      await vi.advanceTimersByTimeAsync(liveMs)
      const before = instances.length
      sock.onclose?.(new CloseEvent("close", { code }))
      // Past the longest backoff, so the next socket exists.
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(instances.length).toBeGreaterThan(before))
    }

    it("flags the connection after three early abnormal cuts within two minutes", async () => {
      const ws = await setup()
      await cycle(5_000)
      await cycle(5_000)
      expect(ws.unstable()).toBe(false)
      await cycle(5_000)
      expect(ws.unstable()).toBe(true)
      ws.disconnect()
    })

    it("a single blip never flags it", async () => {
      const ws = await setup()
      await cycle(5_000)
      expect(ws.unstable()).toBe(false)
      ws.disconnect()
    })

    it("ignores sockets that lived longer than the early-cut window", async () => {
      const ws = await setup()
      await cycle(20_000)
      await cycle(20_000)
      await cycle(20_000)
      expect(ws.unstable()).toBe(false)
      ws.disconnect()
    })

    it("ignores expected close codes (normal, auth, permissions, rate limit, policy)", async () => {
      const ws = await setup()
      for (const code of [1000, 4008, 4029, 1000]) await cycle(2_000, code)
      expect(ws.unstable()).toBe(false)
      ws.disconnect()
    })

    it("1012 reconnects within 250 ms and does not mark the connection unstable", async () => {
      // A server restart (RFC 6455 1012): reconnect now, spread over 0-250 ms
      // so a whole fleet of sockets does not land in one tick.
      vi.spyOn(Math, "random").mockReturnValue(0.5)
      const ws = await setup()
      for (let i = 0; i < 3; i++) {
        const sock = instances[instances.length - 1]
        sock._open()
        await vi.advanceTimersByTimeAsync(2_000)
        const before = instances.length
        sock.onclose?.(new CloseEvent("close", { code: 1012 }))
        await vi.advanceTimersByTimeAsync(100)
        expect(instances.length).toBe(before)
        await vi.advanceTimersByTimeAsync(150)
        await vi.waitFor(() => expect(instances.length).toBeGreaterThan(before))
      }
      expect(ws.unstable()).toBe(false)
      ws.disconnect()
    })

    it("ignores sockets that never opened and failed ticket exchanges", async () => {
      const ws = await setup()
      for (let i = 0; i < 4; i++) {
        const before = instances.length
        instances[instances.length - 1].onclose?.(new CloseEvent("close", { code: 1006 }))
        await vi.advanceTimersByTimeAsync(30_000)
        await vi.waitFor(() => expect(instances.length).toBeGreaterThan(before))
      }
      expect(ws.unstable()).toBe(false)
      ws.disconnect()
    })

    it("ignores cuts while the device is offline", async () => {
      const ws = await setup()
      for (let i = 0; i < 3; i++) {
        const sock = instances[instances.length - 1]
        sock._open()
        await vi.advanceTimersByTimeAsync(2_000)
        vi.stubGlobal("navigator", { onLine: false })
        sock.onclose?.(new CloseEvent("close", { code: 1006 }))
        vi.stubGlobal("navigator", { onLine: true })
        const before = instances.length
        window.dispatchEvent(new Event("online"))
        await vi.advanceTimersByTimeAsync(0)
        await vi.waitFor(() => expect(instances.length).toBeGreaterThan(before))
      }
      expect(ws.unstable()).toBe(false)
      ws.disconnect()
    })

    it("cuts spread over more than two minutes do not add up", async () => {
      const ws = await setup()
      await cycle(5_000)
      await vi.advanceTimersByTimeAsync(120_000)
      await cycle(5_000)
      await cycle(5_000)
      expect(ws.unstable()).toBe(false)
      ws.disconnect()
    })

    it("clears once a socket stays open for a minute", async () => {
      const ws = await setup()
      await cycle(5_000)
      await cycle(5_000)
      await cycle(5_000)
      expect(ws.unstable()).toBe(true)
      const sock = instances[instances.length - 1]
      sock._open()
      // Answer the 30 s ping, or the pong timeout closes the socket.
      await vi.advanceTimersByTimeAsync(31_000)
      sock._message(JSON.stringify({ type: "pong" }))
      await vi.advanceTimersByTimeAsync(28_000)
      expect(ws.unstable()).toBe(true)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(ws.unstable()).toBe(false)
      ws.disconnect()
    })

    it("clears on a manual disconnect, and a manual close is never a cut", async () => {
      const ws = await setup()
      await cycle(5_000)
      await cycle(5_000)
      await cycle(5_000)
      expect(ws.unstable()).toBe(true)
      ws.disconnect()
      expect(ws.unstable()).toBe(false)

      ws.connect()
      for (let i = 0; i < 3; i++) {
        await vi.waitFor(() => expect(instances.length).toBeGreaterThan(0))
        instances[instances.length - 1]._open()
        await vi.advanceTimersByTimeAsync(1_000)
        ws.disconnect()
        const before = instances.length
        ws.connect()
        await vi.advanceTimersByTimeAsync(0)
        await vi.waitFor(() => expect(instances.length).toBeGreaterThan(before))
      }
      expect(ws.unstable()).toBe(false)
      ws.disconnect()
    })
  })
  describe("network-blip detection (S26)", () => {
    type Handler = (online: boolean) => void
    function fakeConnectivity() {
      let handler: Handler = () => {}
      return {
        source: {
          initial: true,
          subscribe(h: Handler) {
            handler = h
            return () => {
              handler = () => {}
            }
          },
        },
        set: (online: boolean) => handler(online),
      }
    }

    async function openSocket(extra: Record<string, unknown> = {}) {
      vi.useFakeTimers()
      const { createWebSocket } = await import("~/primitives/createWebSocket")
      const ws = createWebSocket({ getToken: () => "token", ...extra })
      ws.connect()
      await waitForInstance()
      instances[0]._open()
      return ws
    }

    it("a missed pong opens a new socket within 9 s without waiting for onclose", async () => {
      const ws = await openSocket()
      instances[0]._goDead()
      await vi.advanceTimersByTimeAsync(9_000)
      await vi.waitFor(() => expect(instances.length).toBe(2))
      expect(instances[0].onmessage).toBeNull()
      ws.disconnect()
    })

    it("offline drops the socket and online reconnects at once", async () => {
      const net = fakeConnectivity()
      const ws = await openSocket({ connectivity: net.source })
      net.set(false)
      expect(instances[0].readyState).toBe(WebSocket.CLOSED)
      expect(ws.status()).not.toBe("connected")
      await vi.advanceTimersByTimeAsync(20_000)
      expect(instances).toHaveLength(1)
      net.set(true)
      await vi.advanceTimersByTimeAsync(0)
      await vi.waitFor(() => expect(instances.length).toBe(2))
      ws.disconnect()
    })

    it("focus and visibility probe an open socket, and a missed probe pong reconnects within 3 s", async () => {
      const ws = await openSocket()
      const before = instances[0].pings()
      window.dispatchEvent(new Event("focus"))
      expect(instances[0].pings()).toBe(before + 1)
      instances[0]._goDead()
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
      document.dispatchEvent(new Event("visibilitychange"))
      await vi.advanceTimersByTimeAsync(3_000)
      await vi.waitFor(() => expect(instances.length).toBe(2))
      ws.disconnect()
    })

    it("a timer gap of 20 s (the machine slept) retries a waiting reconnect at once", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5)
      const ws = await openSocket()
      // The server is unreachable: every ticket exchange fails, the backoff grows.
      const fetchMock = vi.fn(() => Promise.reject(new TypeError("network")))
      vi.stubGlobal("fetch", fetchMock)
      instances[0].onclose?.(new CloseEvent("close", { code: 1006 }))
      // Attempts at 0, +1 s, +2 s, +4 s, +8 s: the next waits 16 s.
      await vi.advanceTimersByTimeAsync(15_100)
      const calls = fetchMock.mock.calls.length
      expect(calls).toBe(5)
      // The machine sleeps 20 s: the clock jumps, no timer ran meanwhile.
      vi.setSystemTime(Date.now() + 20_000)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fetchMock.mock.calls.length).toBe(calls + 1)
      ws.disconnect()
    })

    it("the presence frame still goes every 30 s while pings go every 5 s", async () => {
      const ws = await openSocket({ getClientKind: () => "browser", getLastActiveAt: () => 1 })
      await vi.advanceTimersByTimeAsync(60_000)
      const frames = instances[0].sent.map((f) => JSON.parse(f))
      expect(frames.filter((f) => f.type === "presence")).toHaveLength(2)
      expect(frames.filter((f) => f.type === "ping")).toHaveLength(12)
      expect(instances).toHaveLength(1)
      ws.disconnect()
    })

    it("backoff carries jitter and never exceeds 39 s", async () => {
      const { reconnectDelay } = await import("~/primitives/createWebSocket")
      expect(reconnectDelay(0, () => 0.99)).toBe(0)
      expect(reconnectDelay(1, () => 0)).toBe(700)
      expect(reconnectDelay(1, () => 1)).toBe(1300)
      for (let attempt = 1; attempt < 40; attempt++) {
        expect(reconnectDelay(attempt, () => 0.9999)).toBeLessThanOrEqual(39_000)
      }
      expect(reconnectDelay(30, () => 0.9999)).toBeGreaterThan(30_000)
    })

    it("a native foreground probes the socket", async () => {
      let foreground: () => void = () => {}
      const ws = await openSocket({
        onForeground: (cb: () => void) => {
          foreground = cb
          return () => {}
        },
      })
      instances[0]._goDead()
      foreground()
      await vi.advanceTimersByTimeAsync(3_000)
      await vi.waitFor(() => expect(instances.length).toBe(2))
      ws.disconnect()
    })

    it("a late close of a dropped socket leaves the new socket alone", async () => {
      const ws = await openSocket()
      const lateClose = instances[0].onclose
      instances[0]._goDead()
      await vi.advanceTimersByTimeAsync(9_000)
      await vi.waitFor(() => expect(instances.length).toBe(2))
      instances[1]._open()
      expect(ws.status()).toBe("connected")
      // The drop stops listening to the dead socket...
      expect(instances[0].onclose).toBeNull()
      // ...and a close it had already queued (TCP finally gave up) changes nothing.
      lateClose?.(new CloseEvent("close", { code: 1006 }))
      expect(ws.status()).toBe("connected")
      const pings = instances[1].pings()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(instances[1].pings()).toBeGreaterThan(pings)
      expect(instances).toHaveLength(2)
      expect(ws.status()).toBe("connected")
      ws.disconnect()
    })

    it("a probe while a heartbeat pong is awaited keeps one deadline: the pong saves the socket", async () => {
      const ws = await openSocket()
      instances[0].autoPong = false
      // The heartbeat ping goes at 5 s (its pong is due by 9 s).
      await vi.advanceTimersByTimeAsync(5_000)
      expect(instances[0].pings()).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)
      window.dispatchEvent(new Event("focus"))
      expect(instances[0].pings()).toBe(2)
      // One pong answers: the socket is healthy.
      await vi.advanceTimersByTimeAsync(500)
      instances[0]._message('{"type":"pong"}')
      instances[0].autoPong = true
      await vi.advanceTimersByTimeAsync(10_000)
      expect(instances).toHaveLength(1)
      expect(instances[0].readyState).toBe(WebSocket.OPEN)
      expect(ws.status()).toBe("connected")
      ws.disconnect()
    })

    it("disconnect removes every listener: a later focus or offline does nothing", async () => {
      const net = fakeConnectivity()
      const ws = await openSocket({ connectivity: net.source })
      ws.disconnect()
      window.dispatchEvent(new Event("focus"))
      net.set(false)
      net.set(true)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(instances).toHaveLength(1)
    })
  })
})
