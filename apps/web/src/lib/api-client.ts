// SPDX-License-Identifier: FSL-1.1-ALv2
import { DEMO_WORKSPACE_EXPIRED_CODE, ORG_MOVING_CODE } from "@liaison/shared"
import { ApiError, isAppAccessLost } from "~/lib/api-error"
import { type EnsureFreshToken, isAuthRefreshError, type PendingRefresh } from "~/lib/auth-refresh"
import { clientHeaders } from "~/lib/client-version"
import {
  demoWorkspaceEnded,
  isDemoWorkspaceExpired,
  noteDemoWorkspaceExpired,
} from "~/lib/demo-expired"
import { apiBase } from "~/lib/env"
import {
  isOrgSuspendedRefusal,
  noteOrgSuspended,
  orgSuspended,
  suspensionFromError,
} from "~/lib/org-suspended"
import {
  isRestartingResponse,
  noteServerBack,
  noteServerRestarting,
  SERVER_RESTARTING_CODE,
  trackRequest,
} from "~/lib/server-pause"
import { noteWebBuildFrom } from "~/lib/web-build"
import { tNow } from "~/modules/i18n/i18n-context"

/**
 * How long a request waits out an org move: the longest a refusal lasts, with a margin. A message
 * is refused from the start of the drain (at most 30 s, while live agent turns run down) through
 * the write gap (at most 20 s).
 */
const ORG_MOVE_WAIT_MS = 60_000

async function isOrgMoving(response: Response): Promise<boolean> {
  try {
    const json = (await response.clone().json()) as { error?: { code?: unknown } }
    return json?.error?.code === ORG_MOVING_CODE
  } catch {
    return false
  }
}

/** The global toast for a 5xx: names the server's reference when it sent one,
 *  so "something went wrong" always carries a key to its log line. */
export function serverFaultMessage(ref: string | undefined): string {
  return ref
    ? tNow("kernel.apiErrors.serverFaultRef", { ref })
    : tNow("kernel.apiErrors.serverFault")
}

export { ApiError }

/**
 * Reject any `path` that is not strictly kernel-relative before it reaches
 * `fetch()` — the same client attaches the user's `Authorization: Bearer`
 * header, so an absolute/protocol-relative/scheme-bearing path would exfiltrate
 * the bearer token to an attacker-controlled origin (account takeover). Legit
 * kernel calls are all `/api/...` (or `/auth/...`), so they pass untouched.
 *
 * Rejected: protocol-relative (`//evil`), any URI scheme (`https:`, `javascript:`,
 * `data:`, …), backslashes (browser normalizes `\` → `/` so `/\evil` becomes
 * protocol-relative), and leading whitespace/control chars (which fetch trims,
 * so ` //evil` would slip past a naive prefix check).
 */
export function assertKernelRelativePath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new ApiError(
      `Refusing non-kernel-relative request path: ${String(path)}`,
      0,
      "non_kernel_relative_path",
    )
  }
  // No leading whitespace or C0/DEL control char. fetch() strips a leading
  // tab/newline/space, so `" //evil"` or a tab-prefixed value would masquerade
  // as relative once trimmed; reject anything whose first code point is <= 0x20
  // or == 0x7F.
  const first = path.charCodeAt(0)
  if (first <= 0x20 || first === 0x7f) {
    throw new ApiError(
      `Refusing non-kernel-relative request path: ${path}`,
      0,
      "non_kernel_relative_path",
    )
  }
  // Must start with a single `/` and NOT be protocol-relative (`//`).
  if (path[0] !== "/" || path[1] === "/") {
    throw new ApiError(
      `Refusing non-kernel-relative request path: ${path}`,
      0,
      "non_kernel_relative_path",
    )
  }
  // No backslashes anywhere (browsers normalize `\` → `/`, so `/\evil` would
  // resolve protocol-relative).
  if (path.includes("\\")) {
    throw new ApiError(
      `Refusing non-kernel-relative request path: ${path}`,
      0,
      "non_kernel_relative_path",
    )
  }
  // Reject any URI scheme (`scheme:` per RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )).
  // A leading `/` already guards this, but keep it explicit for defense-in-depth.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new ApiError(
      `Refusing non-kernel-relative request path: ${path}`,
      0,
      "non_kernel_relative_path",
    )
  }
}

export interface ApiClientConfig {
  /** How long a request waits out an org move (tests). */
  orgMoveWaitMs?: number
  getAccessToken: () => string | null
  onUnauthorized: () => void
  /**
   * The auth manager's single-flight refresh. A 401 passes `force` (a 401 on
   * an unexpired token means its claims are stale) and `rejected`, the token
   * the request was refused with, so it joins the refresh that is under way
   * or already replaced that token instead of starting another.
   */
  ensureFreshToken?: EnsureFreshToken
  /**
   * The refresh in flight, if any. A request waits for it before it is sent,
   * so a page coming back from the background (which refreshes first) sends
   * its burst of requests with the new token rather than the expired one.
   */
  pendingRefresh?: PendingRefresh
  baseUrl?: string
  onError?: (status: number, message: string, details?: Record<string, unknown>) => void
  /**
   * A request was refused because the viewer can no longer use its app: an
   * admin restricted them away from it (403) or turned it Off (410).
   */
  onAppRestricted?: () => void
  /**
   * How long a read (GET) may take before it fails as a timeout (S26),
   * retries included. Default 20 s: a request the network swallowed must
   * settle, or every screen waiting on it hangs.
   */
  getTimeoutMs?: number
  /**
   * The socket is reconnecting: the network is known to be down, a banner
   * already says so, and a failed read raises no connection toast of its own.
   */
  isReconnecting?: () => boolean
}

export interface RequestInitLike {
  signal?: AbortSignal
  /** Skip the global onError toast for this call — the caller surfaces its own error inline. */
  suppressGlobalError?: boolean
  /**
   * This call is a person pressing a button (a Try again under a failed list),
   * not a screen refetching itself. It is let through the rate limit cool-down:
   * a human pressing a button is not a loop, and while the cool-down stands it
   * is the only way back. The answer still arms the cool-down as any read does.
   */
  userInitiated?: boolean
  /** Let the request outlive the page (fetch `keepalive`): a send made as the page goes away. */
  keepalive?: boolean
}

export interface ApiClient {
  get: <T = unknown>(path: string, init?: RequestInitLike) => Promise<T>
  post: <T = unknown>(path: string, body?: unknown, init?: RequestInitLike) => Promise<T>
  put: <T = unknown>(path: string, body?: unknown, init?: RequestInitLike) => Promise<T>
  patch: <T = unknown>(path: string, body?: unknown, init?: RequestInitLike) => Promise<T>
  delete: <T = unknown>(path: string, body?: unknown, init?: RequestInitLike) => Promise<T>
  /** Like `get` but returns the full envelope `{ data, meta }` without unwrapping `data`. */
  getEnvelope: <T = unknown>(
    path: string,
    init?: RequestInitLike,
  ) => Promise<{ data: T; meta?: Record<string, unknown> }>
  /**
   * POST returning the raw {@link Response} (auth refresh handled, errors
   * thrown) so callers can read non-JSON bodies (blobs) AND response headers
   * — used by the Data Export view to surface the partial-skip header.
   */
  rawPost: (path: string, body?: unknown, init?: RequestInitLike) => Promise<Response>
  /**
   * GET returning the raw {@link Response} (auth refresh handled, errors
   * thrown) so callers can read binary bodies — used for authenticated file
   * downloads and inline image previews.
   */
  rawGet: (path: string, init?: RequestInitLike) => Promise<Response>
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

const DEFAULT_GET_TIMEOUT_MS = 20_000
/** The waits before a read's two retries, each drawn from its [min, max] range. */
const READ_RETRY_WAITS_MS: ReadonlyArray<readonly [number, number]> = [
  [300, 900],
  [1_000, 2_000],
]

/**
 * One signal that aborts when the caller's does or when `ms` pass. Built by
 * hand: `AbortSignal.any` and `AbortSignal.timeout` are missing from older
 * WebKit, which the phone app runs on.
 */
function deadlineSignal(caller: AbortSignal | undefined, ms: number) {
  const controller = new AbortController()
  let timedOut = false
  const onCallerAbort = () => controller.abort(caller?.reason)
  if (caller?.aborted) controller.abort(caller.reason)
  else caller?.addEventListener("abort", onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException("The request timed out", "AbortError"))
  }, ms)
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      caller?.removeEventListener("abort", onCallerAbort)
    },
  }
}

/** Statuses whose Response must carry no body (the constructor refuses one). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/**
 * The response with its body read in full, or a rejection with the signal's
 * reason when it aborts first (an engine whose body read ignores the signal
 * included). The copy carries the same status and headers.
 */
async function bufferedWithin(response: Response, signal: AbortSignal): Promise<Response> {
  if (NULL_BODY_STATUSES.has(response.status) || !response.body) return response
  let onAbort: (() => void) | null = null
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    // The abort is listed first: an engine that hands back an already-read
    // body (Bun) settles both at once, and the caller's abort must still win.
    const body = await Promise.race([aborted, response.arrayBuffer()])
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } catch (error) {
    response.body?.cancel().catch(() => {})
    throw error
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

/** Waits `ms`, or less when `signal` aborts first (the loop then sees why). */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

/**
 * A body that fetch can send as-is (binary/multipart), so we must NOT
 * JSON.stringify it and must NOT force `application/json`. For a Blob/File,
 * fetch derives the Content-Type from the blob's own `type` (e.g. the picked
 * image's `image/png`); for FormData it sets the multipart boundary itself.
 */
function isRawBody(body: unknown): body is BodyInit {
  return (
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    body instanceof URLSearchParams ||
    ArrayBuffer.isView(body)
  )
}

function isJsonContentType(contentType: string): boolean {
  return /(^|\s|;)(application\/json|[^;\s]+\+json)(;|$)/i.test(contentType)
}

function isTextContentType(contentType: string): boolean {
  return (
    /^text\//i.test(contentType) ||
    /(application\/(xml|csv|javascript|x-www-form-urlencoded)|image\/svg\+xml)/i.test(contentType)
  )
}

function isBinaryContentType(contentType: string): boolean {
  return /^(application\/(octet-stream|pdf|zip)|audio\/|font\/|image\/(?!svg\+xml)|video\/)/i.test(
    contentType,
  )
}

async function parseSuccessResponse<T>(response: Response): Promise<T> {
  if (response.status === 204 || response.status === 205) {
    return undefined as T
  }

  const contentLength = response.headers.get("Content-Length")
  if (contentLength === "0") {
    return undefined as T
  }

  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? ""

  if (isJsonContentType(contentType)) {
    const text = await response.text()
    if (!text.trim()) {
      return undefined as T
    }

    const json = JSON.parse(text)
    // A `{ data: null }` envelope is a null result (a tool that found nothing), not a raw body:
    // `json.data ?? json` handed the caller the envelope object itself, which read as a found row
    // with every field undefined.
    if (json && typeof json === "object" && !Array.isArray(json) && "data" in json) {
      return json.data as T
    }
    return json as T
  }

  if (isTextContentType(contentType) || !contentType) {
    const text = await response.text()
    return (text ? text : undefined) as T
  }

  if (isBinaryContentType(contentType) && typeof response.blob === "function") {
    return (await response.blob()) as T
  }

  const text = await response.text()
  if (text) {
    return text as T
  }

  if (typeof response.blob === "function") {
    return (await response.blob()) as T
  }

  return undefined as T
}

/**
 * The structured part of an error body: its `details` object, plus `issues`
 * when the refusal lists its problems at their paths (a validation 422), so the
 * screen that sent the document can show each one where it belongs.
 */
/** The code of a refusal for an app the viewer was restricted away from. */
const APP_RESTRICTED_CODE = "app_restricted"

/** What a 403 says: "You no longer have access" when an admin restricted the app. */
function forbiddenMessage(code: string | undefined): string {
  return code === APP_RESTRICTED_CODE
    ? tNow("kernel.appManagement.noLongerAccess")
    : tNow("kernel.apiErrors.forbidden")
}

function errorDetails(error: {
  details?: unknown
  issues?: unknown
}): Record<string, unknown> | undefined {
  let details =
    error.details && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : undefined
  if (Array.isArray(error.issues)) details = { ...details, issues: error.issues }
  return details
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  // Read per request, not once: under a native shell the base is the address
  // the user entered at first launch, and a client built before the shell has
  // injected it would keep a relative base for the life of the page.
  const base = () => config.baseUrl ?? apiBase()

  // An expired demo workspace leaves through its own exit (lib/demo-expired.ts):
  // the refresh it fails on also clears the session, and that must not send the
  // person to the login page on top of the demo door.
  // A suspended org's page is the suspended view (lib/org-suspended.ts): a
  // member's refused refresh must not send them to the login page on top of it.
  const onUnauthorized = () => {
    if (!demoWorkspaceEnded() && !orgSuspended()) config.onUnauthorized()
  }

  /**
   * The org is suspended or closed (403 `org_suspended`): the suspended page
   * takes over, once, and the refusal raises no toast.
   */
  function suspendedOrg(status: number, code: string | undefined, error: unknown): boolean {
    if (!isOrgSuspendedRefusal(status, code)) return false
    noteOrgSuspended(suspensionFromError(error))
    return true
  }

  /** The demo workspace is over: hand over to its exit, never a toast. */
  function endedDemoWorkspace(status: number, code: string | undefined): boolean {
    if (!isDemoWorkspaceExpired(status, code) && !demoWorkspaceEnded()) return false
    if (isDemoWorkspaceExpired(status, code)) noteDemoWorkspaceExpired()
    return true
  }

  // --- Rate limit cool-down (client wide, reads only) ---
  //
  // A 429 is not a single failed screen: the surfaces that issue reads are
  // effects and stores that re-run whenever a store they watch is written, and
  // a failed read writes its own error state, so the first 429 re-arms the very
  // reads that produced it. Left alone that turns one refusal into hundreds
  // within a couple of minutes, every one of them answered 429.
  //
  // So a 429 on a READ arms a cool-down: until it expires, further reads are
  // refused here, with no network call and no second toast (the ApiError the
  // caller gets is the same shape, so the inline error states keep working).
  // Writes are left alone: a POST comes from a click, and the human is already
  // the brake.
  const kDefaultCooldownSeconds = 5
  const kMaxCooldownSeconds = 60
  let cooldownUntil = 0
  let cooldownError: ApiError | null = null

  function armCooldown(error: ApiError): void {
    const hinted = typeof error.retryAfter === "number" && Number.isFinite(error.retryAfter)
    const seconds = Math.min(
      Math.max(hinted ? (error.retryAfter as number) : kDefaultCooldownSeconds, 1),
      kMaxCooldownSeconds,
    )
    cooldownUntil = Date.now() + seconds * 1000
    cooldownError = error
  }

  /** The error a read must fail with right now, or null when reads may go out. */
  function cooldownRefusal(): ApiError | null {
    const remaining = cooldownUntil - Date.now()
    if (remaining <= 0) return null
    return new ApiError(
      cooldownError?.message ?? "Too many requests",
      429,
      cooldownError?.code,
      Math.max(1, Math.ceil(remaining / 1000)),
      cooldownError?.details,
    )
  }

  function readRetryAfter(response: Response): number | undefined {
    const raw = response.headers.get("Retry-After")
    if (!raw) return undefined
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  async function rawRequest(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInitLike,
  ): Promise<Response> {
    // Defense-in-depth: refuse absolute / protocol-relative / scheme-bearing
    // paths BEFORE the bearer token is read or attached, so no authed client
    // can be tricked into sending the user's token to an external origin.
    assertKernelRelativePath(path)
    // The demo workspace is over and its exit is under way: a signed-in call
    // (a poll, a tour step) would only be refused again, so none goes out.
    if (demoWorkspaceEnded() && config.getAccessToken()) {
      throw new ApiError("Demo workspace ended", 403, DEMO_WORKSPACE_EXPIRED_CODE)
    }
    const raw = body !== undefined && isRawBody(body)
    // A shell names itself once its server answered the client policy
    // (lib/client-version.ts); a browser never does.
    const headers: Record<string, string> = clientHeaders()
    // JSON bodies are serialized and typed here; raw bodies (image upload,
    // multipart) let fetch set the Content-Type from the body itself.
    if (body !== undefined && !raw) {
      headers["Content-Type"] = "application/json"
    }
    const token = config.getAccessToken()
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    // CSRF: State-changing requests use Bearer token headers (not sent by CSRF attacks).
    // The /auth/refresh endpoint uses httpOnly cookie only, making it CSRF-triggerable,
    // but the attacker cannot read the response (blocked by CORS). Conscious decision.
    // The shell's pause notice reads how long requests wait (lib/server-pause.ts).
    const settled = trackRequest()
    let response: Response
    try {
      response = await fetch(`${base()}${path}`, {
        method,
        headers,
        credentials: "include",
        body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
        signal: init?.signal,
        ...(init?.keepalive ? { keepalive: true } : {}),
      })
    } finally {
      settled()
    }
    // Every response says which web build the server ships (lib/web-build.ts).
    noteWebBuildFrom(response)
    // A draining server says so (503 RESTARTING); any other answer while the
    // socket is up means the server is back.
    if (await isRestartingResponse(response)) noteServerRestarting()
    else if (response.status < 500 && !config.isReconnecting?.()) noteServerBack()
    return response
  }

  /**
   * One send; a transport failure is a network error, never an auth verdict.
   * A `read` (an idempotent GET) goes through `sendRead` instead: a deadline
   * and retries across a network blip.
   */
  async function send(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInitLike,
    read = false,
  ): Promise<Response> {
    if (read) return sendRead(path, init)
    try {
      return await rawRequest(method, path, body, init)
    } catch (error) {
      if (isAbortError(error)) throw error
      // A path-guard rejection (assertKernelRelativePath) is a hard refusal, not a
      // network failure — propagate it verbatim instead of masking it as "Network error".
      if (error instanceof ApiError) throw error
      config.onError?.(0, tNow("kernel.connectionError"))
      throw new ApiError("Network error", 0)
    }
  }

  /** The connection toast, unless the socket already says the network is down. */
  function connectionLost(): void {
    if (config.isReconnecting?.()) return
    config.onError?.(0, tNow("kernel.connectionError"))
  }

  /**
   * A read that cannot hang and survives a blip (S26). It settles within
   * `getTimeoutMs` (retries included) as `ApiError(status 0, code "timeout")`,
   * never an AbortError, which callers read as their own cancel. A network
   * error is retried twice after a short jittered wait. The caller's abort
   * ends it at once and is never retried. Only the HTTP exchange is retried:
   * a response of any status, 401 and 429 included, is the caller's.
   */
  async function sendRead(path: string, init?: RequestInitLike): Promise<Response> {
    const deadline = deadlineSignal(init?.signal, config.getTimeoutMs ?? DEFAULT_GET_TIMEOUT_MS)
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await rawRequest("GET", path, undefined, {
            ...init,
            signal: deadline.signal,
          })
          // The deadline covers the body too: headers can arrive and the
          // network go before the body ends, and nothing would end that wait.
          return await bufferedWithin(response, deadline.signal)
        } catch (error) {
          if (error instanceof ApiError) throw error
          // The caller's abort, or one the engine raised itself: theirs, as before.
          if (init?.signal?.aborted || (isAbortError(error) && !deadline.timedOut())) throw error
          if (deadline.timedOut()) {
            connectionLost()
            throw new ApiError("Request timed out", 0, "timeout")
          }
          const wait = READ_RETRY_WAITS_MS[attempt]
          if (!wait) {
            connectionLost()
            throw new ApiError("Network error", 0)
          }
          await pause(wait[0] + Math.random() * (wait[1] - wait[0]), deadline.signal)
        }
      }
    } finally {
      deadline.dispose()
    }
  }

  /**
   * The first send of a request, and the access token it went out with.
   *
   * A refresh already under way is waited for first, when the token is expired
   * (a request with a good token is never held up by one): the page coming back
   * from the background starts one before anything else (createAuthManager,
   * installResumeRefresh), and the requests the same moment fires carry its
   * new token instead of all meeting a 401 with the expired one. Its outcome
   * is not this request's business: a refused refresh has ended the session,
   * and the request then goes out without a token and meets its own 401.
   */
  async function sendFirst(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInitLike,
    read = false,
  ): Promise<{ response: Response; token: string | null }> {
    // The path guard runs before the token is so much as read (rawRequest
    // repeats it; this is the earlier of the two reads).
    assertKernelRelativePath(path)
    const pending = config.pendingRefresh?.()
    if (pending) await pending.catch(() => undefined)
    // Read right before the send, which reads it again synchronously.
    const token = config.getAccessToken()
    return { response: await send(method, path, body, init, read), token }
  }

  /**
   * A 401: refresh (single-flight in the auth manager), then send once more.
   *
   * ONLY THE REFRESH'S VERDICT ENDS THE SESSION. A burst of requests sent with
   * an expired token (a phone app resuming) all come back 401 at once, and
   * some of them only after the refresh they triggered has already landed.
   * Each one names the token it was refused with, so it joins the refresh in
   * flight, or, when that token has already been replaced, is simply sent
   * again with the new one: one refresh for the whole burst, never a second
   * rotation behind the first.
   *
   * The resend is outside the refresh's try: a resend that never came back (a
   * request its caller aborted while the refresh ran, a drop on a flaky
   * network) used to be read as a refused refresh and signed the user out with
   * a perfectly good session. And a 401 on the resend is that request's answer,
   * not the session's: the refresh has just said the session is good, so it
   * fails the call and signs nobody out. A session the server has really ended
   * is refused at its next refresh, which is the verdict that signs out.
   */
  async function refreshAndResend(
    method: string,
    path: string,
    body: unknown,
    init: RequestInitLike | undefined,
    read: boolean,
    rejected: string | null,
  ): Promise<Response> {
    if (!config.ensureFreshToken) {
      onUnauthorized()
      throw new ApiError("Unauthorized", 401)
    }
    try {
      await config.ensureFreshToken({ force: true, rejected })
    } catch (error) {
      if (isAuthRefreshError(error) && error.kind === "transient") {
        config.onError?.(0, tNow("kernel.apiErrors.serverUnavailable"))
        throw new ApiError("Server error", 0)
      }
      // A refused refresh token, or an unexpected failure of the refresh itself.
      onUnauthorized()
      throw new ApiError("Unauthorized", 401)
    }
    return send(method, path, body, init, read)
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInitLike,
  ): Promise<T> {
    if (method === "GET" && !init?.userInitiated) {
      const refusal = cooldownRefusal()
      if (refusal) throw refusal
    }
    const read = method === "GET"
    const first = await sendFirst(method, path, body, init, read)
    let response = first.response

    if (response.status === 401)
      response = await refreshAndResend(method, path, body, init, read, first.token)

    // The org is being moved between servers: nothing was done, and the move ends in seconds. The
    // same request goes again (a typed message is not lost, a form is not refused). The flip's
    // first answer can be a 401 (the new server signs its own tokens), which refresh answers.
    const moveWaitUntil = Date.now() + (config.orgMoveWaitMs ?? ORG_MOVE_WAIT_MS)
    while (response.status === 503 && (await isOrgMoving(response)) && Date.now() < moveWaitUntil) {
      const hinted = readRetryAfter(response)
      const ms = Math.min(Math.max((hinted ?? 1) * 1000, 250), moveWaitUntil - Date.now())
      await pause(ms, init?.signal ?? new AbortController().signal)
      if (init?.signal?.aborted) throw new DOMException("The request was cancelled", "AbortError")
      const again = await sendFirst(method, path, body, init, read)
      response = again.response
      if (response.status === 401)
        response = await refreshAndResend(method, path, body, init, read, again.token)
    }

    if (!response.ok) {
      let message = "Request failed"
      let code: string | undefined
      let ref: string | undefined
      let retryAfter: number | undefined
      let details: Record<string, unknown> | undefined
      let rawError: unknown
      try {
        const json = await response.json()
        if (json.error) {
          rawError = json.error
          message = json.error.message ?? message
          code = json.error.code
          if (typeof json.error.ref === "string") ref = json.error.ref
          details = errorDetails(json.error)
        }
      } catch {
        // Non-JSON error body
      }
      if (response.status === 429) {
        retryAfter = readRetryAfter(response)
      }
      const error = new ApiError(message, response.status, code, retryAfter, details)
      error.ref = ref
      if (response.status === 429 && method === "GET") armCooldown(error)
      // `suppressGlobalError` lets a caller that renders its own inline error
      // (e.g. the scope-request inbox decide) opt out of the global error toast.
      // Restricted away from an app (S20) or the app turned Off (S19): the
      // shell drops its entry now.
      if (isAppAccessLost(response.status, code)) config.onAppRestricted?.()
      const suspended = suspendedOrg(response.status, code, rawError)
      if (!suspended && !endedDemoWorkspace(response.status, code) && !init?.suppressGlobalError) {
        if (response.status === 429) {
          config.onError?.(429, tNow("kernel.apiErrors.rateLimited"))
        } else if (response.status >= 500 && code !== SERVER_RESTARTING_CODE) {
          // A 503 RESTARTING is a deploy: the shell's pause notice says so
          // (lib/server-pause.ts), not a fault toast.
          config.onError?.(response.status, serverFaultMessage(error.ref))
        } else if (response.status === 403) {
          // Pass `details` so the UI can name the missing scope and offer a
          // "Request access" action (see ApiContext); falls back to generic copy.
          config.onError?.(403, forbiddenMessage(code), details)
        }
      }
      throw error
    }

    return parseSuccessResponse<T>(response)
  }

  async function rawResponse(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInitLike,
  ): Promise<Response> {
    if (method === "GET" && !init?.userInitiated) {
      const refusal = cooldownRefusal()
      if (refusal) throw refusal
    }
    const first = await sendFirst(method, path, body, init)
    let response = first.response
    if (response.status === 401)
      response = await refreshAndResend(method, path, body, init, false, first.token)
    if (!response.ok) {
      let message = "Request failed"
      let code: string | undefined
      let ref: string | undefined
      let rawError: unknown
      try {
        const json = await response.json()
        if (json.error) {
          rawError = json.error
          message = json.error.message ?? message
          code = json.error.code
          if (typeof json.error.ref === "string") ref = json.error.ref
        }
      } catch {
        // non-JSON error body
      }
      // Binary reads go through here too (inline image previews, downloads). A
      // preview the UI already degrades from must be able to fail quietly, so
      // this path honours `suppressGlobalError` exactly as `request` does.
      const error = new ApiError(
        message,
        response.status,
        code,
        response.status === 429 ? readRetryAfter(response) : undefined,
      )
      error.ref = ref
      if (response.status === 429 && method === "GET") armCooldown(error)
      // Restricted away from an app (S20) or the app turned Off (S19): the
      // shell drops its entry now.
      if (isAppAccessLost(response.status, code)) config.onAppRestricted?.()
      const suspended = suspendedOrg(response.status, code, rawError)
      if (!suspended && !endedDemoWorkspace(response.status, code) && !init?.suppressGlobalError) {
        if (response.status >= 500) {
          config.onError?.(response.status, serverFaultMessage(error.ref))
        } else if (response.status === 403) {
          config.onError?.(403, forbiddenMessage(code))
        }
      }
      throw error
    }
    return response
  }

  async function getEnvelope<T>(
    path: string,
    init?: RequestInitLike,
  ): Promise<{ data: T; meta?: Record<string, unknown> }> {
    if (!init?.userInitiated) {
      const refusal = cooldownRefusal()
      if (refusal) throw refusal
    }
    const first = await sendFirst("GET", path, undefined, init, true)
    let response = first.response
    if (response.status === 401)
      response = await refreshAndResend("GET", path, undefined, init, true, first.token)

    if (!response.ok) {
      let message = "Request failed"
      let code: string | undefined
      let ref: string | undefined
      let details: Record<string, unknown> | undefined
      let rawError: unknown
      try {
        const json = await response.json()
        if (json.error) {
          rawError = json.error
          message = json.error.message ?? message
          code = json.error.code
          if (typeof json.error.ref === "string") ref = json.error.ref
          details = errorDetails(json.error)
        }
      } catch {}
      const error = new ApiError(
        message,
        response.status,
        code,
        response.status === 429 ? readRetryAfter(response) : undefined,
        details,
      )
      error.ref = ref
      if (response.status === 429) armCooldown(error)
      // Restricted away from an app (S20) or the app turned Off (S19): the
      // shell drops its entry now.
      if (isAppAccessLost(response.status, code)) config.onAppRestricted?.()
      const suspended = suspendedOrg(response.status, code, rawError)
      if (!suspended && !endedDemoWorkspace(response.status, code) && !init?.suppressGlobalError) {
        if (response.status === 429) {
          config.onError?.(429, tNow("kernel.apiErrors.rateLimited"))
        } else if (response.status >= 500 && code !== SERVER_RESTARTING_CODE) {
          // A 503 RESTARTING is a deploy: the shell's pause notice says so
          // (lib/server-pause.ts), not a fault toast.
          config.onError?.(response.status, serverFaultMessage(error.ref))
        } else if (response.status === 403) {
          config.onError?.(403, forbiddenMessage(code), details)
        }
      }
      throw error
    }

    const json = await response.json()
    return json as { data: T; meta?: Record<string, unknown> }
  }

  return {
    get: <T = unknown>(path: string, init?: RequestInitLike) =>
      request<T>("GET", path, undefined, init),
    post: <T = unknown>(path: string, body?: unknown, init?: RequestInitLike) =>
      request<T>("POST", path, body, init),
    put: <T = unknown>(path: string, body?: unknown, init?: RequestInitLike) =>
      request<T>("PUT", path, body, init),
    patch: <T = unknown>(path: string, body?: unknown, init?: RequestInitLike) =>
      request<T>("PATCH", path, body, init),
    delete: <T = unknown>(path: string, body?: unknown, init?: RequestInitLike) =>
      request<T>("DELETE", path, body, init),
    getEnvelope,
    rawPost: (path: string, body?: unknown, init?: RequestInitLike) =>
      rawResponse("POST", path, body, init),
    rawGet: (path: string, init?: RequestInitLike) => rawResponse("GET", path, undefined, init),
  }
}

/** Pre-configured client for unauthenticated pages (login, register, reset, etc.) */
export const anonApiClient = createApiClient({
  getAccessToken: () => null,
  onUnauthorized: () => {},
})
