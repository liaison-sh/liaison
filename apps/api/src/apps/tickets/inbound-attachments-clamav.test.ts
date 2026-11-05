// SPDX-License-Identifier: FSL-1.1-ALv2
// The support inbox with a virus scanner (CLAMAV_HOST): an infected inbound
// attachment is kept under a quarantine key, the message carries a text notice
// in its place, and admins get a security event. A clean one is stored as is.
import { afterAll, describe, expect, it, mock } from "bun:test"
import { createServer } from "node:net"
// HERMETICITY: same complete-stub-and-restore pattern as
// inbound-attachments.integration.test.ts (mock.module is process-global).
import * as realObjectStorage from "~/infra/storage/object-storage"
import * as realSecurityEvents from "~/modules/security/security-events"

const realObjectStorageModule = { ...realObjectStorage }
const realSecurityEventsModule = { ...realSecurityEvents }

const putObjectCalls: Array<{ key: string; body: Buffer; contentType: string }> = []
mock.module("~/infra/storage/object-storage", () => ({
  ...realObjectStorageModule,
  putObject: async (args: { key: string; body: Buffer; contentType: string }) => {
    putObjectCalls.push({ key: args.key, body: args.body, contentType: args.contentType })
  },
}))
const securityEvents: Array<{ kind: string; detail?: Record<string, unknown> }> = []
mock.module("~/modules/security/security-events", () => ({
  ...realSecurityEventsModule,
  emitSecurityEvent: async (s: { kind: string; detail?: Record<string, unknown> }) => {
    securityEvents.push(s)
  },
}))

const clamd = createServer((sock) => {
  let buf = Buffer.alloc(0)
  sock.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    if (buf.subarray(buf.length - 4).equals(Buffer.alloc(4)) && buf.length > 14) {
      sock.end(
        buf.includes(Buffer.from("infected-marker"))
          ? "stream: Eicar-Test-Signature FOUND\0"
          : "stream: OK\0",
      )
    }
  })
})
await new Promise<void>((r) => clamd.listen(0, "127.0.0.1", () => r()))
const prior = process.env.CLAMAV_HOST
process.env.CLAMAV_HOST = `127.0.0.1:${(clamd.address() as { port: number }).port}`

afterAll(() => {
  mock.module("~/infra/storage/object-storage", () => realObjectStorageModule)
  mock.module("~/modules/security/security-events", () => realSecurityEventsModule)
  clamd.close()
  if (prior === undefined) delete process.env.CLAMAV_HOST
  else process.env.CLAMAV_HOST = prior
})

const { persistInboundAttachments } = await import("./inbound")

const ORG_ID = "00000000-0000-0000-0000-000000000001"
const MSG_ID = "11111111-1111-1111-1111-111111111111"
const EICAR = "liaison-test-infected-marker"

describe("persistInboundAttachments with CLAMAV_HOST", () => {
  it("quarantines the infected attachment, stores a notice instead, and flags it", async () => {
    const inserts: string[] = []
    const ctx = {
      db: {
        execute: async (q: unknown) => {
          inserts.push(JSON.stringify(q))
          return [] as never
        },
        queueEvent: async () => {},
      } as never,
      orgId: ORG_ID,
    }
    const report = await persistInboundAttachments(ctx, {
      messageId: MSG_ID,
      attachments: [
        {
          filename: "invoice.exe",
          mimeType: "application/octet-stream",
          bytesBase64: Buffer.from(EICAR).toString("base64"),
          disposition: "attachment",
        },
        {
          filename: "photo.png",
          mimeType: "image/png",
          bytesBase64: Buffer.from("clean-bytes").toString("base64"),
          disposition: "inline",
          contentId: "cid-1",
        },
      ] as never,
    })

    expect(report.persisted).toBe(2)
    expect(report.quarantined).toEqual([
      { filename: "invoice.exe", signature: "Eicar-Test-Signature" },
    ])
    // The original went to the quarantine prefix only; the record carries the notice.
    const quarantine = putObjectCalls.filter((c) => c.key.includes("/quarantine/"))
    expect(quarantine).toHaveLength(1)
    expect(quarantine[0].body.toString()).toBe(EICAR)
    const onMessage = putObjectCalls.filter((c) => c.key.includes(`/tickets/message/${MSG_ID}/`))
    expect(onMessage).toHaveLength(2)
    expect(onMessage.some((c) => c.body.toString().includes(EICAR))).toBe(false)
    const notice = onMessage.find((c) => c.key.endsWith("invoice.exe.quarantined.txt"))
    expect(notice?.contentType).toBe("text/plain")
    expect(notice?.body.toString()).toContain("Eicar-Test-Signature")
    // The clean one is stored as received.
    expect(onMessage.find((c) => c.key.endsWith("photo.png"))?.body.toString()).toBe("clean-bytes")
    // Admins are told.
    expect(securityEvents.map((e) => e.kind)).toEqual(["malware_quarantined"])
    expect(securityEvents[0].detail?.signature).toBe("Eicar-Test-Signature")
  })
})
