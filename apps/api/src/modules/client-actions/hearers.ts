// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who hears what the person outside did with a client action. Its sender; once they left the
// organization, the person who approved the send; else the people of a restricted document's
// list, or the organization's admins for any other. Nobody who left is named, and a decision is
// never told to nobody while someone active may hear it.

import { sql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"

const K = () => sql.raw(schemaRef("kernel"))

export async function clientActionHearers(
  tx: Pick<PrivilegedDb, "execute">,
  orgId: string,
  actionId: string,
): Promise<string[]> {
  const rows = extractRows<{ id: string; tier: number }>(
    await tx.execute(sql`
      SELECT u.id::text AS id,
             CASE WHEN u.id = a.created_by_user_id THEN 1
                  WHEN u.id = a.approved_by_user_id THEN 2 ELSE 3 END AS tier
        FROM ${K()}.client_actions a
        JOIN ${K()}.users u ON u.org_id = a.org_id AND u.user_type = 'member' AND u.status = 'active'
       WHERE a.id = ${actionId} AND a.org_id = ${orgId}
         AND (u.id = a.created_by_user_id
              OR (u.id = a.approved_by_user_id
                  AND (a.visible_to IS NULL OR u.id = ANY(a.visible_to)))
              OR u.id = ANY(coalesce(a.visible_to, '{}'::uuid[]))
              OR (a.visible_to IS NULL AND EXISTS (
                   SELECT 1 FROM ${K()}.user_roles ur
                     JOIN ${K()}.roles r ON r.id = ur.role_id
                     LEFT JOIN ${K()}.role_scope_grants g ON g.role_id = r.id
                    WHERE ur.user_id = u.id AND ur.org_id = a.org_id
                      AND (r.name = 'admin' OR g.scope IN ('*', 'kernel', 'kernel:*')))))
       ORDER BY tier, u.created_at, u.id
    `),
  )
  const first = rows[0]?.tier
  return rows.filter((r) => r.tier === first).map((r) => r.id)
}
