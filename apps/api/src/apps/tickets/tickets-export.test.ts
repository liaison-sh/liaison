// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { env } from "~/lib/env"
import { validateAppManifest } from "~/modules/apps/contract"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { signAccessToken } from "~/modules/auth/jwt"
import { invokeAppExport } from "~/modules/export/invoke-export"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import ticketsManifest from "./app.manifest.json"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireTestLock()
})

afterAll(async () => {
  await releaseTestLock()
})

beforeEach(async () => {
  orgId = (await createTestOrg()).id
  await ensureAppsForOrg(orgId)
  userId = await withSystemDb("tickets-export-user", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(
        drizzleSql`SELECT id FROM kernel.users WHERE org_id = ${orgId} ORDER BY created_at ASC LIMIT 1`,
      ),
    )
    return rows[0].id
  })
})

async function seedTicket(team: string): Promise<string> {
  const id = crypto.randomUUID()
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await withSystemDb("tickets-export-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, team, sensitivity,
        reply_token, sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
        message_count, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${`ticket-${suffix}`}, ${`Subj ${suffix}`}, 'open', 'normal', 'manual',
        ${team}, 'internal', ${`TK${suffix.replace(/[^A-Za-z0-9]/g, "").slice(0, 14)}`},
        3600, now() + interval '1 hour', now(), 0, 0, now(), now()
      )
    `)
  })
  return id
}

async function seedTicketAt(team: string, createdAtIso: string): Promise<string> {
  const id = crypto.randomUUID()
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 14)
  await withSystemDb("tickets-export-seed-at", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, team, sensitivity,
        reply_token, sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
        message_count, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${`ticket-${suffix}`}, ${`Subj ${suffix}`}, 'open', 'normal', 'manual',
        ${team}, 'internal', ${`TK${suffix}`},
        3600, now() + interval '1 hour', now(), 0, 0, ${createdAtIso}::timestamptz, ${createdAtIso}::timestamptz
      )
    `)
  })
  return id
}

// RLS policies on app_tickets.* read `app.current_dimensions->'tickets:<key>'`
// (the grant key is `<appName>:<dimKey>`), so the actor must carry the
// namespaced dimension keys for the export's db_findMany to see rows.
const adminAllTeams: () => UserContext = () => ({
  actorType: "user",
  userId,
  orgId,
  scopes: ["tickets:tickets:read"],
  dimensionGrants: { "tickets:team": ["*"], "tickets:sensitivity": ["restricted"] },
})

const adminEuOnly: () => UserContext = () => ({
  actorType: "user",
  userId,
  orgId,
  scopes: ["tickets:tickets:read"],
  dimensionGrants: { "tickets:team": ["support-eu"], "tickets:sensitivity": ["restricted"] },
})

describe("tickets export (E1/E3)", () => {
  test("manifest with export slot validates", () => {
    expect(validateAppManifest(ticketsManifest).success).toBe(true)
  })

  test("CSV export contains exactly the tickets the admin can see, with declared columns (E3)", async () => {
    await seedTicket("support-eu")
    await seedTicket("support-eu")
    await seedTicket("support-us")

    const csv = (await invokeAppExport(orgId, "tickets", "csv", adminEuOnly())) as string
    expect(typeof csv).toBe("string")
    const lines = csv.trim().split("\n")
    const header = lines[0]
    const dataRows = lines.slice(1)
    // The EU-only admin sees only the 2 EU tickets, never the US one.
    expect(dataRows).toHaveLength(2)
    const declared = Object.keys(
      (ticketsManifest as { export: { schema: Record<string, string> } }).export.schema,
    )
    expect(header).toBe(declared.join(","))
  })

  test("JSON export round-trips the visible rows", async () => {
    await seedTicket("support-eu")
    await seedTicket("support-us")
    const json = (await invokeAppExport(orgId, "tickets", "json", adminAllTeams())) as unknown
    expect(Array.isArray(json)).toBe(true)
    expect(json as unknown[]).toHaveLength(2)
    for (const row of json as Array<Record<string, unknown>>) {
      expect(typeof row.id).toBe("string")
      expect(typeof row.subject).toBe("string")
    }
  })

  test("empty result yields a valid empty file (header only for CSV, [] for JSON)", async () => {
    const csv = (await invokeAppExport(orgId, "tickets", "csv", adminAllTeams())) as string
    expect(csv.trim().split("\n")).toHaveLength(1) // header only
    const json = (await invokeAppExport(orgId, "tickets", "json", adminAllTeams())) as unknown[]
    expect(json).toEqual([])
  })

  test("date-range filter narrows the export to in-range rows only (E2/E3)", async () => {
    await seedTicketAt("support-eu", "2020-01-01T00:00:00Z") // before range
    const inRange = await seedTicketAt("support-eu", "2026-05-19T12:00:00Z")
    await seedTicketAt("support-eu", "2030-01-01T00:00:00Z") // after range

    const json = (await invokeAppExport(orgId, "tickets", "json", adminAllTeams(), {
      dateRange: { from: "2026-01-01T00:00:00Z", to: "2026-12-31T23:59:59Z" },
    })) as Array<Record<string, unknown>>
    expect(json).toHaveLength(1)
    expect(json[0].id).toBe(inRange)
  })

  test("export is NOT truncated at 1000 rows — full RLS set paginated (E3)", async () => {
    // Bulk-insert 1050 visible tickets in one statement; the bridge caps each
    // db_findMany page at 1000, so a non-paginating handler would silently
    // return 1000 and break |exported| == |visible|.
    await withSystemDb("tickets-export-bulk", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, team, sensitivity,
          reply_token, sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
          message_count, created_at, updated_at
        )
        SELECT gen_random_uuid(), ${orgId},
          'tk-bulk-' || g, 'Subj ' || g, 'open', 'normal', 'manual',
          'support-eu', 'internal', 'TKB' || lpad(g::text, 13, '0'),
          3600, now() + interval '1 hour', now(), 0, 0, now(), now()
        FROM generate_series(1, 1050) AS g
      `)
    })
    const json = (await invokeAppExport(orgId, "tickets", "json", adminAllTeams())) as unknown[]
    expect(json).toHaveLength(1050)
  }, 30_000)

  test("route /api/apps/export/tickets returns the same body as invokeAppExport (regression)", async () => {
    await seedTicket("support-eu")
    await seedTicket("support-us")

    const direct = await invokeAppExport(orgId, "tickets", "json", adminAllTeams())

    const token = await signAccessToken(
      {
        userId,
        orgId,
        name: "Admin",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["tickets:tickets:read", "*"],
        dimensionGrants: { "tickets:team": ["*"], "tickets:sensitivity": ["restricted"] },
      },
      env.JWT_SECRET,
    )
    const res = await app.request("/api/apps/export/tickets?format=json", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-org-id": orgId,
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown }
    expect(body.data).toEqual(direct)
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data as unknown[]).toHaveLength(2)
  })
})
