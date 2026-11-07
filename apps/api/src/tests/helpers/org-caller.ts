// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Run code the way a request runs it: on an RLS transaction for a member of the
// org (by default an admin, whose grant is `*` on every dimension). Tool
// handlers, admin ops, approval-card summarizers and app bridges run on the
// caller's RLS transaction in production, and take their own short privileged
// transactions for the writes RLS refuses. A test that wraps them in a
// privileged transaction instead makes every one of those nest on the
// privileged pool, a shape production never has.

import type { RlsClient } from "~/db"
import { withRlsContext } from "~/db/rls"
import { UUID_RE } from "~/lib/uuid"

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

export function asOrgMember<T>(
  orgId: string,
  userId: string,
  fn: (tx: RlsClient) => Promise<T>,
  scopes: string[] = ["*"],
): Promise<T> {
  return withRlsContext(
    {
      actorType: "user",
      userId: UUID_RE.test(userId) ? userId : NIL_UUID,
      orgId,
      scopes,
      dimensionGrants: { "*": ["*"] },
    },
    fn,
  )
}
