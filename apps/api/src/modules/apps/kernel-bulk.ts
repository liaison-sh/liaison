// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ApprovalSummary } from "@liaison/shared"
import { eq } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { registerBulkAgentTools } from "~/modules/apps/bulk-agent-tools"
import { deactivateUser, UserAuthorityError } from "~/modules/users/service"

const KERNEL_BULK: Record<string, any> = {
  deactivateUsers: {
    label: "Deactivate users",
    underlyingTool: "deactivateUser",
    dispatchMode: "perItem",
    perItemParam: "userId",
    agentTool: "bulkDeactivateUsers",
    // Admin bulk action: deferred from the hot tool core (discoverable via tool_search).
    deferLoading: true,
  },
}

const KERNEL_BULK_TOOLS: Record<string, any> = {
  deactivateUser: {
    requiredScopes: ["kernel:users:admin"],
    writesToTable: "kernel.users",
    params: { properties: { userId: { type: "string" } } },
  },
}

/** kernel:deactivateUser: who loses access. */
export async function summarizeDeactivateUser(
  params: unknown,
  ctx: { tx: RlsClient },
): Promise<ApprovalSummary> {
  const userId = (params as { userId?: unknown } | null)?.userId
  let who = "(no account named)"
  if (typeof userId === "string") {
    const [u] = await ctx.tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    who = u ? (u.name ? `${u.name} (${u.email})` : u.email) : userId
  }
  return {
    kind: "deactivate_user",
    title: `Deactivate ${who}`,
    lines: [
      "This account can no longer sign in, and its open sessions end.",
      "An admin can reactivate it later; nothing it owns is deleted.",
    ],
  }
}

/**
 * Register kernel-scoped bulk runtime: manifest entries for the kernel "app",
 * and an underlying `deactivateUser` tool that the bulk dispatcher invokes
 * per-item. Idempotent — safe to call multiple times.
 */
export function registerKernelBulkApp(orgId: string): void {
  toolRegistry.set([orgId, "kernel", "deactivateUser"], {
    appName: "kernel",
    name: "deactivateUser",
    deferLoading: true,
    description:
      "Deactivate a user account (admin only). Gated: lands as an approval a person decides.",
    searchKeywords: [
      "désactiver",
      "retirer",
      "départ",
      "disable",
      "utilisateur",
      "collaborateur",
      "remove",
      "deactivate",
      "user",
    ],
    requiredScopes: ["kernel:users:admin"],
    // Who may sign in is a person's decision, as role edits are (kernel:create_role): an agent's
    // call parks for one, whatever the turn read. A person's own click runs at once.
    trustBoundary: "user",
    gated: true,
    approvalImpact: "internal",
    // Sets the target account's status: a kernel.users row.
    writesToTable: "kernel.users",
    params: z.object({ userId: z.string().uuid() }),
    handler: async (params: unknown, ctx: any) => {
      const { userId } = params as { userId: string }
      if (userId === ctx.userId) {
        return { error: { code: "invalid_params", message: "Cannot deactivate own account" } }
      }
      let result: Awaited<ReturnType<typeof deactivateUser>>
      try {
        result = await withPrivilegedDb(ctx.orgId, "kernel-bulk-deactivate", (tx) =>
          deactivateUser(tx, {
            targetId: userId,
            actorId: ctx.userId,
            orgId: ctx.orgId,
            actorScopes: Array.isArray(ctx.scopes) ? (ctx.scopes as string[]) : [],
          }),
        )
      } catch (err) {
        if (err instanceof UserAuthorityError) {
          return { error: { code: "forbidden", message: err.message } }
        }
        throw err
      }
      if (!result) {
        return { error: { code: "not_found", message: "User not found" } }
      }
      return { id: result.id }
    },
  })

  registerApprovalSummarizer(orgId, "kernel", "deactivateUser", summarizeDeactivateUser)

  const existing = manifestRegistry.get([orgId, "kernel"])
  manifestRegistry.set([orgId, "kernel"], {
    ...(existing ?? { name: "kernel", uiBundleUrl: null }),
    name: "kernel",
    bulk: { ...(existing?.bulk ?? {}), ...KERNEL_BULK },
    uiBundleUrl: existing?.uiBundleUrl ?? null,
  })

  registerBulkAgentTools({
    orgId,
    appName: "kernel",
    bulk: KERNEL_BULK,
    tools: KERNEL_BULK_TOOLS,
    vouched: true,
  })
}
