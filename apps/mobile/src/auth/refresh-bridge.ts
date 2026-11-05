// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How a WRAPPED session survives its first access-token expiry.
//
// apps/web keeps its refresh token in the `liaison_rt` cookie, HttpOnly and
// SameSite=Strict. Inside this shell the page is served from
// `capacitor://localhost` and the server is somewhere else entirely, so every
// call is cross site and that cookie is attached to none of them: the session
// died the moment the access token expired, and the push client could never
// mint the bearer its two token calls need.
//
// The server side of the fix is in apps/api/src/lib/response.ts: a request
// from one of the shells' own origins is answered with the refresh token in
// the BODY and no cookie, and /api/auth/refresh takes that token back in the
// `X-Liaison-Refresh` header. This is the device side of the same contract,
// and it lives in the SHELL rather than in apps/web because apps/web is
// wrapped unmodified (S15): a fetch wrapper installed by the boot bundle sees
// every call the app makes without the app knowing anything about it.
//
// IT IS NARROW ON PURPOSE. The header is added to one path, on one origin (the
// server this install is bound to, compared as an ORIGIN and never as a string
// prefix), and the body is read only for the auth paths that can carry a
// token. Anything else passes through untouched, including the Response the
// caller gets back: the body is read from a clone.

/** The header the API accepts the refresh token in. */
export const REFRESH_HEADER = "X-Liaison-Refresh"
/** Where a rotation happens, and the only path the header is sent on. */
export const REFRESH_PATH = "/api/auth/refresh"
/** Where a session ends, and the token stored here stops being worth keeping. */
export const LOGOUT_PATH = "/api/auth/logout"
/** The key the token is stored under, in the OS secret store (auth/secret-store.ts). */
export const REFRESH_TOKEN_KEY = "liaison.refreshToken"

/** Every auth path whose answer may carry a fresh refresh token. */
const TOKEN_BEARING_PREFIX = "/api/auth/"
/**
 * The one sign-in outside /api/auth/: a visitor's demo workspace is created
 * and signed into by this call, answered like a login (apps/api modules/demo/
 * routes.ts). Exact path: its status polls carry no session.
 */
export const DEMO_SIGNUP_PATH = "/api/demo/orgs"

function bearsTokens(path: string | null): boolean {
  return path !== null && (path.startsWith(TOKEN_BEARING_PREFIX) || path === DEMO_SIGNUP_PATH)
}

/** Where the token lives between launches. Native storage in the app. */
export interface RefreshTokenStore {
  load: () => Promise<string | null>
  save: (token: string) => Promise<void>
  clear: () => Promise<void>
}

/** Just enough of `fetch`, matching the seam the push client already uses. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface RefreshBridgeDependencies {
  fetchImpl: FetchLike
  /** The bound server's origin, or null before first launch has settled one. */
  serverOrigin: () => string | null
  store: RefreshTokenStore
  /**
   * Where the access token in an auth answer is published, when the shell has
   * something that needs one (push registration). Optional: a bridge without
   * it is the pure refresh-token bridge it was.
   */
  accessTokens?: AccessTokenStore
  /**
   * Resolves once the shell KNOWS which server this install is bound to,
   * whether or not there is one.
   *
   * The bound origin is read from native storage, which answers a tick or two
   * after the page starts, and the wrapped app fires its session refresh in
   * its very first tick. Without something to wait on, that refresh went out
   * with no token, the server answered 401, and the app landed on the login
   * screen with a perfectly good session in storage. Only the two token calls
   * wait, only while the origin is still unknown, and a deployment that
   * settles on no address at all resolves this too.
   */
  serverOriginSettled?: () => Promise<void>
  /**
   * What the SHELL itself has to undo when the session ends, run while the
   * bearer that authenticates it is still in the store and before the tokens
   * are dropped. The push registration is the one that matters: the row is
   * this device's claim on a user's notifications, and a row left behind
   * keeps every message for the user who signed out landing on a handset they
   * no longer hold. A handler that fails is not allowed to keep the session's
   * tokens alive, so its failure is swallowed here.
   */
  onSessionEnd?: () => Promise<void> | void
  /**
   * How long that wait may last. A first launch settles nothing until the user
   * has typed an address, and an app that waits forever is worse than one that
   * sends a call without a token, so the wait is bounded and the call goes out
   * either way.
   */
  settleTimeoutMs?: number
  /**
   * This device's id on the bound server, or null (receipts.ts). The logout
   * call names it, and the server revokes that device's receipt credential
   * with the session (A7), so a signed-out NSE can post nothing.
   */
  deviceId?: () => Promise<string | null>
  /**
   * How long a sign-out waits for a token call already under way (a refresh
   * that does not come back) before it is sent anyway. A sign-out held behind
   * a stalled refresh is a user who cannot sign out.
   */
  logoutQueueWaitMs?: number
}

/** The logout body with `deviceId` added, keeping whatever the app sent. */
async function withDeviceId(
  init: RequestInit | undefined,
  deviceId: (() => Promise<string | null>) | undefined,
): Promise<RequestInit | undefined> {
  const id = deviceId ? await deviceId().catch(() => null) : null
  if (!id) return init
  let body: Record<string, unknown> = {}
  if (typeof init?.body === "string" && init.body.length > 0) {
    try {
      const parsed = JSON.parse(init.body) as unknown
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return init
      body = parsed as Record<string, unknown>
    } catch {
      // Not JSON: the app meant something else by it, so it is left alone.
      return init
    }
  } else if (init?.body !== undefined && init.body !== null) {
    return init
  }
  const headers = new Headers(init?.headers)
  if (!headers.has("content-type")) headers.set("content-type", "application/json")
  return { ...init, headers, body: JSON.stringify({ ...body, deviceId: id }) }
}

/**
 * The ACCESS token, in memory only.
 *
 * The shell needs a bearer of its own (the push client's two token calls), and
 * the one place that already sees every access token the app is handed is this
 * bridge: login, refresh, magic link and TOTP all answer with one in the body,
 * and the bridge reads that body anyway to keep the refresh token. So the
 * bearer is TAKEN from what the app was given rather than minted a second
 * time: a second mint is a second single-use refresh rotation racing the
 * app's own, and the loser of that race is left with nothing.
 *
 * It is never written to Preferences, never to localStorage: an access token
 * is short lived, and the only thing that needs it is alive in this page.
 */
export interface AccessTokenStore {
  /** The current bearer, or null before a login and once a session has ended. */
  get: () => string | null
  /** Replaces it. `null` on sign-out. Notifies only on a real change. */
  set: (token: string | null) => void
  /** Called on every change, including the first one. Returns a disposer. */
  subscribe: (listener: (token: string | null) => void) => () => void
}

export function createAccessTokenStore(): AccessTokenStore {
  let current: string | null = null
  const listeners = new Set<(token: string | null) => void>()
  return {
    get: () => current,
    set: (token: string | null) => {
      if (token === current) return
      current = token
      for (const listener of [...listeners]) {
        try {
          listener(current)
        } catch {
          // One subscriber's failure is not the session's.
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** A store with no device behind it. The tests' own, and nothing else's. */
export function createMemoryRefreshStore(): RefreshTokenStore {
  let token: string | null = null
  return {
    load: async () => token,
    save: async (value: string) => {
      token = value
    },
    clear: async () => {
      token = null
    },
  }
}

/** How long a token call waits for the bound origin before giving up on it. */
const SETTLE_TIMEOUT_MS = 5000
/** How long a sign-out waits for the token call ahead of it. */
const LOGOUT_QUEUE_WAIT_MS = 5000

async function waitBounded(
  settled: (() => Promise<unknown>) | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!settled) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      settled().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * A REFRESH RUNS TO ITS END, whatever the caller's signal says; only the
 * caller stops waiting.
 *
 * A refresh the page gives up on (its own timeout) has usually reached the
 * server, which spends the presented token the moment it rotates. Aborting
 * the call underneath would drop the successor on the floor and leave the
 * spent token in the store, and that token presented again is a sign-out. So
 * the call goes out without the signal, its rotation is read and kept, and the
 * next token call queues behind THAT, not behind the caller's abandoned wait.
 */
function withoutSignal(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || !("signal" in init)) return init
  const { signal: _dropped, ...rest } = init
  return rest
}

/** `result`, or the caller's abort as soon as its signal fires. */
function honouringSignal(
  result: Promise<Response>,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  if (!signal) return result
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"))
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
    result.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

/**
 * What a refresh gets when the rotated refresh token could not be saved.
 *
 * The server has rotated by then, but the store still holds the spent token.
 * The app keeps its old pair and reads this like any transient failure; the
 * successor stays UNUSED (no access token of it is handed out), held in memory
 * by the bridge and presented, never the spent token, at the next refresh,
 * which also retries the save (installRefreshBridge, `unsaved`).
 */
function unsavedResponse(): Response {
  return new Response(JSON.stringify({ error: { code: "refresh_token_not_saved" } }), {
    status: 503,
    headers: { "content-type": "application/json" },
  })
}

/** What a refresh gets when a sign-out overtook it: its successor is not kept. */
function signedOutResponse(): Response {
  return new Response(JSON.stringify({ error: { code: "signed_out" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  })
}

/** What a refresh gets when this install is bound to no server at all. */
function unboundResponse(): Response {
  return new Response(JSON.stringify({ error: { code: "no_bound_server" } }), {
    status: 503,
    headers: { "content-type": "application/json" },
  })
}

/** The same origin, by URL parsing: `https://box.example` is not a prefix match. */
function isBoundServer(url: string, origin: string | null): boolean {
  if (origin === null) return false
  try {
    return new URL(url).origin === new URL(origin).origin
  } catch {
    return false
  }
}

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname
  } catch {
    return null
  }
}

/** The tokens in a response body, when the body carries any. */
async function tokensFrom(
  response: Response,
): Promise<{ refreshToken: string | null; accessToken: string | null }> {
  try {
    const body = (await response.clone().json()) as {
      data?: { refreshToken?: unknown; accessToken?: unknown }
    }
    const text = (value: unknown): string | null =>
      typeof value === "string" && value.length > 0 ? value : null
    return {
      refreshToken: text(body?.data?.refreshToken),
      accessToken: text(body?.data?.accessToken),
    }
  } catch {
    // A non-JSON answer (an error page, an empty 204) carries no token.
    return { refreshToken: null, accessToken: null }
  }
}

/**
 * Returns the wrapped `fetch`. The caller decides where to put it: the boot
 * bundle assigns it to the page's `fetch`, and a test calls it directly.
 */
export function installRefreshBridge(deps: RefreshBridgeDependencies): FetchLike {
  // ONE TOKEN CALL AT A TIME. A refresh reads the stored token, the server
  // spends it, and the answer's successor is saved: a second refresh or a
  // logout started in between would read the token the first one is spending.
  // So they queue, each reading the store only once the one before it settled.
  let tokenCalls: Promise<unknown> = Promise.resolve()
  // A SUCCESSOR THE STORE REFUSED is held here, in memory, for the life of the
  // page. The server spent the stored token when it rotated, and that token
  // presented again inside 30 s is a race the server refuses for a token in
  // the header: the app signed out over a keychain hiccup. So while this holds
  // a token, it is the one presented, never the stored one, and every token
  // call tries to save it again first.
  let unsaved: string | null = null
  // Bumped by every sign-out. A refresh that a sign-out overtook (it waited
  // for that refresh only so long) keeps nothing it is answered with.
  let session = 0
  const keep = async (token: string): Promise<boolean> => {
    try {
      await deps.store.save(token)
      unsaved = null
      return true
    } catch {
      unsaved = token
      return false
    }
  }
  const presentable = async (): Promise<string | null> => {
    if (unsaved !== null) await keep(unsaved)
    return unsaved ?? (await deps.store.load())
  }
  const bridged = async (input: string, init?: RequestInit): Promise<Response> => {
    const path = pathOf(input)
    let origin = deps.serverOrigin()
    // THE TOKEN CALLS WAIT FOR THE RECORD, and nothing else does: a read that
    // is merely early is not worth delaying, but a refresh sent early is a
    // session lost.
    if (origin === null && (path === REFRESH_PATH || path === LOGOUT_PATH)) {
      await waitBounded(deps.serverOriginSettled, deps.settleTimeoutMs ?? SETTLE_TIMEOUT_MS)
      origin = deps.serverOrigin()
      // STILL NO BOUND SERVER: this install has none, so there is nothing to
      // refresh against. Sent anyway, the call goes to whatever base the app
      // resolved, which inside the shell is `capacitor://localhost`, where
      // there is no API: the 401 that comes back is read as an ended session
      // and takes a stored one down with it. The shell answers instead, and
      // the first launch prompt the user is already looking at is the screen
      // that belongs in front of them.
      if (origin === null && path === REFRESH_PATH) return unboundResponse()
    }
    if (!isBoundServer(input, origin)) return deps.fetchImpl(input, init)
    if (!bearsTokens(path)) return deps.fetchImpl(input, init)

    let request = init
    // BOTH ENDS OF THE SESSION. The refresh call presents the token to rotate
    // it; the logout call presents the SAME token so the server has something
    // to revoke. The app posts an empty body and carries no cookie from this
    // origin, so without the header a sign-out left the session row alive for
    // its full thirty days.
    if (path === LOGOUT_PATH) request = await withDeviceId(request, deps.deviceId)
    if (path === REFRESH_PATH || path === LOGOUT_PATH) {
      const stored = await presentable()
      if (stored) {
        const headers = new Headers(request?.headers)
        // A caller that set the header itself means it: never overwritten.
        if (!headers.has(REFRESH_HEADER)) headers.set(REFRESH_HEADER, stored)
        request = { ...request, headers }
      }
    }

    if (path === LOGOUT_PATH) {
      // A SIGN-OUT STICKS ON THIS DEVICE WHATEVER THE SERVER ANSWERED. The
      // app has already dropped its own state by the time this resolves, and
      // under a shell a cold start refreshes with whatever token the store
      // holds: a token kept after a failed call (offline, a 5xx, a proxy
      // error page) silently signed the user back in at the next launch.
      // The server-side session then runs out on its own.
      // THE SHELL'S OWN REGISTRATIONS GO FIRST, before the logout is sent:
      // the server refuses a session's access tokens as soon as it ends, so
      // the DELETE they carry must reach it while the session is still live.
      // (The logout names the device too, so the server drops the push row
      // even when this call cannot be made.)
      try {
        await deps.onSessionEnd?.()
      } catch {
        // A device that cannot reach the server to unregister still has to
        // finish signing out here.
      }
      // The token is in the header by now; the device forgets it, and the
      // bearer, before the call is even answered, so a call that never comes
      // back signs nobody back in either.
      session += 1
      unsaved = null
      try {
        await deps.store.clear()
      } catch {
        // Nothing left to do about a store that cannot be cleared.
      }
      // The bearer goes with the session. Anything still holding one (the
      // push client) stops at the next gate rather than calling with a
      // token that belongs to a user who has signed out.
      deps.accessTokens?.set(null)
      return deps.fetchImpl(input, request)
    }
    if (path === REFRESH_PATH) {
      const started = session
      return settleRefresh(await deps.fetchImpl(input, request), started)
    }
    const response = await deps.fetchImpl(input, request)
    if (!response.ok) return response
    const { refreshToken, accessToken } = await tokensFrom(response)
    // A sign-in that the store refuses is still held for this page and saved
    // at the next token call, like a rotation's successor.
    if (refreshToken !== null) await keep(refreshToken)
    // EVERY auth answer, not just the refresh: a first login is exactly the
    // moment the shell has a bearer for the first time, and waiting for a
    // rotation would mean waiting for the next launch.
    if (accessToken !== null) deps.accessTokens?.set(accessToken)
    return response
  }
  const settleRefresh = async (response: Response, started: number): Promise<Response> => {
    // OVERTAKEN BY A SIGN-OUT: whatever this rotation minted belongs to a
    // session the user has ended here, so none of it is kept or handed on.
    if (session !== started) return signedOutResponse()
    if (response.ok) {
      // SAVED BEFORE IT IS USED. The new access token reaches the app (and the
      // shell's own bearer) only once its refresh token is safely stored. One
      // the store refuses is held (`unsaved`) and presented next time.
      const { refreshToken, accessToken } = await tokensFrom(response)
      if (refreshToken !== null && !(await keep(refreshToken))) return unsavedResponse()
      if (accessToken !== null) deps.accessTokens?.set(accessToken)
      return response
    }
    if (response.status === 401) {
      // THE OTHER WAY A SESSION ENDS, and the one that never posts a logout: a
      // refresh token the server refuses. The bearer in the store belongs to
      // that session, so it goes with it, rather than sitting in memory for
      // the life of the page while the shell believes somebody is signed in.
      unsaved = null
      deps.accessTokens?.set(null)
    }
    return response
  }
  return (input: string, init?: RequestInit): Promise<Response> => {
    const path = pathOf(input)
    if (path !== REFRESH_PATH && path !== LOGOUT_PATH) return bridged(input, init)
    // A SIGN-OUT WAITS FOR THE CALL AHEAD OF IT ONLY SO LONG, then goes: the
    // refresh it overtook keeps nothing (`session`), and the user is signed
    // out here whatever the server says.
    const ahead = tokenCalls
    if (path === LOGOUT_PATH) {
      const call = waitBounded(() => ahead, deps.logoutQueueWaitMs ?? LOGOUT_QUEUE_WAIT_MS).then(
        () => bridged(input, init),
      )
      tokenCalls = call.catch(() => undefined)
      return call
    }
    const settled = ahead.then(() => bridged(input, withoutSignal(init)))
    tokenCalls = settled.catch(() => undefined)
    return honouringSignal(settled, init?.signal)
  }
}

/** The marker that says this page's `fetch` is already wrapped. */
const INSTALLED_FLAG = "__liaisonRefreshBridge__"

/**
 * Wraps the PAGE's `fetch`, which is what apps/web calls. Idempotent: the boot
 * bundle can be evaluated twice (a reload, a second webview) and a second
 * wrapper would read every response body twice.
 *
 * A `Request` object or a `URL` is passed straight through: the app builds
 * every call from a string (lib/api-client.ts), and re-creating a Request here
 * to inspect it would consume its body.
 */
export function attachRefreshBridge(
  target: { fetch: typeof fetch } & Record<string, unknown>,
  deps: Omit<RefreshBridgeDependencies, "fetchImpl">,
): void {
  if (target[INSTALLED_FLAG] === true) return
  const original = target.fetch.bind(target) as FetchLike
  const bridged = installRefreshBridge({ ...deps, fetchImpl: original })
  target.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    typeof input === "string"
      ? bridged(input, init)
      : original(input as never, init)) as typeof fetch
  target[INSTALLED_FLAG] = true
}
