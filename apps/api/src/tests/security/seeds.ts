// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Security suite seeds (B1-B15, the two-org route sweep, the RLS boundary
 * example): each builds its world on the minimal tier, so people, roles,
 * grants and threads come through the product's own services (invitation and
 * registration, the role editor, the thread service) on a registered org and,
 * where a test needs a second tenant, a provisioned one.
 *
 * Every seed that starts a world calls `createTestOrg`, which truncates the
 * org tables: the consuming file holds the test lock.
 */
import crypto from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { threadParticipants, users } from "~/db/schema/kernel"
import { createSavedView } from "~/modules/saved-views/service"
import { seedContext } from "~/seed/context"
import { seedApprovalRequests } from "~/seed/factories/approvals/requests"
import { actorFor } from "~/seed/factories/people/actors"
import { setUserDimension } from "~/seed/factories/people/user-dimensions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

const ctxOf = (orgId: string) => seedContext({ orgId, now: new Date() })

export interface TwoOrgsFixture {
  orgA: { id: string; secretThreadId: string }
  orgB: { id: string }
  userA: minimal.Person
  userB: minimal.Person
  tokenA: string
  tokenB: string
}

/** A registered org's admin. */
async function registeredOrgAdmin(): Promise<minimal.Person> {
  return minimal.orgAdmin((await createTestOrg()).id)
}

/**
 * Two tenants: org A registered (its admin is userA, who owns a thread titled
 * "secret"), org B provisioned with its own admin (userB). Each admin holds a
 * session token.
 */
export async function seedTwoOrgsWithIsolatedData(): Promise<TwoOrgsFixture> {
  const userA = await registeredOrgAdmin()
  const orgB = await minimal.secondOrg()
  const userB = await minimal.orgAdmin(orgB.orgId)
  const secretThreadId = await minimal.thread(userA.orgId, userA.id, { title: "secret" })
  return {
    orgA: { id: userA.orgId, secretThreadId },
    orgB: { id: orgB.orgId },
    userA,
    userB,
    tokenA: await minimal.token(userA.id),
    tokenB: await minimal.token(userB.id),
  }
}

/**
 * Seed for B2/B3: a member of a second org holding `test:external:read` and
 * the `test:market` values that make exactly `visibleCount` rows of the test
 * app's 10-row `externalSearch` mock visible. The mock returns 4 EU + 3 US +
 * 3 AP rows (handlers.ts), so the supported values map to:
 *   0  -> []           (no rows)
 *   3  -> ["us"]       (3 rows)
 *   4  -> ["eu"]       (4 rows)
 *   6  -> ["us", "ap"] (6 rows)
 *   7  -> ["eu", "ap"] (7 rows)
 *   10 -> ["eu", "us", "ap"]
 * Other values throw.
 */
export async function seedExternalApiMockOver10Rows(visibleCount: number): Promise<{
  mockProvider: { url: string }
  userB: minimal.Person
  tokenB: string
}> {
  const marketsForCount: Record<number, string[]> = {
    0: [],
    3: ["us"],
    4: ["eu"],
    6: ["us", "ap"],
    7: ["eu", "ap"],
    10: ["eu", "us", "ap"],
  }
  const markets = marketsForCount[visibleCount]
  if (!markets) {
    throw new Error(
      `seedExternalApiMockOver10Rows: visibleCount=${visibleCount} is not supported; mock has 4 EU + 3 US + 3 AP rows.`,
    )
  }
  // Org A registered, org B provisioned: the member lives in the second tenant.
  await createTestOrg()
  const { orgId: orgBId, adminUserId: adminBId } = await minimal.secondOrg()
  const userB = await minimal.person(orgBId)
  await minimal.grantScope(userB.id, "test:external:read")
  // `test:market` is the dimension the test app's externalSearch filters on
  // (returns.dimensions), declared on its `externalrecords` table, so the
  // grant goes through the role editor's own per-person service.
  if (markets.length > 0) {
    await setUserDimension(orgBId, {
      adminUserId: adminBId,
      userId: userB.id,
      dimension: "test:market",
      values: markets,
    })
  }
  return {
    mockProvider: { url: "/api/apps/tools/test:externalSearch" },
    userB,
    tokenB: await minimal.token(userB.id),
  }
}

/**
 * Seed for B6: a member holding the test app's `test:items:write` (not
 * `test:approve`) with a thread of their own, and the registered
 * `test:riskyAction` handler wrapped with a counter. `handlerCallCount` is
 * live: a gated tool must never reach the handler without approval.
 */
export async function seedGatedToolFixture(): Promise<{
  gatedTool: { name: string; handlerCallCount: number }
  tokenB: string
  memberId: string
  orgId: string
  threadId: string
  cleanup: () => Promise<void>
}> {
  const orgId = (await createTestOrg()).id
  // Approvals are for agents (execute-tool.ts computeSkipGate): an agent call on
  // this member's behalf always parks, while the member's own REST click runs on
  // the tool's scope. B6 asserts the agent path never reaches the handler.
  const member = await minimal.person(orgId)
  await minimal.grantScope(member.id, "test:items:write")
  // A real thread: a gated call needs one to create its approval request,
  // otherwise the gate refuses before the handler check (a weaker invariant).
  const threadId = await minimal.thread(orgId, member.id, { title: "B6 Gated Thread" })

  const { toolRegistry } = await import("~/modules/apps/app-registries")
  const original = toolRegistry.get([orgId, "test", "riskyAction"])
  if (!original) throw new Error("seedGatedToolFixture: test:riskyAction not in toolRegistry")
  const gatedTool = { name: "test:riskyAction", handlerCallCount: 0 }
  const wrappedHandler = (async (params: unknown, ctx: unknown) => {
    gatedTool.handlerCallCount++
    return (original as { handler: (p: unknown, c: unknown) => Promise<unknown> }).handler(
      params,
      ctx,
    )
  }) as typeof original.handler
  toolRegistry.set([orgId, "test", "riskyAction"], { ...original, handler: wrappedHandler })

  return {
    gatedTool,
    tokenB: await minimal.token(member.id),
    memberId: member.id,
    orgId,
    threadId,
    cleanup: async () => {
      toolRegistry.set([orgId, "test", "riskyAction"], original)
    },
  }
}

/**
 * Seed for B15: `count` synthetic item ids and the registered org's admin
 * with a token (B15 drives the bulk dispatcher directly).
 */
export async function seedBulkGatedItems(
  count: number,
): Promise<{ itemIds: string[]; tokenB: string; orgId: string; userId: string }> {
  const admin = await registeredOrgAdmin()
  const itemIds = Array.from({ length: count }, () => crypto.randomUUID())
  return { itemIds, tokenB: await minimal.token(admin.id), orgId: admin.orgId, userId: admin.id }
}

/**
 * Seed for B8: a file on a thread the admin is in, and `revokeAccess`, which
 * takes the admin out of the thread. After it the file is no longer visible
 * (kernel.files SELECT EXISTS-joins on the thread, whose policy requires a
 * participant).
 */
export async function seedFileFixtureWithRevoke(): Promise<{
  fileId: string
  tokenB: string
  revokeAccess: () => Promise<void>
}> {
  const admin = await registeredOrgAdmin()
  const orgId = admin.orgId
  const threadId = await minimal.thread(orgId, admin.id, { title: "B8 File Thread" })
  const fileId = await withPrivilegedDb(orgId, "b8-seed-file", async (tx) => {
    const { files } = await import("~/db/schema/kernel/files")
    const [f] = await tx
      .insert(files)
      .values({
        orgId,
        app: "kernel",
        entityType: "thread",
        entityId: threadId,
        filename: "secret.txt",
        mimeType: "text/plain",
        sizeBytes: 11,
        storageKey: `orgs/${orgId}/k/thread/${threadId}/${crypto.randomUUID()}.txt`,
        uploadedBy: admin.id,
      })
      .returning({ id: files.id })
    return f.id
  })

  // The initial files SELECT policy is `USING (false)`: boot-phase10 rebuilds
  // it from the manifests' fileParent declarations, which a test app skips.
  const { rebuildFilesSelectPolicy } = await import("~/infra/boot-phase10")
  await rebuildFilesSelectPolicy()

  const revokeAccess = async () => {
    await withPrivilegedDb(orgId, "b8-revoke-access", async (tx) => {
      await tx
        .delete(threadParticipants)
        .where(
          and(eq(threadParticipants.threadId, threadId), eq(threadParticipants.userId, admin.id)),
        )
      // The bearer minted before the revoke must be re-checked, as a removal does.
      await tx
        .update(users)
        .set({ permissionVersion: sql`${users.permissionVersion} + 1` })
        .where(eq(users.id, admin.id))
    })
    const { invalidateAuthCache } = await import("~/modules/auth/auth-state")
    invalidateAuthCache(admin.id)
  }
  return { fileId, tokenB: await minimal.token(admin.id), revokeAccess }
}

/**
 * Seed for B9: two kernel mutations (a thread created, then renamed), each
 * run through the durable consumers and the live publish so the audit row
 * exists when the test reads the log. `changes` holds the post-state.
 */
export async function seedAuditMutationSet(): Promise<
  Array<{
    execute: () => Promise<void>
    entityId: string
    actorId: string
    expectedAction: string
    expectedChanges: (changes: unknown) => boolean
  }>
> {
  const admin = await registeredOrgAdmin()
  const orgId = admin.orgId
  const {
    initEventBus,
    resetEventBus,
    _publishEventInternal: publishEvent,
    flushEventHandlers,
  } = await import("~/infra/events/event-bus")
  const { registerEventSubscribers } = await import("~/infra/events/event-subscribers")
  const { runDurableConsumers, DurableConsumersTestAccess } = await import(
    "~/infra/events/durable-consumers"
  )
  resetEventBus()
  initEventBus()
  // Only the audit + timeline durable consumers: an indexer or attention
  // consumer a prior file left registered would need Meili/BullMQ here.
  DurableConsumersTestAccess.reset()
  registerEventSubscribers({
    bufferAndBroadcast: async () => {},
    broadcast: async () => {},
  } as never)

  const threadId = crypto.randomUUID()
  const updatedTitle = "B9 Updated Title"
  const run = async (action: "create" | "update", data: Record<string, unknown>) => {
    const event = {
      app: "kernel",
      entity: "thread",
      action,
      entityId: threadId,
      orgId,
      actorId: admin.id,
      actorType: "user" as const,
      data,
    }
    // The outbox order: durable consumers (audit + timeline, at least once,
    // I-EVT-1) before the live publish.
    await runDurableConsumers({ eventId: crypto.randomUUID(), event })
    await publishEvent(event)
    await flushEventHandlers()
  }
  return [
    {
      entityId: threadId,
      actorId: admin.id,
      expectedAction: "thread.create",
      expectedChanges: (c) => (c as Record<string, unknown> | null)?.id === threadId,
      execute: () => run("create", { id: threadId, title: "B9 Audit Thread" }),
    },
    {
      entityId: threadId,
      actorId: admin.id,
      expectedAction: "thread.update",
      expectedChanges: (c) => (c as Record<string, unknown> | null)?.title === updatedTitle,
      execute: () => run("update", { id: threadId, title: updatedTitle }),
    },
  ]
}

/**
 * Seed for B13: a registered org (the test app registers a `test-hook`
 * webhook with HMAC verification) and its public webhook route.
 */
export async function seedWebhookFixture(): Promise<{ webhookRoute: string; orgId: string }> {
  const orgId = (await createTestOrg()).id
  return { orgId, webhookRoute: `/webhooks/${orgId}/test/test-hook` }
}

/**
 * Seed for B14: the org admin (userA) and a member (userB), and a saved view
 * one of them made through the saved-views service: `"private"` is
 * `sharedWithOrg=false`, `"team"` is `sharedWithOrg=true`.
 */
export async function seedSavedViewFixture(opts: {
  visibility: "private" | "team"
  owner: "userA" | "userB"
}): Promise<{
  privateViewId: string
  tokenA: string
  tokenB: string
  app: string
  viewId: string
}> {
  const userA = await registeredOrgAdmin()
  const orgId = userA.orgId
  const userB = await minimal.person(orgId)
  const owner = opts.owner === "userA" ? userA : userB
  const app = "kernel"
  const viewId = "threads"
  const view = await createSavedView(await actorFor(ctxOf(orgId), owner.id), {
    app,
    viewId,
    name: "B14 Private View",
    payload: {},
    sharedWithOrg: opts.visibility === "team",
  } as never)
  return {
    privateViewId: view.id,
    tokenA: await minimal.token(userA.id),
    tokenB: await minimal.token(userB.id),
    app,
    viewId,
  }
}

/**
 * Seed for B11: a pending approval of a REAL registered gated tool
 * (`test:gatedEcho`) in the admin's thread, and the admin's token. A missing
 * tool would make an approve fail and revert the row to pending, which lets a
 * later racer decide it too: the race's outcome would depend on timing.
 */
export async function seedApproval(): Promise<{ approvalId: string; tokenB: string }> {
  const admin = await registeredOrgAdmin()
  const orgId = admin.orgId
  const threadId = await minimal.thread(orgId, admin.id, { title: "B11 Approval" })
  const approvalId = crypto.randomUUID()
  await seedApprovalRequests(ctxOf(orgId), [
    {
      id: approvalId,
      handle: `b11-${crypto.randomUUID().slice(0, 8)}`,
      threadId,
      toolName: "test:gatedEcho",
      payload: { message: "race" },
      requestedBy: admin.id,
      agentId: null,
      notifyUserIds: [admin.id],
      status: "pending",
      reason: "gated",
      createdAt: new Date(),
    },
  ])
  return { approvalId, tokenB: await minimal.token(admin.id) }
}

/**
 * Seed for B10: two tenants and a thread in org A, userA's, whose title is a
 * prompt-injection payload; userB (org B) acts against it.
 */
export async function seedHostileEntity(opts: {
  description: string
}): Promise<{ entityId: string; orgAId: string; tokenB: string }> {
  const fixture = await seedTwoOrgsWithIsolatedData()
  const entityId = await minimal.thread(fixture.orgA.id, fixture.userA.id, {
    title: opts.description,
  })
  return { entityId, orgAId: fixture.orgA.id, tokenB: fixture.tokenB }
}
