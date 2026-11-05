// SPDX-License-Identifier: FSL-1.1-ALv2
// clamd INSTREAM client against a fake clamd (a marker string stands in for a
// real signature, so no test-virus string lives in the repository) on a loopback port: the framing,
// the verdicts, and the outage behaviour (stored unscanned, never lost).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { createServer, type Server } from "node:net"
import { clamavTarget, parseClamdReply, scanBytes, scanInboundAttachment } from "~/lib/clamav"

const EICAR = "liaison-test-infected-marker"

let server: Server
let port = 0
let received: Buffer[] = []

/** A fake clamd: reads `zINSTREAM\0` then length-prefixed chunks to a zero chunk. */
function fakeClamd(): Server {
  return createServer((sock) => {
    let buf = Buffer.alloc(0)
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      const head = "zINSTREAM\0"
      if (buf.length < head.length) return
      let off = head.length
      const parts: Buffer[] = []
      while (off + 4 <= buf.length) {
        const len = buf.readUInt32BE(off)
        if (len === 0) {
          const body = Buffer.concat(parts)
          received.push(body)
          sock.end(
            body.includes(Buffer.from("infected-marker"))
              ? "stream: Eicar-Test-Signature FOUND\0"
              : "stream: OK\0",
          )
          return
        }
        if (off + 4 + len > buf.length) return
        parts.push(buf.subarray(off + 4, off + 4 + len))
        off += 4 + len
      }
    })
  })
}

const prior = process.env.CLAMAV_HOST

beforeAll(async () => {
  server = fakeClamd()
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  port = (server.address() as { port: number }).port
})
afterAll(() => {
  server.close()
  if (prior === undefined) delete process.env.CLAMAV_HOST
  else process.env.CLAMAV_HOST = prior
})
afterEach(() => {
  received = []
})

describe("clamav", () => {
  it("is off without CLAMAV_HOST, and the attachment passes unchanged", async () => {
    delete process.env.CLAMAV_HOST
    expect(clamavTarget()).toBeNull()
    const att = {
      filename: "a.exe",
      mimeType: "application/octet-stream",
      bytes: Buffer.from(EICAR),
    }
    const out = await scanInboundAttachment(att, { orgId: "o", where: "t" })
    expect(out.quarantined).toBe(false)
    expect(out.attachment).toBe(att)
  })

  it("parses host, host:port and [v6]:port", () => {
    process.env.CLAMAV_HOST = "clamd"
    expect(clamavTarget()).toEqual({ host: "clamd", port: 3310 })
    process.env.CLAMAV_HOST = "10.0.0.2:3311"
    expect(clamavTarget()).toEqual({ host: "10.0.0.2", port: 3311 })
    process.env.CLAMAV_HOST = "[::1]:3312"
    expect(clamavTarget()).toEqual({ host: "::1", port: 3312 })
  })

  it("parses clamd replies", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ status: "clean" })
    expect(parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({
      status: "infected",
      signature: "Win.Test.EICAR_HDB-1",
    })
    expect(parseClamdReply("INSTREAM size limit exceeded. ERROR\0").status).toBe("not_scanned")
  })

  it("streams the bytes in chunks and reports clean and infected", async () => {
    process.env.CLAMAV_HOST = `127.0.0.1:${port}`
    const big = Buffer.alloc(200 * 1024, 7)
    expect(await scanBytes(big)).toEqual({ status: "clean" })
    expect(received[0].equals(big)).toBe(true)
    expect(await scanBytes(Buffer.from(EICAR))).toEqual({
      status: "infected",
      signature: "Eicar-Test-Signature",
    })
  })

  it("replaces an infected attachment with a notice and hands back the original", async () => {
    process.env.CLAMAV_HOST = `127.0.0.1:${port}`
    const bytes = Buffer.from(EICAR)
    const out = await scanInboundAttachment(
      { filename: "invoice.exe", mimeType: "application/octet-stream", bytes },
      { orgId: "o", where: "tickets" },
    )
    expect(out.quarantined).toBe(true)
    if (!out.quarantined) return
    expect(out.signature).toBe("Eicar-Test-Signature")
    expect(out.original.bytes).toBe(bytes)
    expect(out.attachment.filename).toBe("invoice.exe.quarantined.txt")
    expect(out.attachment.mimeType).toBe("text/plain")
    expect(new TextDecoder().decode(out.attachment.bytes)).toContain("Eicar-Test-Signature")
  })

  it("stores unscanned (not lost) when clamd cannot be reached", async () => {
    const dead = createServer()
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()))
    const deadPort = (dead.address() as { port: number }).port
    await new Promise<void>((r) => dead.close(() => r()))
    process.env.CLAMAV_HOST = `127.0.0.1:${deadPort}`
    expect((await scanBytes(Buffer.from("x"))).status).toBe("not_scanned")
    const att = { filename: "a.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") }
    const out = await scanInboundAttachment(att, { orgId: "o", where: "t" })
    expect(out).toEqual({ quarantined: false, attachment: att })
  })
})
