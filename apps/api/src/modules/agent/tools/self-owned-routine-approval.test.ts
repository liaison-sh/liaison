// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A person approves the routine their agent drafted FOR THEM. The approval exists so a human
// confirms what an agent drafted; for a routine that runs as the requester, within the
// requester's own scopes, that human is the requester, so it routes to them alone (owner-routed,
// like any personal resource) even without the org's deciding scope (`kernel:approve`). Another
// member cannot decide it, and a routine that runs as ANOTHER person keeps the org's deciders.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { connectedAccounts, users } from "~/db/schema/kernel"
import * as eventBusModule from "~/infra/events/event-bus"
import { registerConnectionTools } from "~/modules/agent/tools/connection-tools"
import { registerSkillRoutineTools } from "~/modules/agent/tools/skills-routines-tools"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import { resolveApprovalResourceOwner } from "~/modules/approvals/resource-owner"
import { executeTool } from "~/modules/apps/execute-tool"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

async function contextOf(orgId: string, userId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(orgId, "test-self-owned-routine-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants ?? {},
  }
}

describe("routine approvals: a person approves their own routine", () => {
  let orgId: string
  let admin: minimal.Session
  let requesterId: string
  let otherId: string
  let delegatorId: string

  beforeAll(async () => {
    orgId = (await createTestOrg()).id
    admin = await minimal.adminSession(orgId)
    requesterId = (await minimal.person(orgId)).id
    otherId = (await minimal.person(orgId)).id
    delegatorId = (await minimal.person(orgId)).id
    for (const id of [requesterId, otherId, delegatorId]) {
      await minimal.grantScope(id, "kernel:routines:write")
    }
    await minimal.grantScope(delegatorId, "kernel:routines:delegate")
    await registerSkillRoutineTools(orgId)
  })

  afterAll(() => {
    broadcastSpy.mockRestore()
  })

  const propose = async (
    userId: string,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<string> => {
    const actor = await contextOf(orgId, userId)
    const res = await executeTool({
      toolName,
      orgId,
      actor,
      params,
      threadId: await minimal.thread(orgId, userId),
      origin: "in-app-agent",
      stepBundleId: null,
    })
    const id = res.blocked?.approvalRequestId
    if (typeof id !== "string") throw new Error(`not parked: ${JSON.stringify(res)}`)
    return id
  }

  const reminder = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    description: "Reminder to send the invoices",
    kind: "recurring",
    cron: "30 9 * * 1-5",
    timezone: "UTC",
    prompt: "Remind me to send the invoices.",
    scopes: [],
    ...extra,
  })

  const approvalRow = async (id: string) => {
    const [row] = await sql<Array<{ resource_owner_id: string | null; status: string }>>`
      SELECT resource_owner_id::text AS resource_owner_id, status
        FROM kernel.approval_requests WHERE id = ${id}`
    return row
  }

  const routineNamed = async (name: string) =>
    sql<Array<{ id: string; owner_user_id: string }>>`
      SELECT id, owner_user_id::text AS owner_user_id FROM kernel.routines
       WHERE org_id = ${orgId} AND name = ${name}`

  const decide = async (userId: string, id: string, decision: "approve" | "deny" = "approve") =>
    decideApproval({ orgId, requestId: id, actor: await contextOf(orgId, userId), decision })

  it("the requester holds the routine write scope and not the org's deciding scope", async () => {
    const ctx = await contextOf(orgId, requesterId)
    expect(hasScope("kernel:routines:write", ctx.scopes)).toBe(true)
    expect(hasScope("kernel:approve", ctx.scopes)).toBe(false)
    expect(hasScope("kernel:approve", (await contextOf(orgId, otherId)).scopes)).toBe(false)
  })

  it("a self-owned routine is routed to its requester, who approves it", async () => {
    const id = await propose(requesterId, "kernel:create_routine", reminder("own-reminder"))
    expect(await approvalRow(id)).toMatchObject({
      resource_owner_id: requesterId,
      status: "pending",
    })
    await decide(requesterId, id)
    const rows = await routineNamed("own-reminder")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.owner_user_id).toBe(requesterId)
  })

  it("another member without kernel:approve cannot decide it", async () => {
    const id = await propose(requesterId, "kernel:create_routine", reminder("not-yours"))
    const err = await decide(otherId, id).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApprovalDecisionError)
    // Owner-routed: the row is not even visible to them (404), never decidable (403 otherwise).
    expect([403, 404]).toContain((err as ApprovalDecisionError).status)
    expect(await routineNamed("not-yours")).toHaveLength(0)
  })

  it("the requester's own update, run and delete are routed to them too", async () => {
    const created = await propose(requesterId, "kernel:create_routine", reminder("lifecycle"))
    await decide(requesterId, created)
    const routineId = (await routineNamed("lifecycle"))[0]?.id as string
    expect(routineId).toBeDefined()

    const update = await propose(requesterId, "kernel:update_routine", {
      id: routineId,
      prompt: "Remind me to send the invoices and the quotes.",
    })
    expect((await approvalRow(update))?.resource_owner_id).toBe(requesterId)
    await decide(requesterId, update)

    const del = await propose(requesterId, "kernel:delete_routine", { id: routineId })
    expect((await approvalRow(del))?.resource_owner_id).toBe(requesterId)
    // Someone else's routine is never theirs to route: the other member's delete of it is not.
    const foreign = await propose(otherId, "kernel:delete_routine", { id: routineId }).catch(
      () => null,
    )
    if (foreign) expect((await approvalRow(foreign))?.resource_owner_id).toBeNull()
    await decide(requesterId, del)
    expect(await routineNamed("lifecycle")).toHaveLength(0)
  })

  it("scopes beyond the requester's own keep the org's deciders", async () => {
    const id = await propose(
      requesterId,
      "kernel:create_routine",
      reminder("too-wide", { scopes: ["kernel:roles:admin"] }),
    )
    expect((await approvalRow(id))?.resource_owner_id).toBeNull()
  })

  it("a routine that runs as another person routes to delegate or admin deciders", async () => {
    const id = await propose(
      delegatorId,
      "kernel:create_routine",
      reminder("for-a-teammate", { ownerUserId: requesterId }),
    )
    expect((await approvalRow(id))?.resource_owner_id).toBeNull()
    // Neither the delegator nor the run-as person decides it without the deciding scope.
    for (const userId of [delegatorId, requesterId]) {
      const err = await decide(userId, id).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApprovalDecisionError)
    }
    await decide(admin.userId, id)
    const rows = await routineNamed("for-a-teammate")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.owner_user_id).toBe(requesterId)
  })

  describe("other requests a member makes for themselves", () => {
    const ownerOf = (tool: string, params: Record<string, unknown>, by = requesterId) =>
      resolveApprovalResourceOwner(orgId, "kernel", tool, params, by)

    beforeAll(async () => {
      registerConnectionTools(orgId)
    })

    it("hiding an app skill for oneself is theirs; for the org it is the org's", async () => {
      const params = { appName: "tickets", skillName: "triage" }
      expect(await ownerOf("toggle_app_skill", { ...params, scope: "user" })).toBe(requesterId)
      expect(await ownerOf("toggle_app_skill", { ...params, scope: "org" })).toBeNull()
    })

    it("a connect link to one's own address is theirs; to someone else it is not", async () => {
      const email = async (id: string) =>
        (
          await withPrivilegedDb(orgId, "test-email", (tx) =>
            tx.select({ email: users.email }).from(users).where(eq(users.id, id)),
          )
        )[0]?.email as string
      const link = { app: "mail", connection: "gmail" }
      expect(
        await ownerOf("connect_link_send", {
          ...link,
          email: (await email(requesterId)).toUpperCase(),
        }),
      ).toBe(requesterId)
      expect(
        await ownerOf("connect_link_send", { ...link, email: await email(otherId) }),
      ).toBeNull()
    })

    it("disconnecting one's own personal connection is theirs; an org or other one is not", async () => {
      const connect = (identifier: string, ownerType: "user" | "org", ownerId: string | null) =>
        withPrivilegedDb(orgId, "test-connection", async (tx) => {
          const [row] = await tx
            .insert(connectedAccounts)
            .values({
              orgId,
              appName: "mail",
              connectionName: "gmail",
              ownerType,
              ownerId,
              providerType: "oauth2",
              identifier,
              createdBy: ownerId ?? admin.userId,
            })
            .returning({ id: connectedAccounts.id })
          return row?.id as string
        })
      const mine = await connect("mine@example.test", "user", requesterId)
      await connect("theirs@example.test", "user", otherId)
      await connect("team@example.test", "org", null)
      const target = (account: string) => ({ app: "mail", connection: "gmail", account })
      expect(await ownerOf("connection_disconnect", target("mine@example.test"))).toBe(requesterId)
      expect(await ownerOf("connection_disconnect", { ...target("x"), connectionId: mine })).toBe(
        requesterId,
      )
      expect(await ownerOf("connection_disconnect", target("theirs@example.test"))).toBeNull()
      expect(await ownerOf("connection_disconnect", target("team@example.test"))).toBeNull()
    })
  })
})
