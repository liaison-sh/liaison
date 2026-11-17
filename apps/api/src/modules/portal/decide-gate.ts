// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a portal person sees of one client action before they may decide or ask a
// code, read as the portal role: the action is there only when their company's open
// share shows it to them (portal.client_actions), with who it was sent to, and the
// address they signed in with (portal.me). decideClientAction asks this first.
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import {
  type PortalContext,
  PortalContextRefusedError,
  PortalUnavailableError,
  withPortalContext,
} from "~/db/portal-rls"

/** The caller of a portal decision (set by portalAuthMiddleware). */
export type PortalCaller = PortalContext

export type PortalActionSight =
  | { seen: true; invitedEmail: string; invitedName: string; myEmail: string }
  | { seen: false; why: "none" | "refused" | "unavailable" }

export async function portalActionSight(
  portal: PortalCaller,
  actionId: string,
): Promise<PortalActionSight> {
  try {
    const row = await withPortalContext(portal, async (tx) => {
      const [a] = extractRows<{ invited_email: string; invited_name: string; me: string | null }>(
        await tx.execute(sql`
          SELECT a.invited_email, a.invited_name, (SELECT lower(m.email) FROM portal.me m) AS me
            FROM portal.client_actions a WHERE a.id = ${actionId}::uuid`),
      )
      return a ?? null
    })
    if (!row?.me) return { seen: false, why: "none" }
    return {
      seen: true,
      invitedEmail: row.invited_email,
      invitedName: row.invited_name,
      myEmail: row.me,
    }
  } catch (err) {
    if (err instanceof PortalContextRefusedError) return { seen: false, why: "refused" }
    if (err instanceof PortalUnavailableError) return { seen: false, why: "unavailable" }
    throw err
  }
}
