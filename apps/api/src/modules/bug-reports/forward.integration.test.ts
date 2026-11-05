// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Forwarding a bug report to the Liaison team (consent per report): the
// preview, the frozen snapshot, the digest check before anything is filed, the
// outbox rows, and what the serialized envelope may and may not carry. Real
// database and Redis, the fake control plane over TCP, object storage stubbed
// in memory (the attachment bytes are read back from it at send time).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
// HERMETICITY: mock.module replaces the module for every later file; stub it
// completely (spread the real module) and put the real one back in afterAll.
import * as realObjectStorage from "~/infra/storage/object-storage"
import { createTestOrg } from "~/tests/helpers/org"

const realObjectStorageModule = { ...realObjectStorage }
const objects = new Map<string, Buffer>()
mock.module("~/infra/storage/object-storage", () => ({
  ...realObjectStorageModule,
  putObject: async (args: { key: string; body: Buffer }) => {
    objects.set(args.key, Buffer.from(args.body))
  },
  getObjectBuffer: async (key: string, _d?: unknown, opts?: { maxBytes?: number }) => {
    const bytes = objects.get(key)
    if (!bytes) {
      const err = new Error("The specified key does not exist.") as Error & {
        name: string
        $metadata: { httpStatusCode: number }
      }
      err.name = "NoSuchKey"
      err.$metadata = { httpStatusCode: 404 }
      throw err
    }
    if (opts?.maxBytes !== undefined && bytes.byteLength > opts.maxBytes) {
      throw new Error(`Object exceeds maxBytes=${opts.maxBytes} during streaming`)
    }
    return bytes
  },
}))

const { createHash, randomUUID } = await import("node:crypto")
const { MAX_BUG_REPORT_ENVELOPE_BYTES, MAX_FORWARD_ATTACHMENT_BYTES } = await import(
  "@liaison/control-plane-contract"
)
const { app } = await import("~/app")
const { sql } = await import("~/db")
const { env } = await import("~/lib/env")
const { ErrorTrackerTestAccess, trackError } = await import("~/lib/error-tracker")
const { redis } = await import("~/lib/redis")
const { startFakeControlPlane } = await import("~/tests/e2e/helpers/mock-control-plane")
const minimal = await import("~/seed/tiers/minimal")
const { acquireTestLock, releaseTestLock } = await import("~/tests/route-test-setup")
const { drainOnce } = await import("~/modules/liaison-team/outbox")
const { setSharing } = await import("~/modules/liaison-team/settings")
const { buildBugReportForward } = await import("~/modules/liaison-team/bug-report-payload")

type Fake = Awaited<ReturnType<typeof startFakeControlPlane>>

const HOST = "support.acme-forward.example"
const saved = {
  endpoint: env.LIAISON_TEAM_ENDPOINT,
  baseUrl: env.BASE_URL,
  operator: env.LIAISON_OPERATOR_ORG_ID,
}
const mutableEnv = env as unknown as Record<string, string | undefined>

let fake: Fake
let token: string
let orgId: string
let userId: string
let reporterEmail: string
let reporterName: string
let now: Date

// Rows queued by a request are stamped with the real clock: the drain clock
// never runs behind it.
const drain = () => {
  now = new Date(Math.max(now.getTime(), Date.now()) + 1)
  return drainOnce(now, { random: () => 0.5, elapsedMs: () => 0 })
}

interface OutboxRow {
  id: string
  type: string
  message_id: string
  depends_on: string | null
  status: string
  last_error: string | null
  data: Record<string, unknown>
}
const outbox = () =>
  sql<OutboxRow[]>`SELECT id, type, message_id, depends_on, status, last_error, data
                     FROM kernel.control_plane_outbox
                    WHERE type IN ('bug-report', 'bug-report-attachment')
                    ORDER BY created_at, type, id`
const ticketCount = async () => {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app_tickets.tickets WHERE org_id = ${orgId}::uuid`
  return r?.n ?? 0
}

function call(path: string, body?: unknown, auth = true): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/bug-reports${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64")

interface Form {
  description: string
  clientLogs?: string[]
  context?: { url?: string; userAgent?: string }
  attachments?: Array<{ filename: string; mimeType: string; bytesBase64: string }>
}

function form(over: Partial<Form> = {}): Form {
  return {
    description: "The reply button does nothing\nThe spinner never stops.",
    clientLogs: ["2026-11-02T07:00:00.000Z [info] app booted"],
    context: { url: `https://${HOST}/tickets/42?tab=open&q=secret`, userAgent: "TestAgent/1.0" },
    ...over,
  }
}

interface Preview {
  snapshotId: string
  digest: string
  data: Record<string, any>
  attachments: Array<{ index: number; filename: string; sizeBytes: number; tooLarge: boolean }>
}

async function preview(
  f: Form,
  opts: { includeEmail?: boolean; snapshotId?: string; attachmentIndexes?: number[] } = {},
): Promise<Preview> {
  const res = await call("/forward-preview", {
    ...f,
    includeEmail: opts.includeEmail ?? false,
    attachmentIndexes: opts.attachmentIndexes ?? [],
    ...(opts.snapshotId ? { snapshotId: opts.snapshotId } : {}),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: Preview }).data
}

function submit(f: Form, p: Preview, opts: { includeEmail?: boolean; indexes?: number[] } = {}) {
  return call("", {
    ...f,
    forward: {
      includeEmail: opts.includeEmail ?? false,
      snapshotId: p.snapshotId,
      digest: p.digest,
      attachmentIndexes: opts.indexes ?? [],
    },
  })
}

/** The serialized envelope the fake received for this message id. */
function sentBody(messageId: string): string {
  const req = fake.control
    .requests()
    .find((r) => (r.body as { messageId?: string })?.messageId === messageId)
  if (!req) throw new Error(`message ${messageId} was not sent`)
  return req.rawBody
}

beforeAll(async () => {
  await acquireTestLock()
  const session = await minimal.session((await createTestOrg()).id)
  token = session.bearer
  orgId = session.orgId
  userId = session.userId
  const [u] = await sql<{ email: string; name: string }[]>`
    SELECT email, name FROM kernel.users WHERE id = ${session.userId}::uuid`
  reporterEmail = u.email
  // A name the payload could never contain by accident.
  reporterName = "Zephyrine Quillfeather"
  await sql`UPDATE kernel.users SET name = ${reporterName} WHERE id = ${session.userId}::uuid`
}, 60_000)

afterAll(async () => {
  mutableEnv.LIAISON_TEAM_ENDPOINT = saved.endpoint
  mutableEnv.BASE_URL = saved.baseUrl
  mutableEnv.LIAISON_OPERATOR_ORG_ID = saved.operator
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
  mock.module("~/infra/storage/object-storage", () => realObjectStorageModule)
  await releaseTestLock()
})

afterEach(async () => {
  await fake.kill()
})

beforeEach(async () => {
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
  fake = await startFakeControlPlane(0)
  now = new Date(Math.floor(Date.now() / 1000) * 1000)
  fake.control.setClock(() => now)
  mutableEnv.LIAISON_TEAM_ENDPOINT = fake.control.endpoint
  mutableEnv.BASE_URL = `https://${HOST}`
  // The reporter's org is the operator unless a test says otherwise.
  mutableEnv.LIAISON_OPERATOR_ORG_ID = orgId
  ErrorTrackerTestAccess.reset()
  // Registered, forwarding allowed.
  await setSharing({ register: true }, { userId: null }, now)
  await drain()
  await setSharing({ forwardBugReports: true }, { userId: null }, now)
  await sql`DELETE FROM kernel.control_plane_outbox`
})

describe("availability and authentication", () => {
  it("unauthenticated GET /forwarding and POST /forward-preview answer 401 (R6)", async () => {
    expect((await call("/forwarding", undefined, false)).status).toBe(401)
    expect(
      (await call("/forward-preview", { ...form(), attachmentIndexes: [] }, false)).status,
    ).toBe(401)
  })

  it("GET /forwarding says available only while forwarding is on and the server is registered", async () => {
    let res = await call("/forwarding")
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { available: boolean } }).data.available).toBe(true)
    await setSharing({ forwardBugReports: false }, { userId: null }, now)
    res = await call("/forwarding")
    expect(((await res.json()) as { data: { available: boolean } }).data.available).toBe(false)
  })

  it("forwarding unavailable: preview and submit answer 409 FORWARDING_UNAVAILABLE and nothing is filed", async () => {
    const p = await preview(form())
    await setSharing({ forwardBugReports: false }, { userId: null }, now)
    const before = await ticketCount()
    const res = await submit(form(), p)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "FORWARDING_UNAVAILABLE",
    )
    expect(await ticketCount()).toBe(before)
    expect(await outbox()).toHaveLength(0)
    const pre = await call("/forward-preview", { ...form(), attachmentIndexes: [] })
    expect(pre.status).toBe(409)
  })
})

describe("submit", () => {
  it("no forward field: the report is filed and no outbox row is queued", async () => {
    const before = await ticketCount()
    const res = await call("", form())
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: Record<string, unknown> }).data.forwarded).toBeUndefined()
    expect(await ticketCount()).toBe(before + 1)
    expect(await outbox()).toHaveLength(0)
  })

  it("matching digest: the local ticket plus one bug-report row whose data equals the preview", async () => {
    const f = form()
    const p = await preview(f)
    const before = await ticketCount()
    const res = await submit(f, p)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { forwarded: string } }).data.forwarded).toBe("queued")
    expect(await ticketCount()).toBe(before + 1)
    const rows = await outbox()
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe("bug-report")
    expect(rows[0].data).toEqual(p.data)
    // Exactly the Privacy table's keys.
    expect(Object.keys(p.data).sort()).toEqual(["edition", "report", "version"])
    expect(Object.keys(p.data.report).sort()).toEqual(
      [
        "attachments",
        "description",
        "logs",
        "logsTruncated",
        "page",
        "serverErrors",
        "userAgent",
      ].sort(),
    )
  })

  it("a new log line and a new server error between preview and submit still match (R3)", async () => {
    trackError(new Error("first failure before the preview"))
    const f = form()
    const p = await preview(f)
    expect(JSON.stringify(p.data.report.serverErrors)).toContain("first failure")
    trackError(new Error("second failure after the preview"))
    // The dialog froze its logs at the first tick; a newer line in the body is ignored.
    const res = await submit({ ...f, clientLogs: [...(f.clientLogs ?? []), "a newer line"] }, p)
    expect(res.status).toBe(200)
    const [row] = await outbox()
    expect(row.data).toEqual(p.data)
    expect(JSON.stringify(row.data)).not.toContain("second failure")
    expect(JSON.stringify(row.data)).not.toContain("a newer line")
  })

  it("digest mismatch (description edited): 409 FORWARD_PAYLOAD_CHANGED with a new preview, no ticket", async () => {
    const f = form()
    const p = await preview(f)
    const before = await ticketCount()
    const res = await submit({ ...f, description: `${f.description}\nedited` }, p)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: Preview } }
    expect(body.error.code).toBe("FORWARD_PAYLOAD_CHANGED")
    expect(body.error.details.snapshotId).toBe(p.snapshotId)
    expect(body.error.details.digest).not.toBe(p.digest)
    expect(body.error.details.data.report.description).toContain("edited")
    expect(await ticketCount()).toBe(before)
    expect(await outbox()).toHaveLength(0)
  })

  it("expired snapshot: 409 with a fresh snapshot, no ticket", async () => {
    const f = form()
    const p = await preview(f)
    expect(await redis.del(`liaison-team:fwd:${orgId}:${userId}:${p.snapshotId}`)).toBe(1)
    const before = await ticketCount()
    const res = await submit(f, p)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: Preview } }
    expect(body.error.code).toBe("FORWARD_PAYLOAD_CHANGED")
    expect(body.error.details.snapshotId).not.toBe(p.snapshotId)
    expect(await ticketCount()).toBe(before)
    // The fresh snapshot submits.
    const ok = await submit(f, body.error.details)
    expect(ok.status).toBe(200)
  })
})

describe("what the envelope carries", () => {
  it("never the host (also typed in the description), the name, an unticked file or any bytes; the email only with the second tick", async () => {
    const shot = Buffer.from("PNG-bytes-of-the-ticked-screenshot")
    const secret = Buffer.from("bytes-of-the-unticked-private-file")
    const f = form({
      description: `Broken on https://${HOST}/mail since this morning`,
      clientLogs: [`GET https://${HOST}/api/threads failed`, "plain line"],
      attachments: [
        { filename: "ticked-shot.png", mimeType: "image/png", bytesBase64: b64(shot) },
        { filename: "unticked-payroll.pdf", mimeType: "application/pdf", bytesBase64: b64(secret) },
      ],
    })
    const p = await preview(f, { attachmentIndexes: [0] })
    expect(p.data.report.description).toBe("Broken on https://<instance>/mail since this morning")
    expect(p.attachments.map((a) => a.filename)).toEqual([
      "ticked-shot.png",
      "unticked-payroll.pdf",
    ])
    expect(await submit(f, p, { indexes: [0] }).then((r) => r.status)).toBe(200)
    const [report] = await outbox()
    await drain()
    const raw = sentBody(report.message_id)
    expect(raw).not.toContain(HOST)
    expect(raw).not.toContain(reporterName)
    expect(raw).not.toContain(reporterEmail)
    expect(raw).not.toContain("unticked-payroll")
    expect(raw).not.toContain(b64(shot))
    expect(raw).not.toContain(b64(secret))
    expect(raw).toContain("ticked-shot.png")
    expect(raw).toContain(createHash("sha256").update(shot).digest("hex"))

    // With the second tick, the email goes (and only then).
    const p2 = await preview(f, { includeEmail: true, snapshotId: p.snapshotId })
    expect(p2.snapshotId).toBe(p.snapshotId)
    expect(p2.data.reporter).toEqual({ email: reporterEmail })
    await sql`DELETE FROM kernel.control_plane_outbox`
    expect(await submit(f, p2, { includeEmail: true }).then((r) => r.status)).toBe(200)
    const [withEmail] = await outbox()
    await drain()
    expect(sentBody(withEmail.message_id)).toContain(reporterEmail)
  })

  it("page query values are dropped, keys kept, origin removed (R14)", async () => {
    const p = await preview(form())
    expect(p.data.report.page).toBe("/tickets/42?tab&q")
  })

  it("a reporter outside the operator org: no serverErrors key (R14)", async () => {
    trackError(new Error("an operator-only failure"))
    mutableEnv.LIAISON_OPERATOR_ORG_ID = randomUUID()
    const p = await preview(form())
    expect("serverErrors" in p.data.report).toBe(false)
  })

  it("worst-case description and escaped logs are truncated to fit 256 KiB with logsTruncated (R26)", () => {
    const description = "\u{1F600}".repeat(20_000) // 20 000 four-byte characters
    const line = "\u0001".repeat(2_000) // each JSON-escapes to six bytes
    const clientLogs = Array.from({ length: 400 }, (_, i) => `${i}:${line}`.slice(0, 2_000))
    const built = buildBugReportForward({
      form: { description, context: { url: "/x", userAgent: "UA" } },
      snapshot: { clientLogs },
      includeEmail: false,
      reporterEmail,
      attachmentIndexes: [],
    })
    const envelope = {
      v: 1,
      type: "bug-report",
      messageId: randomUUID(),
      instanceId: randomUUID(),
      ts: new Date().toISOString(),
      data: built.data,
    }
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(
      MAX_BUG_REPORT_ENVELOPE_BYTES,
    )
    expect(built.data.report.logsTruncated).toBe(true)
    expect(built.data.report.logs.length).toBeGreaterThan(0)
    // The oldest lines are the ones dropped.
    expect(built.data.report.logs.at(-1)?.startsWith("399:")).toBe(true)
    expect(built.data.report.description).toBe(description)
  })
})

describe("attachments", () => {
  it("two ticked files: two bug-report-attachment rows depending on the report; an 8 MiB file cannot be ticked", async () => {
    const big = Buffer.alloc(8 * 1024 * 1024, 7)
    const f = form({
      attachments: [
        { filename: "one.png", mimeType: "image/png", bytesBase64: b64("first file") },
        { filename: "big.mp4", mimeType: "video/mp4", bytesBase64: big.toString("base64") },
        { filename: "two.txt", mimeType: "text/plain", bytesBase64: b64("second file") },
      ],
    })
    const p = await preview(f, { attachmentIndexes: [0, 2] })
    expect(p.attachments).toEqual([
      expect.objectContaining({ index: 0, filename: "one.png", sizeBytes: 10, tooLarge: false }),
      expect.objectContaining({
        index: 1,
        filename: "big.mp4",
        sizeBytes: big.length,
        tooLarge: true,
      }),
      expect.objectContaining({ index: 2, filename: "two.txt", sizeBytes: 11, tooLarge: false }),
    ])
    expect(big.length).toBeGreaterThan(MAX_FORWARD_ATTACHMENT_BYTES)
    expect(p.data.report.attachments.map((a: { index: number }) => a.index)).toEqual([0, 2])

    // The too-large index is refused before anything is filed.
    const before = await ticketCount()
    const tooLarge = await submit(f, p, { indexes: [0, 1, 2] })
    expect(tooLarge.status).toBe(400)
    expect(await ticketCount()).toBe(before)
    const previewBig = await call("/forward-preview", { ...f, attachmentIndexes: [1] })
    expect(previewBig.status).toBe(400)

    expect(await submit(f, p, { indexes: [0, 2] }).then((r) => r.status)).toBe(200)
    const rows = await outbox()
    const report = rows.find((r) => r.type === "bug-report")
    const files = rows.filter((r) => r.type === "bug-report-attachment")
    expect(report).toBeDefined()
    expect(files).toHaveLength(2)
    for (const row of files) {
      expect(row.depends_on).toBe(report?.id ?? "")
      expect(row.data.reportMessageId).toBe(report?.message_id)
      expect(typeof row.data.fileId).toBe("string")
      expect(row.data.bytesBase64).toBeUndefined()
    }
    expect(files.map((r) => r.data.index).sort()).toEqual([0, 2])
  })

  it("an attachment row sends the bytes read at send time; a deleted source is cancelled source_file_gone", async () => {
    const f = form({
      attachments: [
        { filename: "kept.png", mimeType: "image/png", bytesBase64: b64("kept bytes") },
        { filename: "gone.png", mimeType: "image/png", bytesBase64: b64("gone bytes") },
      ],
    })
    const p = await preview(f, { attachmentIndexes: [0, 1] })
    expect(await submit(f, p, { indexes: [0, 1] }).then((r) => r.status)).toBe(200)
    const files = (await outbox()).filter((r) => r.type === "bug-report-attachment")
    const gone = files.find((r) => r.data.index === 1)
    const kept = files.find((r) => r.data.index === 0)
    // Delete the second file's stored object before it is sent.
    const [file] = await sql<{ storage_key: string }[]>`
      SELECT storage_key FROM kernel.files WHERE id = ${gone?.data.fileId as string}::uuid`
    objects.delete(file.storage_key)

    await drain() // the report
    await drain() // its attachments
    const after = await outbox()
    expect(after.find((r) => r.id === kept?.id)?.status).toBe("delivered")
    const goneRow = after.find((r) => r.id === gone?.id)
    expect(goneRow?.status).toBe("cancelled")
    expect(goneRow?.last_error).toBe("source_file_gone")
    const sent = JSON.parse(sentBody(kept?.message_id ?? "")) as { data: Record<string, unknown> }
    expect(sent.data.bytesBase64).toBe(b64("kept bytes"))
    expect(Object.keys(sent.data).sort()).toEqual(
      [
        "bytesBase64",
        "filename",
        "index",
        "mimeType",
        "reportMessageId",
        "sha256",
        "sizeBytes",
      ].sort(),
    )
  })
})
