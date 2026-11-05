// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The plan caps added for the managed edition (S24, A42): custom apps refused
// at the cap under the org lock, and audit retention "as sold" (P3R-16): the
// managed retention is min(admin choice ?? cap, cap), the 90-day settings
// default is not read there, and a self-hosted org keeps its setting.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { _setEdition } from "~/lib/edition"
import { purgeExpiredAuditLog } from "~/modules/org/audit-retention"
import {
  assertCustomAppRoom,
  CapLimitError,
  countCustomApps,
  effectiveAuditRetentionDays,
  OrgCapsTestAccess,
  setOrgCaps,
} from "~/modules/org/caps"
import { seedAuditEntry } from "~/seed/factories/org/rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const DAY_MS = 86_400_000

async function auditRow(orgId: string, ageDays: number): Promise<string> {
  const at = new Date(Date.now() - ageDays * DAY_MS).toISOString()
  return seedAuditEntry({
    orgId,
    timestamp: new Date(at),
    actorType: "system",
    action: "cloud-caps.test",
  })
}

async function surviving(ids: string[]): Promise<Set<string>> {
  const rows = await sql`SELECT id FROM kernel.audit_log WHERE id = ANY(${ids}::uuid[])`
  return new Set(rows.map((r) => r.id as string))
}

async function setSettings(orgId: string, settings: Record<string, unknown>): Promise<void> {
  await sql`UPDATE kernel.organizations SET settings = ${JSON.stringify(settings)}::jsonb WHERE id = ${orgId}`
}

function patchOrg(token: string, settings: Record<string, unknown>) {
  return app.request("/api/org", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ settings }),
  })
}

beforeAll(async () => {
  await acquireTestLock()
  await createTestOrg()
})
afterEach(() => {
  _setEdition(null)
  OrgCapsTestAccess.setCustomAppCounter(null)
})
afterAll(async () => {
  await releaseTestLock()
})

describe("custom apps cap", () => {
  it("counts no custom app until org-private apps exist", async () => {
    const { orgId } = await minimal.secondOrg()
    expect(await withSystemDb("t", (db) => countCustomApps(db, orgId))).toBe(0)
  })

  it("a custom app at the cap is refused with 409 CUSTOM_APP_LIMIT_REACHED and {limit, used}", async () => {
    const { orgId } = await minimal.secondOrg()
    await setOrgCaps(orgId, { set: { customApps: 2 } })
    OrgCapsTestAccess.setCustomAppCounter(async () => 1)
    await withSystemDb("t", (db) => assertCustomAppRoom(db, orgId))
    OrgCapsTestAccess.setCustomAppCounter(async () => 2)
    const err = await withSystemDb("t", (db) => assertCustomAppRoom(db, orgId)).catch((e) => e)
    expect(err).toBeInstanceOf(CapLimitError)
    expect(err.status).toBe(409)
    expect(err.code).toBe("CUSTOM_APP_LIMIT_REACHED")
    expect(err.details).toEqual({ limit: 2, used: 2 })
  })

  it("an org without the cap takes no count", async () => {
    const { orgId } = await minimal.secondOrg()
    let counted = false
    OrgCapsTestAccess.setCustomAppCounter(async () => {
      counted = true
      return 99
    })
    await withSystemDb("t", (db) => assertCustomAppRoom(db, orgId))
    expect(counted).toBe(false)
  })
})

describe("audit retention as sold", () => {
  it("the effective retention: managed min(chosen ?? cap, cap); self-hosted the setting", () => {
    _setEdition("managed")
    expect(effectiveAuditRetentionDays({ auditDays: 365 }, { auditRetentionDays: 90 })).toBe(365)
    expect(
      effectiveAuditRetentionDays(
        { auditDays: 365 },
        { auditRetentionDays: 90, auditRetentionDaysChosen: 60 },
      ),
    ).toBe(60)
    expect(effectiveAuditRetentionDays({ auditDays: 30 }, { auditRetentionDaysChosen: 60 })).toBe(
      30,
    )
    expect(effectiveAuditRetentionDays({}, { auditRetentionDays: 120 })).toBe(120)
    _setEdition("self_hosted")
    expect(effectiveAuditRetentionDays({ auditDays: 30 }, { auditRetentionDays: 120 })).toBe(120)
    expect(effectiveAuditRetentionDays({}, {})).toBe(90)
  })

  it("a Pro org (cap 365) with the 90-day default keeps a 364-day row and purges a 366-day one", async () => {
    _setEdition("managed")
    const { orgId } = await minimal.secondOrg()
    await setSettings(orgId, { fileSizeLimitMb: 50, auditRetentionDays: 90 })
    await setOrgCaps(orgId, { set: { auditDays: 365 } })
    const kept = await auditRow(orgId, 364)
    const gone = await auditRow(orgId, 366)
    await purgeExpiredAuditLog()
    expect(await surviving([kept, gone])).toEqual(new Set([kept]))
  })

  it("an admin choosing 60 keeps 60 days; a plan push down to 30 then keeps 30", async () => {
    _setEdition("managed")
    const { orgId, adminUserId } = await minimal.secondOrg()
    await setOrgCaps(orgId, { set: { auditDays: 365 } })
    const token = await minimal.token(adminUserId)
    const res = await patchOrg(token, { auditRetentionDays: 60 })
    expect(res.status).toBe(200)
    const [org] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${orgId}`
    expect(org.settings.auditRetentionDaysChosen).toBe(60)

    const at59 = await auditRow(orgId, 59)
    const at61 = await auditRow(orgId, 61)
    await purgeExpiredAuditLog()
    expect(await surviving([at59, at61])).toEqual(new Set([at59]))

    await setOrgCaps(orgId, { set: { auditDays: 30 } })
    const at29 = await auditRow(orgId, 29)
    const at31 = await auditRow(orgId, 31)
    await purgeExpiredAuditLog()
    expect(await surviving([at29, at31])).toEqual(new Set([at29]))
  })

  it("the managed PATCH above the cap is refused with the cap code and nothing is written", async () => {
    _setEdition("managed")
    const { orgId, adminUserId } = await minimal.secondOrg()
    await setOrgCaps(orgId, { set: { auditDays: 30 } })
    const token = await minimal.token(adminUserId)
    const res = await patchOrg(token, { auditRetentionDays: 60 })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: unknown } }
    expect(body.error.code).toBe("AUDIT_DAYS_LIMIT_REACHED")
    expect(body.error.details).toEqual({ limit: 30, used: 60 })
    const [org] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${orgId}`
    expect(org.settings.auditRetentionDaysChosen).toBeUndefined()
  })

  it("self-hosted unchanged: an uncapped org keeps its 90-day setting, the PATCH writes the setting", async () => {
    _setEdition("self_hosted")
    const { orgId, adminUserId } = await minimal.secondOrg()
    await setSettings(orgId, { fileSizeLimitMb: 50, auditRetentionDays: 90 })
    const kept = await auditRow(orgId, 89)
    const gone = await auditRow(orgId, 91)
    await purgeExpiredAuditLog()
    expect(await surviving([kept, gone])).toEqual(new Set([kept]))

    const token = await minimal.token(adminUserId)
    const res = await patchOrg(token, { auditRetentionDays: 400 })
    expect(res.status).toBe(200)
    const [org] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${orgId}`
    expect(org.settings.auditRetentionDays).toBe(400)
    expect(org.settings.auditRetentionDaysChosen).toBeUndefined()
  })
})
