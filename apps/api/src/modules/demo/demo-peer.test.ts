// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bucket the demo limiter counts against, on its own.
//
// Two properties, both of which the old `getClientIp` keying failed: the value
// cannot be chosen by the caller, and one client cannot hold more than one
// bucket. The second is what the IPv6 /64 is for -- an address-keyed budget
// hands a residential client 2^64 buckets, which is the same as no budget.
import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { env } from "~/lib/env"
import { attachSocketPeer } from "~/lib/server"
import {
  demoClientIp,
  demoIpBucket,
  demoNetworkKey,
  demoPeerBucket,
  peerBucket,
  UNKNOWN_PEER,
} from "~/modules/demo/demo-peer"

describe("peerBucket", () => {
  it("keys IPv4 by the address", () => {
    expect(peerBucket("203.0.113.7")).toBe("203.0.113.7")
    expect(peerBucket(" 203.0.113.7 ")).toBe("203.0.113.7")
    expect(peerBucket("203.0.113.7:51234")).toBe("203.0.113.7")
    expect(peerBucket("::ffff:203.0.113.7")).toBe("203.0.113.7")
  })

  it("keys IPv6 by the /56, not by the address", () => {
    const first = peerBucket("2001:db8:abcd:1234::1")
    const last = peerBucket("2001:db8:abcd:12ff:ffff:ffff:ffff:ffff")
    const bracketed = peerBucket("[2001:0db8:abcd:1234::beef]:51234")
    expect(first).toBe("2001:db8:abcd:1200::/56")
    expect(last).toBe(first)
    expect(bracketed).toBe(first)
  })

  it("keeps a DIFFERENT /56 in a different bucket", () => {
    expect(peerBucket("2001:db8:abcd:1234::1")).not.toBe(peerBucket("2001:db8:abcd:1334::1"))
  })

  it("expands :: correctly rather than truncating the wrong groups", () => {
    expect(peerBucket("::1")).toBe("0:0:0:0::/56")
    expect(peerBucket("2001:db8::")).toBe("2001:db8:0:0::/56")
    expect(peerBucket("fe80::1234:5678:9abc:def0")).toBe("fe80:0:0:0::/56")
  })

  it("shares one bucket when there is no usable address", () => {
    expect(peerBucket(undefined)).toBe(UNKNOWN_PEER)
    expect(peerBucket("")).toBe(UNKNOWN_PEER)
    expect(peerBucket("1:2:3")).toBe(UNKNOWN_PEER)
    expect(peerBucket("1:2:3::4:5:6:7:8:9")).toBe(UNKNOWN_PEER)
  })
})

describe("demoNetworkKey and demoIpBucket", () => {
  it("groups IPv4 by /24 for spend and by address for per-IP limits", () => {
    expect(demoNetworkKey("203.0.113.7")).toBe("203.0.113.0/24")
    expect(demoNetworkKey("203.0.113.250")).toBe("203.0.113.0/24")
    expect(demoNetworkKey("203.0.114.7")).not.toBe(demoNetworkKey("203.0.113.7"))
    expect(demoIpBucket("203.0.113.7")).not.toBe(demoIpBucket("203.0.113.8"))
  })

  it("groups IPv6 by /48 for spend and by /56 per IP", () => {
    // Two addresses in one /56 share a per-IP bucket.
    expect(demoIpBucket("2001:db8:abcd:1201::1")).toBe(demoIpBucket("2001:db8:abcd:12ff::9"))
    // Two /56s inside one /48 do not share a per-IP bucket...
    expect(demoIpBucket("2001:db8:abcd:1200::1")).not.toBe(demoIpBucket("2001:db8:abcd:1300::1"))
    // ...but they are one network.
    expect(demoNetworkKey("2001:db8:abcd:1200::1")).toBe("2001:db8:abcd::/48")
    expect(demoNetworkKey("2001:db8:abcd:1300::1")).toBe(demoNetworkKey("2001:db8:abcd:1200::1"))
    expect(demoNetworkKey("2001:db8:abce::1")).not.toBe(demoNetworkKey("2001:db8:abcd::1"))
  })
})

describe("demoClientIp behind an edge that overwrites X-Forwarded-For", () => {
  async function clientFor(headers: Record<string, string>): Promise<string | number> {
    const app = new Hono()
    let seen: string | number = ""
    app.get("/x", (c) => {
      try {
        seen = demoPeerBucket(c)
      } catch (err) {
        seen = err instanceof HTTPException ? err.status : -1
      }
      return c.text("ok")
    })
    await app.request("/x", { headers })
    return seen
  }

  function withFlag<T>(value: boolean, run: () => Promise<T>): Promise<T> {
    const before = env.LIAISON_DEMO_EDGE_OVERWRITES_XFF
    env.LIAISON_DEMO_EDGE_OVERWRITES_XFF = value
    return run().finally(() => {
      env.LIAISON_DEMO_EDGE_OVERWRITES_XFF = before
    })
  }

  // Red before the fix: the socket peer is the proxy's loopback address for
  // every visitor, so two different clients landed in one bucket.
  it("puts two clients behind a loopback proxy in two buckets", async () => {
    await withFlag(true, async () => {
      const a = await clientFor({
        "x-bun-socket-ip": "127.0.0.1",
        "x-forwarded-for": "198.51.100.1",
      })
      const b = await clientFor({
        "x-bun-socket-ip": "127.0.0.1",
        "x-forwarded-for": "198.51.100.2",
      })
      expect(a).toBe("198.51.100.1")
      expect(b).toBe("198.51.100.2")
    })
  })

  it("refuses a comma list with 400", async () => {
    await withFlag(true, async () => {
      expect(
        await clientFor({
          "x-bun-socket-ip": "127.0.0.1",
          "x-forwarded-for": "198.51.100.1, 198.51.100.2",
        }),
      ).toBe(400)
    })
  })

  it("reads the socket peer when the flag is off", async () => {
    await withFlag(false, async () => {
      expect(
        await clientFor({ "x-bun-socket-ip": "127.0.0.1", "x-forwarded-for": "198.51.100.1" }),
      ).toBe("127.0.0.1")
    })
  })

  it("reads the socket peer when the peer is public, whatever the flag", async () => {
    await withFlag(true, async () => {
      expect(
        await clientFor({ "x-bun-socket-ip": "93.184.216.34", "x-forwarded-for": "198.51.100.1" }),
      ).toBe("93.184.216.34")
    })
  })

  it("exposes the client address itself", async () => {
    await withFlag(true, async () => {
      const app = new Hono()
      const seen: { ip: string | null } = { ip: null }
      app.get("/x", (c) => {
        seen.ip = demoClientIp(c)
        return c.text("ok")
      })
      await app.request("/x", {
        headers: { "x-bun-socket-ip": "10.0.0.2", "x-forwarded-for": "2001:db8::5" },
      })
      expect(seen.ip).toBe("2001:db8::5")
    })
  })
})

describe("demoPeerBucket", () => {
  /** Run one request through a Hono app and capture what the bucket resolved to. */
  async function bucketFor(headers: Record<string, string>): Promise<string> {
    const app = new Hono()
    let seen = ""
    app.get("/x", (c) => {
      seen = demoPeerBucket(c)
      return c.text("ok")
    })
    await app.request("/x", { headers })
    return seen
  }

  // BLOCKER 2. `getClientIp` computes `parts.length - hops - 1` over
  // X-Forwarded-For, so with the shipped TRUSTED_PROXY_HOPS=1 and a proxy that
  // APPENDS, index 0 is the attacker's own string. This must read none of it.
  it("ignores X-Forwarded-For entirely, however many hops it claims", async () => {
    const peer = "203.0.113.9"
    const plain = await bucketFor({ "x-bun-socket-ip": peer })
    for (const forwarded of [
      "198.51.100.1",
      "198.51.100.1, 198.51.100.2",
      "198.51.100.1, 198.51.100.2, 198.51.100.3",
    ]) {
      expect(await bucketFor({ "x-bun-socket-ip": peer, "x-forwarded-for": forwarded })).toBe(plain)
    }
  })

  it("ignores X-Real-IP too", async () => {
    expect(await bucketFor({ "x-bun-socket-ip": "203.0.113.9", "x-real-ip": "198.51.100.1" })).toBe(
      "203.0.113.9",
    )
  })

  it("falls back to one shared bucket rather than to a header", async () => {
    expect(await bucketFor({ "x-forwarded-for": "198.51.100.1" })).toBe(UNKNOWN_PEER)
  })
})

// The half of the peer fix that lives in lib/server.ts: the header the bucket
// trusts is written by the transport and an inbound copy is removed first.
// Without the delete, `x-bun-socket-ip` is a client-supplied string and BLOCKER
// 2 is open again through a different header.
describe("attachSocketPeer", () => {
  it("removes a client-supplied x-bun-socket-ip and writes the real peer", () => {
    const req = new Request("http://localhost/x", {
      headers: { "x-bun-socket-ip": "203.0.113.200" },
    })
    attachSocketPeer(req, "198.51.100.4")
    expect(req.headers.get("x-bun-socket-ip")).toBe("198.51.100.4")
    expect(peerBucket(req.headers.get("x-bun-socket-ip"))).toBe("198.51.100.4")
  })

  it("removes it even when there is no peer to put back", () => {
    const req = new Request("http://localhost/x", {
      headers: { "x-bun-socket-ip": "203.0.113.200" },
    })
    attachSocketPeer(req, undefined)
    expect(req.headers.get("x-bun-socket-ip")).toBeNull()
  })
})
