// SPDX-License-Identifier: FSL-1.1-ALv2
// A support agent's tickets scopes (the tickets manifest's `support` role), for
// the settings scenarios' member: someone who uses Tickets and administers none of it.
import type { WorkerEnv } from "@liaison/test-helpers"
import { assignRoleToUser, seedRoleWithScopes } from "./seed"

export async function grantSupportAgent(env: WorkerEnv, orgId: string, userId: string) {
  const roleId = await seedRoleWithScopes(env, orgId, {
    name: `Support agent ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    scopes: [
      "tickets:tickets:read",
      "tickets:tickets:write",
      "tickets:tickets:reply",
      "tickets:inboxes:read",
      "tickets:categories:read",
    ],
  })
  await assignRoleToUser(env, orgId, roleId, userId)
}
