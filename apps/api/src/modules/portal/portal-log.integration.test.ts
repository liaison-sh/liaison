// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The portal access log keeps its own length: 12 months by default, 6 to 36 with a
// stated reason. The ordinary audit purge never removes a portal row; the portal's
// own purge removes only portal rows past the org's length.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { portalSettingsSchema } from "@liaison/shared"
import { app } from "~/app"
import { extractRows, sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { createPortalSession } from "~/modules/auth/auth"
import { buildDataSubjectBundle } from "~/modules/export/data-subject-export-tool"
import { purgeExpiredAuditLog, purgeExpiredPortalLog } from "~/modules/org/audit-retention"
import { PortalAccessError, readPortalAccessLog, setPortalSettings } from "~/modules/portal/access"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
  memberContext,
} from "~/tests/security/portal-doors/fixture"

let w: DoorWorld

/** One audit row of the first org, `days` before the database's now. */
async function row(app: string, days: number): Promise<string> {
  const id = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.audit_log", {
      id,
      org_id: w.orgId,
      actor_type: app === "portal" ? "external" : "user",
      actor_id: app === "portal" ? w.clientA.userId : w.admin.userId,
      app,
      action: app === "portal" ? "portal.sign_in" : "door_probe",
      timestamp: { raw: `now() - interval '${days} days'` },
      metadata: JSON.stringify({ companyId: w.companyA }),
    }),
  )
  return id
}

async function remaining(ids: string[]): Promise<string[]> {
  const list = ids.map((i) => `'${i}'`).join(",")
  return extractRows<{ id: string }>(
    await sql.unsafe(`SELECT id FROM kernel.audit_log WHERE id IN (${list})`),
  )
    .map((r) => r.id)
    .sort()
}

beforeAll(async () => {
  await acquireTestLock()
  w = await createDoorWorld()
})

afterAll(async () => {
  await dropDoorWorld(w)
  await releaseTestLock()
})

describe("what the access log records", () => {
  it("a client's view of their portal writes one row: who, their company, what, the device; never a token", async () => {
    const { accessToken } = await createPortalSession(w.clientA.userId, w.orgId)
    const res = await app.request("/api/portal/home", {
      headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "Maison Browser 1.0" },
    })
    expect(res.status).toBe(200)
    let rows: Array<{ actor_type: string; action: string; metadata: Record<string, unknown> }> = []
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
      rows = extractRows(
        await sql.unsafe(
          `SELECT actor_type::text, action, metadata FROM kernel.audit_log
            WHERE org_id = $1 AND actor_id = $2 AND app = 'portal' AND action = 'portal.view'`,
          [w.orgId, w.clientA.userId],
        ),
      )
    }
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actor_type).toBe("external")
    expect(rows[0]?.metadata).toEqual({
      companyId: w.companyA,
      device: { userAgent: "Maison Browser 1.0" },
    })
    expect(JSON.stringify(rows)).not.toContain(accessToken)
    // Read back through the panel's log with the log scope.
    const log = await withRlsContext(memberContext(w, ["kernel:portal:logs"]), (tx) =>
      readPortalAccessLog({ db: tx, companyId: w.companyA }),
    )
    expect(log.map((r) => r.action)).toContain("portal.view")
    // And in the person's data subject export, with their portal account.
    const bundle = await withRlsContext(memberContext(w, ["*"]), (tx) =>
      buildDataSubjectBundle(w.clientA.contactId, {
        orgId: w.orgId,
        userId: w.admin.userId,
        db: tx,
      }),
    )
    if ("error" in bundle) throw new Error(bundle.error.message)
    expect(bundle.records.portal.account?.userId).toBe(w.clientA.userId)
    expect(bundle.records.portal.accessLog.map((r) => r.action)).toContain("portal.view")
  })
})

describe("the portal access log's length", () => {
  it("the ordinary audit purge keeps portal rows; the portal purge keeps 12 months by default", async () => {
    const portalOld = await row("portal", 400)
    const portalRecent = await row("portal", 100)
    const memberOld = await row("kernel", 100)
    await purgeExpiredAuditLog()
    expect(await remaining([portalOld, portalRecent, memberOld])).toEqual(
      [portalOld, portalRecent].sort(),
    )
    await purgeExpiredPortalLog()
    expect(await remaining([portalOld, portalRecent])).toEqual([portalRecent])
  })

  it("a shorter length stated with a reason applies to the next purge", async () => {
    await setPortalSettings(w.orgId, {
      logRetentionMonths: 6,
      logRetentionReason: "contract clause",
    })
    const kept = await row("portal", 150)
    const gone = await row("portal", 200)
    await purgeExpiredPortalLog()
    expect(await remaining([kept, gone])).toEqual([kept])
  })

  it("another length without a reason, or outside 6 to 36 months, is refused", async () => {
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => (e instanceof PortalAccessError ? e.code : String(e)),
      )
    expect(await code(setPortalSettings(w.orgId, { logRetentionMonths: 24 }))).toBe(
      "PORTAL_SETTINGS_INVALID",
    )
    expect(
      await code(setPortalSettings(w.orgId, { logRetentionMonths: 48, logRetentionReason: "x" })),
    ).toBe("PORTAL_SETTINGS_INVALID")
    expect(await code(setPortalSettings(w.orgId, { logRetentionMonths: 12 }))).toBe("ok")
    expect(
      portalSettingsSchema.safeParse({ logRetentionMonths: 5, logRetentionReason: "x" }).success,
    ).toBe(false)
  })
})
