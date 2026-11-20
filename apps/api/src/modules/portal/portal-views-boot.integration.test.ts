// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The portal views over a catalog app's tables live as long as the app's schema:
// made by its registration (also on a schema already current), put back at boot
// when their definition was changed in the database, and never dropped when one
// org lets the app go. At boot only on a schema a registration has applied: on a
// fresh database the tickets schema comes from a migration, without the columns
// its manifest adds, and its view waits for the app's first registration.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { ensureAppPortalViewsAtBoot, ensureInstalledAppPortalViews } from "~/infra/boot-phase10"
import { APP_DDL_STAMP_PREFIX } from "~/modules/apps/ddl-stamp"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import { ensurePortalViews } from "~/modules/portal/views"
import { seedOrgRow } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import invoicingManifest from "../../../../../bundled-apps/invoicing/app.manifest.json"

const orgs = [crypto.randomUUID(), crypto.randomUUID()]

function invoicing() {
  return {
    ...invoicingManifest,
    _format: "manifest" as const,
    _firstParty: true,
    _bundlePath: new URL(
      `../../../../../bundled-apps/.source/invoicing/${invoicingManifest.version}/bundle.js`,
      import.meta.url,
    ).pathname,
  } as unknown as Parameters<typeof registerApps>[0][number]
}

async function viewdef(name: string): Promise<string | null> {
  const [row] = await sql<{ def: string | null }[]>`
    SELECT CASE WHEN to_regclass(${`portal.${name}`}) IS NULL THEN NULL
                ELSE pg_get_viewdef(to_regclass(${`portal.${name}`})) END AS def`
  return row?.def ?? null
}

beforeAll(async () => {
  await acquireTestLock()
  for (const id of orgs) {
    await seedOrgRow({ id, name: "Maison Vues", slug: `portal-views-${id.slice(0, 8)}` })
  }
  const { failedApps } = await registerApps([invoicing()], orgs[0] as string, { skipOrgRows: true })
  expect(failedApps).toEqual([])
}, 180_000)

afterAll(async () => {
  for (const id of orgs) {
    await sql`DELETE FROM kernel.apps WHERE org_id = ${id}`.catch(() => {})
    await sql`DELETE FROM kernel.organizations WHERE id = ${id}`.catch(() => {})
  }
  await releaseTestLock()
})

describe("portal views of a catalog app", () => {
  it("a view whose definition was edited in the database is restored at boot", async () => {
    const original = await viewdef("invoices")
    expect(original).toContain("company_id")
    await sql.unsafe(`CREATE OR REPLACE VIEW portal.invoices WITH (security_barrier = true) AS
      SELECT d.id, d.type, d.number, d.status, d.payment_status, d.currency,
             d.subtotal_minor, d.tax_total_minor, d.grand_total_minor,
             d.issued_at, d.due_at, d.paid_at, d.pdf_file_id, d.original_document_id,
             NULL::text AS label
        FROM app_invoicing.documents d`)
    expect(await viewdef("invoices")).not.toContain("company_id")
    await ensureInstalledAppPortalViews()
    expect(await viewdef("invoices")).toBe(original)
    const [grant] = await sql<{ ok: boolean }[]>`
      SELECT has_table_privilege('liaison_portal', 'portal.invoices', 'SELECT') AS ok`
    expect(grant?.ok).toBe(true)
  })

  it("an org letting invoicing go leaves another org's portal invoices in place", async () => {
    await teardownAppRegistrations(orgs[0] as string, "invoicing")
    expect(await viewdef("invoices")).toContain("company_id")
    expect(await viewdef("billing_upcoming")).not.toBeNull()
  })

  it("a registration on a current schema still creates a missing portal view", async () => {
    await sql.unsafe("DROP VIEW portal.billing_upcoming")
    expect(await viewdef("billing_upcoming")).toBeNull()
    const { failedApps } = await registerApps([invoicing()], orgs[1] as string)
    expect(failedApps).toEqual([])
    expect(await viewdef("billing_upcoming")).toContain("company_id")
  }, 120_000)

  it("on a fresh database the tickets view waits for the column its registration adds", async () => {
    const rollback = new Error("rollback")
    const seen: Record<string, unknown> = {}
    const ticketView = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
      const [row] = extractRows<{ oid: string | null }>(
        await tx.execute(drizzleSql`SELECT to_regclass('portal.ticket_messages')::text AS oid`),
      )
      return row?.oid ?? null
    }
    await db
      .transaction(async (tx) => {
        // The schema as the numbered migrations leave it, before any registration: the
        // message table without the manifest's author columns, and no DDL stamp.
        await tx.execute(drizzleSql.raw("DROP VIEW IF EXISTS portal.ticket_messages"))
        await tx.execute(
          drizzleSql.raw(
            "ALTER TABLE app_tickets.messages DROP COLUMN author_agent_id CASCADE, DROP COLUMN author_label CASCADE",
          ),
        )
        await tx.execute(drizzleSql.raw("COMMENT ON SCHEMA app_tickets IS NULL"))
        // Making the view now fails on the missing column: what boot used to try.
        seen.early = (await ensurePortalViews(tx, "tickets", "compare")).failed
        // Boot leaves it to the registration and logs nothing.
        seen.boot = await ensureAppPortalViewsAtBoot(tx, "tickets")
        seen.viewAfterBoot = await ticketView(tx)
        // The registration adds the columns, then stamps the schema: boot now makes the view.
        await tx.execute(
          drizzleSql.raw(
            "ALTER TABLE app_tickets.messages ADD COLUMN author_label text, ADD COLUMN author_agent_id uuid",
          ),
        )
        await tx.execute(
          drizzleSql.raw(`COMMENT ON SCHEMA app_tickets IS '${APP_DDL_STAMP_PREFIX}test'`),
        )
        const applied = await ensureAppPortalViewsAtBoot(tx, "tickets")
        seen.applied = typeof applied === "string" ? applied : applied.written
        seen.viewAfterApply = (await ticketView(tx)) !== null
        throw rollback
      })
      .catch((err: unknown) => {
        if (err !== rollback) throw err
      })
    expect(seen).toEqual({
      early: ["ticket_messages"],
      boot: "not-applied",
      viewAfterBoot: null,
      applied: ["ticket_messages"],
      viewAfterApply: true,
    })
  })
})
