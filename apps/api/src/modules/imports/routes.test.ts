// SPDX-License-Identifier: FSL-1.1-ALv2
// Import runs over HTTP (P3a T6): route scopes, a strict body (no server
// paths), the file read under the person's RLS, a run enqueued and executed by
// the `imports-run` job, permissions rebuilt at execute time (R11), undo.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { processImportRunJob, registerImportJobWorker } from "~/modules/imports/job"
import { createImportRun } from "~/modules/imports/runs"
import { saveTransform } from "~/modules/imports/transforms/store"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import * as minimal from "~/seed/tiers/minimal"
import { uploadPrivateImportFile } from "~/tests/helpers/import-files"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let adminId = ""
let memberId = ""
let adminToken = ""

const tag = () => crypto.randomUUID().slice(0, 8)

function ticketLine(ref: string): string {
  return `${JSON.stringify({
    subject: `Imported ${ref}`,
    externalRef: ref,
    messages: [{ kind: "inbound", textBody: "hello" }],
  })}\n`
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api/imports${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json }
}

async function runRow(runId: string) {
  const rows = await sql`SELECT status, counts, errors FROM kernel.import_runs WHERE id = ${runId}`
  return rows[0] as { status: string; counts: Record<string, unknown>; errors: unknown[] }
}

/** Execute the queued run (a test job host may race us to it: wait for final). */
async function execute(runId: string) {
  await processImportRunJob({ orgId, runId })
  for (let i = 0; i < 60; i++) {
    const r = await runRow(runId)
    if (["done", "failed", "cancelled"].includes(r.status)) return r
    await new Promise((res) => setTimeout(res, 500))
  }
  return runRow(runId)
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `imp-routes-${tag()}`, name: "Import Routes Org" })).orgId
  const mk = async (role: "admin" | "member") =>
    (
      await ensureUser({
        orgId,
        email: `${role}-${tag()}@fabrikam.example`,
        name: role,
        password: "pw-import-1!",
        role,
      })
    ).userId
  adminId = await mk("admin")
  memberId = await mk("member")
  await ensureAppsForOrg(orgId)
  await rebuildFilesSelectPolicy()
  registerImportJobWorker()
  adminToken = await minimal.token(adminId)
}, 300_000)
afterAll(releaseTestLock)

describe("/api/imports", () => {
  it("needs the imports scopes", async () => {
    const token = await minimal.token(memberId)
    expect((await call(token, "GET", "")).status).toBe(403)
    expect((await call(token, "GET", "/kinds")).status).toBe(403)
    const post = await call(token, "POST", "", {
      fileId: crypto.randomUUID(),
      kinds: ["tickets.ticket"],
      sourceLabel: "jira",
    })
    expect(post.status).toBe(403)
  })

  it("lists the org's kinds", async () => {
    const r = await call(adminToken, "GET", "/kinds")
    expect(r.status).toBe(200)
    const kinds = (r.json.data as Array<{ kind: string }>).map((k) => k.kind)
    expect(kinds).toContain("tickets.ticket")
    expect(kinds).toContain("contacts.contact")
  })

  it("refuses a server path and an unknown kind", async () => {
    const withPath = await call(adminToken, "POST", "", {
      fileId: crypto.randomUUID(),
      kinds: ["tickets.ticket"],
      sourceLabel: "jira",
      path: "/etc/passwd",
    })
    expect(withPath.status).toBe(400)
    const fileId = await uploadPrivateImportFile(orgId, adminId, ticketLine(`T-${tag()}`))
    const unknown = await call(adminToken, "POST", "", {
      fileId,
      kinds: ["nope.kind"],
      sourceLabel: "jira",
    })
    expect(unknown.status).toBe(400)
  })

  it("refuses another person's private file (A9)", async () => {
    const otherAdmin = (
      await ensureUser({
        orgId,
        email: `other-${tag()}@fabrikam.example`,
        name: "Other",
        password: "pw-import-1!",
        role: "admin",
      })
    ).userId
    const fileId = await uploadPrivateImportFile(orgId, otherAdmin, ticketLine(`T-${tag()}`))
    const r = await call(adminToken, "POST", "", {
      fileId,
      kinds: ["tickets.ticket"],
      sourceLabel: "jira",
    })
    expect(r.status).toBe(404)
  })

  it("queues a run, the job executes it, and undo removes what it created", async () => {
    const ref = `T-${tag()}`
    const fileId = await uploadPrivateImportFile(orgId, adminId, ticketLine(ref))
    const started = await call(adminToken, "POST", "", {
      fileId,
      kinds: ["tickets.ticket"],
      sourceLabel: "jira",
    })
    expect(started.status).toBe(202)
    const runId = String((started.json.data as { id: string }).id)
    expect((started.json.data as { status: string }).status).toBe("queued")
    const done = await execute(runId)
    expect(done.status).toBe("done")
    expect(done.counts["tickets.ticket"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const one = await call(adminToken, "GET", `/${runId}`)
    expect((one.json.data as { status: string }).status).toBe("done")
    const tickets = await sql`
      SELECT id FROM app_tickets.tickets WHERE org_id = ${orgId} AND external_ref = ${`jira:${ref}`}`
    expect(tickets.length).toBe(1)

    const undo = await call(adminToken, "POST", `/${runId}/undo`)
    expect(undo.status).toBe(200)
    expect((undo.json.data as { deleted: number }).deleted).toBeGreaterThan(0)
    const after = await sql`
      SELECT id FROM app_tickets.tickets WHERE org_id = ${orgId} AND external_ref = ${`jira:${ref}`}`
    expect(after.length).toBe(0)
    expect((await runRow(runId)).status).toBe("undone")
    // An undone run cannot be undone again, and the refusal says why.
    const again = await call(adminToken, "POST", `/${runId}/undo`)
    expect(again.status).toBe(409)
    expect(JSON.stringify(again.json)).toContain("already_undone")
  }, 120_000)

  it("imports an ICS file as calendar events (format ics)", async () => {
    const uid = `evt-${tag()}@example.com`
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      "DTSTART:20250304T090000Z",
      "DTEND:20250304T100000Z",
      "SUMMARY:Planning",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n")
    const fileId = await uploadPrivateImportFile(orgId, adminId, ics)
    const started = await call(adminToken, "POST", "", {
      fileId,
      kinds: ["calendar.event"],
      sourceLabel: "ics",
      format: "ics",
    })
    expect(started.status).toBe(202)
    const runId = String((started.json.data as { id: string }).id)
    const done = await execute(runId)
    expect(done.errors).toEqual([])
    expect(done.counts["calendar.event"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const events = await sql`
      SELECT title FROM app_calendar.events WHERE org_id = ${orgId} AND external_ref = ${`ics:${uid}`}`
    expect(events.map((e) => e.title)).toEqual(["Planning"])
    // A format carries its one kind only.
    const wrong = await call(adminToken, "POST", "", {
      fileId,
      kinds: ["tickets.ticket"],
      sourceLabel: "ics",
      format: "ics",
    })
    expect(wrong.status).toBe(400)
  }, 120_000)

  it("rebuilds the person's permissions at execute time: a revoked scope refuses the run", async () => {
    for (const s of ["kernel:imports:run", "kernel:imports:read", "tickets:tickets:write"]) {
      await minimal.grantScope(memberId, s)
    }
    await minimal.grantScope(memberId, "kernel:threads:read")
    const ref = `T-${tag()}`
    const fileId = await uploadPrivateImportFile(orgId, memberId, ticketLine(ref))
    // The run row the route writes for this person, but not enqueued: a POST
    // enqueues at once, and the job worker this file registers can take the
    // run (and import it, the scope still held) before the revoke below lands.
    // The job's payload is the run id only, so the revoke must reach the run
    // from the database, which is what this test proves.
    const run = await createImportRun({
      orgId,
      kinds: ["tickets.ticket"],
      sourceLabel: "jira",
      source: { fileId },
      mode: "api",
      dryRun: false,
      placeholders: false,
      startedBy: memberId,
    })
    const runId = run.id
    await minimal.revokeScope(memberId, "tickets:tickets:write")
    const r = await execute(runId)
    expect(r.status).toBe("failed")
    expect(JSON.stringify(r.errors)).toContain("tickets:tickets:write")
    const rows = await sql`
      SELECT id FROM app_tickets.tickets WHERE org_id = ${orgId} AND external_ref = ${`jira:${ref}`}`
    expect(rows.length).toBe(0)
  }, 120_000)
})

describe("import runs: the list, and the events a progress card follows", () => {
  it("the list hides previews unless asked, and finds the run an approval started", async () => {
    const approvalRequestId = crypto.randomUUID()
    const base = {
      orgId,
      kinds: ["tickets.ticket"],
      sourceLabel: "lst",
      source: {},
      mode: "api" as const,
      placeholders: false,
      startedBy: adminId,
    }
    const preview = await createImportRun({ ...base, dryRun: true })
    const real = await createImportRun({ ...base, dryRun: false, approvalRequestId })
    const ids = (r: { json: Record<string, unknown> }) =>
      (r.json.data as Array<{ id: string }>).map((x) => x.id)
    const plain = await call(adminToken, "GET", "")
    expect(ids(plain)).toContain(real.id)
    expect(ids(plain)).not.toContain(preview.id)
    expect(ids(await call(adminToken, "GET", "?previews=1"))).toContain(preview.id)
    const byApproval = await call(adminToken, "GET", `?approvalRequestId=${approvalRequestId}`)
    expect(ids(byApproval)).toEqual([real.id])
  })

  it("a run's lifecycle queues import_run events that carry its id and status only", async () => {
    const ref = `E-${tag()}`
    const fileId = await uploadPrivateImportFile(orgId, adminId, ticketLine(ref))
    const started = await call(adminToken, "POST", "", {
      fileId,
      kinds: ["tickets.ticket"],
      sourceLabel: "evt",
    })
    const runId = String((started.json.data as { id: string }).id)
    await execute(runId)
    const events = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entity' = 'import_run' AND payload->>'entityId' = ${runId}
      ORDER BY seq`
    const statuses = events.map((e) => (e.payload as { data: { status: string } }).data.status)
    expect(statuses[0]).toBe("queued")
    expect(statuses).toContain("running")
    expect(statuses.at(-1)).toBe("done")
    for (const e of events) {
      expect(Object.keys((e.payload as { data: object }).data).sort()).toEqual(["id", "status"])
    }
  }, 120_000)
})

describe("the Imports view's routes: transforms, preview, start", () => {
  const CODE = `async function transform(batch, ctx) {
  await ctx.emitRecords("tickets.ticket", batch.records.map(function (r) {
    return { subject: r.subject, externalRef: r.ref, messages: [{ kind: "inbound", textBody: r.body }] }
  }))
  return {}
}`

  it("lists transforms, previews one on an uploaded file, and starts it as the caller", async () => {
    const name = `view-${tag()}`
    await withPrivilegedDb(orgId, "t", (tx) =>
      saveTransform(tx, {
        orgId,
        name,
        source: CODE,
        kinds: ["tickets.ticket"],
        sourceType: "upload",
        createdBy: adminId,
      }),
    )
    const list = await call(adminToken, "GET", "/transforms")
    expect(list.status).toBe(200)
    const listed = (
      list.json.data as Array<{ name: string; version: number; sourceType: string }>
    ).find((t) => t.name === name)
    expect(listed).toMatchObject({ version: 1, sourceType: "upload" })

    const ref = `V-${tag()}`
    const fileId = await uploadPrivateImportFile(
      orgId,
      adminId,
      `${JSON.stringify({ ref, subject: "From the view", body: "hello" })}\n`,
    )
    const preview = await call(adminToken, "POST", "/previews", {
      transform: name,
      fileIds: [fileId],
      sourceLabel: "view",
    })
    expect(preview.status).toBe(200)
    const pv = preview.json.data as {
      previewId: string
      counts: Record<string, { created: number }>
    }
    expect(pv.counts["tickets.ticket"]?.created).toBe(1)
    // Nothing written by the preview.
    expect(
      (
        await sql`SELECT id FROM app_tickets.tickets WHERE org_id = ${orgId} AND external_ref = ${`view:${ref}`}`
      ).length,
    ).toBe(0)

    const started = await call(adminToken, "POST", `/previews/${pv.previewId}/start`)
    expect(started.status).toBe(202)
    const runId = (started.json.data as { runId: string }).runId
    const done = await execute(runId)
    expect(done.status).toBe("done")
    expect(
      (
        await sql`SELECT id FROM app_tickets.tickets WHERE org_id = ${orgId} AND external_ref = ${`view:${ref}`}`
      ).length,
    ).toBe(1)
  }, 120_000)

  it("a preview is started only by the person who made it, and only with the run scope", async () => {
    const name = `view2-${tag()}`
    await withPrivilegedDb(orgId, "t", (tx) =>
      saveTransform(tx, {
        orgId,
        name,
        source: CODE,
        kinds: ["tickets.ticket"],
        sourceType: "upload",
        createdBy: adminId,
      }),
    )
    const fileId = await uploadPrivateImportFile(
      orgId,
      adminId,
      `${JSON.stringify({ ref: `W-${tag()}`, subject: "x", body: "y" })}\n`,
    )
    const preview = await call(adminToken, "POST", "/previews", {
      transform: name,
      fileIds: [fileId],
      sourceLabel: "view",
    })
    const previewId = (preview.json.data as { previewId: string }).previewId
    const otherAdmin = (
      await ensureUser({
        orgId,
        email: `other-${tag()}@fabrikam.example`,
        name: "o",
        password: "pw-import-1!",
        role: "admin",
      })
    ).userId
    const other = await call(
      await minimal.token(otherAdmin),
      "POST",
      `/previews/${previewId}/start`,
    )
    expect(other.status).toBe(403)
    const memberToken = await minimal.token(memberId)
    expect(
      (
        await call(memberToken, "POST", "/previews", {
          transform: name,
          fileIds: [fileId],
          sourceLabel: "view",
        })
      ).status,
    ).toBe(403)
    // A preview with a refusal comes back as a 400 naming it.
    const bad = await call(adminToken, "POST", "/previews", {
      transform: "no-such-transform",
      fileIds: [fileId],
      sourceLabel: "view",
    })
    expect(bad.status).toBe(404)
  }, 120_000)
})
