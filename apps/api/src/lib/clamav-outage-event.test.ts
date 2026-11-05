// SPDX-License-Identifier: FSL-1.1-ALv2
// A configured virus scanner that cannot be reached raises `clamav_unavailable`
// (counted on /diag, an org alert at most once an hour), and the attachment is
// still stored unscanned. A clamd that answers with an error is no outage.
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test"
import { createServer } from "node:net"
// HERMETICITY: complete-stub-and-restore (mock.module is process-global).
import * as realSecurityEvents from "~/modules/security/security-events"

const realSecurityEventsModule = { ...realSecurityEvents }
const signals: Array<Record<string, unknown>> = []
mock.module("~/modules/security/security-events", () => ({
  ...realSecurityEventsModule,
  emitSecurityEvent: async (s: Record<string, unknown>) => {
    signals.push(s)
  },
}))

const prior = process.env.CLAMAV_HOST
afterAll(() => {
  mock.module("~/modules/security/security-events", () => realSecurityEventsModule)
  if (prior === undefined) delete process.env.CLAMAV_HOST
  else process.env.CLAMAV_HOST = prior
})
afterEach(() => {
  signals.length = 0
})

const { scanInboundAttachment } = await import("~/lib/clamav")

const ORG = "00000000-0000-0000-0000-0000000000c1"
const att = { filename: "a.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") }

async function deadPort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()))
  const port = (s.address() as { port: number }).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

describe("clamav outage signal", () => {
  it("raises clamav_unavailable for the org, throttled to one alert an hour, and stores unscanned", async () => {
    process.env.CLAMAV_HOST = `127.0.0.1:${await deadPort()}`
    const out = await scanInboundAttachment(att, { orgId: ORG, where: "tickets" })
    expect(out).toEqual({ quarantined: false, attachment: att })
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      kind: "clamav_unavailable",
      orgId: ORG,
      orgAlertEveryMs: 60 * 60 * 1000,
      detail: { where: "tickets" },
    })
  })

  it("raises nothing when clamd answers with an error (reachable, not an outage)", async () => {
    const clamd = createServer((sock) => {
      sock.on("data", (d: Buffer) => {
        if (d.subarray(d.length - 4).equals(Buffer.alloc(4))) {
          sock.end("INSTREAM size limit exceeded. ERROR\0")
        }
      })
    })
    await new Promise<void>((r) => clamd.listen(0, "127.0.0.1", () => r()))
    try {
      process.env.CLAMAV_HOST = `127.0.0.1:${(clamd.address() as { port: number }).port}`
      const out = await scanInboundAttachment(att, { orgId: ORG, where: "tickets" })
      expect(out).toEqual({ quarantined: false, attachment: att })
      expect(signals).toHaveLength(0)
    } finally {
      clamd.close()
    }
  })
})
