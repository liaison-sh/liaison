// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import sharp from "sharp"
import { downloadVerifiedMedia, resolverRegistry } from "~/apps/tickets/link-ingest-download"
import { MEDIA_MAX_BYTES } from "~/modules/agent/media/media-analysis-constants"

const WHITELIST = ["wetransfer.com", "we.tl", "swisstransfer.com"]

async function jpegBytes(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 200, b: 10 } },
  })
    .jpeg()
    .toBuffer()
}

/** A streamed Response of exactly `size` bytes with the given content-type. */
function streamedResponse(size: number, contentType: string, prefix?: Buffer): Response {
  const head = prefix ?? Buffer.alloc(0)
  const padLen = Math.max(0, size - head.byteLength)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength) controller.enqueue(new Uint8Array(head))
      // chunk the padding
      let remaining = padLen
      const CHUNK = 64 * 1024
      while (remaining > 0) {
        const n = Math.min(CHUNK, remaining)
        controller.enqueue(new Uint8Array(n))
        remaining -= n
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": contentType } })
}

describe("downloadVerifiedMedia", () => {
  let lookupSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    lookupSpy = spyOn(dnsPromises, "lookup")
    // Default: resolve everything to a safe public IP.
    lookupSpy.mockImplementation((async () => [{ address: "93.184.216.34", family: 4 }]) as never)
  })
  afterEach(() => {
    lookupSpy.mockRestore()
  })

  it("rejects a non-whitelisted host via onHopValidate", async () => {
    const res = await downloadVerifiedMedia("https://evil.example/file.jpg", {
      whitelist: WHITELIST,
    })
    expect("error" in res).toBe(true)
  })

  it("rejects an off-whitelist redirect hop (target WOULD succeed → proves the whitelist gate fired)", async () => {
    const jpeg = await jpegBytes()
    // The off-whitelist redirect target returns a VALID 200 media response, so
    // FOLLOWING it would SUCCEED. The only thing that can make this fail is the
    // onHopValidate whitelist gate — deleting it flips this test red.
    const fakeFetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes("swisstransfer.com")) {
        return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } })
      }
      return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } })
    }) as unknown as typeof fetch
    const res = await downloadVerifiedMedia("https://swisstransfer.com/dl/abc", {
      whitelist: WHITELIST,
      fetchImpl: fakeFetch,
    })
    expect("error" in res).toBe(true)
    if ("error" in res) expect(res.error.toLowerCase()).toContain("whitelist")
  })

  it("rejects a host that resolves to a private IP (DNS rebind) — names the unsafe reason", async () => {
    lookupSpy.mockImplementation((async () => [{ address: "169.254.169.254", family: 4 }]) as never)
    const fakeFetch = mock(
      async () => new Response("x", { status: 200 }),
    ) as unknown as typeof fetch
    const res = await downloadVerifiedMedia("https://swisstransfer.com/dl/abc", {
      whitelist: WHITELIST,
      fetchImpl: fakeFetch,
    })
    expect("error" in res).toBe(true)
    // The downloader maps an UnsafeOutboundUrlError to "Refused unsafe download: …".
    if ("error" in res) expect(res.error.toLowerCase()).toContain("unsafe")
  })

  it("rejects a plain http target (requireHttps default) — names the unsafe/https reason", async () => {
    const res = await downloadVerifiedMedia("http://swisstransfer.com/dl/abc", {
      whitelist: WHITELIST,
    })
    expect("error" in res).toBe(true)
    if ("error" in res) {
      const reason = res.error.toLowerCase()
      expect(reason.includes("unsafe") || reason.includes("https") || reason.includes("http")).toBe(
        true,
      )
    }
  })

  it("rejects a magic-byte mismatch (header says image/png, bytes are a ZIP)", async () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00])
    const fakeFetch = mock(
      async () => new Response(zip, { status: 200, headers: { "content-type": "image/png" } }),
    ) as unknown as typeof fetch
    const res = await downloadVerifiedMedia("https://swisstransfer.com/dl/x", {
      whitelist: WHITELIST,
      fetchImpl: fakeFetch,
    })
    expect("error" in res).toBe(true)
  })

  it("byte-cap boundary: exactly MEDIA_MAX_BYTES succeeds, +1 rejects", async () => {
    const jpeg = await jpegBytes()
    // exactly the cap → success
    const okFetch = mock(async () =>
      streamedResponse(MEDIA_MAX_BYTES, "image/jpeg", jpeg),
    ) as unknown as typeof fetch
    const ok = await downloadVerifiedMedia("https://swisstransfer.com/dl/ok", {
      whitelist: WHITELIST,
      fetchImpl: okFetch,
    })
    expect("error" in ok).toBe(false)

    // cap + 1 → reject
    const badFetch = mock(async () =>
      streamedResponse(MEDIA_MAX_BYTES + 1, "image/jpeg", jpeg),
    ) as unknown as typeof fetch
    const bad = await downloadVerifiedMedia("https://swisstransfer.com/dl/bad", {
      whitelist: WHITELIST,
      fetchImpl: badFetch,
    })
    expect("error" in bad).toBe(true)
  })

  it("happy path: a whitelisted host serving a small JPEG", async () => {
    const jpeg = await jpegBytes()
    const fakeFetch = mock(
      async () => new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }),
    ) as unknown as typeof fetch
    const res = await downloadVerifiedMedia("https://swisstransfer.com/dl/x", {
      whitelist: WHITELIST,
      fetchImpl: fakeFetch,
    })
    expect("error" in res).toBe(false)
    if (!("error" in res)) {
      expect(res.mimeFromMagic).toBe("image/jpeg")
      expect(res.bytes.byteLength).toBe(jpeg.byteLength)
    }
  })

  it("rejects an early non-media content-type", async () => {
    const fakeFetch = mock(
      async () => new Response("hello", { status: 200, headers: { "content-type": "text/html" } }),
    ) as unknown as typeof fetch
    const res = await downloadVerifiedMedia("https://swisstransfer.com/dl/x", {
      whitelist: WHITELIST,
      fetchImpl: fakeFetch,
    })
    expect("error" in res).toBe(true)
  })
})

describe("resolverRegistry", () => {
  let lookupSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    lookupSpy = spyOn(dnsPromises, "lookup")
    lookupSpy.mockImplementation((async () => [{ address: "93.184.216.34", family: 4 }]) as never)
  })
  afterEach(() => lookupSpy.mockRestore())

  it("WeTransfer resolver returns [] on a non-JSON response", async () => {
    const fakeFetch = mock(
      async () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch
    const out = await resolverRegistry["wetransfer.com"]("https://wetransfer.com/downloads/abc", {
      whitelist: WHITELIST,
      fetchImpl: fakeFetch,
    })
    expect(out).toEqual([])
  })
})
