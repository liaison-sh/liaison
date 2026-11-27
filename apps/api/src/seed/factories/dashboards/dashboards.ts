// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dashboards a seeded org opens with. A spec is checked against the dashboard
// schema before anything is written (a bad spec throws, the org keeps what it
// had), then written as its first version under a deterministic id, so a
// re-seed adopts the row instead of adding one. The sources are not resolved
// here: a seed runs before the org's apps register in a server, and the
// dashboard reads them, as for any dashboard, when someone opens it.
import { withPrivilegedDb } from "~/db/privileged"
import { dashboards, dashboardVersions } from "~/db/schema/kernel"
import { dashboardSpecSchema } from "~/modules/dashboards/spec"
import type { SeedContext } from "~/seed/context"

export interface DashboardSeed {
  /** Stable key: the row's id is derived from it. */
  key: string
  title: string
  ownerUserId: string
  /** "org": every member opens it (as a viewer); "personal": its owner only. */
  visibility: "org" | "personal"
  spec: unknown
}

/** Write each dashboard (and its first version) once; returns the ids, in order. */
export async function seedDashboards(ctx: SeedContext, seeds: DashboardSeed[]): Promise<string[]> {
  const rows = seeds.map((s) => {
    const parsed = dashboardSpecSchema.safeParse(s.spec)
    if (!parsed.success) {
      throw new Error(`seed dashboard '${s.key}': invalid spec: ${parsed.error.message}`)
    }
    return { seed: s, id: ctx.id("dashboard", s.key), spec: parsed.data }
  })
  if (rows.length === 0) return []
  await withPrivilegedDb(ctx.orgId, "seed:dashboards", async (tx) => {
    for (const { seed, id, spec } of rows) {
      const at = ctx.now
      await tx
        .insert(dashboards)
        .values({
          id,
          orgId: ctx.orgId,
          title: seed.title,
          visibility: seed.visibility,
          orgAccess: seed.visibility === "org" ? "viewer" : "none",
          ownerUserId: seed.ownerUserId,
          spec,
          version: 1,
          createdBy: seed.ownerUserId,
          updatedBy: seed.ownerUserId,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing()
      await tx
        .insert(dashboardVersions)
        .values({
          orgId: ctx.orgId,
          dashboardId: id,
          version: 1,
          title: seed.title,
          spec,
          visibility: seed.visibility,
          savedBy: seed.ownerUserId,
          savedAt: at,
        })
        .onConflictDoNothing()
    }
  })
  ctx.log(`dashboards: ${rows.map((r) => r.seed.title).join(", ")}`)
  return rows.map((r) => r.id)
}
