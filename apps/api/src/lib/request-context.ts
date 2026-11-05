// SPDX-License-Identifier: FSL-1.1-ALv2
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
  const socketIp = c.req.header("x-bun-socket-ip")
  if (!socketIp && (trustedHops ?? env.TRUSTED_PROXY_HOPS) === 0) {
    rootLogger.warn("Missing client IP — rate limiting degraded")
  }
  return getClientIpFromHeaders(c.req.raw.headers, socketIp, trustedHops)
}
