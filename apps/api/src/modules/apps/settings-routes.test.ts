// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Declarative settings read/write routes (settings-overhaul P2 T3; S10, S17,
 * A19, plan §R1). `GET|PATCH /api/apps/:app/settings/{org|user}`, one field per
 * PATCH (`{ path, value }`), against the `settingsfx` fixture app which
 * declares a field of every source.
 *
 * Discriminators: a member's org write is refused by the API (403) whatever the
 * UI shows; a write sets ONE path and keeps its siblings (deep merge, not the
 * shallow `||` of setOrgAppSettings); a 3-segment path lands on an empty
 * namespace; the user read never writes defaults; a tool-backed field runs the
 * app's tools as the caller, and a parked call answers 202, never "saved".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { app } from "~/app"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  approvalPolicies,
  approvalRequests,
  auditLog,
  organizations,
  users,
} from "~/db/schema/kernel"
import { apps as appsTable } from "~/db/schema/kernel/apps"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { env } from "~/lib/env"
import { settingsFixtureApp } from "~/modules/apps/__fixtures__/settings-app/descriptor"
import { registerApps } from "~/modules/apps/runtime"
import { createSession } from "~/modules/auth/auth"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { invalidateScopeCatalog } from "~/modules/permissions/scope-catalog"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "settingsfx"

async function mintToken(userId: string): Promise<string> {
  const [row] = await withSystemDb("settings-routes-mint", (db) =>
    db
      .select({
        orgId: users.orgId,
        name: users.name,
        authVersion: users.authVersion,
        permissionVersion: users.permissionVersion,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )
  if (!row) throw new Error(`mintToken: user ${userId} missing`)
  const perms = await withPrivilegedDb(row.orgId, "settings-routes-perms", (tx) =>
    loadEffectivePermissions(tx, userId, row.orgId),
  )
  return signAccessToken(
    {
      userId,
      orgId: row.orgId,
      name: row.name,
      authVersion: row.authVersion,
      permissionVersion: row.permissionVersion,
      roles: perms.roles,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    env.JWT_SECRET,
    60 * 60,
  )
}

interface Answer {
  status: number
  body: {
    data?: Record<string, any>
    error?: { message: string; code?: string; field?: string }
  }
}

async function call(
  token: string,
  method: "GET" | "PATCH",
  scope: "org" | "user",
  body?: unknown,
): Promise<Answer> {
  const res = await app.request(`/api/apps/${APP}/settings/${scope}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as Answer["body"] }
}

const patchOrg = (token: string, path: string, value: unknown) =>
  call(token, "PATCH", "org", { path, value })
const patchUser = (token: string, path: string, value: unknown) =>
  call(token, "PATCH", "user", { path, value })

async function orgNamespace(orgId: string): Promise<unknown> {
  const [row] = await withSystemDb("settings-routes-org-ns", (db) =>
    db
      .select({ v: drizzleSql<unknown>`${organizations.settings}->${APP}` })
      .from(organizations)
      .where(eq(organizations.id, orgId)),
  )
  return row?.v ?? null
}

async function userNamespace(userId: string): Promise<{ has: boolean; v: unknown }> {
  const [row] = await withSystemDb("settings-routes-user-ns", (db) =>
    db
      .select({
        has: drizzleSql<boolean>`${users.settings} ? ${APP}`,
        v: drizzleSql<unknown>`${users.settings}->${APP}`,
      })
      .from(users)
      .where(eq(users.id, userId)),
  )
  return { has: row?.has === true, v: row?.v ?? null }
}

describe("declarative settings routes", () => {
  let orgId: string
  let adminId: string
  let adminToken: string
  let memberId: string
  let memberToken: string
  /** Holds the limits section's adminScope only (no tool scope, no kernel:apps:admin). */
  let leadToken: string

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    await registerApps([settingsFixtureApp], orgId)
    invalidateScopeCatalog(orgId)
    adminId = (await minimal.person(orgId, { role: "admin" })).id
    adminToken = await mintToken(adminId)
    // A second admin, so a two-approver policy has a distinct approver.
    await minimal.person(orgId, { role: "admin" })
    memberId = (await minimal.person(orgId, { role: "member" })).id
    memberToken = await mintToken(memberId)
    const lead = await minimal.person(orgId, { role: "member" })
    await minimal.grantScope(lead.id, "settingsfx:limits:admin")
    leadToken = await mintToken(lead.id)
  }, 180_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  describe("org writes: access stays at the data layer (S17)", () => {
    test("a member writing a field of a section with an adminScope is refused", async () => {
      const r = await patchOrg(memberToken, "limits.max", 5)
      expect(r.status).toBe(403)
      expect(r.body.error?.code).toBe("forbidden")
      expect(await orgNamespace(orgId)).toBeNull()
    })

    test("a section without its own adminScope requires kernel:apps:admin", async () => {
      const r = await patchOrg(leadToken, "greeting", "hi")
      expect(r.status).toBe(403)
      const ok = await patchOrg(adminToken, "greeting", "hi")
      expect(ok.status).toBe(200)
    })

    test("an unknown field is refused, not stored", async () => {
      const r = await patchOrg(adminToken, "limits.nope", 1)
      expect(r.status).toBe(404)
      expect(r.body.error?.code).toBe("unknown_field")
    })
  })

  describe("org writes: one path, deep merge", () => {
    test("the section's scope holder writes, and a sibling under the same object is kept", async () => {
      const first = await patchOrg(leadToken, "limits.max", 7)
      expect(first.status).toBe(200)
      expect(first.body.data).toEqual({ path: "limits.max", value: 7 })
      const second = await patchOrg(leadToken, "limits.label", "Seven")
      expect(second.status).toBe(200)
      const ns = (await orgNamespace(orgId)) as Record<string, any>
      expect(ns.limits).toEqual({ max: 7, label: "Seven" })
      const read = await call(leadToken, "GET", "org")
      expect(read.body.data?.values["limits.max"]).toBe(7)
      expect(read.body.data?.values["limits.label"]).toBe("Seven")
    })

    test("a 3-segment path lands on an empty branch and reads back", async () => {
      expect(((await orgNamespace(orgId)) as Record<string, any>).deep).toBeUndefined()
      const r = await patchOrg(leadToken, "deep.level.leaf", "green")
      expect(r.status).toBe(200)
      const ns = (await orgNamespace(orgId)) as Record<string, any>
      expect(ns.deep).toEqual({ level: { leaf: "green" } })
      expect(ns.limits).toEqual({ max: 7, label: "Seven" })
      const read = await call(leadToken, "GET", "org")
      expect(read.body.data?.values["deep.level.leaf"]).toBe("green")
    })

    test("null clears a value", async () => {
      const r = await patchOrg(leadToken, "limits.label", null)
      expect(r.status).toBe(200)
      const ns = (await orgNamespace(orgId)) as Record<string, any>
      expect(ns.limits).toEqual({ max: 7 })
      const read = await call(leadToken, "GET", "org")
      expect(read.body.data?.values["limits.label"]).toBeNull()
    })

    test("each write is recorded as a kernel app_setting event", async () => {
      const rows = await withSystemDb("settings-routes-events", (db) =>
        db.execute(drizzleSql`
          SELECT payload FROM kernel.pending_events
          WHERE org_id = ${orgId} AND payload->>'entity' = 'app_setting'`),
      )
      const payloads = extractRows<{ payload: { app: string; action: string; data: any } }>(
        rows,
      ).map((r) => r.payload)
      const deep = payloads.find((p) => p.data?.path === "deep.level.leaf")
      expect(deep).toBeDefined()
      expect(deep?.app).toBe("kernel")
      expect(deep?.action).toBe("updated")
      expect(deep?.data).toEqual({ app: APP, path: "deep.level.leaf", scope: "org" })
    })
  })

  describe("validation from the manifest (422)", () => {
    test.each([
      ["limits.max", "seven"],
      ["limits.max", 500],
      [
        "hours.weekly",
        {
          mon: [
            ["09:00", "12:00"],
            ["11:00", "13:00"],
          ],
          tue: [],
          wed: [],
          thu: [],
          fri: [],
          sat: [],
          sun: [],
        },
      ],
      [
        "hours.weekly",
        { mon: [["12:00", "09:00"]], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
      ],
      ["hours.holidays", [{ date: "2026-02-30", label: "Not a day" }]],
      ["dashboardUrl", "ftp://example.com"],
    ])("%s = %j is refused with the field named", async (path, value) => {
      const r = await patchOrg(adminToken, path, value)
      expect(r.status).toBe(422)
      expect(r.body.error?.code).toBe("invalid_field")
      expect(r.body.error?.field).toBe(path)
    })

    test("a valid schedule and holiday list are stored", async () => {
      const weekly = {
        mon: [
          ["09:00", "12:00"],
          ["13:00", "17:00"],
        ],
        tue: [],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
        sun: [],
      }
      expect((await patchOrg(adminToken, "hours.weekly", weekly)).status).toBe(200)
      const holidays = [{ date: "2026-12-25", label: "Christmas" }]
      expect((await patchOrg(adminToken, "hours.holidays", holidays)).status).toBe(200)
      const ns = (await orgNamespace(orgId)) as Record<string, any>
      expect(ns.hours).toEqual({ weekly, holidays })
    })
  })

  describe("config-backed field", () => {
    test("the section adminScope, not kernel:apps:admin, decides; the value lands in the app config", async () => {
      const r = await patchOrg(leadToken, "dashboardUrl", "https://dash.example.com")
      expect(r.status).toBe(200)
      const [row] = await withSystemDb("settings-routes-config", (db) =>
        db
          .select({ config: appsTable.config })
          .from(appsTable)
          .where(and(eq(appsTable.orgId, orgId), eq(appsTable.name, APP))),
      )
      expect((row?.config as Record<string, unknown>)?.dashboardUrl).toBe(
        "https://dash.example.com",
      )
      const read = await call(leadToken, "GET", "org")
      expect(read.body.data?.values.dashboardUrl).toBe("https://dash.example.com")
    })

    test("a member's read of the org page omits config and tool fields", async () => {
      const read = await call(memberToken, "GET", "org")
      expect(read.status).toBe(200)
      const values = read.body.data?.values ?? {}
      expect(values["limits.max"]).toBe(7)
      expect("dashboardUrl" in values).toBe(false)
      expect("remote.mode" in values).toBe(false)
    })
  })

  describe("tool-backed field", () => {
    test("reads through the get tool for a holder", async () => {
      const read = await call(adminToken, "GET", "org")
      expect(read.body.data?.values["remote.mode"]).toBe("a")
      expect(read.body.data?.values["remote.gated"]).toBe(false)
    })

    test("runs the set tool as the caller: the section scope alone is not the tool's scope", async () => {
      const r = await patchOrg(leadToken, "remote.mode", "b")
      expect(r.status).toBe(403)
    })

    test("hands the set tool the get tool's object with the one path changed", async () => {
      const r = await patchOrg(adminToken, "remote.mode", "b")
      expect(r.status).toBe(200)
      expect(r.body.data?.path).toBe("remote.mode")
      expect(r.body.data?.value).toBe("b")
      expect(r.body.data?.result).toEqual({
        stored: { remote: { mode: "b", gated: false }, untouched: "kept" },
      })
    })

    // MIG-05: a clear on a tool-backed field must reach the set tool as an explicit null.
    // Dropping the key instead hands the tool an object without the field, which a
    // whole-object setter reads as "keep the stored value": the clear is lost.
    test("a clear hands the set tool the field as null, not an absent key", async () => {
      const r = await patchOrg(adminToken, "remote.mode", null)
      expect(r.status).toBe(200)
      const remote = r.body.data?.result?.stored?.remote as Record<string, unknown>
      expect(remote).toEqual({ mode: null, gated: false })
      expect("mode" in remote).toBe(true)
    })

    test("a value outside the options is refused before any tool runs", async () => {
      const r = await patchOrg(adminToken, "remote.mode", "z")
      expect(r.status).toBe(422)
      expect(r.body.error?.field).toBe("remote.mode")
    })

    // F-P2-2: the route runs the set tool with origin human-ui, so a person's click on a
    // gated tool IS its approval: a single-approver policy still saves directly.
    test("a single-approver policy on the gated set tool still saves from a person's click", async () => {
      await withPrivilegedDb(orgId, "settings-routes-policy-1", (tx) =>
        tx.insert(approvalPolicies).values({
          orgId,
          toolName: `${APP}:remote.setGated`,
          enabled: true,
          conditions: [],
          requireApproval: true,
          minApprovers: 1,
          createdBy: adminId,
        }),
      )
      const r = await patchOrg(adminToken, "remote.gated", true)
      expect(r.status).toBe(200)
      expect(r.body.data?.pending).toBeUndefined()
      // The gated tool ran (the fixture echoes what it was handed).
      expect(r.body.data?.result).toEqual({
        stored: { remote: { mode: "a", gated: true }, untouched: "kept" },
      })
    })

    // Before the two-approver policy below: under the single-approver one, a person's write
    // saved at once just above. The same write from a capped client is no person's click.
    test("a restricted device session's write of a gated tool field parks, it does not save", async () => {
      const restrictedToken = (
        await createSession(adminId, orgId, [`${APP}:remote`, `${APP}:limits:admin`])
      ).accessToken
      const r = await patchOrg(restrictedToken, "remote.gated", true)
      expect(r.status).toBe(202)
      const approvalId = r.body.data?.pending?.approvalRequestId
      expect(typeof approvalId).toBe("string")
      // Withdrawn again: the tests below count this tool's pending approvals.
      await withPrivilegedDb(orgId, "settings-routes-restricted-clear", (tx) =>
        tx.delete(approvalRequests).where(eq(approvalRequests.id, approvalId)),
      )
    })

    test("a set that parks for approval answers 202 pending, not saved", async () => {
      // One policy per tool: the single-approver one above becomes a two-approver one.
      await withPrivilegedDb(orgId, "settings-routes-policy-clear", (tx) =>
        tx
          .delete(approvalPolicies)
          .where(
            and(
              eq(approvalPolicies.orgId, orgId),
              eq(approvalPolicies.toolName, `${APP}:remote.setGated`),
            ),
          ),
      )
      await withPrivilegedDb(orgId, "settings-routes-policy", (tx) =>
        tx.insert(approvalPolicies).values({
          orgId,
          toolName: `${APP}:remote.setGated`,
          enabled: true,
          conditions: [],
          requireApproval: true,
          minApprovers: 2,
          createdBy: adminId,
        }),
      )
      const r = await patchOrg(adminToken, "remote.gated", true)
      expect(r.status).toBe(202)
      expect(typeof r.body.data?.pending?.approvalRequestId).toBe("string")
    })

    test("a second write on a set tool whose approval is pending is refused (409), nothing parks", async () => {
      const before = await pendingFor("remote.setGated")
      expect(before).toHaveLength(1)
      const r = await patchOrg(adminToken, "remote.gated", false)
      expect(r.status).toBe(409)
      expect(r.body.error?.code).toBe("approval_pending")
      expect(r.body.error?.message).toMatch(/waiting for approval/i)
      expect(await pendingFor("remote.setGated")).toHaveLength(1)
    })
  })

  // M1: the fields of one gated whole-object setter save as one unit, so one edit of
  // the section is one tool call and one approval carrying every new value.
  describe("section saved as one unit (one gated whole-object setter)", () => {
    beforeAll(async () => {
      await withPrivilegedDb(orgId, "settings-routes-policy-address", (tx) =>
        tx.insert(approvalPolicies).values({
          orgId,
          toolName: `${APP}:address.setGated`,
          enabled: true,
          conditions: [],
          requireApproval: true,
          minApprovers: 2,
          createdBy: adminId,
        }),
      )
    })

    const address = {
      "address.street": "1 Main St",
      "address.city": "Lyon",
      "address.zip": "69001",
    }

    test("one edit of three fields parks ONE approval holding all three values", async () => {
      const r = await call(adminToken, "PATCH", "org", { values: address })
      expect(r.status).toBe(202)
      expect(typeof r.body.data?.pending?.approvalRequestId).toBe("string")
      const rows = await pendingFor("address.setGated")
      expect(rows).toHaveLength(1)
      expect((rows[0]?.params as { address?: unknown } | undefined)?.address).toEqual({
        street: "1 Main St",
        city: "Lyon",
        zip: "69001",
      })
    })

    test("while it waits, a second save of the section is refused with a clear message", async () => {
      const r = await call(adminToken, "PATCH", "org", {
        values: { ...address, "address.city": "Paris" },
      })
      expect(r.status).toBe(409)
      expect(r.body.error?.code).toBe("approval_pending")
      expect(r.body.error?.message).toMatch(/waiting for approval/i)
      expect(await pendingFor("address.setGated")).toHaveLength(1)
    })

    test("a multi-field write mixing sources or set tools is refused", async () => {
      const r = await call(adminToken, "PATCH", "org", {
        values: { "address.city": "Paris", "remote.mode": "b" },
      })
      expect(r.status).toBe(400)
      expect(r.body.error?.code).toBe("invalid_body")
    })

    test("each value is validated, the field named", async () => {
      const r = await call(adminToken, "PATCH", "org", {
        values: { "address.city": 12 },
      })
      expect(r.status).toBe(422)
      expect(r.body.error?.field).toBe("address.city")
    })
  })

  async function pendingFor(tool: string): Promise<Array<{ params: unknown }>> {
    return withSystemDb("settings-routes-pending", (db) =>
      db
        .select({ params: approvalRequests.toolParams })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.orgId, orgId),
            eq(approvalRequests.toolName, `${APP}:${tool}`),
            eq(approvalRequests.status, "pending"),
          ),
        ),
    )
  }

  describe("user settings", () => {
    test("the read returns declared defaults without writing them", async () => {
      expect((await userNamespace(memberId)).has).toBe(false)
      const read = await call(memberToken, "GET", "user")
      expect(read.status).toBe(200)
      expect(read.body.data?.values["digest.enabled"]).toBe(true)
      expect(read.body.data?.values["signature.text"]).toBeNull()
      expect((await userNamespace(memberId)).has).toBe(false)
    })

    test("writing signature.text keeps signature.html", async () => {
      await withSystemDb("settings-routes-seed-sig", (db) =>
        db.execute(drizzleSql`
          UPDATE kernel.users
          SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), ${`{${APP}}`},
            ${JSON.stringify({ signature: { html: "<p>Kept</p>" } })}::jsonb, true)
          WHERE id = ${memberId}`),
      )
      const r = await patchUser(memberToken, "signature.text", "Best, M")
      expect(r.status).toBe(200)
      expect((await userNamespace(memberId)).v).toEqual({
        signature: { html: "<p>Kept</p>", text: "Best, M" },
      })
      const read = await call(memberToken, "GET", "user")
      expect(read.body.data?.values["signature.text"]).toBe("Best, M")
    })

    test("a user write touches only the caller's own row and is validated", async () => {
      const bad = await patchUser(memberToken, "digest.enabled", "yes")
      expect(bad.status).toBe(422)
      expect(bad.body.error?.field).toBe("digest.enabled")
      const ok = await patchUser(adminToken, "digest.enabled", false)
      expect(ok.status).toBe(200)
      expect((await userNamespace(adminId)).v).toEqual({ digest: { enabled: false } })
      expect(((await userNamespace(memberId)).v as Record<string, unknown>).digest).toBeUndefined()
    })

    test("an org field is not writable through the user route", async () => {
      const r = await patchUser(adminToken, "limits.max", 3)
      expect(r.status).toBe(404)
      expect(r.body.error?.code).toBe("unknown_field")
    })
  })

  // F-P2-3: every settings PATCH leaves exactly one audit row, whatever the field's source.
  describe("audit: one row per write", () => {
    beforeAll(() => {
      resetEventBus()
      initEventBus()
      DurableConsumersTestAccess.reset()
      registerEventSubscribers()
    })
    afterAll(() => {
      resetEventBus()
    })

    async function drainOutbox(): Promise<void> {
      for (let i = 0; i < 10; i++) {
        await processOutboxBatch()
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    async function auditRows(): Promise<Array<{ entityType: string | null; action: string }>> {
      return withSystemDb("settings-routes-audit", (db) =>
        db
          .select({ entityType: auditLog.entityType, action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.orgId, orgId)),
      )
    }

    test.each([
      ["a settings field", "limits.max", 9],
      ["a config field", "dashboardUrl", "https://audit.example.com"],
      ["a tool field", "remote.mode", "a"],
    ])("%s (%s)", async (_kind, path, value) => {
      await drainOutbox()
      const before = (await auditRows()).length
      const r = await patchOrg(path === "limits.max" ? leadToken : adminToken, path, value)
      expect(r.status).toBe(200)
      await drainOutbox()
      const after = await auditRows()
      expect(after.length - before).toBe(1)
    })
  })

  test("an app without a settings page answers 404", async () => {
    const res = await app.request("/api/apps/contacts/settings/org", {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(404)
  })
})
