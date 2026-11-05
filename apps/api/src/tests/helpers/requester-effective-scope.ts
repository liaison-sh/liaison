// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The scope-taint fixture shared by the read-projection tests: one support requester's full
// effective scope, the shape an abnormal turn stamped on its reply (write and action scopes
// included), and the read scopes it projects onto.

/** A support requester's full effective scope, the shape the abnormal turn stamped. */
export const REQUESTER_EFFECTIVE_SCOPE = [
  "boxtal:catalog:read",
  "boxtal:documents:read",
  "boxtal:quotes:read",
  "boxtal:shipments:read",
  "boxtal:shipments:write",
  "kernel:agent:memory:read",
  "kernel:agent:memory:write",
  "kernel:agent:web",
  "kernel:agents:read",
  "kernel:approvals:read",
  "kernel:contacts:read",
  "kernel:contacts:write",
  "kernel:files:analyze",
  "kernel:files:read",
  "kernel:routines:read",
  "kernel:skills:read",
  "kernel:skills:write",
  "kernel:threads:read",
  "kernel:threads:write",
  "kernel:users:read",
  "knowledge:documents:create",
  "knowledge:documents:read",
  "mail:accounts:read",
  "mail:conversations:read",
  "mail:conversations:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "tickets:approve",
  "tickets:categories:read",
  "tickets:inboxes:read",
  "tickets:tickets:close",
  "tickets:tickets:read",
  "tickets:tickets:reply",
  "tickets:tickets:write",
]

/**
 * What that set classifies as (scope-taint.ts, rule 5): every `:read` scope, plus the scopes
 * whose action is not a write or action verb, kept as they are (`kernel:agent:web`,
 * `kernel:files:analyze`). Each write or action scope lands on a read scope already here
 * (`tickets:tickets:close` on `tickets:tickets:read`) or is dropped (`tickets:approve`, whose
 * `tickets:read` sibling is not a catalogued scope). Spelled out, not derived, so it checks the
 * projection rather than repeating it.
 */
export const REQUESTER_TAINT_PROJECTION = [
  "boxtal:catalog:read",
  "boxtal:documents:read",
  "boxtal:quotes:read",
  "boxtal:shipments:read",
  "kernel:agent:memory:read",
  "kernel:agent:web",
  "kernel:agents:read",
  "kernel:approvals:read",
  "kernel:contacts:read",
  "kernel:files:analyze",
  "kernel:files:read",
  "kernel:routines:read",
  "kernel:skills:read",
  "kernel:threads:read",
  "kernel:users:read",
  "knowledge:documents:read",
  "mail:accounts:read",
  "mail:conversations:read",
  "projects:tasks:read",
  "tickets:categories:read",
  "tickets:inboxes:read",
  "tickets:tickets:read",
]
