// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHmac, timingSafeEqual } from "node:crypto"
import { BlockList, isIP } from "node:net"
import type { Context } from "hono"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"

/**
 * The peers allowed to hand us an X-Forwarded-For: loopback and the private
 * ranges a reverse proxy on the same host or network connects from, plus any
 * operator-listed CIDRs (TRUSTED_PROXY_CIDRS). A connection from anywhere else
 * reached the app port directly, so its X-Forwarded-For is whatever the client
 * typed and is never read.
 */
export function buildTrustedProxyList(extraCidrs: string): BlockList {
  const list = new BlockList()
  const add = (cidr: string) => {
    const [net, bits] = cidr.split("/")
    const family = isIP(net ?? "")
    if (!net || family === 0) {
      rootLogger.warn({ cidr }, "TRUSTED_PROXY_CIDRS: ignoring an entry that is not a CIDR")
      return
    }
    const type = family === 4 ? "ipv4" : "ipv6"
    const prefix = bits === undefined ? (family === 4 ? 32 : 128) : Number(bits)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
      rootLogger.warn({ cidr }, "TRUSTED_PROXY_CIDRS: ignoring an entry with a bad prefix")
      return
    }
    list.addSubnet(net, prefix, type)
  }
  for (const cidr of [
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "::1/128",
    "fc00::/7",
  ]) {
    add(cidr)
  }
  for (const cidr of extraCidrs
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean))
    add(cidr)
  return list
}

let trustedProxies: BlockList | null = null
function isTrustedProxyPeer(socketIp: string): boolean {
  trustedProxies ??= buildTrustedProxyList(env.TRUSTED_PROXY_CIDRS)
  return isTrustedProxyAddress(trustedProxies, socketIp)
}

/** Whether `ip` (v4, v6, or v4-mapped v6) falls in `list`. */
export function isTrustedProxyAddress(list: BlockList, ip: string): boolean {
  const family = isIP(ip)
  if (family === 0) return false
  return list.check(ip, family === 4 ? "ipv4" : "ipv6")
}

/**
 * Extract client IP from raw headers, accounting for trusted proxy hops.
 * Shared between Hono context (getClientIp) and raw Request (getClientIpFromHeaders).
 */
export function getClientIpFromHeaders(
  headers: { get(name: string): string | null },
  socketIp?: string | null,
  trustedHops?: number,
): string {
  const hops = trustedHops ?? env.TRUSTED_PROXY_HOPS
  if (hops === 0) {
    return socketIp ?? "unknown-ip"
  }
  // A known socket peer that is not a proxy we trust connected straight to the
  // app: its forwarded chain is client-chosen. (No socket peer at all only
  // happens for in-process requests, which have no other address to use.)
  if (socketIp && !isTrustedProxyPeer(socketIp)) return socketIp
  // The N trusted proxies each APPEND the address of the peer they saw, so with
  // N of them the entry the outermost trusted proxy appended -- the real client --
  // is the Nth from the right. Everything to its left is client-supplied and is
  // never read. (A proxy that OVERWRITES the header, the Caddy default, leaves a
  // single entry, which is the same element.) With fewer entries than N the chain
  // is shorter than configured, so the leftmost entry is the earliest we have.
  const forwarded = headers.get("x-forwarded-for")
  if (forwarded) {
    const parts = forwarded.split(",").map((s) => s.trim())
    const candidate = parts[Math.max(parts.length - hops, 0)]
    // An IP is at most 45 characters; anything longer is junk that must not
    // become an unbounded Redis key.
    if (candidate && candidate.length <= 45) return candidate
  }
  // No usable forwarded chain: the socket peer is the only address a client
  // cannot choose. (x-real-ip is not read: nothing guarantees the proxy sets it.)
  return socketIp ?? "unknown-ip"
}

/**
 * Extract the client IP from a Hono context.
 * Falls back to "unknown-ip" so all unknown-IP requests share one rate-limit bucket.
 */
export function getClientIp(c: Context, trustedHops?: number): string {
  // Behind an edge (LIAISON_EDGE_MODE), the edge says who the client is.
  if (env.LIAISON_EDGE_MODE && trustedHops === undefined) return effectiveRequest(c).clientIp
  const socketIp = c.req.header("x-bun-socket-ip")
  if (!socketIp && (trustedHops ?? env.TRUSTED_PROXY_HOPS) === 0) {
    rootLogger.warn("Missing client IP — rate limiting degraded")
  }
  return getClientIpFromHeaders(c.req.raw.headers, socketIp, trustedHops)
}

// ---------------------------------------------------------------------------
// The effective request: which host the client asked for and who the client is,
// as the edge in front of this server saw them. One seam, two edge modes
// (LIAISON_EDGE_MODE); unset keeps the plain Host header and getClientIp.
// ---------------------------------------------------------------------------

export interface EffectiveRequest {
  /** The host (with port, lowercase) the client asked for; null when none can be trusted. */
  host: string | null
  /** The client's address. */
  clientIp: string
}

/** Headers the signing edge sets (LIAISON_EDGE_MODE=signed). */
export const EDGE_HOST_HEADER = "x-liaison-host"
export const EDGE_CLIENT_IP_HEADER = "x-liaison-client-ip"
export const EDGE_TS_HEADER = "x-liaison-ts"
export const EDGE_SIGNATURE_HEADER = "x-liaison-host-sig"
/** How far an edge signature's timestamp may be from now, in seconds. */
export const EDGE_SIGNATURE_WINDOW_S = 60

/**
 * The signature the edge puts in `x-liaison-host-sig`: base64 HMAC-SHA256 with
 * the shared edge secret over `host.ts.METHOD.path.clientIp`, where `path` is the
 * URL path without its query and `ts` is in unix seconds.
 */
export function signEdgeHeaders(
  secret: string,
  parts: { host: string; ts: number | string; method: string; path: string; clientIp: string },
): string {
  return createHmac("sha256", secret)
    .update(
      `${parts.host}.${parts.ts}.${parts.method.toUpperCase()}.${parts.path}.${parts.clientIp}`,
    )
    .digest("base64")
}

function hostHeaderOf(req: Request): string | null {
  const raw = req.headers.get("host")
  if (raw) return raw.trim().toLowerCase()
  try {
    return new URL(req.url).host.toLowerCase() || null
  } catch {
    return null
  }
}

/** Whether `ip` is a loopback address (v4, v6 or v4-mapped). */
function isLoopback(ip: string | null | undefined): boolean {
  if (!ip) return false
  return ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.")
}

/** The signed headers, when present, fresh and correctly signed; null otherwise. */
function verifiedEdgeHeaders(req: Request): { host: string; clientIp: string } | null {
  const secret = env.LIAISON_EDGE_SECRET
  if (!secret) return null
  const host = req.headers.get(EDGE_HOST_HEADER)?.trim().toLowerCase()
  const clientIp = req.headers.get(EDGE_CLIENT_IP_HEADER)?.trim()
  const ts = req.headers.get(EDGE_TS_HEADER)?.trim()
  const sig = req.headers.get(EDGE_SIGNATURE_HEADER)?.trim()
  if (!host || !clientIp || !ts || !sig) return null
  if (!/^\d{1,12}$/.test(ts) || isIP(clientIp) === 0 || host.length > 253) return null
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > EDGE_SIGNATURE_WINDOW_S) return null
  let path: string
  try {
    path = new URL(req.url).pathname
  } catch {
    return null
  }
  const expected = Buffer.from(
    signEdgeHeaders(secret, { host, ts, method: req.method, path, clientIp }),
    "base64",
  )
  const presented = Buffer.from(sig, "base64")
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null
  return { host, clientIp }
}

const effectiveCache = new WeakMap<Request, EffectiveRequest>()

/**
 * The effective host and client address of a raw request (the WebSocket upgrade
 * path has no Hono context). `socketIp` is the TCP peer.
 *
 * - unset: the Host header; the client address per TRUSTED_PROXY_HOPS.
 * - `direct`: the Host header (the edge preserves it); CF-Connecting-IP is the
 *   client address only when the peer is on loopback (the local tunnel
 *   connector), and is ignored from anywhere else.
 * - `signed`: `x-liaison-host` and `x-liaison-client-ip` when their signature is
 *   valid and fresh; otherwise no host at all (the request reaches no org) and
 *   the peer's address.
 */
export function effectiveRequestFromRaw(
  req: Request,
  socketIp: string | null | undefined,
): EffectiveRequest {
  const cached = effectiveCache.get(req)
  if (cached) return cached
  let result: EffectiveRequest
  const mode = env.LIAISON_EDGE_MODE
  if (mode === "signed") {
    const signed = verifiedEdgeHeaders(req)
    result = signed ?? { host: null, clientIp: socketIp ?? "unknown-ip" }
  } else if (mode === "direct") {
    const cf = req.headers.get("cf-connecting-ip")?.trim()
    const clientIp =
      isLoopback(socketIp) && cf && isIP(cf) !== 0
        ? cf
        : getClientIpFromHeaders(req.headers, socketIp)
    result = { host: hostHeaderOf(req), clientIp }
  } else {
    result = { host: hostHeaderOf(req), clientIp: getClientIpFromHeaders(req.headers, socketIp) }
  }
  effectiveCache.set(req, result)
  return result
}

/** The effective host and client address of a request (see effectiveRequestFromRaw). */
export function effectiveRequest(c: Context): EffectiveRequest {
  return effectiveRequestFromRaw(c.req.raw, c.req.header("x-bun-socket-ip"))
}
