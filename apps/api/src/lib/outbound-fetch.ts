// SPDX-License-Identifier: FSL-1.1-ALv2
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { env } from "~/lib/env"
import { isAlwaysBlockedIp, isPrivateIp } from "~/lib/ip-classify"
import { isInstanceHostname } from "~/lib/org-public-url"
import { ownOption } from "~/lib/safe-path"

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const DEFAULT_MAX_REDIRECTS = 5
/** Request headers that carry the first origin's credentials; never sent to another origin. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"]

function withoutCredentialHeaders(headers: RequestInit["headers"]): Headers {
  const out = new Headers(headers)
  for (const name of CREDENTIAL_HEADERS) out.delete(name)
  return out
}

export class UnsafeOutboundUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeOutboundUrlError"
  }
}

interface OutboundValidationOptions {
  requireHttps?: boolean
  allowPrivateHostsInTest?: boolean
  /**
   * Allow private and loopback addresses (an operator's own server on its
   * network). Link-local and metadata addresses stay refused
   * (`isAlwaysBlockedIp`). Off by default; the caller decides from an
   * operator setting, never from a request.
   */
  allowPrivate?: boolean
}

function normalizeUrl(url: string | URL): URL {
  return typeof url === "string" ? new URL(url) : new URL(url.toString())
}

function isTestPrivateHostAllowed(opts: OutboundValidationOptions): boolean {
  return env.NODE_ENV === "test" && (ownOption(opts, "allowPrivateHostsInTest") ?? false)
}

/**
 * The routes a holder of a client's link or a portal session calls. No
 * server-side fetch (an agent's web fetch, an app's egress, an API connector)
 * may call them on this server: an agent that found a link must not be able to
 * open, verify or decide it from the server.
 */
const OWN_ACTION_PREFIXES = ["/api/public", "/api/portal"]

/** The path as the router reads it: percent-decoded, lowercased, single slashes, no dot segments. */
function routedPath(url: URL): string {
  let path = url.pathname
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(path); i++) {
    try {
      path = decodeURIComponent(path)
    } catch {
      break
    }
  }
  path = path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .toLowerCase()
  const out: string[] = []
  for (const seg of path.split("/")) {
    if (seg === "..") out.pop()
    else if (seg !== "." && seg !== "") out.push(seg)
  }
  return `/${out.join("/")}`
}

function isActionRoutePath(url: URL): boolean {
  const path = routedPath(url)
  return OWN_ACTION_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
}

/** This server's own public addresses (LIAISON_CELL_PUBLIC_ADDRESSES), as compared. */
function ownPublicAddresses(): Set<string> {
  return new Set(
    (env.LIAISON_CELL_PUBLIC_ADDRESSES ?? "")
      .split(",")
      .map((a) => normalizeIp(a))
      .filter((a) => a.length > 0),
  )
}

function normalizeIp(address: string): string {
  const a = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
  return /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)?.[1] ?? a
}

const OWN_ACTION_REFUSAL = "Outbound URL must not call this server's public or portal routes"

/** Refuses this server's own client action and portal routes, by name or by address. */
function refuseOwnActionRoute(url: URL, address?: string): void {
  if (!isActionRoutePath(url)) return
  if (isInstanceHostname(url.hostname)) throw new UnsafeOutboundUrlError(OWN_ACTION_REFUSAL)
  const own = ownPublicAddresses()
  const isOwn = (a: string) => {
    const ip = normalizeIp(a)
    // Loopback is this machine: with private hosts allowed, it is this server too.
    return (
      own.has(ip) || ip === "localhost" || ip === "::1" || ip === "0.0.0.0" || /^127\./.test(ip)
    )
  }
  if (isOwn(url.hostname) || (address && isOwn(address))) {
    throw new UnsafeOutboundUrlError(OWN_ACTION_REFUSAL)
  }
}

/**
 * Scheme + literal-IP validation only. Does NOT resolve DNS — used by
 * fetchWithPinnedHost which combines this with a single DNS resolution
 * inside resolveAndPin. Exported so callers that delegate to
 * fetchWithPinnedHost can avoid redundant DNS lookups.
 */
export function validateOutboundUrlNoDns(
  url: string | URL,
  opts: OutboundValidationOptions = {},
): URL {
  const parsed = normalizeUrl(url)
  const requireHttps = opts.requireHttps ?? true
  // Before every other rule, test hosts included: no option opens these routes.
  refuseOwnActionRoute(parsed)

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeOutboundUrlError("Outbound URL must use http or https")
  }
  if (requireHttps && parsed.protocol !== "https:" && !isTestPrivateHostAllowed(opts)) {
    throw new UnsafeOutboundUrlError("Outbound URL must use HTTPS")
  }
  if (isTestPrivateHostAllowed(opts)) {
    return parsed
  }
  const hostname = parsed.hostname
  const cleanHost =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  if (ownOption(opts, "allowPrivate") === true && isAlwaysBlockedIp(cleanHost)) {
    throw new UnsafeOutboundUrlError(
      "Outbound URL must not point to a link-local or metadata address",
    )
  }
  if (ownOption(opts, "allowPrivate") !== true && isPrivateIp(cleanHost)) {
    throw new UnsafeOutboundUrlError("Outbound URL must not point to a private network")
  }
  return parsed
}

export async function validateOutboundUrl(
  url: string | URL,
  opts: OutboundValidationOptions = {},
): Promise<URL> {
  const parsed = validateOutboundUrlNoDns(url, opts)

  if (isTestPrivateHostAllowed(opts)) {
    return parsed
  }

  const hostname = parsed.hostname
  const cleanHost =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname

  if (isIP(cleanHost)) {
    return parsed
  }

  try {
    const resolved = await lookup(cleanHost, { all: true })
    if (resolved.length === 0) {
      throw new UnsafeOutboundUrlError("Outbound URL host could not be resolved")
    }
    for (const entry of resolved) refuseOwnActionRoute(parsed, entry.address)
    if (
      ownOption(opts, "allowPrivate") === true &&
      resolved.some((entry) => isAlwaysBlockedIp(entry.address))
    ) {
      throw new UnsafeOutboundUrlError(
        "Outbound URL must not resolve to a link-local or metadata address",
      )
    }
    if (
      ownOption(opts, "allowPrivate") !== true &&
      resolved.some((entry) => isPrivateIp(entry.address))
    ) {
      throw new UnsafeOutboundUrlError("Outbound URL must not resolve to a private network")
    }
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) throw err
    throw new UnsafeOutboundUrlError("Outbound URL host could not be validated")
  }

  return parsed
}

interface RedirectValidationOptions extends OutboundValidationOptions {
  maxRedirects?: number
}

export interface PinnedFetchOptions extends RedirectValidationOptions {
  /** Test-only injection seam. */
  fetchImpl?: typeof fetch
  /**
   * Called once for the initial URL (after validateOutboundUrl) and once for
   * each redirect target (after validateOutboundUrl on the new URL). Throw
   * to abort the chain — the thrown error propagates to the caller. Use
   * this for caller-policy enforcement (allowlist, blocklist).
   */
  onHopValidate?: (next: URL) => void | Promise<void>
  /**
   * Send `init.headers` on the FIRST request only; every redirect hop goes out with no
   * request headers at all. For a credentialed download whose upstream redirects to a
   * storage host (a presigned URL): the credential is the first host's, never the next one's.
   */
  headersOnFirstHopOnly?: boolean
  /** Called after each hop's response is received (status, host), for an audit line. */
  onHopResponse?: (hop: { url: URL; status: number }) => void
  /**
   * Per-hop operator allowance: when it returns true for a hop's URL, that hop (and only that
   * hop) may use plain HTTP and resolve to a private or loopback address, as `allowPrivate`
   * does. Link-local and metadata addresses stay refused. A redirect to a URL it does not
   * accept falls back to the caller's base options.
   */
  privateAllowedFor?: (url: URL) => boolean
  /**
   * Addresses the caller may never reach, whatever the other options allow
   * (this server's own public addresses for a tenant's code): checked on every
   * hop's pinned address. Return a reason to refuse it.
   */
  refuseAddress?: (address: string, url: URL) => string | null
}

function hopOptions<T extends PinnedFetchOptions>(opts: T, url: URL): T {
  return opts.privateAllowedFor?.(url) ? { ...opts, requireHttps: false, allowPrivate: true } : opts
}

async function resolveAndPin(
  url: URL,
  opts: { allowPrivate?: boolean; allowPrivateNotMetadata?: boolean } = {},
): Promise<{ address: string; family: 4 | 6 } | null> {
  const hostname = url.hostname
  const cleanHost =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  if (isIP(cleanHost)) {
    return { address: cleanHost, family: isIP(cleanHost) as 4 | 6 }
  }
  const resolved = await lookup(cleanHost, { all: true })
  if (resolved.length === 0) return null
  if (
    ownOption(opts, "allowPrivateNotMetadata") === true &&
    resolved.some((entry) => isAlwaysBlockedIp(entry.address))
  ) {
    throw new UnsafeOutboundUrlError(
      "Outbound URL must not resolve to a link-local or metadata address",
    )
  }
  if (
    ownOption(opts, "allowPrivate") !== true &&
    resolved.some((entry) => isPrivateIp(entry.address))
  ) {
    throw new UnsafeOutboundUrlError("Outbound URL must not resolve to a private network")
  }
  return { address: resolved[0].address, family: resolved[0].family as 4 | 6 }
}

/** Bun's fetch options beyond RequestInit: TLS settings for the connection. */
type RuntimeFetchInit = RequestInit & { tls?: Record<string, unknown> }

/**
 * The request that reaches exactly `pinned`: the URL's host is the IP literal
 * (bracketed for IPv6), the Host header carries the original host[:port], and
 * HTTPS verifies the certificate for, and sends SNI of, the original hostname.
 * A URL whose host is already an IP literal goes out unchanged.
 */
function pinnedRequest(
  url: URL,
  pinned: { address: string; family: 4 | 6 },
  init: RuntimeFetchInit,
): { target: URL; init: RuntimeFetchInit } {
  const hostname = url.hostname
  const cleanHost =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  if (isIP(cleanHost)) return { target: url, init }
  const target = new URL(url)
  target.hostname = pinned.family === 6 ? `[${pinned.address}]` : pinned.address
  const headers = new Headers(init.headers)
  headers.set("host", url.host)
  return {
    target,
    init: {
      ...init,
      headers,
      ...(url.protocol === "https:" ? { tls: { ...init.tls, serverName: cleanHost } } : {}),
    },
  }
}

/**
 * SSRF-safe fetch: resolves DNS once for the original hostname, validates the
 * answer, then connects to that IP literal (Host header and TLS server name
 * stay the original hostname, so certificate checks are unchanged). Re-runs
 * validation + pinning on each redirect hop (followed manually, capped by
 * `maxRedirects`). Closes the DNS-rebinding TOCTOU of a plain fetch(), which
 * resolves the hostname again at connect time.
 *
 * Pass `fetchImpl` to inject a fake fetch for tests: it receives the original
 * URL (no pinning happens inside a fake). Otherwise the runtime's fetch is
 * used with the pinned request.
 * Pass `onHopValidate` to enforce caller policy on initial URL + every redirect.
 *
 * Redirects and credentials: `init.redirect` is honoured ("manual" returns the
 * 3xx unfollowed, "error" throws on one; the default follows). A followed
 * redirect that leaves the request's origin drops the Authorization, Cookie and
 * Proxy-Authorization headers for that hop and every later one, and a 307/308
 * that would replay a request body to another origin is refused: a body is
 * where OAuth requests carry refresh tokens, codes and client secrets.
 */
// Test-only injection seam — applies to callers that don't pass `fetchImpl`
// explicitly (e.g. mail/image-proxy which routes through
// fetchWithRedirectValidation). Pattern mirrors SandboxBridgeTestAccess.setFetch.
let outboundFetchForTest: typeof fetch | null = null

export async function fetchWithPinnedHost(
  url: string | URL,
  init: RequestInit = {},
  opts: PinnedFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const injectedFetch = opts.fetchImpl ?? outboundFetchForTest

  let currentUrl = normalizeUrl(url)
  currentUrl = validateOutboundUrlNoDns(currentUrl, hopOptions(opts, currentUrl))
  await opts.onHopValidate?.(currentUrl)
  let currentMethod = init.method ?? "GET"
  let currentBody = init.body
  const redirectMode = init.redirect ?? "follow"
  const originalOrigin = currentUrl.origin
  // Once a hop leaves the original origin, credentials stay off for the rest of the chain.
  let leftOrigin = false

  // Honour `allowPrivateHostsInTest` for the DNS-pin layer too — callers that
  // want to reach local-network mocks (test OIDC server, mail Mailpit, etc.)
  // already passed this flag into validateOutboundUrlNoDns above; mirror it
  // for resolveAndPin so the second check doesn't undo the first.
  const allowPrivateLookup =
    env.NODE_ENV === "test" && (ownOption(opts, "allowPrivateHostsInTest") ?? false)

  for (let hop = 0; hop <= maxRedirects; hop++) {
    // An operator-allowed private server: private and loopback pins pass, the
    // always-blocked addresses never do (checked on every hop's pin below).
    const allowPrivateNotMetadata = hopOptions(opts, currentUrl).allowPrivate === true
    const pinned = await resolveAndPin(currentUrl, {
      allowPrivate: allowPrivateLookup || allowPrivateNotMetadata,
      allowPrivateNotMetadata: allowPrivateNotMetadata && !allowPrivateLookup,
    })
    if (!pinned) {
      throw new UnsafeOutboundUrlError("Outbound URL host could not be resolved")
    }
    if (allowPrivateNotMetadata && !allowPrivateLookup && isAlwaysBlockedIp(pinned.address)) {
      throw new UnsafeOutboundUrlError(
        "Outbound URL must not resolve to a link-local or metadata address",
      )
    }
    if (!allowPrivateLookup && !allowPrivateNotMetadata && isPrivateIp(pinned.address)) {
      throw new UnsafeOutboundUrlError("Outbound URL must not resolve to a private network")
    }
    refuseOwnActionRoute(currentUrl, pinned.address)
    const refused = opts.refuseAddress?.(pinned.address, currentUrl)
    if (refused) throw new UnsafeOutboundUrlError(refused)

    const hopInit: RuntimeFetchInit = {
      ...init,
      ...(opts.headersOnFirstHopOnly && hop > 0
        ? { headers: {} }
        : leftOrigin
          ? { headers: withoutCredentialHeaders(init.headers) }
          : {}),
      method: currentMethod,
      body: currentBody,
      redirect: "manual",
    }
    let response: Response
    if (injectedFetch) {
      response = await injectedFetch(currentUrl, hopInit)
    } else {
      const request = pinnedRequest(currentUrl, pinned, hopInit)
      response = await Bun.fetch(request.target, request.init)
      // Callers read the URL they asked for (e.g. the agent's page source), not the IP.
      Object.defineProperty(response, "url", { value: currentUrl.toString() })
    }
    opts.onHopResponse?.({ url: currentUrl, status: response.status })

    if (!REDIRECT_STATUSES.has(response.status) || redirectMode === "manual") {
      return response
    }
    if (redirectMode === "error") {
      throw new UnsafeOutboundUrlError(`Redirect refused (status ${response.status})`)
    }

    if (hop === maxRedirects) {
      throw new UnsafeOutboundUrlError(`Too many redirects (max ${maxRedirects})`)
    }

    const location = response.headers.get("location")
    if (!location) {
      throw new UnsafeOutboundUrlError("Redirect response missing location header")
    }

    const nextUrl = new URL(location, currentUrl)
    currentUrl = validateOutboundUrlNoDns(nextUrl, hopOptions(opts, nextUrl))
    await opts.onHopValidate?.(currentUrl)

    const keepsBody =
      currentBody !== undefined &&
      currentBody !== null &&
      (response.status === 307 ||
        response.status === 308 ||
        ((response.status === 301 || response.status === 302) &&
          currentMethod.toUpperCase() !== "POST"))
    if (currentUrl.origin !== originalOrigin) {
      if (keepsBody) {
        throw new UnsafeOutboundUrlError(
          "Cross-origin redirect refused: it would resend the request body to another origin",
        )
      }
      leftOrigin = true
    }

    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        currentMethod.toUpperCase() === "POST")
    ) {
      currentMethod = "GET"
      currentBody = undefined
    }
  }

  throw new UnsafeOutboundUrlError("Redirect validation failed")
}

export async function fetchWithRedirectValidation(
  url: string | URL,
  init: RequestInit = {},
  opts: PinnedFetchOptions = {},
): Promise<Response> {
  return fetchWithPinnedHost(url, init, opts)
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const OutboundFetchTestAccess = {
  setFetch(fn: typeof fetch | null): void {
    outboundFetchForTest = fn
  },
}
