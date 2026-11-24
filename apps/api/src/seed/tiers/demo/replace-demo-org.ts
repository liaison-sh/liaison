// SPDX-License-Identifier: FSL-1.1-ALv2
import { isPublicDemoInstance } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, loadDemoMarker } from "~/modules/demo/demo-org"
import { orgClassOf, protectedOrgReason } from "~/modules/demo/org-class"
import { purgeOrg } from "~/modules/org/purge/purge-org"
import { findOrgIdBySlug } from "~/seed/factories/org/org"

/**
 * Delete the demo org under `slug`, when there is one, so a seed starts it
 * fresh: the way a private box (a walk or QA box) rebuilds a disposable seeded
 * org, where the in-place content reset is the reserved org's alone.
 *
 * Refused for an org that is not of class `demo` with a demo marker, for a
 * customer's or the operator's org (`protectedOrgReason`), all re-checked at
 * the row delete, and on a public demo box (`isPublicDemoInstance`), where demo
 * orgs belong to visitors and the reaper.
 */
export async function replaceSeededDemoOrg(
  slug: string,
  log: (msg: string) => void,
  opts: { who: string; tier: string },
): Promise<boolean> {
  const orgId = await findOrgIdBySlug(slug)
  if (!orgId) return false
  if (isPublicDemoInstance()) {
    throw new Error(
      `${opts.who}: refusing to replace '${slug}' on a public demo box: its demo orgs belong to visitors.`,
    )
  }
  const guard = async (id: string) => {
    await invalidateDemoMarker(id)
    if (
      !(await loadDemoMarker(id)) ||
      (await orgClassOf(id)) !== "demo" ||
      (await protectedOrgReason(id))
    ) {
      throw new Error(
        `${opts.who}: refusing to replace '${slug}': it is not a demo org, and replacing deletes it.`,
      )
    }
  }
  await guard(orgId)
  const { deleted } = await purgeOrg(orgId, {
    reason: `seed-${opts.tier}-replace`,
    assertAllowed: guard,
    settle: false,
    // As the demo reaper does: the marker check above bumps a Redis key of the
    // org that a residue scan would count, and a re-run is the retry.
    verify: false,
    regenerateTriggers: false,
  })
  const rows = Object.values(deleted).reduce((n, v) => n + v, 0)
  log(`${opts.tier}: replaced the earlier org '${slug}' (${rows} rows deleted)`)
  return true
}
