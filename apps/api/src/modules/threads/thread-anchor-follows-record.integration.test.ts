// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A conversation made from a record follows what happens to the record.
 *
 * Driven through the product's own paths: the record is created by its app's tools, the
 * conversation is created from it as the threads route does, and its anchor is read as the thread
 * page reads it (resolveThreadAnchor under the reader's own row security). A ticket merged into
 * another moves the conversation to the ticket that survives; a task whose app is switched off
 * reads `gone`, so the conversation stops offering a page that is no longer there.
 */
import { describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { disableOrgApp, enableOrgApp } from "~/modules/apps/org-app-admin"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { createThread } from "~/modules/threads/thread"
import { resolveThreadAnchor, threadAnchorRef } from "~/modules/threads/thread-anchor"
import * as minimal from "~/seed/tiers/minimal"

async function ctxOf(orgId: string, userId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(orgId, "anchor-follows-perms", (tx) =>
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

async function org() {
  const { orgId, adminUserId } = await minimal.secondOrg({ name: "Anchor Follows" })
  await ensureAppsForOrg(orgId)
  return { orgId, adminUserId, admin: await ctxOf(orgId, adminUserId) }
}

type Org = Awaited<ReturnType<typeof org>>

async function tool(o: Org, toolName: string, params: Record<string, unknown>) {
  const res = await executeTool({ toolName, orgId: o.orgId, actor: o.admin, params })
  if (res.blocked) throw new Error(`${toolName} refused: ${JSON.stringify(res)}`)
  return res
}

async function conversationFrom(
  o: Org,
  app: string,
  entityType: string,
  entityId: string,
): Promise<string> {
  const created = await withRlsContext(o.admin, (tx) =>
    createThread(
      tx as never,
      {
        orgId: o.orgId,
        userId: o.adminUserId,
        participantIds: [],
        title: `About ${entityType} ${randomUUID().slice(0, 6)}`,
        createdFrom: { app, entityType, entityId },
        forceCreate: true,
      } as never,
    ),
  )
  return (created as { id: string }).id
}

/** The conversation's anchor as its page reads it, for the admin who made it. */
async function anchorOf(o: Org, threadId: string) {
  return withRlsContext(o.admin, async (tx) => {
    const [row] = extractRows<{ created_from: unknown }>(
      await tx.execute(
        drizzleSql`SELECT created_from FROM kernel.threads WHERE id = ${threadId}::uuid`,
      ),
    )
    const ref = threadAnchorRef(row?.created_from, o.orgId)
    return ref ? resolveThreadAnchor(tx as never, o.orgId, ref) : null
  })
}

describe("a conversation made from a record", () => {
  it("moves to the surviving ticket when its ticket is merged into another", async () => {
    const o = await org()
    const one = await tool(o, "tickets:create", { subject: "Anchor ticket", channel: "manual" })
    const two = await tool(o, "tickets:create", { subject: "Surviving ticket", channel: "manual" })
    const gone = (one.data as { ticketId: string }).ticketId
    const survivor = (two.data as { ticketId: string }).ticketId
    const threadId = await conversationFrom(o, "tickets", "ticket", gone)
    expect((await anchorOf(o, threadId))?.entityId).toBe(gone)

    await tool(o, "tickets:merge", { targetTicketId: survivor, sourceTicketIds: [gone] })

    const anchor = await anchorOf(o, threadId)
    expect(anchor?.entityId).toBe(survivor)
    expect(anchor?.label).toContain("Surviving ticket")
  })

  it("reads gone while its task's app is switched off, and openable again once it is back on", async () => {
    const o = await org()
    const created = await tool(o, "projects:createProject", {
      name: `${randomUUID().slice(0, 6)} project`,
      tasks: [{ title: "Anchor task" }],
    })
    const taskId = (created.data as { tasks: Array<{ id: string }> }).tasks[0]?.id ?? ""
    const threadId = await conversationFrom(o, "projects", "task", taskId)
    expect((await anchorOf(o, threadId))?.state).toBeUndefined()

    const actor = { actorId: o.adminUserId, actorType: "user" as const }
    await disableOrgApp(o.orgId, "projects", actor)
    const off = await anchorOf(o, threadId)
    expect(off?.state).toBe("gone")
    expect(off?.entityId).toBe(taskId)

    await enableOrgApp(o.orgId, "projects", actor)
    expect((await anchorOf(o, threadId))?.state).toBeUndefined()
  })
})
