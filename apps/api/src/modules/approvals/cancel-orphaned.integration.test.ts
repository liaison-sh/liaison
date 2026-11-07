// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A pending request whose target went away closes with a state its asker can read.
 *
 * Driven through the product's own paths: an agent turn proposes deleting a task (the kernel parks
 * it as a pending request for the deciders), then the task is deleted from its page, taken back out
 * of the bin, or its app is switched off. The request is read as Home reads it (the deciders'
 * attention feed) and as its card does (getApproval for the person who asked).
 */
import { describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { deleteTask, restoreTask } from "~/apps/projects/service/tasks"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { TARGET_TASK_DELETED_REASON } from "~/modules/approvals/cancel"
import { getApproval } from "~/modules/approvals/list"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { disableOrgApp } from "~/modules/apps/org-app-admin"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"

async function ctxOf(orgId: string, userId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(orgId, "cancel-orphaned-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
}

function projectName(): string {
  return `${Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("")} project`
}

/** An org of its own, a task, and a pending request by `requester` to delete it. */
async function world() {
  const { orgId, adminUserId } = await minimal.secondOrg({ name: "Orphaned Requests" })
  await ensureAppsForOrg(orgId)
  const admin = await ctxOf(orgId, adminUserId)
  const tag = randomUUID().slice(0, 6)
  const requester = (await minimal.person(orgId, { name: `R${tag} Asker` })).id
  const decider = (await minimal.person(orgId, { name: `D${tag} Decider` })).id
  await minimal.grantScope(decider, "projects:approve")
  for (const s of ["projects:projects:read", "projects:tasks:read", "projects:tasks:write"])
    await minimal.grantScope(requester, s)
  const thread = await minimal.thread(orgId, requester, { title: `Orphaned ${tag}` })
  const created = await executeTool({
    toolName: "projects:createProject",
    orgId,
    actor: admin,
    params: { name: projectName(), tasks: [{ title: `Task ${tag}` }] },
  })
  const taskId = (created.data as { tasks?: Array<{ id: string }> }).tasks?.[0]?.id ?? ""
  if (!taskId) throw new Error(`task not created: ${JSON.stringify(created)}`)
  await executeTool({
    toolName: "projects:delete",
    orgId,
    actor: await ctxOf(orgId, requester),
    threadId: thread,
    params: { taskId },
    origin: "in-app-agent",
  })
  const [row] = (await sql`
    SELECT id FROM kernel.approval_requests
    WHERE org_id = ${orgId} AND tool_name = 'projects:delete' AND status = 'pending'
      AND tool_params->>'taskId' = ${taskId}`) as Array<{ id: string }>
  if (!row) throw new Error("the delete was not parked as a pending request")
  return { orgId, admin, adminUserId, requester, decider, taskId, requestId: row.id }
}

type World = Awaited<ReturnType<typeof world>>

/** The request as its asker's card shows it. */
async function card(w: World) {
  const ctx = await ctxOf(w.orgId, w.requester)
  return withRlsContext(ctx, (tx) =>
    getApproval(tx, { orgId: w.orgId, userId: w.requester, requestId: w.requestId }),
  )
}

/** Whether the decider's Home lists the request. */
async function inHome(w: World): Promise<boolean> {
  const ctx = await ctxOf(w.orgId, w.decider)
  const items = await withRlsContext(ctx, (tx) =>
    computeApprovalAttentionItems(tx, w.orgId, w.decider),
  )
  return items.some((i) => i.entityId === w.requestId)
}

async function reason(w: World): Promise<string | null> {
  const [row] = (await sql`
    SELECT reason FROM kernel.approval_requests WHERE id = ${w.requestId}`) as Array<{
    reason: string | null
  }>
  return row?.reason ?? null
}

describe("a pending request whose target went away", () => {
  it("is cancelled with why once its task is deleted from its page, and leaves Home", async () => {
    const w = await world()
    expect(await inHome(w)).toBe(true)
    await withRlsContext(w.admin, (tx) =>
      deleteTask({ tx, orgId: w.orgId, actor: w.admin, taskId: w.taskId }),
    )
    expect((await card(w))?.status).toBe("cancelled")
    expect(await reason(w)).toBe(TARGET_TASK_DELETED_REASON)
    expect(await inHome(w)).toBe(false)
  })

  it("is pending again, once, when the task is taken back out of the bin", async () => {
    const w = await world()
    const reasonBefore = await reason(w)
    await withRlsContext(w.admin, (tx) =>
      deleteTask({ tx, orgId: w.orgId, actor: w.admin, taskId: w.taskId }),
    )
    expect((await card(w))?.status).toBe("cancelled")
    await withRlsContext(w.admin, (tx) =>
      restoreTask({ tx, orgId: w.orgId, actor: w.admin, taskId: w.taskId }),
    )
    expect((await card(w))?.status).toBe("pending")
    expect(await reason(w)).toBe(reasonBefore)
    expect(await inHome(w)).toBe(true)
    const [{ n }] = (await sql`
      SELECT count(*)::int AS n FROM kernel.approval_requests
      WHERE org_id = ${w.orgId} AND tool_params->>'taskId' = ${w.taskId}`) as Array<{ n: number }>
    expect(n).toBe(1)
  })

  it("is cancelled with why once its app is switched off, leaves Home, and its row stays", async () => {
    const w = await world()
    await disableOrgApp(w.orgId, "projects", { actorId: w.adminUserId, actorType: "user" })
    expect((await card(w))?.status).toBe("cancelled")
    expect(await reason(w)).toContain("projects app was switched off")
    expect(await inHome(w)).toBe(false)
  })
})
