// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Bug reports sent ONLY to the Liaison team (`bugReportsTeamOnly`): the form
// files no local ticket, its ticked files are staged for the outbox and swept
// with the rows, an undelivered report is told to the org admins, other orgs
// of a multi-tenant server keep their local inbox, and `kernel:report_bug`
// sends nothing until its reporter clicks. Real database and Redis, the fake
// control plane over TCP, object storage stubbed in memory.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import * as realObjectStorage from "~/infra/storage/object-storage"
import * as realPayload from "~/modules/liaison-team/bug-report-payload"
import { createTestOrg } from "~/tests/helpers/org"

const realObjectStorageModule = { ...realObjectStorage }
const realPayloadModule = { ...realPayload }
const objects = new Map<string, Buffer>()
mock.module("~/infra/storage/object-storage", () => ({
  ...realObjectStorageModule,
  putObject: async (args: { key: string; body: Buffer }) => {
    objects.set(args.key, Buffer.from(args.body))
  },
  deleteObjects: async (keys: string[]) => {
    for (const k of keys) objects.delete(k)
  },
  getObjectBuffer: async (key: string) => {
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
    return bytes
  },
}))
// The lock-time re-check lost a race: one queue answers "unavailable".
let forceUnavailable = false
mock.module("~/modules/liaison-team/bug-report-payload", () => ({
  ...realPayloadModule,
  enqueueBugReportForward: (...args: Parameters<typeof realPayload.enqueueBugReportForward>) =>
    forceUnavailable
      ? Promise.resolve({ status: "unavailable" as const })
      : realPayloadModule.enqueueBugReportForward(...args),
}))

const { app } = await import("~/app")
const { sql } = await import("~/db")
const { env } = await import("~/lib/env")
const { _setEdition } = await import("~/lib/edition")
const { resetOperatorOrgCache } = await import("~/modules/apps/operator-org")
const { DemoModeTestAccess } = await import("~/modules/demo/demo-mode")
const { startFakeControlPlane } = await import("~/tests/e2e/helpers/mock-control-plane")
const minimal = await import("~/seed/tiers/minimal")
const { acquireTestLock, releaseTestLock } = await import("~/tests/route-test-setup")
const { drainOnce } = await import("~/modules/liaison-team/outbox")
const { setSharing } = await import("~/modules/liaison-team/settings")
const { sweepTeamOnly } = await import("~/modules/liaison-team/team-only")
const { handleReportBug } = await import("~/modules/bug-reports/tool")
const { runContextStore } = await import("~/modules/agent/runtime/run-context")
const { ensureAppsForOrg } = await import("~/modules/apps/init")
const { isBugReportTeamOnlyFor } = await import("~/modules/liaison-team/bug-report-payload")
const { redis } = await import("~/lib/redis")

type Fake = Awaited<ReturnType<typeof startFakeControlPlane>>
type Session = Awaited<ReturnType<typeof minimal.session>>

const saved = { endpoint: env.LIAISON_TEAM_ENDPOINT, operator: env.LIAISON_OPERATOR_ORG_ID }
const mutableEnv = env as unknown as Record<string, string | undefined>

let fake: Fake
let reporter: Session
let now: Date

const drain = () => {
  now = new Date(Math.max(now.getTime(), Date.now()) + 1)
  return drainOnce(now, { random: () => 0.5, elapsedMs: () => 0 })
}

interface OutboxRow {
  id: string
  type: string
  message_id: string
  status: string
  data: Record<string, any>
}
const outbox = () =>
  sql<OutboxRow[]>`SELECT id, type, message_id, status, data FROM kernel.control_plane_outbox
                    WHERE type IN ('bug-report', 'bug-report-attachment')
                    ORDER BY created_at, type, id`
const ticketCount = async (orgId: string) => {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app_tickets.tickets WHERE org_id = ${orgId}::uuid`
  return r?.n ?? 0
}
const stagedFiles = () =>
  sql<{ id: string; storage_key: string; uploaded_by: string | null }[]>`
    SELECT id, storage_key, uploaded_by FROM kernel.files
     WHERE app = 'kernel' AND entity_type = 'liaison_team_forward'`

function call(s: Session, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/bug-reports${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.bearer}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const form = () => ({
  description: "Saving a draft spins forever\nNothing is saved.",
  clientLogs: ["2026-11-03T07:00:00.000Z [info] app booted"],
  context: { url: "https://support.example/tickets/1", userAgent: "TestAgent/1.0" },
  attachments: [
    {
      filename: "shot.png",
      mimeType: "image/png",
      bytesBase64: Buffer.from("png!").toString("base64"),
    },
    {
      filename: "other.png",
      mimeType: "image/png",
      bytesBase64: Buffer.from("no").toString("base64"),
    },
  ],
})

async function previewAndSubmit(s: Session, opts: { indexes?: number[] } = {}) {
  const f = form()
  const indexes = opts.indexes ?? [0]
  const pre = await call(s, "/forward-preview", {
    ...f,
    includeEmail: true,
    attachmentIndexes: indexes,
  })
  expect(pre.status).toBe(200)
  const p = ((await pre.json()) as { data: { snapshotId: string; digest: string } }).data
  return call(s, "", {
    ...f,
    forward: {
      includeEmail: true,
      snapshotId: p.snapshotId,
      digest: p.digest,
      attachmentIndexes: indexes,
      teamOnly: true,
    },
  })
}

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code

beforeAll(async () => {
  await acquireTestLock()
  reporter = await minimal.session((await createTestOrg()).id)
}, 60_000)

afterAll(async () => {
  mutableEnv.LIAISON_TEAM_ENDPOINT = saved.endpoint
  mutableEnv.LIAISON_OPERATOR_ORG_ID = saved.operator
  resetOperatorOrgCache()
  _setEdition(null)
  DemoModeTestAccess.set(null)
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
  await sql`DELETE FROM kernel.files WHERE app = 'kernel' AND entity_type = 'liaison_team_forward'`
  mock.module("~/infra/storage/object-storage", () => realObjectStorageModule)
  mock.module("~/modules/liaison-team/bug-report-payload", () => realPayloadModule)
  await releaseTestLock()
})

afterEach(async () => {
  forceUnavailable = false
  await fake.kill()
})

beforeEach(async () => {
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
  await sql`DELETE FROM kernel.files WHERE app = 'kernel' AND entity_type = 'liaison_team_forward'`
  await sql`DELETE FROM kernel.pending_events WHERE payload->>'entity' = 'liaison_team_forward'`
  objects.clear()
  fake = await startFakeControlPlane(0)
  now = new Date(Math.floor(Date.now() / 1000) * 1000)
  fake.control.setClock(() => now)
  mutableEnv.LIAISON_TEAM_ENDPOINT = fake.control.endpoint
  mutableEnv.LIAISON_OPERATOR_ORG_ID = reporter.orgId
  resetOperatorOrgCache()
  _setEdition("self_hosted")
  DemoModeTestAccess.set(false)
  await setSharing({ register: true }, { userId: null }, now)
  await drain()
  await setSharing({ forwardBugReports: true, bugReportsTeamOnly: true }, { userId: null }, now)
  await sql`DELETE FROM kernel.control_plane_outbox`
})

describe("the form, team-only", () => {
  it("GET /forwarding says teamOnly", async () => {
    const res = await call(reporter, "/forwarding")
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      available: true,
      teamOnly: true,
    })
  })

  it("files no local ticket: one report row, one row per ticked file, staged files no user can read", async () => {
    const before = await ticketCount(reporter.orgId)
    const res = await previewAndSubmit(reporter)
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: Record<string, unknown> }
    expect(data.teamOnly).toBe(true)
    expect(data.forwarded).toBe("queued")
    expect(data.ticketId).toBeUndefined()
    expect(typeof data.messageId).toBe("string")
    expect(await ticketCount(reporter.orgId)).toBe(before)

    const rows = await outbox()
    expect(rows.map((r) => r.type)).toEqual(["bug-report", "bug-report-attachment"])
    expect(rows[0]?.data.local).toMatchObject({ teamOnly: true, orgId: reporter.orgId })
    const staged = await stagedFiles()
    expect(staged).toHaveLength(1)
    expect(staged[0]?.uploaded_by).toBeNull()
    expect(rows[1]?.data.fileId).toBe(staged[0]?.id)
    // No manifest declares the parent: the RLS policy admits nobody.
    const visible = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE liaison_rls`
      return tx`SELECT id FROM kernel.files WHERE id = ${staged[0]?.id ?? ""}::uuid`
    })
    expect(visible).toHaveLength(0)

    // Delivered: the local bookkeeping never goes out, and the sweep removes the staged file.
    await drain()
    await drain()
    expect((await outbox()).map((r) => r.status)).toEqual(["delivered", "delivered"])
    const body = fake.control
      .requests()
      .find((r) => (r.body as { messageId?: string })?.messageId === data.messageId)?.rawBody
    expect(body).toBeDefined()
    expect(body).not.toContain('"local"')
    expect(body).not.toContain(reporter.orgId)
    const swept = await sweepTeamOnly(now)
    expect(swept.filesDeleted).toBe(1)
    expect(await stagedFiles()).toHaveLength(0)
    expect(objects.size).toBe(0)
  })

  it("a log line over the cap is trimmed, never a 400 that leaves Send dead", async () => {
    const long = `2026-11-09T12:00:00.000Z [info] ${"x".repeat(2_100)}`
    const pre = await call(reporter, "/forward-preview", {
      ...form(),
      clientLogs: [long, "short line"],
      includeEmail: true,
      attachmentIndexes: [],
    })
    expect(pre.status).toBe(200)
    const logs = ((await pre.json()) as { data: { data: { report: { logs: string[] } } } }).data
      .data.report.logs
    expect(logs).toHaveLength(2)
    expect(logs[0]?.length).toBeLessThanOrEqual(2_000)
    expect(logs[0]?.endsWith("…")).toBe(true)
  })

  it("a submit without the previewed payload is 409 FORWARD_REQUIRED and nothing is filed", async () => {
    const before = await ticketCount(reporter.orgId)
    const res = await call(reporter, "", { description: "plain report" })
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe("FORWARD_REQUIRED")
    expect(await ticketCount(reporter.orgId)).toBe(before)
    expect(await outbox()).toHaveLength(0)
  })

  it("unavailable at queue time: 409 FORWARDING_UNAVAILABLE and the staged files are deleted", async () => {
    forceUnavailable = true
    const res = await previewAndSubmit(reporter)
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe("FORWARDING_UNAVAILABLE")
    expect(await stagedFiles()).toHaveLength(0)
    expect(objects.size).toBe(0)
    expect(await outbox()).toHaveLength(0)
  })

  it("team-only switched off between preview and send: 409 and nothing is filed", async () => {
    const f = form()
    const pre = await call(reporter, "/forward-preview", {
      ...f,
      includeEmail: true,
      attachmentIndexes: [],
    })
    const p = ((await pre.json()) as { data: { snapshotId: string; digest: string } }).data
    await setSharing({ bugReportsTeamOnly: false }, { userId: null }, now)
    const before = await ticketCount(reporter.orgId)
    const res = await call(reporter, "", {
      ...f,
      forward: {
        includeEmail: true,
        snapshotId: p.snapshotId,
        digest: p.digest,
        attachmentIndexes: [],
        teamOnly: true,
      },
    })
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe("FORWARDING_UNAVAILABLE")
    expect(await ticketCount(reporter.orgId)).toBe(before)
    expect(await outbox()).toHaveLength(0)
  })

  it("control plane down: the rows stay pending and the reporter is told queued", async () => {
    await fake.kill()
    const res = await previewAndSubmit(reporter, { indexes: [] })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { forwarded: string } }).data.forwarded).toBe("queued")
    await drain()
    expect((await outbox()).map((r) => r.status)).toEqual(["pending"])
    fake = await startFakeControlPlane(0)
  })
})

describe("the sweep", () => {
  it("a team-only report that ends refused raises one notice for the org admins, with its text", async () => {
    expect((await previewAndSubmit(reporter, { indexes: [0] })).status).toBe(200)
    await sql`UPDATE kernel.control_plane_outbox SET status = 'refused', last_error = 'test'
               WHERE type = 'bug-report'`
    await sql`UPDATE kernel.control_plane_outbox SET status = 'cancelled'
               WHERE type = 'bug-report-attachment'`
    const first = await sweepTeamOnly(now)
    expect(first.noticesRaised).toBe(1)
    expect(first.filesDeleted).toBe(1)
    expect((await sweepTeamOnly(now)).noticesRaised).toBe(0)
    const events = await sql<{ payload: Record<string, any> }[]>`
      SELECT payload FROM kernel.pending_events
       WHERE payload->>'entity' = 'liaison_team_forward' AND org_id = ${reporter.orgId}::uuid`
    expect(events).toHaveLength(1)
    expect(events[0]?.payload.action).toBe("undelivered")
    expect(events[0]?.payload.data.reportText).toContain("Saving a draft spins forever")
    expect(events[0]?.payload.data.summary).toContain("Saving a draft spins forever")
  })

  it("endpoint unset after queueing: the row still expires and the undelivered notice fires", async () => {
    await fake.kill()
    expect((await previewAndSubmit(reporter, { indexes: [] })).status).toBe(200)
    mutableEnv.LIAISON_TEAM_ENDPOINT = ""
    // No drain runs without an endpoint; the always-on sweep still ends the row.
    const later = new Date(now.getTime() + 7 * 24 * 3600_000 + 60_000)
    expect((await sweepTeamOnly(later)).noticesRaised).toBe(1)
    const rows = await outbox()
    expect(rows.map((r) => r.status)).toEqual(["expired"])
    const events = await sql<{ payload: Record<string, any> }[]>`
      SELECT payload FROM kernel.pending_events
       WHERE payload->>'entity' = 'liaison_team_forward' AND org_id = ${reporter.orgId}::uuid`
    expect(events).toHaveLength(1)
    expect(events[0]?.payload.data.reportText).toContain("Saving a draft spins forever")
    fake = await startFakeControlPlane(0)
  })

  it("a staged file is deleted after 8 days even while a row still names it", async () => {
    await fake.kill()
    expect((await previewAndSubmit(reporter, { indexes: [0] })).status).toBe(200)
    expect((await sweepTeamOnly(now)).filesDeleted).toBe(0)
    expect(await stagedFiles()).toHaveLength(1)
    const later = new Date(now.getTime() + 8 * 24 * 3600_000 + 1000)
    expect((await sweepTeamOnly(later)).filesDeleted).toBe(1)
    expect(await stagedFiles()).toHaveLength(0)
    fake = await startFakeControlPlane(0)
  })
})

describe("kernel:report_bug, team-only", () => {
  const humanTurn = () => {
    const runId = crypto.randomUUID()
    return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, humanTurn: true }
  }
  const params = { title: "Save spins", description: "The save button spins forever." }

  beforeAll(async () => {
    await ensureAppsForOrg(reporter.orgId, {})
  }, 60_000)

  it("returns the payload and digest and queues nothing until the reporter sends it", async () => {
    const tickets = await ticketCount(reporter.orgId)
    const result = (await runContextStore.run(humanTurn(), () =>
      handleReportBug(params, {
        orgId: reporter.orgId,
        userId: reporter.userId,
        actorType: "agent",
      }),
    )) as Record<string, any>
    expect(result.awaitingConfirmation).toBe(true)
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
    // The conversation keeps only the id, digest and a short summary: never the
    // reporter's email or the instance's server errors.
    expect(result.payload).toBeUndefined()
    expect(result.summary.title).toBe("Save spins")
    expect(result.summary.payloadBytes).toBeGreaterThan(0)
    const [me] = await sql<{ email: string }[]>`
      SELECT email FROM kernel.users WHERE id = ${reporter.userId}::uuid`
    const toolText = JSON.stringify(result)
    expect(me?.email).toBeTruthy()
    expect(toolText).not.toContain(me?.email ?? "")
    expect(toolText).not.toContain("serverErrors")
    expect(toolText).not.toContain("The save button spins forever.")
    // The reporter reads the whole payload from the card's endpoint.
    const own = await call(reporter, `/drafts/${result.draftId}`)
    expect(own.status).toBe(200)
    const draft = ((await own.json()) as { data: { data: Record<string, any> } }).data.data
    expect(draft.report.description).toContain("The save button spins forever.")
    expect(draft.reporter.email).toBe(me?.email)
    expect(await outbox()).toHaveLength(0)

    // Another member cannot read or send it.
    const other = await minimal.session(reporter.orgId)
    expect((await call(other, `/drafts/${result.draftId}`)).status).toBe(404)
    expect(
      (await call(other, `/drafts/${result.draftId}/send`, { digest: result.digest })).status,
    ).toBe(404)
    expect(await outbox()).toHaveLength(0)

    const listed = await call(reporter, "/drafts")
    expect(
      ((await listed.json()) as { data: Array<{ draftId: string }> }).data.map((d) => d.draftId),
    ).toContain(result.draftId)
    const wrong = await call(reporter, `/drafts/${result.draftId}/send`, { digest: "0".repeat(64) })
    expect(wrong.status).toBe(409)
    expect(await errorCode(wrong)).toBe("FORWARD_PAYLOAD_CHANGED")

    const sent = await call(reporter, `/drafts/${result.draftId}/send`, { digest: result.digest })
    expect(sent.status).toBe(200)
    const { data } = (await sent.json()) as { data: { forwarded: string; messageId: string } }
    expect(data.forwarded).toBe("queued")
    const rows = await outbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.message_id).toBe(data.messageId)
    const again = await call(reporter, `/drafts/${result.draftId}/send`, { digest: result.digest })
    expect(again.status).toBe(409)
    expect(await outbox()).toHaveLength(1)
    expect(await ticketCount(reporter.orgId)).toBe(tickets)
  })

  it("a turn with no person behind it (a routine tick) is refused and prepares nothing", async () => {
    const runId = crypto.randomUUID()
    const result = (await runContextStore.run(
      {
        runId,
        parentRunId: null,
        rootRunId: runId,
        nestingDepth: 0,
        routineId: crypto.randomUUID(),
      },
      () =>
        handleReportBug(params, {
          orgId: reporter.orgId,
          userId: reporter.userId,
          actorType: "agent",
        }),
    )) as Record<string, any>
    expect(result.error?.code).toBe("REPORTER_CONFIRMATION_REQUIRED")
    expect(result.error?.message).toContain("Report a bug")
    expect(result.draftId).toBeUndefined()
  })

  it("the sixth prepared report sent within an hour is refused", async () => {
    // The bucket is per reporter: a fresh one.
    const fresh = await minimal.session(reporter.orgId)
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const r = (await runContextStore.run(humanTurn(), () =>
        handleReportBug(
          { ...params, title: `Report ${i}` },
          { orgId: fresh.orgId, userId: fresh.userId, actorType: "agent" },
        ),
      )) as Record<string, any>
      statuses.push((await call(fresh, `/drafts/${r.draftId}/send`, { digest: r.digest })).status)
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
    expect(await outbox()).toHaveLength(5)
  })

  it("a draft prepared before a deploy still sends, exactly as prepared", async () => {
    const fresh = await minimal.session(reporter.orgId)
    const before = mutableEnv.LIAISON_VERSION
    mutableEnv.LIAISON_VERSION = "release-a"
    try {
      const r = (await runContextStore.run(humanTurn(), () =>
        handleReportBug(params, { orgId: fresh.orgId, userId: fresh.userId, actorType: "agent" }),
      )) as Record<string, any>
      // A deploy: the running version moves on while the draft waits for its click.
      mutableEnv.LIAISON_VERSION = "release-b"
      const card = await call(fresh, `/drafts/${r.draftId}`)
      const shown = ((await card.json()) as { data: { digest: string; data: any } }).data
      expect(shown.digest).toBe(r.digest)
      expect(shown.data.version).toBe("release-a")
      const sent = await call(fresh, `/drafts/${r.draftId}/send`, { digest: r.digest })
      expect(sent.status).toBe(200)
      const { messageId } = ((await sent.json()) as { data: { messageId: string } }).data
      const row = (await outbox()).find((o) => o.message_id === messageId)
      expect(row?.data.version).toBe("release-a")
    } finally {
      mutableEnv.LIAISON_VERSION = before
    }
  })

  it("the reporter discards a prepared report: it leaves the list and can no longer be sent", async () => {
    const fresh = await minimal.session(reporter.orgId)
    const r = (await runContextStore.run(humanTurn(), () =>
      handleReportBug(params, { orgId: fresh.orgId, userId: fresh.userId, actorType: "agent" }),
    )) as Record<string, any>
    // Nobody else can drop it.
    const other = await minimal.session(reporter.orgId)
    const foreign = await app.request(`/api/bug-reports/drafts/${r.draftId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${other.bearer}` },
    })
    expect(foreign.status).toBe(404)
    const res = await app.request(`/api/bug-reports/drafts/${r.draftId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${fresh.bearer}` },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { discarded: boolean } }).data.discarded).toBe(true)
    const listed = (await (await call(fresh, "/drafts")).json()) as {
      data: Array<{ draftId: string }>
    }
    expect(listed.data.map((d) => d.draftId)).not.toContain(r.draftId)
    expect((await call(fresh, `/drafts/${r.draftId}/send`, { digest: r.digest })).status).toBe(404)
    // A second discard finds nothing of the caller's: 404, not a 200.
    const again = await app.request(`/api/bug-reports/drafts/${r.draftId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${fresh.bearer}` },
    })
    expect(again.status).toBe(404)
  })

  it("a draft an older release stored without its payload sends with the digest its card shows", async () => {
    const fresh = await minimal.session(reporter.orgId)
    const r = (await runContextStore.run(humanTurn(), () =>
      handleReportBug(params, { orgId: fresh.orgId, userId: fresh.userId, actorType: "agent" }),
    )) as Record<string, any>
    // What the previous release stored: no payload, and a digest of a version no longer running.
    const key = `bug-report:draft:${fresh.orgId}:${fresh.userId}:${r.draftId}`
    const stored = JSON.parse((await redis.get(key)) ?? "{}")
    delete stored.data
    stored.digest = "a".repeat(64)
    await redis.set(key, JSON.stringify(stored), "KEEPTTL")

    const card = await call(fresh, `/drafts/${r.draftId}`)
    const shown = ((await card.json()) as { data: { digest: string } }).data
    expect(shown.digest).toMatch(/^[0-9a-f]{64}$/)
    const sent = await call(fresh, `/drafts/${r.draftId}/send`, { digest: shown.digest })
    expect(sent.status).toBe(200)
    expect(((await sent.json()) as { data: { forwarded: string } }).data.forwarded).toBe("queued")
  })
})

describe("kernel:report_bug, team-only caps", () => {
  const humanTurn = () => {
    const runId = crypto.randomUUID()
    return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, humanTurn: true }
  }
  const prepare = (s: Session, i: number) =>
    runContextStore.run(humanTurn(), () =>
      handleReportBug(
        { title: `Report ${i}`, description: "The save button spins forever." },
        { orgId: s.orgId, userId: s.userId, actorType: "agent" },
      ),
    ) as Promise<Record<string, any>>

  it("a send that could not be queued does not count against the hourly send cap", async () => {
    const fresh = await minimal.session(reporter.orgId)
    const failed = await prepare(fresh, 0)
    forceUnavailable = true
    const refused = await call(fresh, `/drafts/${failed.draftId}/send`, { digest: failed.digest })
    expect(refused.status).toBe(409)
    expect(await errorCode(refused)).toBe("FORWARDING_UNAVAILABLE")
    forceUnavailable = false
    const statuses: number[] = []
    for (let i = 1; i <= 5; i++) {
      const r = await prepare(fresh, i)
      statuses.push((await call(fresh, `/drafts/${r.draftId}/send`, { digest: r.digest })).status)
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200])
  })

  it("at most 10 prepared reports wait at once, and 20 are prepared an hour", async () => {
    const fresh = await minimal.session(reporter.orgId)
    for (let i = 0; i < 10; i++) expect((await prepare(fresh, i)).draftId).toBeTruthy()
    const eleventh = await prepare(fresh, 10)
    expect(eleventh.draftId).toBeUndefined()
    expect(eleventh.error?.code).toBe("DRAFT_LIMIT_REACHED")
    // Ten more once the first ten stopped waiting (here: forgotten by the index).
    await redis.del(`bug-report:drafts:${fresh.orgId}:${fresh.userId}`)
    for (let i = 10; i < 20; i++) expect((await prepare(fresh, i)).draftId).toBeTruthy()
    await redis.del(`bug-report:drafts:${fresh.orgId}:${fresh.userId}`)
    const twentyFirst = await prepare(fresh, 20)
    expect(twentyFirst.draftId).toBeUndefined()
    expect(twentyFirst.error?.code).toBe("DRAFT_LIMIT_REACHED")
  })
})

// Last: a second createTestOrg truncates every org, the reporter's included.
describe("multi-tenant", () => {
  it("on a multi-tenant instance another org's reporter files locally as before", async () => {
    const visitor = await minimal.session((await createTestOrg()).id)
    // The operator org (still named by LIAISON_OPERATOR_ORG_ID) is another org:
    // even on a self-host the switch is not this org's.
    const single = await call(visitor, "/forwarding")
    expect(((await single.json()) as { data: { teamOnly: boolean } }).data.teamOnly).toBe(false)
    DemoModeTestAccess.set(true)
    const res = await call(visitor, "/forwarding")
    expect(((await res.json()) as { data: { teamOnly: boolean } }).data.teamOnly).toBe(false)
    const before = await ticketCount(visitor.orgId)
    const filed = await call(visitor, "", { description: "visitor report" })
    expect(filed.status).toBe(200)
    expect(((await filed.json()) as { data: { ticketId?: string } }).data.ticketId).toBeTruthy()
    expect(await ticketCount(visitor.orgId)).toBe(before + 1)
  })

  it("two orgs on a self-host: only the operator org's reporters are team-only", async () => {
    const operatorOrg = (await createTestOrg()).id
    // A second org of the same server. The rule compares org ids only, so its
    // row is not needed (and createTestOrg would truncate the first).
    const otherOrg = crypto.randomUUID()
    DemoModeTestAccess.set(false)
    _setEdition("self_hosted")
    mutableEnv.LIAISON_OPERATOR_ORG_ID = operatorOrg
    resetOperatorOrgCache()
    expect(await isBugReportTeamOnlyFor(operatorOrg)).toBe(true)
    expect(await isBugReportTeamOnlyFor(otherOrg)).toBe(false)
    // Unset, the operator is the instance's first org.
    mutableEnv.LIAISON_OPERATOR_ORG_ID = undefined
    resetOperatorOrgCache()
    expect(await isBugReportTeamOnlyFor(operatorOrg)).toBe(true)
    expect(await isBugReportTeamOnlyFor(otherOrg)).toBe(false)
  })
})
