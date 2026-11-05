// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
// HERMETICITY: mock.module replaces a module GLOBALLY for every later file and
// mock.restore() does not undo it — stub COMPLETELY (spread the real module,
// override only putObject) and re-install the real module in afterAll. Same
// pattern as apps/tickets/inbound-attachments.integration.test.ts.
import * as realObjectStorage from "~/infra/storage/object-storage"

const realObjectStorageModule = { ...realObjectStorage }
const putObjectCalls: Array<{ key: string; size: number; contentType: string }> = []
mock.module("~/infra/storage/object-storage", () => ({
  ...realObjectStorageModule,
  putObject: async (args: { key: string; body: Buffer; contentType: string }) => {
    putObjectCalls.push({
      key: args.key,
      size: args.body.byteLength,
      contentType: args.contentType,
    })
  },
}))

const { app } = await import("~/app")
const { sql } = await import("~/db")
const { acquireTestLock, releaseTestLock } = await import("~/tests/route-test-setup")

describe("bug-reports routes", () => {
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "bug-admin@test.com",
        password: "testpass123",
        name: "Bug Admin",
      }),
    })
    token = ((await res.json()) as any).data.accessToken
  })

  afterAll(async () => {
    mock.module("~/infra/storage/object-storage", () => realObjectStorageModule)
    await releaseTestLock()
  })

  it("rejects unauthenticated requests", async () => {
    const res = await app.request("/api/bug-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "nope" }),
    })
    expect(res.status).toBe(401)
  })

  it("rejects an empty description", async () => {
    const res = await app.request("/api/bug-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ description: "   " }),
    })
    expect(res.status).toBe(400)
  })

  it("files a ticket carrying the description, context, and scrubbed client logs", async () => {
    const res = await app.request("/api/bug-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        description: "Clicking send on a thread reply does nothing\nThe spinner never stops.",
        clientLogs: [
          "2026-07-07T10:00:00.000Z [info] app booted",
          "2026-07-07T10:00:05.000Z [error] reply failed with Bearer sk-abc12345secret890 for jane@example.com",
        ],
        context: { url: "https://liaison.test/threads/42", userAgent: "TestAgent/1.0" },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.ticketId).toBeTruthy()
    expect(body.data.ticketHandle).toMatch(/^ticket/)

    const [ticket] = await sql`
      SELECT subject, channel FROM app_tickets.tickets WHERE id = ${body.data.ticketId}::uuid
    `
    expect(ticket.subject).toBe("Bug report: Clicking send on a thread reply does nothing")
    expect(ticket.channel).toBe("web_form")

    const [message] = await sql`
      SELECT text_body, from_email FROM app_tickets.messages
      WHERE ticket_id = ${body.data.ticketId}::uuid ORDER BY created_at ASC LIMIT 1
    `
    expect(message.from_email).toBe("bug-admin@test.com")
    expect(message.text_body).toContain("The spinner never stops.")
    expect(message.text_body).toContain("Reported by: Bug Admin (bug-admin@test.com)")
    expect(message.text_body).toContain("Page: https://liaison.test/threads/42")
    expect(message.text_body).toContain("Recent client logs")
    expect(message.text_body).toContain("app booted")
    // Value-level scrub: the bearer token and email in the log line never reach the ticket.
    expect(message.text_body).not.toContain("sk-abc12345secret890")
    expect(message.text_body).not.toContain("jane@example.com")
  })

  it("persists reporter attachments onto the initial ticket message", async () => {
    putObjectCalls.length = 0
    const pngBytes = Buffer.from("fake-png-bytes-for-test")
    const res = await app.request("/api/bug-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        description: "Panel renders blank after resize",
        attachments: [
          {
            filename: "screenshot.png",
            mimeType: "image/png",
            bytesBase64: pngBytes.toString("base64"),
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.attachmentsPersisted).toBe(1)
    expect(body.data.attachmentsSkipped).toEqual([])
    expect(putObjectCalls.length).toBe(1)
    expect(putObjectCalls[0].contentType).toBe("image/png")
    expect(putObjectCalls[0].size).toBe(pngBytes.byteLength)

    const [message] = await sql`
      SELECT id FROM app_tickets.messages
      WHERE ticket_id = ${body.data.ticketId}::uuid ORDER BY created_at ASC LIMIT 1
    `
    const [file] = await sql`
      SELECT filename, mime_type, size_bytes, disposition, uploaded_by
      FROM kernel.files
      WHERE app = 'tickets' AND entity_type = 'message' AND entity_id = ${message.id}
    `
    expect(file).toBeTruthy()
    expect(file.filename).toBe("screenshot.png")
    expect(file.mime_type).toBe("image/png")
    expect(Number(file.size_bytes)).toBe(pngBytes.byteLength)
    expect(file.disposition).toBe("attachment")
    // Attributed to the reporter, unlike inbound email (uploaded_by NULL).
    expect(file.uploaded_by).toBeTruthy()
  })

  it("skips executable attachments but still files the report", async () => {
    putObjectCalls.length = 0
    const res = await app.request("/api/bug-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        description: "Report with a blocked attachment",
        attachments: [
          {
            filename: "payload.exe",
            mimeType: "application/x-msdownload",
            bytesBase64: Buffer.from("MZ").toString("base64"),
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.ticketId).toBeTruthy()
    expect(body.data.attachmentsPersisted).toBe(0)
    expect(body.data.attachmentsSkipped).toEqual([
      { filename: "payload.exe", reason: "blocked file type" },
    ])
    expect(putObjectCalls.length).toBe(0)
  })

  it("rejects more than the attachment count cap", async () => {
    const attachment = {
      filename: "a.png",
      mimeType: "image/png",
      bytesBase64: Buffer.from("x").toString("base64"),
    }
    const res = await app.request("/api/bug-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        description: "Too many attachments",
        attachments: Array.from({ length: 6 }, () => attachment),
      }),
    })
    expect(res.status).toBe(400)
  })

  it("truncates a long first line into the subject", async () => {
    const longLine = "B".repeat(300)
    const res = await app.request("/api/bug-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ description: longLine }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const [ticket] = await sql`
      SELECT subject FROM app_tickets.tickets WHERE id = ${body.data.ticketId}::uuid
    `
    expect(ticket.subject.length).toBeLessThanOrEqual("Bug report: ".length + 121)
  })
})
