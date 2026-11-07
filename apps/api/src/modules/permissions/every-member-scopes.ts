// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Constants only, no imports: the permission loader, the scope catalog and the
// turn's tool view all read this without pulling each other in.

/**
 * Kernel scopes every ACTIVE member of an org holds, whatever their roles:
 * what any signed-in person may do as themself in the app, with nothing read
 * and only their own name on what is written. They are computed with the
 * apps' manifest `everyMemberScopes` (permissions.ts `everyMemberScopeGrants`),
 * never written as role grants, so no role edit removes them and a member who
 * joins later holds them at once.
 *
 * An agent acting for such a person may use them whatever its ceiling: the
 * person could do the same thing themself through the form, so a ceiling that
 * left one out would only send them to the form (effective-scope.ts
 * `turnToolScopes`). Only add a scope here when that holds.
 *
 * Migration 0261's `kernel.every_member_scope_covers` carries this list for the readers of the
 * grant tables: a change here needs a forward migration (eligible-approvers.test.ts fails without).
 *
 *  - `kernel:bug_reports:file`: report a bug about Liaison itself, the
 *    "Report a bug" dialog's REST route (open to every member) and the agent's
 *    `kernel:report_bug`, filed under the person's own name.
 *  - `kernel:data_subject:export:self`: export everything the organization
 *    holds about yourself as a member (`kernel:data_subject_export` with
 *    `userId` "me"), the access right every person has over their own data.
 *    Any other subject needs its parent, `kernel:data_subject:export`.
 */
export const KERNEL_EVERY_MEMBER_SCOPES: readonly string[] = [
  "kernel:bug_reports:file",
  "kernel:data_subject:export:self",
]
