// SPDX-License-Identifier: FSL-1.1-ALv2
// The calendar app's schema as registration reconciles it from the manifest:
// `sync_status` accepts `imported` (the local "Imported" account an ICS import
// writes), and events carry the import's `external_ref` with its per-calendar
// unique index. Registration runs before any import can write a calendar row
// (an API run registers the org's apps first), so this is the order prod sees.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(async () => {
  await acquireTestLock()
  const { orgId } = await ensureOrg({
    slug: `cal-imp-${crypto.randomUUID().slice(0, 8)}`,
    name: "Calendar Imported Status",
  })
  await ensureAppsForOrg(orgId)
}, 300_000)
afterAll(releaseTestLock)

describe("calendar schema for imports", () => {
  it("the accounts sync_status CHECK accepts imported", async () => {
    const checks = await sql`
      SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app_calendar' AND c.relname = 'accounts' AND k.contype = 'c'
        AND pg_get_constraintdef(k.oid) LIKE '%sync_status%'`
    expect(checks.length).toBeGreaterThan(0)
    for (const c of checks) expect(String(c.def)).toContain("'imported'")
  })

  it("events carry external_ref with a partial unique index per calendar", async () => {
    const [idx] = await sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'app_calendar' AND indexname = 'uniq_app_calendar_events_calendar_id_external_ref'`
    expect(String(idx?.indexdef)).toMatch(
      /\(org_id, calendar_id, external_ref\) WHERE \(external_ref IS NOT NULL\)/,
    )
  })
})
