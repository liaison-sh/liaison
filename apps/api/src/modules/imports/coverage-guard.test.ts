// SPDX-License-Identifier: FSL-1.1-ALv2
// Import coverage guard (S13, R12): every org-scoped table, found on the
// migrated database (kernel and the built-in apps' schemas, tables with an
// `org_id`) and in every manifest `schema` (apps/* and bundled-apps/*), is
// written by an import kind or listed in coverage-registry.ts (exempt with a
// reason, or planned). A new app table that is neither fails here. The kernel
// kinds (kernel-kinds.ts) count as one more manifest.
import { beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import { ensureAppsForOrg } from "~/modules/apps/init"
import {
  appSchemaName,
  type CoverageManifest,
  checkCoverage,
  kernelKindsCoverageManifest,
} from "~/modules/imports/coverage"
import { IMPORT_COVERAGE } from "~/modules/imports/coverage-registry"
import { ensureOrg } from "~/modules/provisioning/ensure-org"

const API_APPS = join(import.meta.dir, "../../apps")
const BUNDLED = join(import.meta.dir, "../../../../../bundled-apps")

function readManifests(dir: string): CoverageManifest[] {
  const out: CoverageManifest[] = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    try {
      out.push(JSON.parse(readFileSync(join(dir, d.name, "app.manifest.json"), "utf8")))
    } catch {
      // not an app directory
    }
  }
  return out
}

// The kernel kinds (agents.*) write kernel tables no app manifest owns.
const manifests = [
  ...readManifests(API_APPS),
  ...readManifests(BUNDLED),
  kernelKindsCoverageManifest(),
]
let dbTables: string[] = []

beforeAll(async () => {
  // Register the built-in apps once so their schemas exist on this database.
  const { orgId } = await ensureOrg({
    slug: `imp-guard-${crypto.randomUUID().slice(0, 8)}`,
    name: "Coverage Guard Org",
  })
  await ensureAppsForOrg(orgId)
  const appSchemas = manifests.map((m) => appSchemaName(m.name))
  const rows = await sql`
    SELECT DISTINCT c.table_schema || '.' || c.table_name AS t
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.column_name = 'org_id' AND t.table_type = 'BASE TABLE'
      AND (c.table_schema = 'kernel' OR c.table_schema = ANY(${appSchemas}))`
  dbTables = rows.map((r) => String(r.t))
}, 300_000)

describe("import coverage guard", () => {
  it("found the tables to check", () => {
    expect(dbTables).toContain("kernel.contacts")
    expect(dbTables).toContain("app_tickets.tickets")
    expect(manifests.some((m) => m.name === "invoicing")).toBe(true)
  })

  it("every org-scoped table is imported, exempt or planned", () => {
    const result = checkCoverage({ tables: dbTables, manifests, registry: IMPORT_COVERAGE })
    expect(result.uncovered).toEqual([])
    expect(result.redundant).toEqual([])
  })

  it("only the mail archive is still planned (every other table has a kind or an exemption)", () => {
    const planned = Object.entries(IMPORT_COVERAGE)
      .filter(([, e]) => "planned" in e)
      .map(([t]) => t)
      .sort()
    expect(planned).toEqual(["app_mail.accounts", "app_mail.conversations", "app_mail.messages"])
  })

  it("hand-entered data with no kind yet is a deferral, listed for the owner", () => {
    const deferred = Object.entries(IMPORT_COVERAGE)
      .filter(([, e]) => "exempt" in e && e.exempt === "deferred")
      .map(([t]) => t)
      .sort()
    expect(deferred).toEqual([
      "app_ads.manual_spend",
      "app_invoicing.product_customs_overlay",
      "app_projects.task_labels",
      "kernel.contact_addresses",
      "kernel.contact_group_members",
    ])
  })

  it("every registry entry names a real table", () => {
    const known = new Set(dbTables)
    for (const m of manifests) {
      for (const t of Object.keys(m.schema ?? {})) known.add(`${appSchemaName(m.name)}.${t}`)
    }
    expect(Object.keys(IMPORT_COVERAGE).filter((t) => !known.has(t))).toEqual([])
  })

  it("discriminator: an app with an undeclared table fails the guard", () => {
    const fixture: CoverageManifest = {
      name: "guardfixture",
      schema: { widgets: { fields: {} }, gadgets: { fields: {} } },
      import: { kinds: { widget: { tables: ["app_guardfixture.widgets"] } } },
    }
    const result = checkCoverage({
      tables: dbTables,
      manifests: [...manifests, fixture],
      registry: IMPORT_COVERAGE,
    })
    expect(result.uncovered).toEqual(["app_guardfixture.gadgets"])
  })
})
