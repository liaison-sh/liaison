// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0190-0192: per-workspace app state (S18, A4, A24-1). `kernel.app_status`
// gains `removed`, `kernel.apps` gains `access_mode`, `kernel.org_app_access`
// holds who may use a restricted app (RLS by org), and every org whose
// `settings.hiddenApps` lists an app has that app turned Off (G-P3-1 default:
// hidden -> disabled) with the key removed. The backfill is replayed from the
// file itself against seeded orgs (it is idempotent and touches only orgs that
// still carry `hiddenApps`).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { type SystemContext, withRlsContext } from "~/db/rls"

const FILE = new URL("./0192_hidden_apps_to_off.sql", import.meta.url).pathname
const ORG_HIDES = randomUUID()
const ORG_PLAIN = randomUUID()
const ROLE_A = randomUUID()

/** True when the statement is refused (postgres.js queries are thenables, not Promises). */
async function fails(query: PromiseLike<unknown>): Promise<boolean> {
  try {
    await query
    return false
  } catch {
    return true
  }
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
    VALUES (${ORG_HIDES}, 'Mig0191 hides', ${`mig0191-h-${ORG_HIDES.slice(0, 8)}`},
            ${JSON.stringify({ hiddenApps: ["invoicing", "social", "kernel", "knowledge", "contacts"], enabledApps: ["invoicing"] })}::jsonb)`
  await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
    VALUES (${ORG_PLAIN}, 'Mig0191 plain', ${`mig0191-p-${ORG_PLAIN.slice(0, 8)}`},
            ${JSON.stringify({ enabledApps: ["invoicing"] })}::jsonb)`
  for (const org of [ORG_HIDES, ORG_PLAIN]) {
    await sql`INSERT INTO kernel.apps (org_id, name, version, status)
      VALUES (${org}, 'invoicing', '1.0.0', 'active'), (${org}, 'mail', '1.0.0', 'active'),
             (${org}, 'knowledge', '1.0.0', 'active')`
  }
  await sql`INSERT INTO kernel.roles (id, org_id, name) VALUES (${ROLE_A}, ${ORG_HIDES}, 'mig0191-role')`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.org_app_access WHERE org_id IN (${ORG_HIDES}, ${ORG_PLAIN})`
  await sql`DELETE FROM kernel.apps WHERE org_id IN (${ORG_HIDES}, ${ORG_PLAIN})`
  await sql`DELETE FROM kernel.roles WHERE org_id IN (${ORG_HIDES}, ${ORG_PLAIN})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_HIDES}, ${ORG_PLAIN})`
})

describe("0190/0191 per-workspace app state", () => {
  it("app_status has the removed value and apps.access_mode defaults to everyone", async () => {
    const labels = await sql<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'kernel' AND t.typname = 'app_status' ORDER BY e.enumsortorder`
    expect(labels.map((l) => l.enumlabel)).toEqual(["active", "disabled", "error", "removed"])
    const [row] = await sql<{ access_mode: string }[]>`
      SELECT access_mode FROM kernel.apps WHERE org_id = ${ORG_PLAIN} AND name = 'mail'`
    expect(row?.access_mode).toBe("everyone")
    expect(
      await fails(
        sql`UPDATE kernel.apps SET access_mode = 'nobody' WHERE org_id = ${ORG_PLAIN} AND name = 'mail'`,
      ),
    ).toBe(true)
  })

  it("backfill: a hidden app becomes disabled, the hiddenApps key goes, others untouched", async () => {
    await sql.unsafe(readFileSync(FILE, "utf8"))
    const rows = await sql<{ org_id: string; name: string; status: string }[]>`
      SELECT org_id, name, status FROM kernel.apps
      WHERE org_id IN (${ORG_HIDES}, ${ORG_PLAIN}) ORDER BY org_id, name`
    const state = Object.fromEntries(rows.map((r) => [`${r.org_id}/${r.name}`, r.status]))
    expect(state[`${ORG_HIDES}/invoicing`]).toBe("disabled")
    expect(state[`${ORG_HIDES}/mail`]).toBe("active")
    // A hidden app without a row yet gets one, Off, so its first registration keeps it Off.
    expect(state[`${ORG_HIDES}/social`]).toBe("disabled")
    expect(state[`${ORG_HIDES}/kernel`]).toBeUndefined()
    // Never-Off apps listed as hidden stay On (no row created, none turned Off).
    expect(state[`${ORG_HIDES}/knowledge`]).toBe("active")
    expect(state[`${ORG_HIDES}/contacts`]).toBeUndefined()
    expect(state[`${ORG_PLAIN}/invoicing`]).toBe("active")
    expect(state[`${ORG_PLAIN}/mail`]).toBe("active")
    const orgs = await sql<{ id: string; settings: Record<string, unknown> }[]>`
      SELECT id, settings FROM kernel.organizations WHERE id IN (${ORG_HIDES}, ${ORG_PLAIN})`
    for (const org of orgs) {
      expect(org.settings).not.toHaveProperty("hiddenApps")
      expect(org.settings.enabledApps).toEqual(["invoicing"])
    }
    // Idempotent: a second run changes nothing.
    await sql.unsafe(readFileSync(FILE, "utf8"))
    const [again] = await sql<{ status: string }[]>`
      SELECT status FROM kernel.apps WHERE org_id = ${ORG_HIDES} AND name = 'invoicing'`
    expect(again?.status).toBe("disabled")
  })

  it("org_app_access is org-scoped under RLS: org B reads none of org A's rows", async () => {
    await sql`INSERT INTO kernel.org_app_access (org_id, app, principal_type, principal_id)
      VALUES (${ORG_HIDES}, 'invoicing', 'role', ${ROLE_A})`
    expect(
      await fails(
        sql`INSERT INTO kernel.org_app_access (org_id, app, principal_type, principal_id)
          VALUES (${ORG_HIDES}, 'invoicing', 'team', ${ROLE_A})`,
      ),
    ).toBe(true)
    const count = async (ctx: SystemContext) =>
      withRlsContext(ctx, async (tx) => {
        const [r] = extractRows<{ n: number }>(
          await tx.execute(
            drizzleSql`SELECT count(*)::int AS n FROM kernel.org_app_access WHERE org_id = ${ORG_HIDES}`,
          ),
        )
        return r?.n ?? -1
      })
    expect(await count({ actorType: "system", orgId: ORG_HIDES, purpose: "job" })).toBe(1)
    expect(await count({ actorType: "system", orgId: ORG_PLAIN, purpose: "job" })).toBe(0)
    const [forced] = await sql<{ relforcerowsecurity: boolean }[]>`
      SELECT relforcerowsecurity FROM pg_class WHERE oid = 'kernel.org_app_access'::regclass`
    expect(forced?.relforcerowsecurity).toBe(true)
  })
})
