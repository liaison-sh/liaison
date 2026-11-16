// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The portal views over a catalog app's tables live as long as the app's schema:
// made by its registration (also on a schema already current), put back at boot
// when their definition was changed in the database, and never dropped when one
// org lets the app go.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { ensureInstalledAppPortalViews } from "~/infra/boot-phase10"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
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
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${id}, 'Maison Vues', ${`portal-views-${id.slice(0, 8)}`})`
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
})
