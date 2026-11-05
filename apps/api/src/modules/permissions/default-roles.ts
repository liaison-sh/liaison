// SPDX-License-Identifier: FSL-1.1-ALv2
import type { withSystemDb } from "~/db/privileged"
import { roleScopeGrants, roles } from "~/db/schema/kernel"

type Tx = Parameters<Parameters<typeof withSystemDb>[1]>[0]

/**
 * Default roles every new org ships with. The first registered user is
 * assigned to "admin" (full access); the other roles exist as presets the
 * org admin can apply to invited teammates without designing the permission
 * set from scratch.
 *
 * Scopes referenced here are kernel-only — apps register their scopes after
 * bootstrap, so app-specific scopes (`tickets:*`, `projects:*`) are not
 * granted by default. Admins can add them via the role editor once apps are
 * registered.
 */
export interface DefaultRoleSpec {
  name: string
  description: string
  scopes: string[]
  /** Marks the role intended for the bootstrapping user. Exactly one. */
  isOwner?: boolean
}

export const DEFAULT_ROLES: DefaultRoleSpec[] = [
  {
    name: "admin",
    description: "Full access: administer users, roles, org settings, and every app",
    scopes: ["*"],
    isOwner: true,
  },
  {
    name: "member",
    description: "Standard team member: read and write threads, contacts, and approvals",
    scopes: [
      "kernel:threads:read",
      "kernel:threads:write",
      "kernel:contacts:read",
      "kernel:contacts:write",
      "kernel:products:read",
      "kernel:products:write",
      "kernel:approvals:read",
      "kernel:approvals:write",
      "kernel:files:read",
      // Member-only — the agent-capable role may invoke `analyze_media` (paid
      // Gemini spend). Deliberately NOT granted to `viewer` (read-only must
      // never trigger spend); `owner` is covered by "*".
      "kernel:files:analyze",
      "kernel:saved_views:share",
      // Parent scope grants both REST `:read`/`:write` and the agent-tool
      // gate `kernel:agent:memory` (used by user_memory_get/set/delete).
      // `hasScope` is prefix-hierarchical, so a single parent entry covers
      // every child — adding `:read`+`:write` explicitly would be redundant
      // and would NOT satisfy the parent-only agent-tool gate.
      "kernel:agent:memory",
      // M13 fix — the `spawn_agent` kernel tool is also gated by capability
      // (no `agent.spawn`-declaring app means the tool is suppressed), so
      // granting the scope to members is safe: the cap gate is the real
      // surface guard. Without this scope, a member's chat agent could
      // never reach the tool even when an app installs the capability.
      "kernel:agents:spawn",
    ],
  },
  {
    name: "viewer",
    description: "Read-only: view threads, contacts, approvals, and audit log",
    scopes: [
      "kernel:threads:read",
      "kernel:contacts:read",
      "kernel:products:read",
      "kernel:approvals:read",
      "kernel:files:read",
      "kernel:audit:read",
      // Read-only intent: only the leaf `:read` scope, not the parent. The
      // agent's kernel memory tools (user_memory_set/delete) require the
      // parent and will be denied for viewers — which is the desired
      // viewer semantics.
      "kernel:agent:memory:read",
    ],
  },
]

/** Insert the default roles for a freshly created org. Returns the owner role row. */
export async function seedDefaultRoles(
  tx: Tx,
  orgId: string,
): Promise<{ id: string; name: string }> {
  let owner: { id: string; name: string } | undefined
  for (const spec of DEFAULT_ROLES) {
    const [row] = await tx
      .insert(roles)
      .values({ orgId, name: spec.name, description: spec.description })
      .returning({ id: roles.id, name: roles.name })
    for (const scope of spec.scopes) {
      await tx.insert(roleScopeGrants).values({ roleId: row.id, scope })
    }
    if (spec.isOwner) owner = row
  }
  if (!owner) {
    // Defensive — `DEFAULT_ROLES` is a static constant in this module, so this
    // is a programmer error rather than a runtime condition.
    throw new Error("DEFAULT_ROLES missing an isOwner entry")
  }
  return owner
}
