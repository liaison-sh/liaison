// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { isPrivateIp } from "~/lib/ip-classify"
import {
  fetchWithPinnedHost,
  fetchWithRedirectValidation,
  UnsafeOutboundUrlError,
  validateOutboundUrl,
} from "~/lib/outbound-fetch"

describe("outbound-fetch", () => {
  it("rejects private IPs when validating outbound URLs", async () => {
    await expect(validateOutboundUrl("https://127.0.0.1/private")).rejects.toThrow(
      UnsafeOutboundUrlError,
    )
  })

  it("rejects non-HTTPS outbound URLs by default", async () => {
    await expect(validateOutboundUrl("http://93.184.216.34/plain")).rejects.toThrow("HTTPS")
  })

  it("follows safe redirects after re-validating each hop", async () => {
    const seen: string[] = []
    const fakeFetch = (async (input: any) => {
      const url = String(typeof input === "string" ? input : (input.url ?? input))
      seen.push(url)

      if (url === "https://93.184.216.34/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "/next" },
        })
      }
      if (url === "https://93.184.216.34/next") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    }) as unknown as typeof fetch

    const response = await fetchWithRedirectValidation(
      "https://93.184.216.34/start",
      {},
      { fetchImpl: fakeFetch },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(seen).toEqual(["https://93.184.216.34/start", "https://93.184.216.34/next"])
  })

  it("blocks redirects to private-network targets", async () => {
    const fakeFetch = (async (input: any) => {
      const url = String(typeof input === "string" ? input : (input.url ?? input))
      if (url === "https://93.184.216.34/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/private" },
        })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    }) as unknown as typeof fetch

    await expect(
      fetchWithRedirectValidation("https://93.184.216.34/start", {}, { fetchImpl: fakeFetch }),
    ).rejects.toThrow("private network")
  })
})

describe("fetchWithPinnedHost", () => {
  let lookupSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    lookupSpy = spyOn(dnsPromises, "lookup")
  })
  afterEach(() => {
    lookupSpy.mockRestore()
  })

  it("resolves DNS once and does not re-resolve at connect time", async () => {
    let calls = 0
    lookupSpy.mockImplementation((async () => {
      calls++
      return calls === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }]
    }) as never)

    const fakeFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

    const resp = await fetchWithPinnedHost(
      "https://attacker.example/path",
      {},
      { fetchImpl: fakeFetch },
    )

    expect(resp.status).toBe(200)
    expect(calls).toBe(1)
  })

  it("rejects when the validation lookup returns a private IP", async () => {
    lookupSpy.mockImplementation((async () => [{ address: "10.0.0.5", family: 4 }]) as never)
    await expect(fetchWithPinnedHost("https://internal.example/", {}, {})).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError,
    )
  })

  it("re-validates each redirect hop with its own pinned DNS lookup", async () => {
    let calls = 0
    lookupSpy.mockImplementation((async () => {
      calls++
      return [{ address: calls === 1 ? "93.184.216.34" : "93.184.216.35", family: 4 }]
    }) as never)

    let hop = 0
    const fakeFetch = (async () => {
      hop++
      if (hop === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.example/" },
        })
      }
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch

    const resp = await fetchWithPinnedHost("https://a.example/", {}, { fetchImpl: fakeFetch })
    expect(resp.status).toBe(200)
    expect(calls).toBe(2)
  })

  it("invokes onHopValidate for the initial URL and every redirect, aborting on throw", async () => {
    lookupSpy.mockImplementation((async () => [{ address: "93.184.216.34", family: 4 }]) as never)

    const seen: string[] = []
    let hop = 0
    const fakeFetch = (async () => {
      hop++
      if (hop === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://forbidden.example/" },
        })
      }
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch

    await expect(
      fetchWithPinnedHost(
        "https://a.example/",
        {},
        {
          fetchImpl: fakeFetch,
          onHopValidate: async (next) => {
            seen.push(next.hostname)
            if (next.hostname === "forbidden.example") {
              throw new UnsafeOutboundUrlError("not allowed by policy")
            }
          },
        },
      ),
    ).rejects.toThrow(/not allowed by policy/)

    expect(seen).toEqual(["a.example", "forbidden.example"])
  })
})

describe("isPrivateIp", () => {
  it("blocks the Azure wire server address that sits outside every private range", () => {
    expect(isPrivateIp("168.63.129.16")).toBe(true)
    expect(isPrivateIp("168.63.129.17")).toBe(false)
  })

  it("marks private and loopback hosts as blocked", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true)
    expect(isPrivateIp("10.0.0.1")).toBe(true)
    expect(isPrivateIp("192.168.1.1")).toBe(true)
    expect(isPrivateIp("172.16.0.1")).toBe(true)
    expect(isPrivateIp("169.254.169.254")).toBe(true)
    expect(isPrivateIp("::1")).toBe(true)
    expect(isPrivateIp("::")).toBe(true)
    expect(isPrivateIp("localhost")).toBe(true)
  })

  it("normalizes IPv4-mapped IPv6 and re-classifies the embedded IPv4", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true)
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true)
    expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true)
    // hex-word form of the IPv4-mapped address (::ffff:7f00:1 == 127.0.0.1)
    expect(isPrivateIp("::ffff:7f00:1")).toBe(true)
    // a public IPv4 mapped into IPv6 stays public
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false)
  })

  it("classifies uppercase ULA / link-local IPv6 literals", () => {
    expect(isPrivateIp("FD00::1")).toBe(true)
    expect(isPrivateIp("fc00::1")).toBe(true)
    expect(isPrivateIp("FE80::1")).toBe(true)
    expect(isPrivateIp("[::1]")).toBe(true)
    expect(isPrivateIp("fe80::1%eth0")).toBe(true)
  })

  it("rejects obscure IPv4 encodings (octal / decimal / hex)", () => {
    expect(isPrivateIp("0177.0.0.1")).toBe(true) // octal 0177 == 127
    expect(isPrivateIp("2130706433")).toBe(true) // decimal 127.0.0.1
    expect(isPrivateIp("0x7f.0.0.1")).toBe(true) // hex 0x7f == 127
    expect(isPrivateIp("127.1")).toBe(true) // short form == 127.0.0.1
    expect(isPrivateIp("0.0.0.0")).toBe(true) // unspecified
  })

  it("allows public IPs", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false)
    expect(isPrivateIp("9.9.9.9")).toBe(false)
    expect(isPrivateIp("1.1.1.1")).toBe(false)
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false)
    expect(isPrivateIp("2a00:1450:4007:80f::200e")).toBe(false)
    // NAT64 / 6to4 / compat forms of a PUBLIC IPv4 stay public
    expect(isPrivateIp("64:ff9b::808:808")).toBe(false)
    expect(isPrivateIp("2002:808:808::1")).toBe(false)
  })

  it("classifies IPv6 forms that embed a private IPv4 (NAT64, 6to4, compat hex)", () => {
    expect(isPrivateIp("::7f00:1")).toBe(true) // IPv4-compatible hex form of 127.0.0.1
    expect(isPrivateIp("0:0:0:0:0:0:7f00:1")).toBe(true)
    expect(isPrivateIp("64:ff9b::a00:1")).toBe(true) // NAT64 of 10.0.0.1
    expect(isPrivateIp("64:ff9b::169.254.169.254")).toBe(true) // NAT64, dotted tail
    expect(isPrivateIp("64:ff9b:1::1")).toBe(true) // local-use NAT64
    expect(isPrivateIp("2002:7f00:1::1")).toBe(true) // 6to4 of 127.0.0.1
    expect(isPrivateIp("2002:a9fe:a9fe::1")).toBe(true) // 6to4 of 169.254.169.254
    expect(isPrivateIp("0:0:0:0:0:ffff:a00:1")).toBe(true) // expanded IPv4-mapped
  })

  it("blocks documentation, multicast, site-local and Teredo ranges", () => {
    expect(isPrivateIp("192.0.2.1")).toBe(true)
    expect(isPrivateIp("198.51.100.7")).toBe(true)
    expect(isPrivateIp("203.0.113.1")).toBe(true)
    expect(isPrivateIp("2001:db8::1")).toBe(true)
    expect(isPrivateIp("ff02::1")).toBe(true)
    expect(isPrivateIp("fec0::1")).toBe(true)
    expect(isPrivateIp("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe(true)
  })
})

describe("outbound-fetch allowPrivate (operator-allowed private servers)", () => {
  it("allows a private or loopback address only when allowPrivate is set", async () => {
    await expect(
      validateOutboundUrl("http://192.168.1.20:11434/v1", { requireHttps: false }),
    ).rejects.toThrow("private network")
    await expect(
      validateOutboundUrl("http://192.168.1.20:11434/v1", {
        requireHttps: false,
        allowPrivate: true,
      }),
    ).resolves.toBeInstanceOf(URL)
    await expect(
      validateOutboundUrl("http://127.0.0.1:8080/v1", { requireHttps: false, allowPrivate: true }),
    ).resolves.toBeInstanceOf(URL)
  })

  it("still refuses link-local and metadata addresses with allowPrivate", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "http://[fe80::1]/v1",
      "http://168.63.129.16/machine",
      "http://[::ffff:169.254.169.254]/x",
      "http://[fd00:ec2::254]/latest",
      "http://0.0.0.0:8080/v1",
    ]) {
      await expect(
        validateOutboundUrl(url, { requireHttps: false, allowPrivate: true }),
      ).rejects.toThrow("link-local or metadata")
    }
  })

  it("refuses a hostname resolving to a metadata address with allowPrivate", async () => {
    const spy = spyOn(dnsPromises, "lookup").mockResolvedValue([
      { address: "169.254.169.254", family: 4 },
    ] as never)
    try {
      await expect(
        validateOutboundUrl("http://models.lan/v1", { requireHttps: false, allowPrivate: true }),
      ).rejects.toThrow("link-local or metadata")
    } finally {
      spy.mockRestore()
    }
  })

  it("pins a private address with allowPrivate and refuses redirects when maxRedirects is 0", async () => {
    const seen: string[] = []
    const fakeFetch = (async (input: unknown) => {
      seen.push(String(input))
      return new Response(null, { status: 302, headers: { location: "http://10.0.0.9/x" } })
    }) as unknown as typeof fetch
    await expect(
      fetchWithPinnedHost(
        "http://10.0.0.5:8000/v1/chat/completions",
        { method: "POST", body: "{}" },
        { requireHttps: false, allowPrivate: true, maxRedirects: 0, fetchImpl: fakeFetch },
      ),
    ).rejects.toThrow("Too many redirects")
    expect(seen).toEqual(["http://10.0.0.5:8000/v1/chat/completions"])
  })
})

describe("fetchWithPinnedHost redirect credentials (tokens go only to their issuing origin)", () => {
  type Seen = { url: string; headers: Headers; body: unknown; method: string }
  function recordingFetch(answer: (url: string, n: number) => Response) {
    const seen: Seen[] = []
    const fn = (async (input: unknown, init: RequestInit = {}) => {
      const url = String(input)
      seen.push({
        url,
        headers: new Headers(init.headers),
        body: init.body,
        method: init.method ?? "GET",
      })
      return answer(url, seen.length)
    }) as unknown as typeof fetch
    return { fn, seen }
  }
  const creds = {
    Authorization: "Bearer SECRET-TOKEN",
    Cookie: "sid=1",
    "Proxy-Authorization": "Basic eA==",
    Accept: "application/json",
  }

  it("refuses a cross-origin 307 for a request with a body; the other origin receives nothing", async () => {
    const { fn, seen } = recordingFetch((url) =>
      url.startsWith("https://93.184.216.34/")
        ? new Response(null, { status: 307, headers: { location: "https://93.184.216.35/steal" } })
        : new Response("stolen", { status: 200 }),
    )
    await expect(
      fetchWithPinnedHost(
        "https://93.184.216.34/token",
        { method: "POST", headers: creds, body: "refresh_token=R" },
        { fetchImpl: fn },
      ),
    ).rejects.toThrow(/cross-origin redirect/i)
    expect(seen.map((s) => s.url)).toEqual(["https://93.184.216.34/token"])
  })

  it("refuses a cross-origin 308 for a request with a body", async () => {
    const { fn, seen } = recordingFetch(() =>
      seen.length === 1
        ? new Response(null, { status: 308, headers: { location: "https://93.184.216.35/x" } })
        : new Response("ok"),
    )
    await expect(
      fetchWithPinnedHost(
        "https://93.184.216.34/mcp",
        { method: "POST", body: "{}" },
        { fetchImpl: fn },
      ),
    ).rejects.toThrow(/cross-origin redirect/i)
    expect(seen).toHaveLength(1)
  })

  it("drops Authorization, Cookie and Proxy-Authorization on a cross-origin GET redirect", async () => {
    const { fn, seen } = recordingFetch((_url, n) =>
      n === 1
        ? new Response(null, { status: 302, headers: { location: "https://93.184.216.35/next" } })
        : new Response("ok"),
    )
    const res = await fetchWithPinnedHost(
      "https://93.184.216.34/a",
      { headers: creds },
      { fetchImpl: fn },
    )
    expect(res.status).toBe(200)
    expect(seen[0].headers.get("authorization")).toBe("Bearer SECRET-TOKEN")
    expect(seen[1].url).toBe("https://93.184.216.35/next")
    expect(seen[1].headers.get("authorization")).toBeNull()
    expect(seen[1].headers.get("cookie")).toBeNull()
    expect(seen[1].headers.get("proxy-authorization")).toBeNull()
    expect(seen[1].headers.get("accept")).toBe("application/json")
  })

  it("keeps credentials stripped after leaving the origin, even if a later hop comes back", async () => {
    const { fn, seen } = recordingFetch((_url, n) =>
      n === 1
        ? new Response(null, { status: 302, headers: { location: "https://93.184.216.35/b" } })
        : n === 2
          ? new Response(null, { status: 302, headers: { location: "https://93.184.216.34/c" } })
          : new Response("ok"),
    )
    await fetchWithPinnedHost("https://93.184.216.34/a", { headers: creds }, { fetchImpl: fn })
    expect(seen).toHaveLength(3)
    expect(seen[2].headers.get("authorization")).toBeNull()
  })

  it("follows a same-origin 307 with its method, body and credentials", async () => {
    const { fn, seen } = recordingFetch((_url, n) =>
      n === 1
        ? new Response(null, { status: 307, headers: { location: "/token2" } })
        : new Response("ok"),
    )
    const res = await fetchWithPinnedHost(
      "https://93.184.216.34/token",
      { method: "POST", headers: creds, body: "a=1" },
      { fetchImpl: fn },
    )
    expect(res.status).toBe(200)
    expect(seen[1].url).toBe("https://93.184.216.34/token2")
    expect(seen[1].method).toBe("POST")
    expect(seen[1].body).toBe("a=1")
    expect(seen[1].headers.get("authorization")).toBe("Bearer SECRET-TOKEN")
  })

  it('returns the 3xx unfollowed when the caller asks for redirect: "manual"', async () => {
    const { fn, seen } = recordingFetch(
      () => new Response(null, { status: 307, headers: { location: "https://93.184.216.35/x" } }),
    )
    const res = await fetchWithPinnedHost(
      "https://93.184.216.34/token",
      { method: "POST", body: "a=1", redirect: "manual" },
      { fetchImpl: fn },
    )
    expect(res.status).toBe(307)
    expect(seen).toHaveLength(1)
  })

  it('throws on a 3xx when the caller asks for redirect: "error"', async () => {
    const { fn, seen } = recordingFetch(
      () => new Response(null, { status: 302, headers: { location: "/x" } }),
    )
    await expect(
      fetchWithPinnedHost("https://93.184.216.34/a", { redirect: "error" }, { fetchImpl: fn }),
    ).rejects.toThrow(/redirect/i)
    expect(seen).toHaveLength(1)
  })
})
