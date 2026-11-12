// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * API connector host transport: one adapter operation, rendered, sent and
 * projected. Runs on the host only; credentials never enter the sandbox.
 *
 * The safety stack, in request order:
 *   1. `render` (core) validates params and builds the path, query and body
 *      structurally; `buildRequestUrl` keeps the base host and path.
 *   2. Egress: https only (http only to a loopback host, and only when the
 *      deployment sets LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true); the
 *      SSRF guard (`fetchWithPinnedHost`) pins DNS, refuses private and
 *      loopback addresses unless that flag allows them, and refuses link-local
 *      and metadata addresses always; every redirect hop must stay on the
 *      adapter's base host.
 *   3. Demo orgs: a registered fixture responder answers first; otherwise
 *      `assertDemoAppFetchAllowed` refuses before anything leaves the box.
 *   4. Bounds: 15 s per request, a 2 MB streamed response cap, 200 items, and
 *      a 45 s budget across pages.
 *   5. Output: projected to the operation's `fields` allow-list, and every
 *      credential value (raw and URL-encoded, whatever its length) is
 *      redacted from the projected values, so an API that echoes the key in
 *      an allowed field still never hands it to a tool result, the Test panel
 *      or the card. A non-2xx answer reports its status and a fixed message,
 *      never the body; the same redaction applies to any message this module
 *      builds.
 */

import { createHash } from "node:crypto"
import {
  type Adapter,
  type ApiConnectorErrorCode,
  AUTH_CREDENTIAL_FIELDS,
  buildRequestUrl,
  ConnectorRenderError,
  firstPageQuery,
  isLoopbackHostname,
  type JsonValue,
  MAX_ITEMS_PER_CALL,
  nextPageQuery,
  type Operation,
  type ProjectedObject,
  type ProjectedValue,
  project,
  type RenderedRequest,
  render,
  SECRET_CREDENTIAL_FIELDS,
} from "@liaison/api-connector-core"
import { sanitizeFilename } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { fetchWithPinnedHost, UnsafeOutboundUrlError } from "~/lib/outbound-fetch"
import { readStreamCapped } from "~/lib/read-capped-body"
import { redis } from "~/lib/redis"
import { toolRegistry } from "~/modules/apps/app-registries"
import {
  acquireConnectionPermit,
  ConnectionRateLimitedError,
} from "~/modules/apps/connection-limiter"
import { type ConnectionLimits, declaredConnectionLimits } from "~/modules/apps/connection-limits"
import { connectionLimiterLimits } from "~/modules/apps/run-limits"
import { assertDemoAppFetchAllowed, isDemoRestriction } from "~/modules/demo/demo-egress"
import { privateApiConnectorHostsAllowed } from "./adapter-policy"
import { cacheKeyFor, rememberCacheKey } from "./cache"
import { API_CONNECTOR_APP, API_CONNECTOR_CONNECTION } from "./store"

export const apiConnectorLog = rootLogger.child({ module: "api-connector" })

export const API_CONNECTOR_REQUEST_TIMEOUT_MS = 15_000
export const API_CONNECTOR_RESPONSE_CAP_BYTES = 2 * 1024 * 1024
export const API_CONNECTOR_PAGES_BUDGET_MS = 45_000
const MAX_REDIRECTS = 3

export type { ApiConnectorErrorCode }

/** HTTP status a route answers each code with. */
export const API_CONNECTOR_ERROR_HTTP_STATUS: Record<
  ApiConnectorErrorCode,
  400 | 403 | 404 | 422 | 502 | 504
> = {
  upstream_status: 502,
  timeout: 504,
  too_large: 502,
  invalid_response: 502,
  host_refused: 422,
  not_configured: 422,
  invalid_params: 400,
  demo_restricted: 403,
  unknown_connection: 404,
  unknown_operation: 404,
  write_not_testable: 422,
  write_not_allowed: 422,
}

export class ApiConnectorError extends Error {
  readonly code: ApiConnectorErrorCode
  /** The upstream HTTP status, for `upstream_status`. */
  readonly upstreamStatus?: number
  /**
   * The start of the API's error answer, clipped and with the connection's
   * secrets redacted: vendor text, never in `message`. Only the author's test
   * (connector_adapter_test) shows it, fenced as external content, so the
   * agent can read why the API refused a request ("a body is required").
   */
  readonly upstreamBody?: string
  constructor(
    code: ApiConnectorErrorCode,
    message: string,
    upstreamStatus?: number,
    upstreamBody?: string,
  ) {
    super(message)
    this.name = "ApiConnectorError"
    this.code = code
    if (upstreamStatus !== undefined) this.upstreamStatus = upstreamStatus
    if (upstreamBody) this.upstreamBody = upstreamBody
  }
}

/**
 * A count of upstream requests one caller may still make (the customer
 * resolver gives each connection one per resolution), shared by every call
 * and chain step that carries it. Each page takes one.
 */
export class RequestBudget {
  remaining: number
  constructor(requests: number) {
    this.remaining = requests
  }
  take(): boolean {
    if (this.remaining <= 0) return false
    this.remaining--
    return true
  }
}

/** A call refused because its request budget was spent (reported as `too_large`). */
export class RequestBudgetError extends ApiConnectorError {
  constructor() {
    super("too_large", "The lookup needed more upstream requests than its budget allows.")
    this.name = "RequestBudgetError"
  }
}

/**
 * Requests in flight to one connection at most, across every caller of every
 * process: the shared per-connection limiter (connection-limiter.ts), with the
 * `limits` the app declares on its API connection, this many when it declares
 * none. A wait past the limiter's interactive budget is answered as a timeout.
 */
export const MAX_IN_FLIGHT_PER_CONNECTION = 4

function connectionLimitsOf(orgId: string): ConnectionLimits {
  const manifest = (
    toolRegistry.get([orgId, API_CONNECTOR_APP, "connector_read"]) as
      | { _manifest?: { connections?: Record<string, unknown> } }
      | undefined
  )?._manifest
  return (
    declaredConnectionLimits(manifest, API_CONNECTOR_CONNECTION) ?? {
      concurrency: MAX_IN_FLIGHT_PER_CONNECTION,
    }
  )
}

/** Wait for one of the connection's permits; resolves to its release. */
export async function acquireConnectionSlot(
  orgId: string,
  identifier: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  try {
    return await acquireConnectionPermit(
      { orgId, app: API_CONNECTOR_APP, connection: API_CONNECTOR_CONNECTION, identifier },
      connectionLimitsOf(orgId),
      {
        maxWaitMs: connectionLimiterLimits().maxWaitMs.interactive,
        ...(signal ? { signal } : {}),
      },
    )
  } catch (err) {
    if (err instanceof ConnectionRateLimitedError) {
      throw new ApiConnectorError(
        "timeout",
        "Too many requests to this connection are in flight; try again in a moment.",
      )
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Demo fixture responder
// ---------------------------------------------------------------------------

export interface DemoApiConnectorRequest {
  orgId: string
  identifier: string
  adapter: Adapter
  operation: Operation
  url: URL
  method: string
  body: unknown
}

/** Answers a demo org's request in-process, or returns null to decline. */
export type DemoApiConnectorResponder = (req: DemoApiConnectorRequest) => Promise<Response | null>

let demoResponder: DemoApiConnectorResponder | null = null

/** The demo module registers the fixture transport here (null removes it). */
export function registerDemoApiConnectorResponder(fn: DemoApiConnectorResponder | null): void {
  demoResponder = fn
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Every non-empty SECRET credential value (SECRET_CREDENTIAL_FIELDS, plus what
 * the applied auth derived from them, such as the Basic header), raw and
 * URL-encoded (no length minimum). Identifiers such as a username are not
 * secrets and are never redacted.
 */
function secretValues(credentials: Record<string, string> | null, extra: string[] = []): string[] {
  const out = new Set<string>()
  const secretFields = Object.entries(credentials ?? {})
    .filter(([field]) => SECRET_CREDENTIAL_FIELDS.has(field))
    .map(([, v]) => v)
  for (const v of [...secretFields, ...extra]) {
    if (typeof v !== "string" || v.length === 0) continue
    out.add(v)
    out.add(encodeURIComponent(v))
    out.add(new URLSearchParams({ v }).toString().slice(2))
    // As an API echoes it inside a JSON error body (quotes, backslashes,
    // control characters and, for some encoders, "/" escaped).
    const json = JSON.stringify(v).slice(1, -1)
    out.add(json)
    out.add(json.replaceAll("/", "\\/"))
  }
  return [...out].sort((a, b) => b.length - a.length)
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]")
  return out
}

function redactValue(value: ProjectedValue, secrets: readonly string[]): ProjectedValue {
  if (typeof value === "string") return redactSecrets(value, secrets)
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, secrets)) as ProjectedValue
  }
  if (value !== null && typeof value === "object") return redactItem(value, secrets)
  return value
}

function redactItem(item: ProjectedObject, secrets: readonly string[]): ProjectedObject {
  const out: ProjectedObject = {}
  for (const [k, v] of Object.entries(item)) out[k] = redactValue(v, secrets)
  return out
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

interface AppliedAuth {
  headers: Record<string, string>
  query: [string, string][]
  /** Secrets this request carries (for redaction). */
  secrets: string[]
}

function missingCredential(field: string): ApiConnectorError {
  return new ApiConnectorError("not_configured", `The connection's credentials lack "${field}".`)
}

function need(credentials: Record<string, string> | null, field: string): string {
  const v = credentials?.[field]
  if (typeof v !== "string" || v.length === 0) throw missingCredential(field)
  return v
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/** Version key of an adapter document, for cache keys and approval pins. */
export function adapterHash(adapter: Adapter): string {
  return sha(JSON.stringify(adapter))
}

interface EgressPolicy {
  /** Hosts (host:port) a request or redirect hop may reach. */
  allowedHost: string
  protocol: string
}

function egressOptions(url: URL, policy: EgressPolicy) {
  const allowPrivate = privateApiConnectorHostsAllowed()
  const loopbackHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname)
  return {
    allowPrivate,
    requireHttps: !loopbackHttp,
    maxRedirects: MAX_REDIRECTS,
    onHopValidate: (next: URL) => {
      if (next.host !== policy.allowedHost || next.protocol !== policy.protocol) {
        throw new ApiConnectorError(
          "host_refused",
          "The API redirected off the adapter's host; refused.",
        )
      }
    },
  }
}

/** Refuse a URL this connector may never reach, before any network activity. */
function assertEgressUrl(url: URL): void {
  if (url.protocol === "https:") return
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    if (privateApiConnectorHostsAllowed()) return
    throw new ApiConnectorError(
      "host_refused",
      "Plain http to a loopback host needs LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true on this deployment.",
    )
  }
  throw new ApiConnectorError("host_refused", "The adapter's URL must use https.")
}

const TOKEN_TTL_FLOOR_S = 30
const TOKEN_TTL_CEILING_S = 3600

async function oauthToken(
  orgId: string,
  identifier: string,
  adapter: Adapter,
  credentials: Record<string, string> | null,
  credentialVersion: string,
  signal: AbortSignal,
): Promise<string> {
  const auth = adapter.auth
  if (auth.type !== "oauth2ClientCredentials") throw new Error("not an oauth2 adapter")
  const clientId = need(credentials, "clientId")
  const clientSecret = need(credentials, "clientSecret")
  const key = cacheKeyFor("token", orgId, identifier, adapterHash(adapter), credentialVersion)
  const cached = await redis.get(key).catch(() => null)
  if (cached) return cached

  // The token URL is part of the adapter (validated to the base host or the
  // declared tokenHost); runtime re-checks it, so a document that skipped
  // validation still cannot point the client secret anywhere else.
  const base = new URL(adapter.baseUrl)
  const tokenUrl = new URL(auth.tokenUrl)
  const allowedTokenHosts = new Set([base.hostname, ...(auth.tokenHost ? [auth.tokenHost] : [])])
  if (!allowedTokenHosts.has(tokenUrl.hostname)) {
    throw new ApiConnectorError(
      "host_refused",
      "The adapter's token URL is not on its API host; refused.",
    )
  }
  assertEgressUrl(tokenUrl)
  const secrets = secretValues(credentials)
  const form = new URLSearchParams({ grant_type: "client_credentials" })
  const tokenScope = auth.scope
  if (tokenScope) form.set("scope", tokenScope)
  let res: Response
  try {
    // A demo org's token request is refused before anything leaves the box,
    // exactly like its API requests (the demo fixture uses no oauth2).
    await assertDemoAppFetchAllowed(orgId, tokenUrl.origin)
    res = await fetchWithPinnedHost(
      tokenUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: form.toString(),
        signal,
      },
      {
        ...egressOptions(tokenUrl, { allowedHost: tokenUrl.host, protocol: tokenUrl.protocol }),
        maxRedirects: 0,
      },
    )
  } catch (err) {
    throw mapFetchError(err, secrets, signal)
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw new ApiConnectorError(
      "upstream_status",
      `The token endpoint answered HTTP ${res.status}.`,
      res.status,
    )
  }
  const doc = await readJson(res)
  const token =
    typeof doc === "object" && doc !== null
      ? (doc as { access_token?: unknown }).access_token
      : undefined
  if (typeof token !== "string" || token.length === 0) {
    throw new ApiConnectorError("invalid_response", "The token endpoint returned no access_token.")
  }
  const expiresIn = (doc as { expires_in?: unknown }).expires_in
  const ttl = Math.min(
    TOKEN_TTL_CEILING_S,
    Math.max(TOKEN_TTL_FLOOR_S, (typeof expiresIn === "number" ? expiresIn : 300) - 60),
  )
  await redis
    .set(key, token, "EX", ttl)
    .then(() => rememberCacheKey(orgId, identifier, key, ttl))
    .catch(() => undefined)
  return token
}

async function applyAuth(
  orgId: string,
  identifier: string,
  adapter: Adapter,
  credentials: Record<string, string> | null,
  credentialVersion: string,
  signal: AbortSignal,
): Promise<AppliedAuth> {
  const auth = adapter.auth
  switch (auth.type) {
    case "apiKey": {
      const key = need(credentials, "apiKey")
      return auth.in === "header"
        ? { headers: { [auth.name]: key }, query: [], secrets: [key] }
        : { headers: {}, query: [[auth.name, key]], secrets: [key] }
    }
    case "bearer": {
      const token = need(credentials, "token")
      return { headers: { authorization: `Bearer ${token}` }, query: [], secrets: [token] }
    }
    case "basic": {
      const user = need(credentials, "username")
      const pass = need(credentials, "password")
      const encoded = Buffer.from(`${user}:${pass}`).toString("base64")
      return { headers: { authorization: `Basic ${encoded}` }, query: [], secrets: [pass, encoded] }
    }
    case "oauth2ClientCredentials": {
      const token = await oauthToken(
        orgId,
        identifier,
        adapter,
        credentials,
        credentialVersion,
        signal,
      )
      return { headers: { authorization: `Bearer ${token}` }, query: [], secrets: [token] }
    }
  }
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > API_CONNECTOR_RESPONSE_CAP_BYTES) {
    await res.body?.cancel().catch(() => undefined)
    throw new ApiConnectorError("too_large", "The API response exceeds the 2 MB cap.")
  }
  if (!res.body) return ""
  const bytes = await readStreamCapped(res.body, API_CONNECTOR_RESPONSE_CAP_BYTES)
  if (!bytes) throw new ApiConnectorError("too_large", "The API response exceeds the 2 MB cap.")
  return bytes.toString("utf8")
}

/** Bytes of an error answer read at most, and characters of it kept. */
const ERROR_EXCERPT_READ_BYTES = 8 * 1024
export const ERROR_EXCERPT_MAX_CHARS = 600

/**
 * The start of an error answer: at most ERROR_EXCERPT_READ_BYTES read (the
 * rest is cancelled), whitespace collapsed, secrets redacted, clipped to
 * ERROR_EXCERPT_MAX_CHARS. Best effort: a body that cannot be read gives "".
 */
async function readErrorExcerpt(res: Response, secrets: readonly string[]): Promise<string> {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < ERROR_EXCERPT_READ_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
  } catch {
    return ""
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const text = Buffer.concat(chunks)
    .subarray(0, ERROR_EXCERPT_READ_BYTES)
    .toString("utf8")
    .replace(/\s+/g, " ")
    .trim()
  // Redact before clipping, so a clip never leaves half a secret behind.
  const redacted = redactSecrets(text, secrets)
  return redacted.length > ERROR_EXCERPT_MAX_CHARS
    ? `${redacted.slice(0, ERROR_EXCERPT_MAX_CHARS - 1)}…`
    : redacted
}

async function readJson(res: Response): Promise<unknown> {
  const text = await readCapped(res)
  if (text.trim() === "") return null
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiConnectorError("invalid_response", "The API did not answer with JSON.")
  }
}

function mapFetchError(
  err: unknown,
  secrets: readonly string[],
  signal: AbortSignal,
): ApiConnectorError {
  if (err instanceof ApiConnectorError) return err
  if (signal.aborted) {
    const reason = signal.reason
    if (reason instanceof ApiConnectorError) return reason
    return new ApiConnectorError("timeout", "The API did not answer in time.")
  }
  if (err instanceof UnsafeOutboundUrlError) {
    return new ApiConnectorError("host_refused", redactSecrets(err.message, secrets))
  }
  if (isDemoRestriction(err)) {
    return new ApiConnectorError(
      "demo_restricted",
      err instanceof Error ? err.message : "Refused in a demo.",
    )
  }
  const message = err instanceof Error ? err.message : String(err)
  return new ApiConnectorError(
    "upstream_status",
    `The API could not be reached: ${redactSecrets(message, secrets)}`,
  )
}

// ---------------------------------------------------------------------------
// One operation call
// ---------------------------------------------------------------------------

export interface CallOperationInput {
  orgId: string
  identifier: string
  adapter: Adapter
  credentials: Record<string, string> | null
  /** The credential account's version (store `credentialVersion`), for the token cache key. */
  credentialVersion: string
  operation: Operation
  params: Record<string, unknown>
  /** Pages to fetch at most (the operation's own maxPages still applies). */
  maxPages?: number
  /** Overall budget across pages. */
  budgetMs?: number
  /** Per-request timeout. */
  requestTimeoutMs?: number
  /** The caller's cancellation. */
  signal?: AbortSignal
  /** Upstream requests this call may still make (shared with the caller's other calls). */
  requestBudget?: RequestBudget
}

export interface CallOperationResult {
  /** HTTP status of the last page. */
  status: number
  items: ProjectedObject[]
  truncated: boolean
  pages: number
  ms: number
}

function deadlineSignal(ms: number, code: ApiConnectorErrorCode, message: string): AbortSignal {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new ApiConnectorError(code, message)), ms)
  timer.unref?.()
  return ctl.signal
}

async function sendOnce(
  input: CallOperationInput,
  rendered: RenderedRequest,
  extraQuery: [string, string][],
  auth: AppliedAuth,
  secrets: readonly string[],
  signal: AbortSignal,
): Promise<{ status: number; doc: unknown }> {
  const url = requestUrl(input.adapter, rendered, [...extraQuery, ...auth.query])
  assertEgressUrl(url)
  const base = new URL(input.adapter.baseUrl)
  if (url.host !== base.host)
    throw new ApiConnectorError("host_refused", "The request left the adapter's host.")

  // The adapter's literal headers first: auth always wins over them.
  const headers: Record<string, string> = {
    accept: "application/json",
    ...staticHeaders(input.adapter),
    ...auth.headers,
  }
  let body: string | undefined
  if (rendered.body !== undefined) {
    headers["content-type"] = "application/json"
    body = JSON.stringify(rendered.body)
  }

  let res: Response | null = null
  if (demoResponder) {
    res = await demoResponder({
      orgId: input.orgId,
      identifier: input.identifier,
      adapter: input.adapter,
      operation: input.operation,
      url,
      method: rendered.method,
      body: rendered.body,
    })
  }
  if (!res) {
    try {
      await assertDemoAppFetchAllowed(input.orgId, url.origin)
      res = await fetchWithPinnedHost(
        url,
        { method: rendered.method, headers, body, signal },
        egressOptions(url, { allowedHost: base.host, protocol: base.protocol }),
      )
    } catch (err) {
      throw mapFetchError(err, secrets, signal)
    }
  }
  if (res.status < 200 || res.status >= 300) {
    const excerpt = await readErrorExcerpt(res, secrets)
    throw new ApiConnectorError(
      "upstream_status",
      `The API answered HTTP ${res.status} for ${input.operation.name}.`,
      res.status,
      excerpt,
    )
  }
  try {
    return { status: res.status, doc: await readJson(res) }
  } catch (err) {
    throw mapFetchError(err, secrets, signal)
  }
}

/**
 * The request URL, or the connector error its refusal maps to: a URL that
 * left the base URL is `host_refused`, any other render refusal
 * `invalid_params` (never an internal error).
 */
export function requestUrl(
  adapter: Adapter,
  rendered: RenderedRequest,
  extraQuery: [string, string][] = [],
): URL {
  try {
    return buildRequestUrl(adapter, rendered, extraQuery)
  } catch (err) {
    if (!(err instanceof ConnectorRenderError)) throw err
    if (err.code === "outside_base_url") {
      throw new ApiConnectorError("host_refused", "The request left the adapter's base URL.")
    }
    throw new ApiConnectorError("invalid_params", err.message)
  }
}

/** What `api-connector test --dry-run` prints: the request as it would be sent, auth redacted. */
export interface DryRunRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: JsonValue
  /** A chained read: the steps that would follow, fed by this request's items. */
  chain?: { operation: string; params: Record<string, string | number | boolean> }[]
}

export const REDACTED = "REDACTED"

/**
 * Render one call without sending it or reading a credential: the method, the
 * URL (first page, a query-auth value shown as REDACTED), the headers the
 * transport would add (the auth value REDACTED) and the body. Render
 * refusals map like a real call's (`invalid_params`, `host_refused`).
 */
export function describeRequest(
  adapter: Adapter,
  operation: Operation,
  params: Record<string, unknown>,
  now?: Date,
): DryRunRequest {
  let rendered: RenderedRequest
  try {
    rendered = render(operation, params, now ? { now } : {})
  } catch (err) {
    if (err instanceof ConnectorRenderError)
      throw new ApiConnectorError("invalid_params", err.message)
    throw err
  }
  const headers: Record<string, string> = { accept: "application/json", ...staticHeaders(adapter) }
  const authQuery: [string, string][] = []
  const auth = adapter.auth
  if (auth.type === "apiKey") {
    if (auth.in === "header") headers[auth.name.toLowerCase()] = REDACTED
    else authQuery.push([auth.name, REDACTED])
  } else if (auth.type === "basic") headers.authorization = `Basic ${REDACTED}`
  else headers.authorization = `Bearer ${REDACTED}`
  if (rendered.body !== undefined) headers["content-type"] = "application/json"
  const url = requestUrl(adapter, rendered, [...firstPageQuery(operation), ...authQuery])
  return {
    method: rendered.method,
    url: url.href,
    headers,
    ...(rendered.body !== undefined ? { body: rendered.body } : {}),
    ...(operation.chain
      ? { chain: operation.chain.map((st) => ({ operation: st.operation, params: st.params })) }
      : {}),
  }
}

/** Run one operation (all its pages, within bounds) and return projected items. */
export async function callOperation(input: CallOperationInput): Promise<CallOperationResult> {
  const started = Date.now()
  let rendered: RenderedRequest
  try {
    rendered = render(input.operation, input.params)
  } catch (err) {
    if (err instanceof ConnectorRenderError)
      throw new ApiConnectorError("invalid_params", err.message)
    throw err
  }

  const budget = deadlineSignal(
    input.budgetMs ?? API_CONNECTOR_PAGES_BUDGET_MS,
    "timeout",
    "The API did not finish within the call's time budget.",
  )
  const outer = input.signal ? AbortSignal.any([budget, input.signal]) : budget
  const secrets = secretValues(input.credentials)
  let auth: AppliedAuth
  try {
    auth = await applyAuth(
      input.orgId,
      input.identifier,
      input.adapter,
      input.credentials,
      input.credentialVersion,
      outer,
    )
  } catch (err) {
    throw mapFetchError(err, secrets, outer)
  }
  const allSecrets = secretValues(input.credentials, auth.secrets)

  const maxPages = Math.max(1, input.maxPages ?? Number.POSITIVE_INFINITY)
  const items: ProjectedObject[] = []
  let truncated = false
  let pages = 0
  let status = 0
  let extra = firstPageQuery(input.operation)
  for (;;) {
    const perRequest = AbortSignal.any([
      outer,
      deadlineSignal(
        input.requestTimeoutMs ?? API_CONNECTOR_REQUEST_TIMEOUT_MS,
        "timeout",
        "The API did not answer within 15 seconds.",
      ),
    ])
    if (input.requestBudget && !input.requestBudget.take()) {
      if (pages === 0) throw new RequestBudgetError()
      break
    }
    let page: { status: number; doc: unknown }
    const release = await acquireConnectionSlot(input.orgId, input.identifier, perRequest).catch(
      (err: unknown) => {
        if (err instanceof ApiConnectorError) throw err
        throw mapFetchError(err, allSecrets, perRequest)
      },
    )
    try {
      page = await sendOnce(input, rendered, extra, auth, allSecrets, perRequest)
    } finally {
      await release()
    }
    pages++
    status = page.status
    const projected = project(page.doc, input.operation, MAX_ITEMS_PER_CALL - items.length)
    items.push(...projected.items.map((item) => redactItem(item, allSecrets)))
    if (projected.truncated) {
      truncated = true
      break
    }
    if (items.length >= MAX_ITEMS_PER_CALL || pages >= maxPages) break
    const next = nextPageQuery(input.operation, page.doc, pages, projected.items.length)
    if (!next) break
    extra = next
  }
  return { status, items, truncated, pages, ms: Date.now() - started }
}

/** The credential fields an adapter's auth type needs (all required). */
export function requiredCredentialFields(adapter: Adapter): readonly string[] {
  return AUTH_CREDENTIAL_FIELDS[adapter.auth.type]
}

// ---------------------------------------------------------------------------
// Bound egress for import transforms
// ---------------------------------------------------------------------------
//
// An import transform pulling from an API never sees a URL or a credential:
// it names a path, and the host joins it to the connection's base URL, adds
// the auth and sends a GET. Every rule of an operation call holds (https, the
// pinned-DNS SSRF guard, demo refusal, redaction), plus:
//   - the path is relative to the base URL: an absolute URL, `//`, a `..`
//     segment (plain or percent-encoded), a backslash or a fragment is refused;
//   - GET only: there is no method parameter;
//   - a redirect may only reach the base host or one of the adapter's
//     `redirectHosts` (declared in the adapter document by an admin, never by
//     the transform), over https, and every hop after the first goes out with
//     no request headers at all (`headersOnFirstHopOnly`), so neither an
//     Authorization header nor an apiKey header ever reaches another host;
//   - a 429 is an answer with `retryAfterMs`, not an error, so the import's
//     host loop can wait outside the sandbox deadline.

export interface BoundRequestInput {
  orgId: string
  identifier: string
  adapter: Adapter
  credentials: Record<string, string> | null
  credentialVersion: string
  /** A path relative to the adapter's base URL, with an optional query. */
  path: string
  signal?: AbortSignal
  requestTimeoutMs?: number
}

export interface BoundGetResult {
  status: number
  /** The JSON body of a 2xx answer, credentials redacted; null otherwise. */
  data: unknown
  /** From Retry-After on a 429 (seconds or an HTTP date), else null. */
  retryAfterMs: number | null
}

export interface BoundStreamResult {
  status: number
  /** The body of a 2xx answer; null otherwise (the body is discarded). */
  body: ReadableStream<Uint8Array> | null
  contentType: string | null
  contentLength: number | null
  /** A filename from Content-Disposition, when the API sent one. */
  filename: string | null
  retryAfterMs: number | null
}

const BOUND_PATH_MAX = 4096

/** The request URL for a bound path, or `host_refused` / `invalid_params`. */
export function boundRequestUrl(adapter: Adapter, path: string): URL {
  if (typeof path !== "string" || path.length === 0 || path.length > BOUND_PATH_MAX) {
    throw new ApiConnectorError(
      "invalid_params",
      "A path relative to the connection's base URL is required.",
    )
  }
  if (!path.startsWith("/") || path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new ApiConnectorError(
      "host_refused",
      "Only a path on the connection's base URL may be requested (it starts with a single /), never a full URL.",
    )
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\\#\u0000-\u001f\u007f]/.test(path)) {
    throw new ApiConnectorError(
      "invalid_params",
      "The path contains a backslash, a fragment or a control character.",
    )
  }
  const [rawPath = "", query] = splitOnce(path, "?")
  const segments = rawPath.split("/")
  for (const seg of segments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(seg)
    } catch {
      throw new ApiConnectorError("invalid_params", "The path is not validly percent-encoded.")
    }
    if (decoded === ".." || decoded === "." || decoded.includes("/") || decoded.includes("\\")) {
      throw new ApiConnectorError(
        "host_refused",
        "The path may not leave the connection's base URL.",
      )
    }
  }
  const base = new URL(adapter.baseUrl)
  const basePath = base.pathname.replace(/\/+$/, "")
  const url = new URL(base.origin)
  url.pathname = `${basePath}${rawPath}`
  if (query !== undefined) url.search = query
  if (url.host !== base.host || !url.pathname.startsWith(`${basePath}/`)) {
    throw new ApiConnectorError("host_refused", "The request left the connection's base URL.")
  }
  return url
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const at = s.indexOf(sep)
  return at < 0 ? [s, undefined] : [s.slice(0, at), s.slice(at + 1)]
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after")
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets))
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value))
      out[redactSecrets(k, secrets)] = redactDeep(v, secrets)
    return out
  }
  return value
}

function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition)
  if (star?.[1]) {
    try {
      return sanitizeFilename(decodeURIComponent(star[1].trim()))
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition)
  return plain?.[1] ? sanitizeFilename(plain[1].trim()) : null
}

/**
 * Send a bound GET. The request timeout covers the whole answer for JSON; for
 * a stream (`untilHeaders`) it covers the wait for the headers only, and the
 * caller's own signal bounds the body.
 */
async function sendBound(
  input: BoundRequestInput,
  accept: string,
  untilHeaders = false,
): Promise<{ res: Response; secrets: string[]; signal: AbortSignal; done: () => void }> {
  const ctl = new AbortController()
  const timer = setTimeout(
    () => ctl.abort(new ApiConnectorError("timeout", "The API did not answer in time.")),
    input.requestTimeoutMs ?? API_CONNECTOR_REQUEST_TIMEOUT_MS,
  )
  timer.unref?.()
  const signal = input.signal ? AbortSignal.any([ctl.signal, input.signal]) : ctl.signal
  const done = () => clearTimeout(timer)
  try {
    const sent = await sendBoundWith(input, accept, signal)
    if (untilHeaders) done()
    return { ...sent, done }
  } catch (err) {
    done()
    throw err
  }
}

async function sendBoundWith(
  input: BoundRequestInput,
  accept: string,
  signal: AbortSignal,
): Promise<{ res: Response; secrets: string[]; signal: AbortSignal }> {
  const baseSecrets = secretValues(input.credentials)
  const url = boundRequestUrl(input.adapter, input.path)
  assertEgressUrl(url)
  let auth: AppliedAuth
  try {
    auth = await applyAuth(
      input.orgId,
      input.identifier,
      input.adapter,
      input.credentials,
      input.credentialVersion,
      signal,
    )
  } catch (err) {
    throw mapFetchError(err, baseSecrets, signal)
  }
  const secrets = secretValues(input.credentials, auth.secrets)
  for (const [k, v] of auth.query) url.searchParams.append(k, v)
  const base = new URL(input.adapter.baseUrl)
  const allowedHosts = new Set([base.host, ...(input.adapter.redirectHosts ?? [])])
  try {
    await assertDemoAppFetchAllowed(input.orgId, url.origin)
    const res = await fetchWithPinnedHost(
      url,
      {
        method: "GET",
        headers: { accept, ...staticHeaders(input.adapter), ...auth.headers },
        signal,
      },
      {
        ...egressOptions(url, { allowedHost: base.host, protocol: base.protocol }),
        headersOnFirstHopOnly: true,
        onHopValidate: (next: URL) => {
          const sameBase = next.host === base.host && next.protocol === base.protocol
          if (!sameBase && !(next.protocol === "https:" && allowedHosts.has(next.host))) {
            throw new ApiConnectorError(
              "host_refused",
              "The API redirected to a host the connection does not declare in redirectHosts; refused.",
            )
          }
        },
      },
    )
    return { res, secrets, signal }
  } catch (err) {
    throw mapFetchError(err, secrets, signal)
  }
}

/**
 * The adapter's literal headers (`headers` in the document, validated by the
 * core schema: no auth, cookie, hop, proxy or forwarding header, no
 * placeholder), lowercased. Sent on the first hop only, like auth.
 */
function staticHeaders(adapter: Adapter): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(adapter.headers ?? {})) out[k.toLowerCase()] = v
  return out
}

/** A bound GET returning JSON (2 MB cap), credentials redacted from the answer. */
export async function boundGet(input: BoundRequestInput): Promise<BoundGetResult> {
  const { res, secrets, signal, done } = await sendBound(input, "application/json")
  try {
    return await readBoundAnswer(res, secrets, signal)
  } finally {
    done()
  }
}

async function readBoundAnswer(
  res: Response,
  secrets: string[],
  signal: AbortSignal,
): Promise<BoundGetResult> {
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel().catch(() => undefined)
    return {
      status: res.status,
      data: null,
      retryAfterMs: res.status === 429 ? retryAfterMs(res) : null,
    }
  }
  try {
    return {
      status: res.status,
      data: redactDeep(await readJson(res), secrets),
      retryAfterMs: null,
    }
  } catch (err) {
    throw mapFetchError(err, secrets, signal)
  }
}

/**
 * A bound GET whose body the caller streams to storage (an attachment). The
 * body is handed over unread; the caller applies its own size limits.
 */
export async function boundFetchToStream(input: BoundRequestInput): Promise<BoundStreamResult> {
  const { res } = await sendBound(input, "*/*", true)
  const declared = Number(res.headers.get("content-length") ?? "")
  if (res.status < 200 || res.status >= 300 || !res.body) {
    await res.body?.cancel().catch(() => undefined)
    return {
      status: res.status,
      body: null,
      contentType: null,
      contentLength: null,
      filename: null,
      retryAfterMs: res.status === 429 ? retryAfterMs(res) : null,
    }
  }
  return {
    status: res.status,
    body: res.body,
    contentType: res.headers.get("content-type"),
    contentLength:
      Number.isFinite(declared) && declared >= 0 && res.headers.has("content-length")
        ? declared
        : null,
    filename: filenameFrom(res.headers.get("content-disposition")),
    retryAfterMs: null,
  }
}
