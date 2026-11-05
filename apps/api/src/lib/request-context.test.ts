// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { buildTrustedProxyList, getClientIp, isTrustedProxyAddress } from "~/lib/request-context"

// Minimal mock of Hono Context
function mockContext(headers: Record<string, string>) {
  return {
    req: {
      header(name: string) {
        return headers[name.toLowerCase()]
      },
      raw: { headers: new Headers(headers) },
    },
    env: { remoteAddr: headers.__remote_addr },
  } as any
}

describe("getClientIp — behind proxy (TRUSTED_PROXY_HOPS=1)", () => {
  const hops = 1

  it("takes the entry the trusted proxy appended (rightmost), never a client-supplied one", () => {
    // nginx $proxy_add_x_forwarded_for: "<client-sent>, <real peer>"
    const c = mockContext({ "x-forwarded-for": "1.2.3.4, 203.0.113.1" })
    expect(getClientIp(c, hops)).toBe("203.0.113.1")
  })

  it("is not moved by a spoofed leading chain", () => {
    const c = mockContext({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 7.7.7.7, 203.0.113.1" })
    expect(getClientIp(c, hops)).toBe("203.0.113.1")
  })

  it("returns the single entry of an overwriting proxy (Caddy default)", () => {
    const c = mockContext({ "x-forwarded-for": "203.0.113.1" })
    expect(getClientIp(c, hops)).toBe("203.0.113.1")
  })

  it("ignores x-real-ip and falls back to the socket peer without x-forwarded-for", () => {
    const c = mockContext({ "x-real-ip": "203.0.113.50", "x-bun-socket-ip": "10.0.0.9" })
    expect(getClientIp(c, hops)).toBe("10.0.0.9")
  })

  it("returns 'unknown-ip' fallback when no headers present", () => {
    const c = mockContext({})
    const ip = getClientIp(c, hops)
    expect(ip).toBe("unknown-ip")
  })

  it("trims whitespace from IP addresses", () => {
    const c = mockContext({ "x-forwarded-for": "  10.0.0.1 , 203.0.113.1  " })
    expect(getClientIp(c, hops)).toBe("203.0.113.1")
  })

  it("refuses an oversized junk entry rather than keying a limiter on it", () => {
    const c = mockContext({
      "x-forwarded-for": `1.1.1.1, ${"a".repeat(200)}`,
      "x-bun-socket-ip": "10.0.0.9",
    })
    expect(getClientIp(c, hops)).toBe("10.0.0.9")
  })
})

describe("getClientIp — two trusted proxies (TRUSTED_PROXY_HOPS=2)", () => {
  it("skips the inner proxy's entry and takes the client the outer one appended", () => {
    const c = mockContext({ "x-forwarded-for": "6.6.6.6, 203.0.113.1, 172.16.0.5" })
    expect(getClientIp(c, 2)).toBe("203.0.113.1")
  })

  it("uses the leftmost entry when the chain is shorter than configured", () => {
    const c = mockContext({ "x-forwarded-for": "203.0.113.1" })
    expect(getClientIp(c, 2)).toBe("203.0.113.1")
  })
})

describe("getClientIp — direct connection (TRUSTED_PROXY_HOPS=0)", () => {
  const hops = 0

  it("returns x-bun-socket-ip when available", () => {
    const c = mockContext({ "x-bun-socket-ip": "127.0.0.1" })
    expect(getClientIp(c, hops)).toBe("127.0.0.1")
  })

  it("ignores x-forwarded-for and uses socket IP", () => {
    const c = mockContext({
      "x-forwarded-for": "203.0.113.1",
      "x-bun-socket-ip": "10.0.0.5",
    })
    expect(getClientIp(c, hops)).toBe("10.0.0.5")
  })

  it("returns 'unknown-ip' fallback when no socket IP header", () => {
    const c = mockContext({})
    const ip = getClientIp(c, hops)
    expect(ip).toBe("unknown-ip")
  })
})

describe("getClientIp — only a trusted proxy peer may forward", () => {
  it("ignores X-Forwarded-For from a public socket peer (the app port reached directly)", () => {
    const c = mockContext({ "x-forwarded-for": "1.2.3.4", "x-bun-socket-ip": "198.51.100.7" })
    expect(getClientIp(c, 1)).toBe("198.51.100.7")
  })

  it("reads it from a private or loopback peer, including a v4-mapped v6 address", () => {
    for (const peer of ["172.18.0.3", "127.0.0.1", "::ffff:10.1.2.3", "::1"]) {
      const c = mockContext({ "x-forwarded-for": "203.0.113.1", "x-bun-socket-ip": peer })
      expect(getClientIp(c, 1)).toBe("203.0.113.1")
    }
  })

  it("trusts operator-listed CIDRs on top of the private ranges", () => {
    const list = buildTrustedProxyList("198.51.100.0/24, not-a-cidr")
    expect(isTrustedProxyAddress(list, "198.51.100.7")).toBe(true)
    expect(isTrustedProxyAddress(list, "198.51.101.7")).toBe(false)
    expect(isTrustedProxyAddress(list, "10.0.0.1")).toBe(true)
    expect(isTrustedProxyAddress(list, "garbage")).toBe(false)
  })
})
