// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a portal person sees of one client action before they may decide or ask a
// code, read as the portal role: the action is there only when their company's open
// share shows it to them (portal.client_actions), with who it was sent to, and whether
// that is them (portal.me). decideClientAction asks this first.
import { type SQL, sql } from "drizzle-orm"
import { extractRows } from "~/db"
import {
  type PortalContext,
  PortalContextRefusedError,
  PortalUnavailableError,
  withPortalContext,
} from "~/db/portal-rls"

/** The caller of a portal decision (set by portalAuthMiddleware). */
export type PortalCaller = PortalContext

/**
 * Whether the row `a` of `portal.client_actions` is the signed-in person's: sent to the address
 * they signed in with, and to their name when that address has two signers on the document.
 */
export const MINE: SQL = sql`EXISTS (
    SELECT 1 FROM portal.me me
     WHERE lower(a.invited_email) = lower(me.email)
       AND (lower(a.invited_name) = lower(me.name)
            OR NOT EXISTS (
              SELECT 1 FROM portal.client_actions o
               WHERE o.target_id = a.target_id AND o.revoked_at IS NULL
                 AND lower(o.invited_email) = lower(a.invited_email)
                 AND lower(o.invited_name) <> lower(a.invited_name))))`

export type PortalActionSight =
  | { seen: true; mine: boolean; invitedName: string }
  | { seen: false; why: "none" | "refused" | "unavailable" }

export async function portalActionSight(
  portal: PortalCaller,
  actionId: string,
): Promise<PortalActionSight> {
  try {
    const row = await withPortalContext(portal, async (tx) => {
      const [a] = extractRows<{ invited_name: string; mine: boolean; me: boolean }>(
        await tx.execute(sql`
          SELECT a.invited_name, ${MINE} AS mine,
                 EXISTS (SELECT 1 FROM portal.me) AS me
            FROM portal.client_actions a WHERE a.id = ${actionId}::uuid`),
      )
      return a ?? null
    })
    if (!row?.me) return { seen: false, why: "none" }
    return { seen: true, mine: row.mine === true, invitedName: row.invited_name }
  } catch (err) {
    if (err instanceof PortalContextRefusedError) return { seen: false, why: "refused" }
    if (err instanceof PortalUnavailableError) return { seen: false, why: "unavailable" }
    throw err
  }
}
