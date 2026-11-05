// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Approve EVERY approval a demo org is seeded with, through the real decide
// path, and require each one to END: either the action ran, or it failed
// definitely, with its reason on the card and the request back at `pending`.
// Never `handler_ambiguous`, never a row parked at `approving`.
//
// A visitor's first move on the demo is pressing Approve on the cards waiting
// for them. A live walk found five of eight failing: a playbook edit naming a
// skill id the seed never wrote, a quote colliding on a document number the
// seed held without advancing the sequence, a refund throwing on a JSON number,
// and a Shopify write, a mail and a ticket reply refused by the demo's own
// egress lockdown, the first two of which then parked as "Stalled" forever
// because the refusal was classified as an unknown outcome.
//
// Run it from `apps/api` (the modules it imports use apps/api's `~/` alias):
//   bun run scripts/test-run.ts demo-seed --file src/seed/tiers/demo/demo-approvals.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { reconcileCatalogApps } from "~/modules/apps/catalog"
import { ensureAppsForOrg, reloadInstalledApps } from "~/modules/apps/init"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { discountsFor } from "~/modules/demo/shopify/overlay"
import { DEMO_WAREHOUSE_DSN_ENV } from "~/modules/demo/warehouse"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { ensureBundledAppBuilt } from "~/tests/helpers/bundled-app-build"
import { DEMO_APPS } from "./demo-apps"
import { type SeedDemoWorldResult, seedDemoWorld } from "./seed-demo"

// A FRESH org every run, as every visitor gets. It also installs its apps into
// this run's own apps dir: an org adopted from an earlier run would carry the
// install rows but none of the files, and its tools would never register.
const ORG_SLUG = `demo-approvals-${Date.now().toString(36)}`
const DB_URL = process.env.DATABASE_URL ?? ""

/**
 * The demo refuses these on purpose: they would reach a real channel. Each must
 * fail DEFINITELY, saying it is a demo. Everything else must run, the Shopify
 * discount included: the demo store answers it from its own overlay, so it
 * never reaches a real store either.
 */
const DEMO_REFUSED = new Set(["social:reply_to_finding"])

/**
 * Mail to the demo world's fictional customers, every recipient on a reserved
 * domain: recorded as delivered without leaving the process
 * (modules/demo/fixture-delivery.ts), so these approvals end approved.
 */
const FIXTURE_DELIVERED = new Set(["mail:compose", "tickets:reply"])

/** The demo's catalog apps: the ones `bundled-apps/` ships as `.liaisonapp` bundles. */
const CATALOG_APPS = DEMO_APPS.filter((name) =>
  ["invoicing", "social", "pennylane", "boxtal", "shopify", "monitoring"].includes(name),
)

/**
 * A first-party catalog from the CURRENT bundled-app sources, so the seed
 * installs the apps as the image would and their gated tools have handlers.
 * Without it the seed finds no catalog and only enables the in-tree apps.
 */
function stageCatalog(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "demo-approvals-catalog-"))
  const repo = path.join(import.meta.dir, "..", "..", "..", "..", "..", "..")
  const entries = CATALOG_APPS.map((name) => {
    const manifest = JSON.parse(
      readFileSync(path.join(repo, "bundled-apps", name, "app.manifest.json"), "utf8"),
    ) as {
      displayName?: string
      version: string
      scopes?: string[]
      connections?: Record<string, unknown>
    }
    const tarball = ensureBundledAppBuilt(name)
    const file = path.basename(tarball)
    copyFileSync(tarball, path.join(dir, file))
    return {
      name,
      displayName: manifest.displayName,
      version: manifest.version,
      file,
      scopes: manifest.scopes ?? [],
      connections: Object.keys(manifest.connections ?? {}),
    }
  })
  writeFileSync(path.join(dir, "catalog.json"), JSON.stringify(entries, null, 2))
  return dir
}

beforeAll(() => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database")
  }
  // A demo instance for the duration: the egress refusals under test only fire
  // on one.
  DemoModeTestAccess.set(true)
  process.env[DEMO_WAREHOUSE_DSN_ENV] ??= DB_URL.replace(
    /\/\/[^@]*@/,
    "//liaison_demo_warehouse_it:it-warehouse-password-0123456789@",
  )
  if (!process.env.MIGRATION_DATABASE_URL) {
    const name = DB_URL.split("/").pop() ?? "liaison_hardening_test"
    process.env.MIGRATION_DATABASE_URL = `postgres://postgres:postgres@localhost:5432/${name}`
  }
  process.env.LIAISON_APP_CATALOG_DIR = stageCatalog()
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "demo-approvals-")),
      "apps",
    )
  }
})

afterAll(() => {
  resetAppRegistries()
  DemoModeTestAccess.set(null)
})

interface PendingRow {
  id: string
  tool_name: string
  handle: string
}

async function rows<T>(orgId: string, query: ReturnType<typeof sql>): Promise<T[]> {
  return withPrivilegedDb(orgId, "demo-approvals-test-read", async (tx) => {
    const result = await tx.execute(query)
    return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[]
  })
}

describe("a demo org's seeded approvals: Approve ends every one", () => {
  let world: SeedDemoWorldResult
  let pending: PendingRow[]
  const outcomes: Record<
    string,
    { tool: string; ok: boolean; code?: string; message?: string; status?: string }
  > = {}

  beforeAll(async () => {
    // `now`, not a fixed date: a pending approval's expiry is measured from the
    // seed's clock, and Approve refuses an expired one.
    world = await seedDemoWorld({
      orgSlug: ORG_SLUG,
      variant: "visitor",
      owner: {
        email: `owner+${ORG_SLUG}@demo-approvals.example`,
        name: "Demo Visitor",
        password: "DemoVisitor1!Seed",
      },
    })
    pending = await rows<PendingRow>(
      world.orgId,
      sql`SELECT id, tool_name, handle FROM kernel.approval_requests
          WHERE org_id = ${world.orgId} AND status = 'pending' ORDER BY handle`,
    )
    const ownerId = world.org.ownerUserId
    if (!ownerId) throw new Error("the visitor org was seeded with no owner")
    // The org's apps registered in THIS process, as a server does at boot, so
    // decide finds each approved tool's handler.
    await ensureAppsForOrg(world.orgId)
    // The catalog apps' install rows are instance wide, so on a database an
    // earlier run used the seed finds them "already installed" while this
    // run's apps dir is empty. The boot reconcile puts each enabled app's
    // bundle back on disk, as a server does; then register them here.
    await reconcileCatalogApps({ fallbackInstalledBy: ownerId })
    await reloadInstalledApps(world.orgId)
    const perms = await withPrivilegedDb(world.orgId, "demo-approvals-test-perms", (tx) =>
      loadEffectivePermissions(tx, ownerId, world.orgId),
    )
    for (const p of pending) {
      try {
        const r = await decideApproval({
          orgId: world.orgId,
          requestId: p.id,
          actor: {
            actorType: "user",
            userId: ownerId,
            orgId: world.orgId,
            scopes: perms.scopes,
            dimensionGrants: perms.dimensionGrants ?? {},
          },
          decision: "approve",
        })
        outcomes[p.handle] = { tool: p.tool_name, ok: true, status: r.status }
      } catch (err) {
        if (!(err instanceof ApprovalDecisionError)) throw err
        // decide's 422 carries `{ code, details }`, the handler's own outcome.
        const inner = (err.details as { details?: { message?: unknown } } | undefined)?.details
        outcomes[p.handle] = {
          tool: p.tool_name,
          ok: false,
          code: err.code,
          message: typeof inner?.message === "string" ? inner.message : JSON.stringify(err.details),
        }
      }
    }
  }, 2_400_000)

  it("seeds the whole world, with the approvals a visitor is meant to decide", () => {
    expect(world.failures).toEqual([])
    const tools = new Set(pending.map((p) => p.tool_name))
    for (const tool of [
      "tickets:reply",
      "invoicing:documents_record_refund",
      "invoicing:quote_create_and_issue",
      "kernel:update_skill",
      "kernel:contacts_merge",
      "shopify:discounts_create",
      "mail:compose",
    ]) {
      expect(tools.has(tool)).toBe(true)
    }
  })

  it("never leaves an approval ambiguous or parked at approving", async () => {
    const ambiguous = Object.entries(outcomes).filter(([, o]) => o.code === "handler_ambiguous")
    expect(ambiguous).toEqual([])
    const parked = await rows<{ handle: string; status: string }>(
      world.orgId,
      sql`SELECT handle, status FROM kernel.approval_requests
          WHERE org_id = ${world.orgId} AND status = 'approving'`,
    )
    expect(parked).toEqual([])
  })

  it("runs every approval the demo does not refuse", () => {
    const failed = Object.entries(outcomes).filter(([, o]) => !o.ok && !DEMO_REFUSED.has(o.tool))
    expect(failed).toEqual([])
    for (const o of Object.values(outcomes)) {
      if (o.ok) expect(o.status).toBe("approved")
    }
  })

  it("creates the seeded discount code in the demo store, where the discounts list shows it", async () => {
    const discount = Object.values(outcomes).find((o) => o.tool === "shopify:discounts_create")
    expect(discount).toMatchObject({ ok: true, status: "approved" })
    expect(discountsFor(world.orgId).map((d) => d.code)).toContain("TEACHING26")
  })

  it("records a send to a fictional customer as delivered", () => {
    const sends = Object.values(outcomes).filter((o) => FIXTURE_DELIVERED.has(o.tool))
    expect(new Set(sends.map((o) => o.tool))).toEqual(FIXTURE_DELIVERED)
    for (const o of sends)
      expect({ tool: o.tool, ok: o.ok, status: o.status }).toEqual({
        tool: o.tool,
        ok: true,
        status: "approved",
      })
  })

  it("fails a demo refusal definitely, saying why, and puts the request back to pending", async () => {
    const refused = Object.entries(outcomes).filter(([, o]) => DEMO_REFUSED.has(o.tool))
    expect(new Set(refused.map(([, o]) => o.tool))).toEqual(DEMO_REFUSED)
    for (const [handle, o] of refused) {
      expect({ handle, ok: o.ok, code: o.code }).toEqual({
        handle,
        ok: false,
        code: "handler_failed",
      })
      expect(o.message ?? "").toMatch(/demo instance/i)
    }
    const statuses = await rows<{ handle: string; status: string }>(
      world.orgId,
      sql`SELECT handle, status FROM kernel.approval_requests
          WHERE org_id = ${world.orgId}
            AND handle IN (${sql.join(
              refused.map(([h]) => sql`${h}`),
              sql`, `,
            )})`,
    )
    for (const s of statuses) expect(s.status).toBe("pending")
  })
})
