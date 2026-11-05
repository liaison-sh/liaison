// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one address a demo visitor cannot choose.
//
// The demo signup limiter used to key on `getClientIp`, which is
// X-Forwarded-For with a TRUSTED_PROXY_HOPS offset. That offset is a statement
// about the deployment's proxy chain, and it is wrong the moment the proxy
// APPENDS rather than overwrites: a client-supplied `X-Forwarded-For: <random>`
// becomes `[random, realIP]`, and with one trusted hop the index lands on the
// attacker's own value. One header, unlimited buckets, unlimited org creation,
// each one a full seed.
//
// So this route keys on the SOCKET PEER instead. `lib/server.ts` deletes any
// inbound `x-bun-socket-ip` and writes the real peer address on every request,
// so the value here is the transport's, not the caller's, and it is the same
// value whatever TRUSTED_PROXY_HOPS says. That does mean everyone behind one
// CDN edge shares a bucket; for a budget of three workspaces an hour on a
// public demo box that is the correct trade, and it is the direction that fails
// safe.
//
// BEHIND AN EDGE THAT OVERWRITES. On a box whose reverse proxy runs on the
// host and proxies to loopback, the socket peer is that proxy for EVERY
// visitor, so a per-peer budget is one box-wide budget. When the operator
// states that the edge OVERWRITES X-Forwarded-For with the address it saw
// (`LIAISON_DEMO_EDGE_OVERWRITES_XFF`), and only when the socket peer is
// loopback or private (the request really came through that edge), the
// single-valued header is the client. A comma list means something appended
// to it, which the statement says cannot happen: refused with 400 rather than
// guessed at.
//
// Two groupings of a client address. Per-IP limits (signups, code sends) key
// on the IPv4 address or the IPv6 /56: a residential IPv6 client sources from
// any address of its /64 and usually holds a /56. Spend and verification caps
// key on the NETWORK: IPv4 /24, IPv6 /48 (`demoNetworkKey`).
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { env } from "~/lib/env"
import { isPrivateIp } from "~/lib/ip-classify"

/** Shared bucket for a request whose peer address could not be determined. */
export const UNKNOWN_PEER = "unknown-peer"

/**
 * Expand an IPv6 address to its eight groups, honouring `::` compression.
 * Returns null when the input is not parseable as IPv6.
 */
function ipv6Groups(ip: string): string[] | null {
  if (!ip.includes(":")) return null
  const halves = ip.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":").filter((g) => g !== "") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":").filter((g) => g !== "") : []
  if (halves.length === 1) {
    const groups = ip.split(":")
    return groups.length === 8 ? groups : null
  }
  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  return [...head, ...Array.from({ length: fill }, () => "0"), ...tail]
}

/** Strip leading zeroes from one IPv6 group, keeping a lone "0". */
function trimGroup(group: string): string {
  const trimmed = group.toLowerCase().replace(/^0+(?=.)/, "")
  return trimmed === "" ? "0" : trimmed
}

/** A raw address with its port, brackets and IPv4 mapping removed, or null. */
export function cleanIp(raw: string | null | undefined): string | null {
  if (!raw) return null
  let ip = raw.trim()
  if (ip === "") return null
  // `[2001:db8::1]:443` and `[2001:db8::1]`
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketed) ip = bracketed[1]
  // An IPv4-mapped IPv6 address is an IPv4 client.
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (mapped) return mapped[1]
  // `1.2.3.4:5678`: the one-colon IPv4:port form.
  const v4WithPort = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)
  if (v4WithPort) return v4WithPort[1]
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return ip
  return ipv6Groups(ip) ? ip : null
}

/** An IPv6 prefix of `bits` (a multiple of 8), written `a:b:c:d::/bits`. */
function ipv6Prefix(ip: string, bits: 48 | 56): string | null {
  const groups = ipv6Groups(ip)
  if (!groups) return null
  const fullGroups = Math.floor(bits / 16)
  const out = groups.slice(0, fullGroups).map(trimGroup)
  if (bits % 16 !== 0) {
    const g = Number.parseInt(groups[fullGroups] || "0", 16) & 0xff00
    out.push(g.toString(16))
  }
  while (out.length < 4) out.push("0")
  // `2001:db8:abcd:0` reads as `2001:db8:abcd::` for a /48.
  if (bits === 48) return `${out.slice(0, 3).join(":")}::/48`
  return `${out.join(":")}::/56`
}

/**
 * The per-IP rate-limit bucket for a raw address: the address itself for IPv4,
 * the /56 prefix for IPv6, and `UNKNOWN_PEER` when there is nothing usable.
 */
export function peerBucket(raw: string | null | undefined): string {
  const ip = cleanIp(raw)
  if (!ip) return UNKNOWN_PEER
  if (!ip.includes(":")) return ip
  return ipv6Prefix(ip, 56) ?? UNKNOWN_PEER
}

/** Same as {@link peerBucket}, for an address already resolved by `demoClientIp`. */
export function demoIpBucket(ip: string | null): string {
  return peerBucket(ip)
}

/** The client NETWORK spend and verification caps key on: IPv4 /24, IPv6 /48. */
export function demoNetworkKey(raw: string | null): string {
  const ip = cleanIp(raw)
  if (!ip) return UNKNOWN_PEER
  if (!ip.includes(":")) return `${ip.split(".").slice(0, 3).join(".")}.0/24`
  return ipv6Prefix(ip, 48) ?? UNKNOWN_PEER
}

/**
 * The client address of this request, or null when there is none.
 *
 * The socket peer, unless the operator declared an edge that overwrites
 * X-Forwarded-For AND the peer is loopback or private (see the header note);
 * then the single value of that header. A comma list there is refused (400).
 */
export function demoClientIp(c: Context): string | null {
  const peer = cleanIp(c.req.header("x-bun-socket-ip"))
  if (!env.LIAISON_DEMO_EDGE_OVERWRITES_XFF || !peer || !isPrivateIp(peer)) return peer
  const forwarded = c.req.header("x-forwarded-for")
  if (forwarded === undefined || forwarded.trim() === "") return peer
  if (forwarded.includes(",")) {
    throw new HTTPException(400, { message: "Malformed X-Forwarded-For" })
  }
  return cleanIp(forwarded) ?? peer
}

/** The per-IP bucket for this request (see {@link demoClientIp}). */
export function demoPeerBucket(c: Context): string {
  return peerBucket(demoClientIp(c))
}
