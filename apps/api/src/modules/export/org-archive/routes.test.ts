// SPDX-License-Identifier: FSL-1.1-ALv2
// Whole-org export over HTTP (S3.1, S3.6, A19, A22): `kernel:org:admin` only
// (a users-admin or a member gets 403), one running export per org (409 with
// its id), the list, and a short-lived presigned download refused for an
// expired or failed export.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import { deleteObject } from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import { noteOrgAppsChanged } from "~/modules/apps/org-apps"
import { processTranslationEvent } from "~/modules/attention/translator"
import { processOrgExportJob, registerOrgExportJobWorker } from "~/modules/export/org-archive/job"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const tag = () => crypto.randomUUID().slice(0, 8)
let orgId = ""
let adminId = ""
let adminToken = ""
let memberToken = ""
let usersAdminToken = ""
const keys: string[] = []

async function call(token: string, method: string, path: string) {
  const res = await app.request(`/api/org/export${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, any>
  return { status: res.status, json }
}

beforeAll(async () => {
  await acquireTestLock()
  registerOrgExportJobWorker()
  orgId = (await ensureOrg({ slug: `oexp-rt-${tag()}`, name: "Export Routes Org" })).orgId
  const mk = async (role: "admin" | "member") =>
    (
      await ensureUser({
        orgId,
        email: `${role}-${tag()}@fabrikam.example`,
        name: `${role} person`,
        password: "pw-export-3!",
        role,
      })
    ).userId
  adminId = await mk("admin")
  const memberId = await mk("member")
  const usersAdminId = await mk("member")
  await minimal.grantScope(usersAdminId, "kernel:users:admin")
  adminToken = await minimal.token(adminId)
  memberToken = await minimal.token(memberId)
  usersAdminToken = await minimal.token(usersAdminId)
}, 60_000)

afterAll(async () => {
  for (const k of keys) await deleteObject(k).catch(() => undefined)
  await releaseTestLock()
})

describe("/api/org/export", () => {
  it("refuses a member and a users-admin without kernel:org:admin (403)", async () => {
    for (const token of [memberToken, usersAdminToken]) {
      expect((await call(token, "POST", "")).status).toBe(403)
      expect((await call(token, "GET", "")).status).toBe(403)
      expect((await call(token, "GET", `/${crypto.randomUUID()}/download`)).status).toBe(403)
    }
  })

  it("queues an export, refuses a second one with the running id, lists it", async () => {
    const first = await call(adminToken, "POST", "")
    expect(first.status).toBe(202)
    const id = first.json.data.id as string
    expect(first.json.data.status).toBe("queued")
    const second = await call(adminToken, "POST", "")
    expect(second.status).toBe(409)
    expect(second.json.error.code).toBe("ORG_EXPORT_RUNNING")
    expect(second.json.error.runningId).toBe(id)
    const list = await call(adminToken, "GET", "")
    expect(list.status).toBe(200)
    const item = (list.json.data as Array<Record<string, unknown>>).find((r) => r.id === id)
    // This process hosts the job worker, so the export may already be running.
    expect(["queued", "running", "completed"]).toContain(String(item?.status))
    expect(item?.requestedByName).toBe("admin person")
    expect(JSON.stringify(list.json)).not.toContain("objectKey")
    const audit = await sql`
      SELECT 1 FROM kernel.audit_log
      WHERE org_id = ${orgId} AND entity_id = ${id} AND action = 'org.export.requested'`
    expect(audit.length).toBe(1)

    // Run it: the download is a 5-minute link and stamps downloaded_at.
    // The test process hosts the job worker; a direct run claims it otherwise.
    await processOrgExportJob({ orgId, exportId: id })
    for (let i = 0; i < 120; i++) {
      const [r] = await sql`SELECT status FROM kernel.org_exports WHERE id = ${id}`
      if (r?.status === "completed") break
      await new Promise((res) => setTimeout(res, 250))
    }
    const [done] = await sql`SELECT object_key, run_id FROM kernel.org_exports WHERE id = ${id}`
    const objectKey = String(done?.object_key)
    keys.push(objectKey)
    // One object per run (K3): the key names the run that wrote it.
    expect(objectKey).toBe(`orgs/${orgId}/exports/${id}-${done?.run_id}.zip`)
    // Default delivery (OBJECT_STORAGE_BROWSER_DIRECT off): the store is not
    // browser reachable, so the link is the API's relay, which streams the zip.
    const dl = await call(adminToken, "GET", `/${id}/download`)
    expect(dl.status).toBe(200)
    expect(dl.json.data.expiresInSec).toBe(300)
    expect(dl.json.data.delivery).toBe("relay")
    const relayUrl = new URL(dl.json.data.url as string)
    expect(relayUrl.origin).toBe(new URL(env.BASE_URL).origin)
    expect(relayUrl.pathname).toStartWith("/api/org-export-dl/")
    expect(dl.json.data.url).not.toContain(objectKey)
    // No session needed: the token is the capability.
    const streamed = await app.request(relayUrl.pathname)
    expect(streamed.status).toBe(200)
    expect(streamed.headers.get("content-type")).toBe("application/zip")
    expect(streamed.headers.get("content-disposition")).toContain("attachment")
    const bytes = new Uint8Array(await streamed.arrayBuffer())
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]) // "PK", a zip
    const tampered = await app.request(`${relayUrl.pathname.slice(0, -2)}xx`)
    expect(tampered.status).toBe(401)

    // A browser-reachable store: a 5-minute presigned GET, attachment.
    const saved = env.OBJECT_STORAGE_BROWSER_DIRECT
    ;(env as { OBJECT_STORAGE_BROWSER_DIRECT: boolean }).OBJECT_STORAGE_BROWSER_DIRECT = true
    let direct: Awaited<ReturnType<typeof call>>
    try {
      direct = await call(adminToken, "GET", `/${id}/download`)
    } finally {
      ;(env as { OBJECT_STORAGE_BROWSER_DIRECT: boolean }).OBJECT_STORAGE_BROWSER_DIRECT = saved
    }
    expect(direct.status).toBe(200)
    expect(direct.json.data.delivery).toBe("direct")
    const url = new URL(direct.json.data.url as string)
    expect(url.pathname).toContain(`exports/${id}-`)
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300")
    expect(url.searchParams.get("response-content-disposition")).toContain("attachment")

    // A link minted before the export expired streams nothing after.
    await sql`UPDATE kernel.org_exports SET expires_at = now() - interval '1 second' WHERE id = ${id}`
    expect((await app.request(relayUrl.pathname)).status).toBe(410)
    await sql`UPDATE kernel.org_exports SET expires_at = now() + interval '7 days' WHERE id = ${id}`
    // Mounted outside authMw, the relay still refuses once the org's deletion
    // has started (S2.5): a link minted before the mark streams nothing after.
    await sql`UPDATE kernel.organizations SET deleting_at = now() WHERE id = ${orgId}`
    await noteOrgAppsChanged(orgId)
    try {
      expect((await app.request(relayUrl.pathname)).status).toBe(410)
    } finally {
      await sql`UPDATE kernel.organizations SET deleting_at = NULL WHERE id = ${orgId}`
      await noteOrgAppsChanged(orgId)
    }
    expect((await app.request(relayUrl.pathname)).status).toBe(200)
    const [row] = await sql`SELECT downloaded_at FROM kernel.org_exports WHERE id = ${id}`
    expect(row?.downloaded_at).not.toBeNull()
    const dlAudit = await sql`
      SELECT 1 FROM kernel.audit_log
      WHERE org_id = ${orgId} AND entity_id = ${id} AND action = 'org.export.downloaded'`
    // Each link handed out is audited: the relay one and the direct one.
    expect(dlAudit.length).toBe(2)

    // The requester is told through the attention pipeline (S3.6): the queued
    // outbox event, translated as the outbox drain would.
    const [pending] = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entity' = 'org_export' AND payload->>'entityId' = ${id}`
    expect(pending).toBeDefined()
    const event = pending?.payload as AppEvent
    const data = event.data as { notifyUserId: string; settingsRoute: string }
    expect(data.notifyUserId).toBe(adminId)
    expect(data.settingsRoute).toBe("/settings/admin/org")
    await processTranslationEvent(event)
    const notice = await sql`
      SELECT kind, metadata FROM kernel.attention_events
      WHERE org_id = ${orgId} AND user_id = ${adminId} AND entity_id = ${id}`
    expect(notice.length).toBe(1)
    expect((notice[0]?.metadata as { settingsRoute?: string } | undefined)?.settingsRoute).toBe(
      "/settings/admin/org",
    )
  }, 60_000)

  it("refuses the download of an expired, a failed or an unknown export", async () => {
    const insert = async (status: string) => {
      const [r] = await sql`
        INSERT INTO kernel.org_exports (org_id, status, object_key, requested_by)
        VALUES (${orgId}, ${status}, ${status === "expired" ? null : `orgs/${orgId}/exports/x.zip`}, ${adminId})
        RETURNING id`
      return String(r?.id)
    }
    const expired = await call(adminToken, "GET", `/${await insert("expired")}/download`)
    expect(expired.status).toBe(410)
    expect(expired.json.error.code).toBe("ORG_EXPORT_EXPIRED")
    const failed = await call(adminToken, "GET", `/${await insert("failed")}/download`)
    expect(failed.status).toBe(409)
    expect(failed.json.error.code).toBe("ORG_EXPORT_NOT_READY")
    expect((await call(adminToken, "GET", `/${crypto.randomUUID()}/download`)).status).toBe(404)
    // A completed export past its expiry the sweep has not reached yet.
    const [late] = await sql`
      INSERT INTO kernel.org_exports (org_id, status, object_key, expires_at)
      VALUES (${orgId}, 'completed', ${`orgs/${orgId}/exports/late.zip`}, now() - interval '1 hour')
      RETURNING id`
    expect((await call(adminToken, "GET", `/${late?.id}/download`)).status).toBe(410)
  })

  it("an admin of another org gets 404 for this org's export (K10)", async () => {
    const otherOrg = (await ensureOrg({ slug: `oexp-rt2-${tag()}`, name: "Other Org" })).orgId
    const otherAdmin = (
      await ensureUser({
        orgId: otherOrg,
        email: `admin2-${tag()}@contoso.example`,
        name: "other admin",
        password: "pw-export-4!",
        role: "admin",
      })
    ).userId
    const otherToken = await minimal.token(otherAdmin)
    const [r] = await sql`
      INSERT INTO kernel.org_exports (org_id, status, object_key, requested_by, expires_at)
      VALUES (${orgId}, 'completed', ${`orgs/${orgId}/exports/cross.zip`}, ${adminId},
        now() + interval '1 day')
      RETURNING id`
    // The owner's admin may (the row is downloadable), the other org's may not.
    expect((await call(adminToken, "GET", `/${r?.id}/download`)).status).toBe(200)
    const cross = await call(otherToken, "GET", `/${r?.id}/download`)
    expect(cross.status).toBe(404)
    expect(JSON.stringify(cross.json)).not.toContain("cross.zip")
  }, 30_000)
})
