// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The device side of push: ask for permission, hand the platform token to the
// backend, and keep that registration honest for the life of the install.
//
// Three rules live here, and each of them is silent when broken:
//
//   - THE PROMPT IS ASKED LAST. iOS shows the notification permission dialog
//     once per install. Asking before the app knows which server it talks to,
//     or before anybody is signed in, spends that one dialog on a screen the
//     user cannot yet make sense of, and a refusal is then permanent. So the
//     gates come first: a native platform, a stored server address, a bearer.
//   - THE LISTENER IS ATTACHED BEFORE `register()`. The platform can deliver
//     the token before `register()` resolves, so a listener wired afterwards
//     drops it on exactly the launch that had a fresh token.
//   - A REFUSED POST IS NOT A REGISTRATION. Remembering a token the backend
//     never accepted means the next launch sees no change and never retries,
//     and the handset is unreachable with nothing in any log.
//   - NO TOKEN IS NEVER A RESTING STATE. A `register()` whose token never
//     came back (a `registrationError`, a call that threw, a permission
//     granted later in Settings) is asked again: on a backoff after the
//     error, on every return to the app and on every new bearer. Waiting for
//     the next cold launch left a phone silent until somebody signed in again.
//
// The backend contract is apps/api/src/modules/push/routes.ts: POST and DELETE
// /api/push/tokens with `{platform, token}`, owned by the authenticated
// caller. An iOS POST also names the APNs `environment` the token belongs to
// (S11), which the server uses to pick the APNs host. Every seam is injected, because none of Capacitor, the network or
// the session exists in a bun test.

import { serverAddressOrigin } from "./boot/server-global"
import { type DeepLinkQueue, deepLinkQueue, SESSION_LINK_PREFIX } from "./deep-link"
import type { ApsEnvironment } from "./native/liaison-native"
import { PUSH_NOTICE_FALLBACK } from "./onboarding/mobile-copy"
import { SERVER_ADDRESS_KEY } from "./onboarding/server-address"
import {
  isRetryableRegisterStatus,
  presentationOutcome,
  type ReceiptClient,
  type ReceiptInput,
  receiptOrigin,
  registrationBackoffMs,
  storeRegistrationCredential,
} from "./receipts"

/** The link a payload names, built from its thread id when it names none. */
export const THREAD_LINK_PREFIX = "liaison://thread/"

/** The route the register and unregister calls hit, on whichever server. */
export const PUSH_TOKENS_PATH = "/api/push/tokens"
/** The person's badge, and which delivered notifications are settled (rule 5, 6). */
export const BADGE_PATH = "/api/notifications/badge"
/** The most settle keys one foreground asks about (the server's own bound). */
export const SETTLE_KEYS_MAX = 200

/** The two platforms the backend accepts. Anything else has no native push. */
export type PushPlatform = "ios" | "android"

/**
 * Just enough of `fetch`. The DOM lib's own `typeof fetch` carries `preconnect`
 * in this TypeScript version, which no test double has and none should need.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** The subset of @capacitor/push-notifications this client uses. */
export interface PushPlugin {
  requestPermissions: () => Promise<{ receive: string }>
  register: () => Promise<void>
  /**
   * Clears the notification centre. On iOS it also sets the icon badge to 0
   * (the core plugin does both), so no badge plugin is needed.
   */
  removeAllDeliveredNotifications: () => Promise<void>
  /**
   * Removes these delivered notifications only (the core plugin's call). Where
   * it exists, the foreground withdraws what was read elsewhere and keeps the
   * rest (rule 5); where it does not, the foreground clears everything.
   */
  removeDeliveredNotifications?: (delivered: {
    notifications: Array<{ id?: string; data?: unknown }>
  }) => Promise<void>
  /**
   * What the OS has presented and still shows. Optional: read on foreground,
   * before the clear, to post the final `shown` for pushes that landed while
   * the app was in the background (A3).
   */
  getDeliveredNotifications?: () => Promise<{ notifications: Array<{ data?: unknown }> }>
  addListener: (event: string, handler: (payload: unknown) => void) => unknown
}

export interface PushClientDependencies {
  plugin: PushPlugin
  /** `Capacitor.getPlatform()`. */
  platform: () => string
  /**
   * The current bearer, or null when nobody is signed in. It is READ, never
   * minted: the refresh bridge captures the access token out of every auth
   * answer the app receives (auth/refresh-bridge.ts), so this client never
   * calls /api/auth/refresh itself. It used to, and the refresh token is
   * single use: the two callers raced on every relaunch, the loser got a 401,
   * and on a first login the client had already run and never ran again.
   */
  accessToken: () => Promise<string | null>
  /** The address first launch settled, or null before it has. */
  serverAddress: () => Promise<string | null>
  fetchImpl?: FetchLike
  /** Where a tapped notification is routed. The same fail closed queue. */
  queue?: DeepLinkQueue
  /** Applies the payload's badge count in the app. */
  setBadge?: (count: number) => void
  /**
   * Where the in app notice is rendered (Android only: on iOS the system
   * banner presents a foreground push, see `onPresentation`).
   */
  document?: Document
  /**
   * This build's APNs environment (native/liaison-native.ts). Asked for iOS
   * tokens only; null or a failure sends no field, which the server reads as
   * `production`.
   */
  apsEnvironment?: () => Promise<ApsEnvironment | null>
  /**
   * Subscribes to the app becoming active. Each time it does, the token is
   * posted again and the delivered notifications of what was read are
   * withdrawn (rule 5; everything, with a plugin that cannot remove a few).
   */
  onForeground?: (handler: () => void) => unknown
  /**
   * The conversation the app has on screen, or null (native/thread-on-screen.ts).
   * A push for it that lands while the app is open raises no notice: the user
   * is already reading it. Read only where `onPresentation` is not wired.
   */
  threadOnScreen?: () => string | null
  /**
   * iOS: the native presenter's decision for each push that lands while the
   * app is open (`{outcome, reason?, data}`, ios/App/App/ForegroundPushPresenter.swift).
   * iOS draws the system banner itself, so when this is wired the client
   * raises no notice of its own and posts the receipt from the decision, never
   * from a guess. Unwired (Android), the client decides and shows its notice.
   */
  onPresentation?: (handler: (event: unknown) => void) => unknown
  /**
   * Delivery receipts (receipts.ts). The registration answer's credential is
   * stored through it, and the app's final outcome (shown, suppressed) and the
   * App Group queue the NSE fills offline are posted through it.
   */
  receipts?: ReceiptClient
  /**
   * Runs `run` after `ms`, answering a cancel. A failed registration POST is
   * retried on this timer with exponential backoff (S3). setTimeout by default.
   */
  schedule?: (run: () => void, ms: number) => () => void
  /**
   * Debug builds only (M5): answers true once per armed toggle, and the next
   * registration POST is then failed without being sent.
   */
  forceRegisterFailure?: () => Promise<boolean>
  /**
   * A tapped notification names ANOTHER server than the one the phone is on:
   * the phone signed in to several servers receives from all of them. This
   * moves the phone to that saved server and opens the item there
   * (servers/server-list.ts `openOn`). Unwired, such a tap opens nothing.
   */
  openOnServer?: (server: string, link: string) => Promise<unknown>
  /**
   * Whether this phone knows several servers. Sent with every registration
   * (`multiServer`), so the server names its organisation in the alert only
   * when there is another one to tell it apart from.
   */
  multiServer?: () => Promise<boolean>
}

/** What `start()` decided. Every value is a reason, never a bare boolean. */
export type PushStartResult =
  | "unsupported-platform"
  | "no-server"
  | "not-authenticated"
  | "permission-denied"
  | "registering"
  | "re-registered"

export interface PushClient {
  /** Runs the gates and, when they pass, registers with the platform. */
  start: () => Promise<PushStartResult>
  /** Resolves once every registration call this client started has finished. */
  settled: () => Promise<void>
  /** The token the backend has accepted, or null. */
  registeredToken: () => string | null
  /** Signing out: the backend must stop sending to this device. */
  logout: () => Promise<void>
  /** The app is active again: clear the badge, re-assert the registration. */
  foreground: () => Promise<void>
  /**
   * The saved servers changed (one added or removed): the registration is
   * posted again, with the new `multiServer`, and this resolves once it is.
   */
  refreshRegistration: () => Promise<void>
}

function nativePlatform(platform: string): PushPlatform | null {
  return platform === "ios" || platform === "android" ? platform : null
}

/** The `data` object Capacitor hands back, on either platform. */
function payloadData(event: unknown): Record<string, unknown> | null {
  const notification = (event as { notification?: { data?: unknown } })?.notification
  const data = notification?.data
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null
}

/**
 * The `liaison://` link a payload names: its own `deepLink`, or one built from
 * its `threadId`, or from its `sessionId` (a node session push). Either way the string is handed to the deep link parser,
 * which is the thing that decides whether it is routable.
 */
export function payloadLink(event: unknown): string | null {
  const data = payloadData(event)
  if (data === null) return null
  // A thread-less attention item (an approval) names its `route`; a server
  // that predates its deep link sent the bare `liaison://attention` beside it.
  if (
    typeof data.route === "string" &&
    data.route.startsWith("attention/") &&
    (typeof data.deepLink !== "string" || !data.deepLink.startsWith(THREAD_LINK_PREFIX))
  ) {
    // A message in an entity's thread (a task comment) opens the entity with
    // that message brought into view; the deep link parser checks both ids.
    const focus =
      typeof data.messageId === "string" &&
      data.messageId.length > 0 &&
      typeof data.threadId === "string" &&
      data.threadId.length > 0 &&
      !data.route.includes("?")
        ? `?thread=${data.threadId}&message=${data.messageId}`
        : ""
    return `liaison://${data.route}${focus}`
  }
  if (typeof data.deepLink === "string" && data.deepLink.length > 0) return data.deepLink
  if (typeof data.threadId === "string" && data.threadId.length > 0) {
    return `${THREAD_LINK_PREFIX}${data.threadId}`
  }
  if (typeof data.sessionId === "string" && data.sessionId.length > 0) {
    return `${SESSION_LINK_PREFIX}${data.sessionId}`
  }
  return null
}

/**
 * Whether a payload may be acted on by an install bound to `server`. A payload
 * that names its origin must name this one: a phone set up for server A that
 * still holds a token registered with server B would otherwise route B's
 * thread id against A. A payload that names none (a server from before the
 * field existed) is accepted.
 */
export function payloadFromServer(
  payload: Record<string, unknown> | null,
  server: string | null,
): boolean {
  const named = payload?.server
  if (named === undefined || named === null) return true
  if (typeof named !== "string" || server === null) return false
  const origin = serverAddressOrigin(named)
  return origin !== null && origin === serverAddressOrigin(server)
}

/**
 * Where a tapped notification goes: through the deep link queue when it is
 * this server's, to `openOnServer` when it names another one the phone may be
 * signed in to. A payload that names no server is this server's (a server from
 * before the field existed). Nothing in the payload is trusted further than a
 * typed link: the queue and `openOn` both parse it fail closed.
 */
export function routeTappedPayload(
  payload: Record<string, unknown> | null,
  server: string | null,
  queue: Pick<DeepLinkQueue, "onAppUrlOpen">,
  openOnServer?: (server: string, link: string) => Promise<unknown>,
): "here" | "other-server" | "nowhere" {
  const link = payloadLink({ notification: { data: payload } })
  if (link === null) return "nowhere"
  if (payloadFromServer(payload, server)) {
    queue.onAppUrlOpen(link)
    return "here"
  }
  const named = payload?.server
  if (typeof named !== "string" || !openOnServer) return "nowhere"
  void openOnServer(named, link).catch(() => undefined)
  return "other-server"
}

/**
 * The in app notice element's id. Exported because the tests read the artifact.
 * Android only: on iOS a foreground push is the system banner.
 */
export const PUSH_NOTICE_ID = "liaison-push-notice"

/** How long the in app notice stays up when nobody taps it, like the system banner. */
export const PUSH_NOTICE_MS = 6000

/**
 * The badge, in the app. The OS badge is set by the notification itself (the
 * sender puts `badgeCount` in the APNs `aps.badge` and the FCM
 * `notification_count`), so nothing here has to reach the platform: this is
 * the in app mirror, and on a webview that implements the badging API it also
 * updates the icon while the app is open.
 */
export function defaultSetBadge(count: number): void {
  try {
    const badging = navigator as unknown as { setAppBadge?: (value: number) => Promise<void> }
    void badging.setAppBadge?.(count)
  } catch {
    // A webview without the badging API is the normal case, not a failure.
  }
}

export function createPushClient(deps: PushClientDependencies): PushClient {
  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch
  const queue = deps.queue ?? deepLinkQueue
  const setBadge = deps.setBadge ?? defaultSetBadge
  const doc = deps.document ?? (typeof document === "undefined" ? null : document)

  const schedule =
    deps.schedule ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    })
  let cancelNotice: (() => void) | null = null

  /** One notice at a time: a stack of them is a screen nobody can use. */
  const showNotice = (payload: Record<string, unknown>): void => {
    if (doc === null) return
    doc.getElementById(PUSH_NOTICE_ID)?.remove()
    const notice = doc.createElement("button")
    notice.id = PUSH_NOTICE_ID
    notice.setAttribute("type", "button")
    notice.setAttribute("role", "status")
    const title = typeof payload.title === "string" ? payload.title : null
    const body = typeof payload.body === "string" ? payload.body : null
    // Another server's notice says which organisation it is from.
    const label =
      !payloadFromServer(payload, server) && typeof payload.serverLabel === "string"
        ? payload.serverLabel.trim() || null
        : null
    const text =
      title === null && body === null
        ? PUSH_NOTICE_FALLBACK
        : [title, body].filter(Boolean).join(": ")
    notice.textContent = label ? `${label}: ${text}` : text
    notice.style.cssText = [
      "position:fixed",
      "top:calc(8px + env(safe-area-inset-top))",
      "left:8px",
      "right:8px",
      "z-index:2147483646",
      "min-height:44px",
      "padding:12px",
      "border:0",
      "border-radius:12px",
      "text-align:left",
      "background:#3f4a63",
      "color:#ffffff",
      "font:16px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif",
    ].join(";")
    notice.addEventListener("click", () => {
      notice.remove()
      routeTappedPayload(payload, server, queue, deps.openOnServer)
    })
    doc.documentElement.appendChild(notice)
    // It goes away by itself: left up, it covered the header and its back
    // button through every later screen until tapped (walk 2026-10-08).
    cancelNotice?.()
    cancelNotice = schedule(() => notice.remove(), PUSH_NOTICE_MS)
  }
  let platform: PushPlatform | null = null
  let server: string | null = null
  let registered: string | null = null
  // The last token the PLATFORM handed over, whether or not the backend took
  // it. `start()` runs again whenever the bearer changes, and the platform
  // hands nothing over a second time, so this is what a re-assertion sends.
  let deviceToken: string | null = null
  // iOS asks once per install, and the listeners are attached once per page:
  // a second `start()` that re-attached them would run every handler twice.
  let armed = false
  // Whether the OS granted notifications. Asked once per armed client and
  // again only while it is not granted (a refusal can be lifted in Settings,
  // and asking again shows no dialog once the user has answered).
  let permissionGranted = false
  // The platform registration in progress: a foreground, a new bearer and a
  // retry that land together share it rather than racing the prompt.
  let asking: Promise<"permission-denied" | "registering"> | null = null
  // Consecutive `registrationError`s, and the `register()` retry they armed.
  let registerFailures = 0
  let cancelRegisterRetry: (() => void) | null = null
  // Every listener callback is synchronous (the plugin ignores what it
  // returns), so the work it starts is tracked here rather than lost.
  let inFlight: Promise<void> = Promise.resolve()

  const track = (work: Promise<void>): void => {
    inFlight = inFlight.then(() => work).catch(() => {})
  }

  /** Until nothing is in flight, including work tracked by tracked work. */
  const drain = async (): Promise<void> => {
    let seen: Promise<void>
    do {
      seen = inFlight
      await seen
    } while (seen !== inFlight)
  }

  /**
   * One call to the tokens route. `skipped` when there is nothing to call
   * with (no bearer, no server): not a failure, and never retried.
   */
  type TokensResult =
    | { kind: "skipped" }
    | { kind: "done"; ok: boolean; status: number | null; answer: unknown }

  const callTokens = async (method: "POST" | "DELETE", token: string): Promise<TokensResult> => {
    const bearer = await deps.accessToken()
    if (!bearer || !server || !platform) return { kind: "skipped" }
    const body: Record<string, string | boolean> = { platform, token }
    if (method === "POST" && platform === "ios" && deps.apsEnvironment) {
      const environment = await deps.apsEnvironment().catch(() => null)
      if (environment) body.environment = environment
    }
    if (method === "POST" && deps.multiServer) {
      body.multiServer = await deps.multiServer().catch(() => false)
    }
    let response: Response
    try {
      response = await fetchImpl(`${server}${PUSH_TOKENS_PATH}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body),
      })
    } catch {
      return { kind: "done", ok: false, status: null, answer: null }
    }
    const answer = response.ok ? await response.json().catch(() => null) : null
    return { kind: "done", ok: response.ok, status: response.status, answer }
  }

  // Consecutive failed registration POSTs, and the retry waiting for its turn.
  let failures = 0
  let cancelRetry: (() => void) | null = null

  const stopRetry = (): void => {
    cancelRetry?.()
    cancelRetry = null
  }

  /**
   * Posts `token`. A failure that can clear up is retried with exponential
   * backoff (S3): the platform will not hand the token over again, so without
   * this a single refused POST left the handset unreachable until a relaunch.
   */
  const postToken = async (token: string): Promise<void> => {
    stopRetry()
    let result: TokensResult
    if (await (deps.forceRegisterFailure?.() ?? Promise.resolve(false)).catch(() => false)) {
      // The M5 dev toggle: this POST "fails" without being sent.
      result = { kind: "done", ok: false, status: null, answer: null }
    } else {
      result = await callTokens("POST", token)
    }
    if (result.kind === "skipped") {
      registered = null
      return
    }
    if (result.ok) {
      failures = 0
      registered = token
      if (deps.receipts && server) {
        await storeRegistrationCredential(deps.receipts.native, server, result.answer).catch(
          () => false,
        )
      }
      return
    }
    registered = null
    if (!isRetryableRegisterStatus(result.status)) return
    failures += 1
    cancelRetry = schedule(() => {
      cancelRetry = null
      if (deviceToken !== null) track(postToken(deviceToken))
    }, registrationBackoffMs(failures))
  }

  const stopRegisterRetry = (): void => {
    cancelRegisterRetry?.()
    cancelRegisterRetry = null
  }

  /**
   * Asks the platform for its token: the permission first while it is not
   * granted, then `register()`, whose answer is the `registration` event.
   */
  const askPlatform = (): Promise<"permission-denied" | "registering"> => {
    if (asking !== null) return asking
    asking = (async () => {
      try {
        if (!permissionGranted) {
          const permission = await deps.plugin.requestPermissions()
          if (permission.receive !== "granted") return "permission-denied" as const
          permissionGranted = true
        }
        await deps.plugin.register()
        return "registering" as const
      } finally {
        asking = null
      }
    })()
    return asking
  }

  /** Asks again in the background: a failure is retried by the next trigger. */
  const askPlatformAgain = (): void => {
    track(
      askPlatform().then(
        () => undefined,
        () => undefined,
      ),
    )
  }

  const onRegistration = (token: string): void => {
    if (typeof token !== "string" || token.length === 0) return
    registerFailures = 0
    stopRegisterRetry()
    deviceToken = token
    // The platform hands back the same token on nearly every cold start. The
    // route upserts, but a call per launch is a call that can fail per launch.
    if (token === registered) return
    track(postToken(token))
  }

  /** Posts the known token again. The route upserts, so this is idempotent. */
  const reassert = (): void => {
    if (deviceToken === null) return
    track(postToken(deviceToken))
  }

  /** Posts one receipt for `payload`, when it names a notification. */
  const postReceipt = (
    payload: Record<string, unknown> | null,
    input: Omit<ReceiptInput, "notificationId">,
  ): void => {
    const receipts = deps.receipts
    const notificationId = payload?.notificationId
    if (!receipts || payload === null || typeof notificationId !== "string" || !notificationId) {
      return
    }
    if (input.appState === "foreground") presentedInForeground.add(notificationId)
    const origin = receiptOrigin(payload, server)
    if (origin === null) return
    track(
      receipts
        .post(origin, { notificationId, ...input })
        .then(() => undefined)
        .catch(() => undefined),
    )
  }

  // Pushes already answered in the foreground. The banner's `.list` leaves
  // them in the notification centre, and they are not background pushes.
  const presentedInForeground = new Set<string>()

  /**
   * Pushes the OS presented while the app was away: still in the notification
   * centre, so shown (A3). Read BEFORE the foreground clears them.
   */
  const receiptDelivered = async (): Promise<Array<{ id?: string; data?: unknown }>> => {
    if (!deps.plugin.getDeliveredNotifications) return []
    const delivered = await deps.plugin.getDeliveredNotifications().catch(() => null)
    const list = delivered?.notifications ?? []
    if (!deps.receipts) return list
    for (const notification of list) {
      const data = notification?.data
      const payload = data && typeof data === "object" ? (data as Record<string, unknown>) : null
      const id = payload?.notificationId
      if (typeof id === "string" && presentedInForeground.has(id)) continue
      postReceipt(payload, { outcome: "shown", appState: "background" })
    }
    presentedInForeground.clear()
    return list
  }

  /**
   * The server's badge and, of the settle keys asked, the ones read or
   * resolved; null when it cannot say.
   */
  const readBadge = async (
    settle: string[],
  ): Promise<{ count: number; settled: Set<string> } | null> => {
    const bearer = await deps.accessToken().catch(() => null)
    if (!bearer || !server) return null
    try {
      const response = await fetchImpl(`${server}${BADGE_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ settle }),
      })
      if (!response.ok) return null
      const answer = (await response.json().catch(() => null)) as {
        data?: { count?: unknown; settled?: unknown }
      } | null
      const count = answer?.data?.count
      const keys = answer?.data?.settled
      if (typeof count !== "number" || !Array.isArray(keys)) return null
      return {
        count,
        settled: new Set(keys.filter((key): key is string => typeof key === "string")),
      }
    } catch {
      return null
    }
  }

  /**
   * RULE 5: opening the app clears only what was read. Each delivered
   * notification of this server carries the key of the exact thing it
   * announced (`settle`: a message, an approval, an alert); the server says
   * which of those were read or resolved, on any device, and only those are
   * withdrawn. A notification without a key (from an older server, a burst
   * summary) or from another server stays until the person clears it: nothing
   * is inferred from a key the server did not name. The badge takes the
   * server's number instead of zero. A plugin without the targeted call falls
   * back to the old clear-all; a server that cannot answer leaves everything
   * as it is.
   */
  const settleDelivered = async (
    delivered: Array<{ id?: string; data?: unknown }>,
  ): Promise<void> => {
    const remove = deps.plugin.removeDeliveredNotifications
    if (!remove) {
      setBadge(0)
      await deps.plugin.removeAllDeliveredNotifications().catch(() => {})
      return
    }
    const keyed: Array<{ notification: { id?: string; data?: unknown }; key: string }> = []
    for (const notification of delivered) {
      const data =
        notification.data && typeof notification.data === "object"
          ? (notification.data as Record<string, unknown>)
          : null
      const key = data?.settle
      if (typeof key !== "string" || key.length === 0) continue
      if (!payloadFromServer(data, server)) continue
      keyed.push({ notification, key })
    }
    const reading = await readBadge([...new Set(keyed.map((k) => k.key))].slice(0, SETTLE_KEYS_MAX))
    if (!reading) return
    setBadge(reading.count)
    const read = keyed.filter((k) => reading.settled.has(k.key)).map((k) => k.notification)
    if (read.length > 0) await remove.call(deps.plugin, { notifications: read }).catch(() => {})
  }

  const foreground = async (): Promise<void> => {
    track(
      (async () => {
        const delivered = await receiptDelivered()
        await settleDelivered(delivered)
      })(),
    )
    // What the NSE could not post while the phone was offline.
    if (deps.receipts) track(deps.receipts.flush().then(() => undefined))
    // Only once armed: a foreground before anybody signed in asks nothing.
    // With a token, it is posted again (a row the server dropped comes back);
    // without one, the platform is asked for it again, because the token of
    // the launch that asked may never have arrived.
    if (armed) {
      if (deviceToken !== null) reassert()
      else askPlatformAgain()
    }
    await drain()
  }

  deps.onForeground?.(() => {
    void foreground()
  })

  return {
    async start(): Promise<PushStartResult> {
      platform = nativePlatform(deps.platform())
      if (platform === null) return "unsupported-platform"
      // Launch: whatever the NSE queued while the phone was offline. It needs
      // no session, only the credentials already in the keychain.
      if (deps.receipts) track(deps.receipts.flush().then(() => undefined))
      const address = await deps.serverAddress()
      if (!address) return "no-server"
      server = address.replace(/\/+$/, "")
      if (!(await deps.accessToken())) return "not-authenticated"
      if (armed) {
        // A NEW BEARER, not a new launch. The prompt is spent and the
        // listeners are live; what a rotation invalidates is the registration
        // the backend accepted under the old one, so it is asserted again.
        // No token yet: the platform is asked again (a sign-in after a failed
        // or refused registration is exactly when it can now succeed).
        if (deviceToken === null) return askPlatform()
        reassert()
        return "re-registered"
      }
      armed = true

      deps.plugin.addListener("registration", (event: unknown) =>
        onRegistration((event as { value?: string })?.value ?? ""),
      )
      // A tap and a `liaison://` link from anywhere else on the device are the
      // same navigation, through the same fail closed parser and the same
      // queue: the payload comes from Apple or Google, which is to say from
      // whoever can get a push to this device, so nothing in it is trusted
      // further than a link typed into the address bar would be.
      deps.plugin.addListener("pushNotificationActionPerformed", (event: unknown) => {
        // A tap is the user looking at it: shown, whatever came before.
        postReceipt(payloadData(event), { outcome: "shown", appState: "background" })
        // Another saved server's notification opens that server, then the item.
        routeTappedPayload(payloadData(event), server, queue, deps.openOnServer)
      })

      // iOS: the system banner presents a push that lands while the app is
      // open, or nothing for the conversation on screen. The native presenter
      // decides (ForegroundPushPresenter.swift) and this posts what it decided
      // (A3): TestFlight build 17 posted `shown` for an in-app strip while the
      // owner saw no banner at all (2026-10-12).
      deps.onPresentation?.((event: unknown) => {
        const decision = event as { outcome?: unknown; reason?: unknown; data?: unknown }
        const data = decision?.data
        const payload = data && typeof data === "object" ? (data as Record<string, unknown>) : null
        if (decision?.outcome === "shown") {
          postReceipt(payload, { outcome: "shown", appState: "foreground" })
        } else if (decision?.outcome === "suppressed" && typeof decision.reason === "string") {
          postReceipt(payload, {
            outcome: "suppressed",
            reason: decision.reason,
            appState: "foreground",
          })
        }
      })

      // A push that lands while the app is open. On iOS the system banner is
      // the notification (above); this only applies the badge. Elsewhere the
      // OS raises nothing for a foregrounded app, so the notice below IS the
      // notification, and it carries only what the payload carries, which for
      // a scope tagged message is no text at all.
      deps.plugin.addListener("pushNotificationReceived", (event: unknown) => {
        const data = (event as { data?: unknown })?.data
        const payload = data && typeof data === "object" ? (data as Record<string, unknown>) : null
        if (payload === null) return
        const badgeCount = payload.badgeCount
        if (typeof badgeCount === "number" && Number.isFinite(badgeCount)) setBadge(badgeCount)
        if (deps.onPresentation) return
        // Not for the conversation on screen: the message is already in front
        // of the user, and a banner announcing it covers the very screen they
        // are reading. Every other conversation still gets its notice.
        // The presentation delegate's final outcome (A3): the NSE has posted
        // `received` already; this says what the user got.
        const onScreen = deps.threadOnScreen?.() ?? null
        const decision = presentationOutcome(payload, onScreen)
        postReceipt(payload, { ...decision, appState: "foreground" })
        if (decision.outcome === "suppressed") return
        showNotice(payload)
      })

      deps.plugin.addListener("registrationError", (event: unknown) => {
        // A failed attempt leaves no stale registration claiming this device
        // is reachable, and is asked again on a backoff: APNs refuses a
        // registration for passing reasons (no network at launch, the push
        // service not yet up after an update), and the platform offers
        // nothing again by itself.
        void event
        registered = null
        registerFailures += 1
        stopRegisterRetry()
        cancelRegisterRetry = schedule(() => {
          cancelRegisterRetry = null
          askPlatformAgain()
        }, registrationBackoffMs(registerFailures))
      })

      return askPlatform()
    },
    async settled(): Promise<void> {
      await drain()
    },
    registeredToken(): string | null {
      return registered
    },
    foreground,
    async refreshRegistration(): Promise<void> {
      if (armed) reassert()
      await drain()
    },
    async logout(): Promise<void> {
      stopRetry()
      stopRegisterRetry()
      await drain()
      stopRetry()
      stopRegisterRetry()
      failures = 0
      registerFailures = 0
      // The server revokes the credential (logout names the device, and the
      // DELETE below drops its row); the keychain copy goes too, so the NSE
      // stops posting for a session that has ended.
      const origin = server === null ? null : serverAddressOrigin(server)
      if (deps.receipts && origin !== null) {
        await deps.receipts.native.deleteCredential(origin).catch(() => undefined)
      }
      const token = registered
      if (token === null) return
      registered = null
      await callTokens("DELETE", token).catch(() => null)
    },
  }
}

/** Just the half of an access-token store this file needs. */
export interface AccessTokenSource {
  get: () => string | null
  subscribe: (listener: (token: string | null) => void) => () => void
}

export interface PushArmingDependencies {
  /** Where the bearer comes from. The refresh bridge fills it. */
  accessTokens: AccessTokenSource
  /** Runs the client's gates. Called once per distinct bearer, never before. */
  start: () => Promise<unknown>
  /**
   * Revokes what this arming registered. The client's own `logout`, which
   * DELETEs the row the backend fans out to.
   */
  stop?: () => Promise<void>
  /**
   * Where the shell's sign-out hook lives (main.ts). Arming and revoking are
   * wired in ONE place on purpose: a registration armed here and revoked
   * nowhere is a handset that keeps receiving a signed-out user's messages,
   * and nothing in any log says so.
   */
  onSessionEnd?: (handler: () => Promise<void>) => () => void
}

/**
 * Registration starts when BOTH halves exist, and never before.
 *
 * The server address is the caller's half: this is only reached once first
 * launch has settled one (main.ts). The bearer is the other half, and it can
 * arrive much later than boot (a first login) or change mid-session (a
 * rotation), so it is SUBSCRIBED to rather than sampled once. Sampling once is
 * what made the permission prompt appear on no path at all: at boot there was
 * no session yet, and nothing ever asked again.
 *
 * Returns the disposer for the subscription.
 */
export function armPushRegistration(deps: PushArmingDependencies): () => void {
  let last: string | null = null
  const run = (token: string | null): void => {
    if (token === null || token === last) return
    last = token
    void deps.start().catch(() => {
      // A failed attempt leaves `last` set for this bearer: the next rotation
      // tries again, and a retry loop on the same token would only repeat it.
    })
  }
  const dispose = deps.accessTokens.subscribe(run)
  const disposeHook =
    deps.stop && deps.onSessionEnd ? deps.onSessionEnd(deps.stop) : () => undefined
  run(deps.accessTokens.get())
  return () => {
    disposeHook()
    dispose()
  }
}

/** Reads the address first launch stored, through the storage seam it uses. */
export function createStoredServerAddress(storage: {
  get: (key: string) => Promise<string | null>
}): () => Promise<string | null> {
  return () => storage.get(SERVER_ADDRESS_KEY)
}
