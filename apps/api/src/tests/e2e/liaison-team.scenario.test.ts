// SPDX-License-Identifier: FSL-1.1-ALv2
// Sharing with the Liaison team, end to end against the fake control plane over
// real TCP: the API runs as its own process (LIAISON_TEAM_OUTBOX_INTERVAL_MS
// drains the outbox every second instead of every minute), an admin turns the
// switches on through the Settings routes, and the fake sees what the contract
// says it must: register, a boot heartbeat, a bug report with one ticked
// attachment, the retries after an outage, the 401 / 403 / 409 / retry_later
// paths, and a deregister. One server, one flow, in order: each step starts
// from the state the previous one left.
//
// The backoff after a failed send is at least 24 s; the steps that wait for a
// retry pull `next_attempt_at` forward in SQL instead of waiting it out.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { REJECTION_CODES, rejectionReplySchema } from "@liaison/control-plane-contract"
import type { TestWorld } from "@liaison/test-helpers"
import { allocatePorts, api, type WorkerEnv } from "@liaison/test-helpers"
import { type FakeControlPlaneHandle, startFakeControlPlane } from "./helpers/mock-control-plane"
import { setupScenario, teardownScenario } from "./setup"

let env: WorkerEnv
let world: TestWorld
let cp: FakeControlPlaneHandle
let url: string
let token: string

const HOST = "support.acme-team-e2e.example"
const REPORT_TEXT = "The reply button does nothing in the ticket view"
const FILE_BYTES = "kept screenshot bytes"
const OTHER_BYTES = "unticked file bytes that must never leave"

interface Status {
  available: boolean
  canManage: boolean
  register: { enabled: boolean; state: string; lastError?: string; instanceId?: string | null }
  forwardBugReports: { enabled: boolean }
  outbox?: { pending: number; failed: number; expired: number; lastError: string | null }
}

const status = async (): Promise<Status> => {
  const r = await api(url, "/api/admin/liaison-team", { token })
  expect(r.status).toBe(200)
  return r.body.data as Status
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | false | undefined> | T | false | undefined,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const v = await probe()
      if (v) return v
    } catch (err) {
      last = err
    }
    await Bun.sleep(250)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`)
}

const outboxTable = () => `"${env.schemaPrefix ?? ""}kernel".control_plane_outbox`

/** Skip the backoff of every waiting row: the next 1 s drain sends it. */
async function releaseBackoff(): Promise<void> {
  await env.db.sql.unsafe(
    `UPDATE ${outboxTable()} SET next_attempt_at = now() WHERE status = 'pending'`,
  )
}

async function outboxRows(type: string) {
  return (await env.db.sql.unsafe(
    `SELECT status, attempts, last_error, last_status FROM ${outboxTable()} WHERE type = '${type}' ORDER BY created_at`,
  )) as unknown as Array<{
    status: string
    attempts: number
    last_error: string | null
    last_status: number | null
  }>
}

const acked = (type: string) => cp.control.acks().filter((a) => a.type === type)
const sentOf = (type: string) => cp.control.requests().filter((r) => r.endpoint === type)
const b64 = (s: string) => Buffer.from(s).toString("base64")

function reportForm() {
  return {
    description: REPORT_TEXT,
    clientLogs: ["2026-11-02T07:00:00.000Z [info] app booted"],
    context: { url: `https://${HOST}/tickets/42?tab=open&q=secret`, userAgent: "TestAgent/1.0" },
    attachments: [
      { filename: "kept.png", mimeType: "image/png", bytesBase64: b64(FILE_BYTES) },
      { filename: "other.png", mimeType: "image/png", bytesBase64: b64(OTHER_BYTES) },
    ],
  }
}

/** Preview then submit with the first file ticked; returns the submit response. */
async function forwardReport(description = REPORT_TEXT) {
  const form = { ...reportForm(), description }
  const preview = await api(url, "/api/bug-reports/forward-preview", {
    token,
    body: { ...form, includeEmail: false, attachmentIndexes: [0] },
  })
  expect(preview.status).toBe(200)
  const p = preview.body.data as { snapshotId: string; digest: string }
  const res = await api(url, "/api/bug-reports", {
    token,
    body: {
      ...form,
      forward: {
        includeEmail: false,
        snapshotId: p.snapshotId,
        digest: p.digest,
        attachmentIndexes: [0],
      },
    },
  })
  expect(res.status).toBe(200)
  expect(res.body.data.forwarded).toBe("queued")
  return res
}

beforeAll(async () => {
  const [port] = await allocatePorts(1)
  cp = await startFakeControlPlane(port)
  const result = await setupScenario({
    seed: 1102,
    org: { name: "Liaison Team E2E" },
    ownServer: true,
    serverEnv: {
      LIAISON_TEAM_ENDPOINT: cp.control.endpoint,
      LIAISON_TEAM_OUTBOX_INTERVAL_MS: "1000",
      BASE_URL: `https://${HOST}`,
    },
  })
  env = result.env
  world = result.world
  url = env.serverUrl
  token = world.admin.token
}, 180_000)

afterAll(async () => {
  if (cp) await cp.kill()
  await teardownScenario(env, world)
}, 30_000)

describe("sharing with the Liaison team", () => {
  it("starts off: available, nothing registered, nothing sent", async () => {
    const s = await status()
    expect(s.available).toBe(true)
    expect(s.canManage).toBe(true)
    expect(s.register).toMatchObject({ enabled: false, state: "off" })
    expect(s.forwardBugReports.enabled).toBe(false)
    expect(cp.control.requests()).toHaveLength(0)
    // Forwarding needs registration first.
    const early = await api(url, "/api/admin/liaison-team", {
      token,
      method: "PUT",
      body: { forwardBugReports: true },
    })
    expect(early.status).toBe(400)
    expect(early.body.error.code).toBe("REGISTRATION_REQUIRED")
  })

  it("register: the opt-in registers once and Settings shows the same instance id as the fake", async () => {
    const r = await api(url, "/api/admin/liaison-team", {
      token,
      method: "PUT",
      body: { register: true },
    })
    expect(r.status).toBe(200)
    const s = await waitFor("state registered", async () => {
      const cur = await status()
      return cur.register.state === "registered" && cur
    })
    expect(cp.control.instances()).toEqual([s.register.instanceId as string])
    expect(acked("register")).toHaveLength(1)
    const [reg] = sentOf("register")
    expect(reg.status).toBe(200)
    // The registration carries the Protocol's fields and nothing else.
    const data = (reg.body as { data: Record<string, unknown> }).data
    expect(Object.keys(data).sort()).toEqual(["activeUsers", "edition", "nonce", "version"])
    expect(JSON.stringify(reg.rawBody)).not.toContain(HOST)
    expect(s.outbox?.pending).toBe(0)
  })

  it("heartbeat: a restart with a registered server sends the boot heartbeat", async () => {
    expect(acked("heartbeat")).toHaveLength(0)
    await env.restart()
    await waitFor("heartbeat acked", () => acked("heartbeat").length === 1)
    const [hb] = sentOf("heartbeat")
    expect(hb.status).toBe(200)
    const data = (hb.body as { data: Record<string, unknown> }).data
    expect(Object.keys(data).sort()).toEqual(["activeUsers", "edition", "version"])
    expect(typeof data.activeUsers).toBe("number")
    expect(hb.headers["x-liaison-signature"]).toBeTruthy()
  })

  it("forward with consent: the report and the ticked attachment arrive, the unticked file and local ids do not", async () => {
    const on = await api(url, "/api/admin/liaison-team", {
      token,
      method: "PUT",
      body: { forwardBugReports: true },
    })
    expect(on.status).toBe(200)
    const fwd = await api(url, "/api/bug-reports/forwarding", { token })
    expect(fwd.body.data.available).toBe(true)

    await forwardReport()
    await waitFor("report and attachment acked", () => acked("bug-report-attachment").length === 1)
    expect(acked("bug-report")).toHaveLength(1)

    const [report] = sentOf("bug-report")
    const [attachment] = sentOf("bug-report-attachment")
    const reportEnvelope = report.body as {
      messageId: string
      data: { report: { description: string; page: string; attachments: unknown[] } }
    }
    expect(reportEnvelope.data.report.description).toBe(REPORT_TEXT)
    // Path and query keys only: the `q=secret` value and the host never leave.
    expect(reportEnvelope.data.report.page).not.toContain("secret")
    expect(report.rawBody).not.toContain(HOST)
    expect(reportEnvelope.data.report.attachments).toHaveLength(1)

    const att = (attachment.body as { data: Record<string, unknown> }).data
    expect(att.reportMessageId).toBe(reportEnvelope.messageId)
    expect(att.index).toBe(0)
    expect(att.filename).toBe("kept.png")
    expect(Buffer.from(att.bytesBase64 as string, "base64").toString()).toBe(FILE_BYTES)
    expect(att.sha256).toBe(createHash("sha256").update(FILE_BYTES).digest("hex"))
    // The report arrived before its attachment (the attachment waits on it).
    const order = cp.control.acks().map((a) => a.type)
    expect(order.indexOf("bug-report")).toBeLessThan(order.indexOf("bug-report-attachment"))

    const everything = cp.control
      .requests()
      .map((r) => r.rawBody)
      .join("\n")
    expect(everything).not.toContain(b64(OTHER_BYTES))
    expect(everything).not.toContain("other.png")
    expect(everything).not.toContain(world.admin.email)
    expect(everything).not.toContain(world.admin.name)
    expect(everything).not.toContain(world.org.id)
  })

  it("control plane down, then up: the report waits in the outbox and is delivered once", async () => {
    await cp.control.setMode("down")
    await forwardReport("Sent while the control plane is down")
    const waiting = await waitFor("failed attempt recorded", async () => {
      const s = await status()
      return (s.outbox?.pending ?? 0) > 0 && !!s.outbox?.lastError && s
    })
    expect(waiting.outbox?.pending).toBeGreaterThan(0)
    const before = acked("bug-report").length

    await cp.control.setMode("up")
    await releaseBackoff()
    await waitFor("both delivered", () => acked("bug-report-attachment").length === 2)
    expect(acked("bug-report")).toHaveLength(before + 1)
    const ids = cp.control.acks().map((a) => a.messageId)
    expect(new Set(ids).size).toBe(ids.length)
    expect((await status()).outbox?.pending).toBe(0)
  })

  it("retry_later: the row stays queued with the reason, then goes once the control plane accepts", async () => {
    await cp.control.setMode("retry_later", { retryAfterSeconds: 1 })
    await forwardReport("Sent while the control plane asks to retry later")
    await waitFor("retry_later recorded", async () => {
      const rows = await outboxRows("bug-report")
      return rows.at(-1)?.status === "pending" && rows.at(-1)?.last_error?.includes("retry_later")
    })
    const acksBefore = acked("bug-report").length

    await cp.control.setMode("up")
    await releaseBackoff()
    await waitFor("delivered", () => acked("bug-report-attachment").length === 3)
    expect(acked("bug-report")).toHaveLength(acksBefore + 1)
  })

  it("401: signatures refused put Settings in error; the next accepted message clears it", async () => {
    await cp.control.setMode("401")
    await forwardReport("Sent while signatures are refused")
    const failing = await waitFor("error state", async () => {
      const s = await status()
      return s.register.state === "error" && s
    })
    expect(failing.register.lastError).toContain("401")
    // A 401 is retried, never turned into a new identity this early.
    expect(failing.register.instanceId).toBe(cp.control.instances()[0])

    await cp.control.setMode("up")
    await releaseBackoff()
    await waitFor("recovered", async () => {
      const s = await status()
      return s.register.state === "registered" && acked("bug-report-attachment").length === 4
    })
  })

  it("403 unknown_instance: the control plane forgot us, the server registers again and the waiting report follows", async () => {
    const oldId = cp.control.instances()[0]
    cp.control.forget(oldId)
    await forwardReport("Sent after the control plane forgot this server")
    const s = await waitFor("registered under a new id", async () => {
      const cur = await status()
      return cur.register.state === "registered" && cur.register.instanceId !== oldId && cur
    })
    expect(cp.control.instances()).toEqual([oldId, s.register.instanceId as string])
    await waitFor(
      "report delivered under the new id",
      () => acked("bug-report-attachment").length === 5,
    )
    const last = cp.control
      .acks()
      .filter((a) => a.type === "bug-report")
      .at(-1)
    expect(last?.instanceId).toBe(s.register.instanceId as string)
  })

  it("deregister: switching off sends it and forgets the identity; forwarding goes off with it", async () => {
    const id = (await status()).register.instanceId as string
    const off = await api(url, "/api/admin/liaison-team", {
      token,
      method: "PUT",
      body: { register: false },
    })
    expect(off.status).toBe(200)
    await waitFor("deregister acked", () => acked("deregister").some((a) => a.instanceId === id))
    const s = await waitFor("state off, identity gone", async () => {
      const cur = await status()
      return cur.register.state === "off" && !cur.register.instanceId && cur
    })
    expect(s.forwardBugReports.enabled).toBe(false)
    const fwd = await api(url, "/api/bug-reports/forwarding", { token })
    expect(fwd.body.data.available).toBe(false)
  })

  it("409 already_registered on register: the server takes a new identity and registers", async () => {
    cp.control.queueReplies([
      {
        status: 409,
        body: rejectionReplySchema.parse({ error: { message: REJECTION_CODES.alreadyRegistered } }),
      },
    ])
    const registered = cp.control.instances().length
    const on = await api(url, "/api/admin/liaison-team", {
      token,
      method: "PUT",
      body: { register: true },
    })
    expect(on.status).toBe(200)
    const s = await waitFor("registered after the 409", async () => {
      const cur = await status()
      return cur.register.state === "registered" && cur
    })
    expect(cp.control.instances()).toHaveLength(registered + 1)
    expect(cp.control.instances().at(-1)).toBe(s.register.instanceId as string)
    // The refused attempt is on record at the fake with its 409.
    expect(sentOf("register").some((r) => r.status === 409)).toBe(true)
  })
})
