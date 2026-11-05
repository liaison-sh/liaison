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
 *  - `kernel:bug_reports:file`: report a bug about Liaison itself, the
 *    "Report a bug" dialog's REST route (open to every member) and the agent's
 *    `kernel:report_bug`, filed under the person's own name.
 */
export const KERNEL_EVERY_MEMBER_SCOPES: readonly string[] = ["kernel:bug_reports:file"]
