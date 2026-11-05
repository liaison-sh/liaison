// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NAME A PUSH IS SIGNED WITH: the organisation's own name, so a phone
// signed in to several Liaison servers says which one is talking (the APNs
// subtitle, the FCM title's prefix, sender.ts). Read once per organisation
// and kept for a few minutes: the fanout addresses many devices per event and
// a rename is rare. A failed read costs the label, never the push.
import { eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"

/** How long a name is reused before it is read again. */
export const ORG_LABEL_TTL_MS = 5 * 60_000

export type OrgNameLoader = (orgId: string) => Promise<string | null>

const loadOrgName: OrgNameLoader = (orgId) =>
  withPrivilegedDb(orgId, "push-org-label", async (tx) => {
    const [row] = await tx
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
    return row?.name ?? null
  })

/** A cached reader of organisation names, with its loader and clock injectable. */
export function createOrgLabels(
  load: OrgNameLoader = loadOrgName,
  now: () => number = Date.now,
): (orgId: string) => Promise<string | undefined> {
  const cache = new Map<string, { label: string | undefined; at: number }>()
  return async (orgId) => {
    const hit = cache.get(orgId)
    if (hit && now() - hit.at < ORG_LABEL_TTL_MS) return hit.label
    let label: string | undefined
    try {
      label = (await load(orgId))?.trim() || undefined
    } catch {
      // Not cached: the next push asks again.
      return hit?.label
    }
    cache.set(orgId, { label, at: now() })
    return label
  }
}

/** The process's reader. */
export const orgLabel = createOrgLabels()
