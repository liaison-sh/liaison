// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Delete my account" (spec S19): a signed-in user erases their own account in
// this organisation. The route (`POST /api/auth/account/delete`) confirms with
// the emailed step-up code only (purpose `account_delete`, step-up.ts); this
// module holds what happens around the erasure itself:
//
//   * the last admin is refused: an organisation left without an active admin
//     cannot manage its users, roles or settings any more,
//   * the approvals the user leaves behind are cancelled with a readable
//     reason (approvals/cancel.ts), in the erasure's own transaction,
//   * the erasure is the GDPR one (erasure/erase-user.ts): shared team content
//     stays, anonymised; the user's private rows, sessions and push tokens go.
//
// Other organisations are untouched: an account is one row per organisation,
// and the erasure acts on this one only.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { cancelApprovalsForDeletedAccount } from "~/modules/approvals/cancel"
import { eraseUser } from "~/modules/erasure/erase-user"

const K = drizzleSql.raw(schemaRef("kernel"))

/** The role that administers an org (default-roles.ts). */
const ADMIN_ROLE = "admin"

export const LAST_ADMIN_MESSAGE =
  "You are the only admin of this organisation, so your account cannot be deleted yet. Make another member an admin in Settings, then delete your account."

export class AccountDeletionError extends Error {
  constructor(
    readonly status: 409 | 500,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Is `userId` the only ACTIVE user of `orgId` holding the admin role? False
 * when the user is not an admin at all.
 */
export async function isLastActiveAdmin(orgId: string, userId: string): Promise<boolean> {
  // No bypass: users, roles and user_roles are readable org wide under RLS, so
  // an org-bound system context counts this org's admins and nobody else's.
  const rows = await withRlsContext({ actorType: "system", orgId, purpose: "job" }, async (tx) =>
    extractRows<{ is_admin: boolean; other_admins: number }>(
      await tx.execute(drizzleSql`
        WITH admins AS (
          SELECT DISTINCT ur.user_id
            FROM ${K}.user_roles ur
            JOIN ${K}.roles r ON r.id = ur.role_id AND r.org_id = ur.org_id
            JOIN ${K}.users u ON u.id = ur.user_id AND u.org_id = ur.org_id
           WHERE ur.org_id = ${orgId}::uuid
             AND r.name = ${ADMIN_ROLE}
             AND u.status = 'active'
        )
        SELECT EXISTS (SELECT 1 FROM admins WHERE user_id = ${userId}::uuid) AS is_admin,
               (SELECT count(*)::int FROM admins WHERE user_id <> ${userId}::uuid) AS other_admins`),
    ),
  )
  const row = rows[0]
  return !!row?.is_admin && row.other_admins === 0
}

/**
 * Erase the caller's account in this org. The step-up confirmation is the
 * route's job and happens before this is called. Throws AccountDeletionError.
 */
export async function deleteOwnAccount(
  orgId: string,
  userId: string,
): Promise<{ approvalsCancelled: number }> {
  if (await isLastActiveAdmin(orgId, userId)) {
    throw new AccountDeletionError(409, LAST_ADMIN_MESSAGE)
  }
  let approvalsCancelled = 0
  const result = await eraseUser(userId, {
    inTransaction: async (tx, ctx) => {
      approvalsCancelled = (await cancelApprovalsForDeletedAccount(tx, ctx.orgId, userId)).length
    },
  })
  if (result.exitCode !== 0) {
    throw new AccountDeletionError(
      500,
      "Your account could not be deleted, and nothing was changed. Try again later.",
    )
  }
  return { approvalsCancelled }
}
