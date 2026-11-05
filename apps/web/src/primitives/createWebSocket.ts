// SPDX-License-Identifier: FSL-1.1-ALv2
import { DEMO_WORKSPACE_EXPIRED_WS_CLOSE } from "@liaison/shared"
import { createSignal, onCleanup } from "solid-js"
import type { EnsureFreshToken } from "~/lib/auth-refresh"
import { clientHeaders } from "~/lib/client-version"
import {
  demoWorkspaceEnded,
  noteDemoWorkspaceExpired,
  noteIfDemoWorkspaceExpired,
} from "~/lib/demo-expired"
import { absoluteApiBase, webSocketOrigin } from "~/lib/env"
import { log } from "~/lib/logger"
import { noteServerBack, noteServerRestarting } from "~/lib/server-pause"
import { type ConnectivitySource, connectivitySource } from "~/primitives/createConnectivity"

const wsLog = log.child({ component: "WebSocket" })

type WsStatus = "connecting" | "connected" | "disconnected" | "reconnecting"

interface WsMessage {
  type: string
  eventId?: number
  payload?: unknown
}

type MessageHandler = (msg: WsMessage) => void

interface CreateWebSocketOptions {
  getToken: () => string | null
  /** Refresh the access token if near expiry. `force` refreshes unconditionally
   *  (needed after 4010 session_invalidated — the token may not be near expiry
   *  but its permissionVersion is stale). */
  ensureFreshToken?: EnsureFreshToken
  onSyncRequired?: () => void
  /** Returns a stable scope key (e.g. "orgId:userId") for user-scoped localStorage keys */
  getScope?: () => string | null
  /** What this window is (S6): sent in the hello so the server can pick desktop notify targets. */
  getClientKind?: () => "desktop_app" | "browser" | "mobile_app"
  /** When the user last touched this window (ms): sent in the hello and every 30 s heartbeat. */
  getLastActiveAt?: () => number
  /**
   * This device's id (F1), sent in the hello so the delivery log and receipts
   * name it. Defaults to `notificationDeviceId()`.
   */
  getDeviceId?: () => string | null
  /**
   * The OS notification permission a desktop app reports (A6): sent in the
   * hello and with every presence heartbeat, so a change reaches the server
   * with the next `sendPresence`. Undefined (a browser, or not read yet)
   * leaves the field out.
   */
  getNotificationPermission?: () => "granted" | "denied" | "not_determined" | undefined
  /**
   * This computer's NODE CREDENTIAL (P4 N-D T4, A25), presented in the hello
   * so the server marks the node online. Null (not a node, or switched off)
   * leaves the field out.
   */
  getNodeCredential?: () => string | null
  /**
   * What this window shows and whether it is focused (thread-on-screen.ts):
   * sent in the hello and every presence frame, so the server holds back a
   * device push for a thread the user is reading here.
   */
  getViewing?: () => { threadIds: string[]; focused: boolean }
  /**
   * Whether the device has a network (S26). `offline` drops the socket at once
   * (it is dead, whatever it still reads); `online` probes or reconnects now.
   * Defaults to the shell's reachability source, else the browser's events.
   */
  connectivity?: ConnectivitySource
  /**
   * The native shell's "the app came back to the foreground" (S26). It probes
   * the socket, since a suspended webview can wake with a socket that still
   * reads open. Returns its unsubscribe.
   */
  onForeground?: (handler: () => void) => () => void
}

export const DEVICE_ID_KEY = "liaison:deviceId"

/**
 * One id per browser profile (shared by its tabs and its service worker) or
 * per desktop install (the app's webview keeps its own storage), minted once
 * and kept in localStorage. Null when storage is unavailable.
 */
export function notificationDeviceId(): string | null {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    localStorage.setItem(DEVICE_ID_KEY, id)
    return id
  } catch {
    return null
  }
}

// Dead-socket detection (S26). A half-open socket (Wi-Fi gone, laptop asleep,
// a VPN cut) never fires `onclose` until TCP gives up, minutes later. So the
// client pings every HEARTBEAT_INTERVAL_MS and drops the socket itself when no
// pong comes within PONG_TIMEOUT_MS: a dead socket is noticed within 9 s.
// A probe (focus, visible again, online, foreground, wake) pings at once and
// gives the pong PROBE_TIMEOUT_MS.
export const HEARTBEAT_INTERVAL_MS = 5_000
export const PONG_TIMEOUT_MS = 4_000
export const PROBE_TIMEOUT_MS = 3_000
/** The presence frame goes on every 6th heartbeat: every 30 s, as before. */
const PRESENCE_EVERY_BEATS = 6
/** The wake detector: a tick later than WAKE_GAP_MS means timers were frozen (sleep). */
const WAKE_CHECK_MS = 5_000
const WAKE_GAP_MS = 15_000
const MAX_BACKOFF_MS = 30_000

/**
 * The wait before reconnect attempt `attempt`: none for the first, then an
 * exponential backoff capped at 30 s, spread by a 0.7-1.3 jitter so the
 * clients a server restart cut do not all come back in the same second.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  if (attempt <= 0) return 0
  const base = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS)
  return Math.round(base * (0.7 + random() * 0.6))
}
const LAST_EVENT_ID_PREFIX = "liaison:lastEventId"
const WS_TICKET_TIMEOUT_MS = 8_000

// Unstable-connection detector. Something between the client and the server
// (a VPN, a split-tunnel proxy, a network filter) can cut every long-lived
// connection a few seconds after it opens: the socket opens, dies abnormally,
// reconnects and loops, and "Reconnecting…" alone never says why. A socket
// that OPENED and was cut abnormally within EARLY_CUT_MS is an early cut;
// UNSTABLE_CUT_COUNT of them inside UNSTABLE_WINDOW_MS mark the connection
// unstable. A socket that then stays open STABLE_AFTER_MS clears it.
export const EARLY_CUT_MS = 15_000
export const UNSTABLE_CUT_COUNT = 3
export const UNSTABLE_WINDOW_MS = 120_000
export const STABLE_AFTER_MS = 60_000
/**
 * RFC 6455 "Service Restart": the server is shutting down for a deploy. The
 * client reconnects at once (another process answers), spread over
 * RESTART_RECONNECT_JITTER_MS so a herd of sockets does not land in one tick.
 */
export const SERVICE_RESTART_CLOSE = 1012
export const RESTART_RECONNECT_JITTER_MS = 250
/** Close codes that end a socket on purpose (normal, restart, auth, permissions, rate limit, policy). */
const EXPECTED_CLOSE_CODES: ReadonlySet<number> = new Set([
  1000,
  SERVICE_RESTART_CLOSE,
  4001,
  DEMO_WORKSPACE_EXPIRED_WS_CLOSE,
  4008,
  4010,
  4029,
])

class WsTicketError extends Error {
  constructor(readonly status: number) {
    super(`WS ticket exchange failed: ${status}`)
    this.name = "WsTicketError"
  }
}

interface TestWebSocketHandle {
  __old?: boolean
  __socket: WebSocket | null
  close: () => void
  send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => void
  readonly readyState: number
  readonly url: string
}

export function createWebSocket(options: CreateWebSocketOptions) {
  function scopedKey(): string {
    const scope = options.getScope?.()
    return scope ? `${LAST_EVENT_ID_PREFIX}:${scope}` : LAST_EVENT_ID_PREFIX
  }

  function loadLastEventId(): number {
    const raw = parseInt(localStorage.getItem(scopedKey()) ?? "0", 10)
    return Number.isFinite(raw) && raw >= 0 && raw < 2_147_483_647 ? raw : 0
  }

  const [status, setStatus] = createSignal<WsStatus>("disconnected")
  const [lastEventId, setLastEventId] = createSignal<number>(loadLastEventId())
  const [unstable, setUnstable] = createSignal(false)

  let socket: WebSocket | null = null
  let pingInterval: ReturnType<typeof setInterval> | null = null
  let pongTimeout: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let manualClose = false
  let connecting = false
  let offlineHandler: (() => void) | null = null
  // The connectivity source said offline (a shell's reachability can know
  // before `navigator.onLine` does).
  let sourceOffline = false
  let heartbeats = 0
  let removeLifecycle: (() => void) | null = null
  let testHandle: TestWebSocketHandle | null = null
  let earlyCuts: number[] = []
  let stableTimer: ReturnType<typeof setTimeout> | null = null
  const debugEvents: string[] = []
  const handlers = new Map<string, MessageHandler[]>()

  function debug(message: string) {
    if (!import.meta.env.VITE_TEST_MODE || import.meta.env.PROD || typeof document === "undefined")
      return
    const stamp = new Date().toISOString().slice(11, 19)
    debugEvents.push(`${stamp} ${message}`)
    if (debugEvents.length > 20) debugEvents.shift()
    document.documentElement.setAttribute("data-ws-debug", debugEvents.join(" || "))
  }

  function setWsStatus(next: WsStatus) {
    setStatus(next)
    if (!import.meta.env.VITE_TEST_MODE || import.meta.env.PROD || typeof document === "undefined")
      return
    document.documentElement.setAttribute("data-ws-status", next)
    debug(`status:${next}`)
  }

  function getTestHandle(): TestWebSocketHandle | null {
    if (!import.meta.env.VITE_TEST_MODE || import.meta.env.PROD) return null
    if (testHandle) return testHandle

    const handle = {
      __socket: null,
      close: () => {
        handle.__socket?.close()
      },
      send: (data) => {
        handle.__socket?.send(data as any)
      },
    } as TestWebSocketHandle

    Object.defineProperties(handle, {
      readyState: {
        get() {
          return handle.__socket?.readyState ?? WebSocket.CLOSED
        },
      },
      url: {
        get() {
          return handle.__socket?.url ?? ""
        },
      },
    })

    ;(window as any).__ws = handle
    testHandle = handle
    return handle
  }

  function attachTestSocket(next: WebSocket | null) {
    const handle = getTestHandle()
    if (!handle) return
    handle.__socket = next
    if (next) delete handle.__old
  }

  function on(type: string, handler: MessageHandler): () => void {
    const list = handlers.get(type) ?? []
    list.push(handler)
    handlers.set(type, list)
    return () => {
      const current = handlers.get(type) ?? []
      handlers.set(
        type,
        current.filter((h) => h !== handler),
      )
    }
  }

  function emit(msg: WsMessage) {
    const list = handlers.get(msg.type) ?? []
    for (const h of list) h(msg)
  }

  async function getWsTicket(token: string): Promise<string> {
    // `absoluteApiBase` is the one place the base is decided: it honours the
    // server address a native shell injected (S15) and falls back to
    // VITE_API_TARGET and then the page's own origin, as this did before.
    const ticketBase = absoluteApiBase().replace(/\/api$/, "")
    const res = await fetch(`${ticketBase}/api/auth/ws-ticket`, {
      method: "POST",
      headers: { ...clientHeaders(), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(WS_TICKET_TIMEOUT_MS),
    })
    if (!res.ok) {
      // An ended demo workspace leaves for the demo door (lib/demo-expired.ts).
      await noteIfDemoWorkspaceExpired(res)
      throw new WsTicketError(res.status)
    }
    const body = await res.json()
    return (body.data ?? body).ticket
  }

  /** Exchange the JWT for a WS ticket. On a 401 (stale/expired JWT) force a
   *  token refresh and retry the exchange once immediately with the new token
   *  instead of surfacing the failure into a 30s reconnect-backoff loop. */
  async function exchangeTicket(token: string): Promise<string> {
    try {
      return await getWsTicket(token)
    } catch (err) {
      if (err instanceof WsTicketError && err.status === 401 && options.ensureFreshToken) {
        debug("ticket:401-refresh")
        await options.ensureFreshToken({ force: true, rejected: token })
        const fresh = options.getToken()
        if (fresh) return await getWsTicket(fresh)
      }
      throw err
    }
  }

  function connect() {
    if (connecting) return
    manualClose = false
    installLifecycle()
    const token = options.getToken()
    if (!token) {
      wsLog.warn("No token — skipping WebSocket connect")
      debug("connect:skipped-no-token")
      return
    }

    // Re-read lastEventId from localStorage at connect time using the current
    // scoped key. This ensures the read and all subsequent writes use the same
    // key even if the scope (orgId:userId) wasn't available when the WebSocket
    // was first constructed.
    setLastEventId(loadLastEventId())

    connecting = true
    setWsStatus("connecting")
    debug("ticket:start")

    // Exchange JWT for a single-use WS ticket, then connect
    exchangeTicket(token)
      .then((ticket) => {
        connecting = false
        if (manualClose) return
        debug("ticket:ok")

        const wsUrl = `${webSocketOrigin()}/ws?ticket=${encodeURIComponent(ticket)}`

        const created = new WebSocket(wsUrl)
        socket = created
        attachTestSocket(socket)
        debug("socket:create")
        // When THIS socket opened; null until it does, so a socket that never
        // opened (refused, handshake failed) is never an early cut.
        let openedAt: number | null = null

        socket.onopen = () => {
          openedAt = Date.now()
          startStableTimer()
          setWsStatus("connected")
          // The server is answering again after a restart (lib/server-pause.ts).
          noteServerBack()
          reconnectAttempt = 0
          wsLog.info("WebSocket connected")
          debug("socket:open")

          socket?.send(
            JSON.stringify({
              type: "hello",
              lastEventId: lastEventId(),
              // S53 (D29): this client's session store holds the main thread
              // only; a subagent's events come by `?parent=` while its drawer
              // is open, never over the socket.
              nodeSessionEvents: "top",
              ...(options.getClientKind
                ? {
                    clientKind: options.getClientKind(),
                    lastActiveAt: options.getLastActiveAt?.() ?? Date.now(),
                    deviceId: (options.getDeviceId ?? notificationDeviceId)(),
                    ...permissionField(),
                    ...viewingField(),
                    ...nodeField(),
                  }
                : {}),
            }),
          )

          startPing()
        }

        socket.onmessage = (e) => {
          try {
            const msg: WsMessage = JSON.parse(e.data)

            if (msg.type === "pong") {
              clearPongTimeout()
              return
            }

            if (msg.type === "sync") {
              wsLog.info("Full sync required")
              options.onSyncRequired?.()
              emit(msg)
              return
            }

            if (msg.type === "event" && msg.eventId) {
              setLastEventId(msg.eventId)
              localStorage.setItem(scopedKey(), String(msg.eventId))
            }

            emit(msg)
          } catch (err) {
            wsLog.error({ err }, "Failed to parse WS message")
          }
        }

        socket.onclose = (e) => {
          // A socket already replaced (dropped as dead, then a new one opened)
          // closing late says nothing about the current one: its status, ping
          // and reconnect belong to the new socket.
          if (socket !== created) return
          socket = null
          setWsStatus("disconnected")
          stopPing()
          wsLog.info({ code: e.code }, "WebSocket closed")
          debug(`socket:close:${e.code}`)
          clearStableTimer()

          // Intentional disconnect — do not reconnect
          if (manualClose) return

          // Going offline drops the socket too; that is the offline state, not
          // something cutting a working connection.
          if (openedAt !== null && navigator.onLine) noteClose(e.code, Date.now() - openedAt)

          // A server restart: reconnect now (jittered), not counted as a failure.
          if (e.code === SERVICE_RESTART_CLOSE) {
            // The one sign that this pause is a deploy, not the network (lib/server-pause.ts).
            noteServerRestarting()
            reconnectAttempt = 0
            scheduleReconnect({ now: true, jitterMs: RESTART_RECONNECT_JITTER_MS })
            return
          }

          // The demo workspace is over: never reconnect, leave it (once).
          if (e.code === DEMO_WORKSPACE_EXPIRED_WS_CLOSE) {
            noteDemoWorkspaceExpired()
            return
          }

          if (e.code === 4001 || e.code === 4010) {
            // 4001 = token rejected, 4010 = permissions changed — refresh and retry
            wsLog.info(
              { code: e.code },
              e.code === 4010 ? "Permissions changed — refreshing" : "Token rejected — refreshing",
            )
            // 4010 = permissions changed: the current token is NOT near expiry
            // but carries a stale permissionVersion, so the refresh must be
            // forced or ensureFreshToken no-ops and the server closes 4010 again.
            options.ensureFreshToken?.({ force: e.code === 4010 }).then(
              () => scheduleReconnect(),
              () => wsLog.warn("Token refresh failed after close — stopping reconnect"),
            )
            return
          }

          scheduleReconnect()
        }

        socket.onerror = () => {
          wsLog.warn("WebSocket error")
        }
      })
      .catch((err) => {
        connecting = false
        wsLog.warn({ err }, "WS ticket exchange failed")
        debug(`ticket:fail:${err instanceof Error ? err.name : "unknown"}`)
        if (!manualClose) scheduleReconnect()
      })
  }

  function disconnect() {
    manualClose = true
    connecting = false
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (offlineHandler) {
      window.removeEventListener("online", offlineHandler)
      offlineHandler = null
    }
    removeLifecycle?.()
    removeLifecycle = null
    stopPing()
    resetInstability()
    reconnectAttempt = 0
    socket?.close()
    socket = null
    attachTestSocket(null)
    setWsStatus("disconnected")
    debug("disconnect:manual")
  }

  function clearLastEventId() {
    setLastEventId(0)
    localStorage.removeItem(scopedKey())
  }

  function isOffline(): boolean {
    return !navigator.onLine || sourceOffline
  }

  /**
   * `now`: a probe found no socket (or the server restarted); try at once
   * without growing the backoff. `jitterMs`: spread a `now` over 0..jitterMs.
   */
  function scheduleReconnect(opts: { now?: boolean; jitterMs?: number } = {}) {
    // An ended demo workspace is left, not reconnected to (lib/demo-expired.ts).
    if (demoWorkspaceEnded()) return
    // Idempotency guard: if a reconnect is already scheduled or a connect is
    // in progress (covering the async ticket-fetch gap), do not spawn another.
    // A live socket needs none either (a late `online` event after a probe
    // already reconnected).
    if (
      reconnectTimer !== null ||
      connecting ||
      socket?.readyState === WebSocket.OPEN ||
      socket?.readyState === WebSocket.CONNECTING
    ) {
      debug("reconnect:skip-duplicate")
      return
    }

    if (isOffline()) {
      wsLog.info("Offline — pausing reconnection")
      debug("reconnect:offline")
      // Clean up any previous offline handler
      if (offlineHandler) {
        window.removeEventListener("online", offlineHandler)
      }
      offlineHandler = () => {
        offlineHandler = null
        scheduleReconnect()
      }
      window.addEventListener("online", offlineHandler, { once: true })
      return
    }

    setWsStatus("reconnecting")
    const delay = opts.now
      ? Math.round(Math.random() * (opts.jitterMs ?? 0))
      : reconnectDelay(reconnectAttempt)
    if (!opts.now) reconnectAttempt++

    wsLog.debug({ delay, attempt: reconnectAttempt }, "Scheduling reconnect")
    debug(`reconnect:scheduled:${delay}`)
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null
      // AWAIT the refresh: connecting with a possibly-expired token turns
      // every reconnect into a guaranteed 401 ticket-exchange failure.
      try {
        await options.ensureFreshToken?.()
      } catch {
        wsLog.warn("Token refresh failed before reconnect")
        debug("reconnect:refresh-failed")
      }
      if (manualClose) return
      debug("reconnect:connect")
      connect()
    }, delay)
  }

  function noteClose(code: number, openForMs: number) {
    if (EXPECTED_CLOSE_CODES.has(code) || openForMs > EARLY_CUT_MS) return
    const now = Date.now()
    earlyCuts = earlyCuts.filter((at) => now - at < UNSTABLE_WINDOW_MS)
    earlyCuts.push(now)
    debug(`unstable:early-cut:${earlyCuts.length}`)
    if (earlyCuts.length >= UNSTABLE_CUT_COUNT && !unstable()) {
      wsLog.warn(
        { cuts: earlyCuts.length, code },
        "Connection keeps dropping shortly after opening (VPN or network filter?)",
      )
      setUnstable(true)
    }
  }

  function startStableTimer() {
    clearStableTimer()
    stableTimer = setTimeout(() => {
      stableTimer = null
      resetInstability()
    }, STABLE_AFTER_MS)
  }

  function clearStableTimer() {
    if (stableTimer) {
      clearTimeout(stableTimer)
      stableTimer = null
    }
  }

  function resetInstability() {
    clearStableTimer()
    earlyCuts = []
    setUnstable(false)
  }

  /**
   * Ping and expect a pong within `timeoutMs`, else drop the socket and
   * reconnect. A pong already awaited keeps its earlier deadline. The timer is
   * armed before the send, so a pong can never arrive ahead of it.
   */
  function sendPing(timeoutMs: number, reason: string) {
    if (socket?.readyState !== WebSocket.OPEN) return
    if (!pongTimeout) {
      pongTimeout = setTimeout(() => {
        pongTimeout = null
        dropAndReconnect(reason)
      }, timeoutMs)
    }
    socket.send(JSON.stringify({ type: "ping" }))
  }

  function startPing() {
    stopPing()
    heartbeats = 0
    pingInterval = setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) return
      sendPing(PONG_TIMEOUT_MS, "pong-timeout")
      heartbeats++
      // Presence heartbeat (S6): keeps this connection a live notify target
      // (server TTL 60 s) and reports when the user last touched it.
      if (options.getClientKind && heartbeats % PRESENCE_EVERY_BEATS === 0) sendPresence()
    }, HEARTBEAT_INTERVAL_MS)
  }

  /**
   * The socket is dead though it never said so: stop listening to it, close
   * it, and reconnect now. Its `onclose` may come minutes later or never, so
   * nothing waits for it.
   */
  function dropAndReconnect(reason: string) {
    if (manualClose) return
    wsLog.warn({ reason }, "Connection lost — reconnecting")
    debug(`drop:${reason}`)
    const dead = socket
    socket = null
    if (dead) {
      dead.onopen = null
      dead.onmessage = null
      dead.onclose = null
      dead.onerror = null
      try {
        dead.close()
      } catch {
        // Closing a socket that is already gone throws in some engines.
      }
    }
    stopPing()
    clearStableTimer()
    setWsStatus(isOffline() ? "disconnected" : "reconnecting")
    reconnectAttempt = 0
    scheduleReconnect()
  }

  /**
   * Something says the connection may have changed (focus, visible again,
   * online, foreground, wake). An open socket is pinged and must answer within
   * PROBE_TIMEOUT_MS; with no socket, a waiting reconnect goes now.
   */
  function probe(reason: string) {
    if (manualClose) return
    if (socket?.readyState === WebSocket.OPEN) {
      debug(`probe:${reason}`)
      sendPing(PROBE_TIMEOUT_MS, `probe-${reason}`)
      return
    }
    if (connecting || socket?.readyState === WebSocket.CONNECTING) return
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    debug(`probe:${reason}:reconnect`)
    scheduleReconnect({ now: true })
  }

  /** The listeners that notice a blip, installed by `connect`, removed by `disconnect`. */
  function installLifecycle() {
    if (removeLifecycle) return
    const offs: Array<() => void> = []
    const source = options.connectivity ?? connectivitySource()
    sourceOffline = !source.initial
    offs.push(
      source.subscribe((online) => {
        sourceOffline = !online
        if (online) probe("online")
        else dropAndReconnect("offline")
      }),
    )
    if (typeof window !== "undefined") {
      const onFocus = () => probe("focus")
      window.addEventListener("focus", onFocus)
      offs.push(() => window.removeEventListener("focus", onFocus))
    }
    if (typeof document !== "undefined") {
      const onVisibility = () => {
        if (document.visibilityState === "visible") probe("visible")
      }
      document.addEventListener("visibilitychange", onVisibility)
      offs.push(() => document.removeEventListener("visibilitychange", onVisibility))
    }
    if (options.onForeground) {
      try {
        const off = options.onForeground(() => probe("foreground"))
        if (typeof off === "function") offs.push(off)
      } catch (err) {
        wsLog.warn({ err }, "Foreground hook failed")
      }
    }
    // Wake detector: timers stop while the machine sleeps, so a tick that
    // comes far later than scheduled means the device just woke up.
    let lastTick = Date.now()
    const wake = setInterval(() => {
      const now = Date.now()
      const gap = now - lastTick
      lastTick = now
      if (gap > WAKE_GAP_MS) probe("wake")
    }, WAKE_CHECK_MS)
    offs.push(() => clearInterval(wake))
    removeLifecycle = () => {
      for (const off of offs) off()
    }
  }

  function stopPing() {
    if (pingInterval) {
      clearInterval(pingInterval)
      pingInterval = null
    }
    clearPongTimeout()
  }

  function clearPongTimeout() {
    if (pongTimeout) {
      clearTimeout(pongTimeout)
      pongTimeout = null
    }
  }

  function permissionField(): { notificationPermission?: string } {
    const permission = options.getNotificationPermission?.()
    return permission ? { notificationPermission: permission } : {}
  }

  function viewingField(): { viewing?: { threadIds: string[]; focused: boolean } } {
    return options.getViewing ? { viewing: options.getViewing() } : {}
  }

  function nodeField(): { nodeCredential?: string } {
    const credential = options.getNodeCredential?.()
    return credential ? { nodeCredential: credential } : {}
  }

  function sendPresence() {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "presence",
          lastActiveAt: options.getLastActiveAt?.() ?? Date.now(),
          ...permissionField(),
          ...viewingField(),
        }),
      )
    }
  }

  function send(data: unknown) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data))
    }
  }

  // Auto-cleanup when the owning reactive scope is disposed
  onCleanup(disconnect)

  return {
    status,
    /** True while sockets keep being cut seconds after they open (VPN, network filter). */
    unstable,
    lastEventId,
    connect,
    disconnect,
    clearLastEventId,
    on,
    send,
    sendPresence,
  }
}
