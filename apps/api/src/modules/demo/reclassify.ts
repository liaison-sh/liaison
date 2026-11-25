// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison demo reclassify`: give the class `demo` to the visitor workspaces the
// PREVIOUS release made while both releases ran (modules/demo/org-class.ts). That
// release creates an org without a class and marks it after; the purge takes no
// org of another class, so those would outlive their expiry. Run once, right
// after a demo instance's switch to this release.
//
// It never blesses a marker it cannot tell from a forged one. An org is taken
// only when every condition holds: demo mode on and not the managed edition;
// class `standard`; created in the window; a marker that parses, of variant
// `visitor`; the slug the product gives a visitor workspace (a random suffix
// nobody picks); no billing row; not created by the control plane; not the
// operator's. The rows are read and changed under their locks, in one
// transaction.
import { demoOrgMarkerSchema } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { isManagedEdition } from "~/lib/edition"
import { rootLogger } from "~/lib/logger"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker } from "~/modules/demo/demo-org"
import { isNamedOperatorOrg, notACustomerOrg } from "~/modules/demo/org-class"

const log = rootLogger.child({ module: "demo-reclassify" })

/** The kernel schema, through the prefix a test lane runs under (db/schema-ref.ts). */
const K = () => drizzleSql.raw(schemaRef("kernel"))

/** The slug `demoOrgSlug` (demo-pool.ts) gives a visitor workspace, as a POSIX regex. */
export const VISITOR_SLUG_SHAPE = "^demo-[a-z0-9-]+-[0-9a-f]{12}$"

export interface ReclassifyWindow {
  since: Date
  until: Date
  /** Only this org (its id). */
  orgId?: string
}

export interface WindowOrg {
  orgId: string
  slug: string
  createdAt: string
  expiresAt: string | null
}

/** Reclassifying is refused on this instance; nothing was read or written. */
export class ReclassifyRefusedError extends Error {}

function assertDemoInstance(): void {
  if (isManagedEdition()) {
    throw new ReclassifyRefusedError("refused in the managed edition: its orgs are customers'")
  }
  if (!isDemoModeEnabled()) {
    throw new ReclassifyRefusedError("refused: demo mode (LIAISON_DEMO_MODE) is off here")
  }
}

async function windowOrgs(
  tx: PrivilegedDb,
  window: ReclassifyWindow,
  lock: boolean,
): Promise<WindowOrg[]> {
  const result = await tx.execute(drizzleSql`
    SELECT o.id, o.slug, o.created_at, o.settings->'demo' AS demo
      FROM ${K()}.organizations o
     WHERE o.class = 'standard'
       AND o.created_at >= ${window.since.toISOString()}::timestamptz
       AND o.created_at <= ${window.until.toISOString()}::timestamptz
       AND o.slug ~ ${VISITOR_SLUG_SHAPE}
       AND o.settings->'demo'->>'variant' = 'visitor'
       ${window.orgId === undefined ? drizzleSql`` : drizzleSql`AND o.id = ${window.orgId}::uuid`}
       AND ${notACustomerOrg()}
     ORDER BY o.created_at, o.id
     ${lock ? drizzleSql`FOR UPDATE OF o` : drizzleSql``}
  `)
  const rows = (
    Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  ) as Array<{ id: string; slug: string; created_at: Date | string; demo: unknown }>
  const out: WindowOrg[] = []
  for (const row of rows) {
    const raw = typeof row.demo === "string" ? JSON.parse(row.demo) : row.demo
    const marker = demoOrgMarkerSchema.safeParse(raw)
    if (!marker.success || marker.data.variant !== "visitor") continue
    if (isNamedOperatorOrg(row.id)) continue
    out.push({
      orgId: row.id,
      slug: row.slug,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: marker.data.expiresAt,
    })
  }
  return out
}

/** The dry run: the orgs `reclassifyWindowOrgs` would change. */
export async function listWindowOrgs(window: ReclassifyWindow): Promise<WindowOrg[]> {
  assertDemoInstance()
  return withSystemDb("demo-reclassify-list", (tx) => windowOrgs(tx, window, false))
}

/** Set the class of exactly the orgs the window lists; returns them. */
export async function reclassifyWindowOrgs(window: ReclassifyWindow): Promise<WindowOrg[]> {
  assertDemoInstance()
  const changed = await withSystemDb("demo-reclassify", async (tx) => {
    const orgs = await windowOrgs(tx, window, true)
    for (const org of orgs) {
      await tx.execute(drizzleSql`
        UPDATE ${K()}.organizations SET class = 'demo'
         WHERE id = ${org.orgId}::uuid AND class = 'standard'`)
    }
    return orgs
  })
  for (const org of changed) await invalidateDemoMarker(org.orgId)
  if (changed.length > 0) log.warn({ orgs: changed }, "demo workspaces reclassified")
  return changed
}
