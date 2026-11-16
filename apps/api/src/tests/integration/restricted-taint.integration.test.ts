// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a read of a restricted agreement touches stays with its list. The kernel stamps the turn
// with `restricted:agreements.agreement:<id>` after the read returns (from its own lookup of the
// returned ids), no grant holds that scope (`*` included), and the existing taint rules then
// park a post others could not read, decided by the person who asked, while the same summary in
// their own direct messages runs and is read by the list only.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as dsql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { ownerCanSeeEventEntity } from "~/infra/jobs/event-routine-gate"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { taintApprovalAudienceGapDetail } from "~/modules/agent/scopes/taint-approval-audience"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { executeToolCore, restrictedStampOf } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { keepRestrictedReaders } from "~/modules/attention/restricted-recipients"
import { followRestrictedAccess } from "~/modules/client-actions/restricted-follow"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { restrictedScope } from "~/modules/permissions/restricted-scope"
import { sendMessage } from "~/modules/threads/message"
import { insertAppRow } from "~/seed/factories/app-tables"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { insertClientAction } from "~/tests/security/portal-doors/fixture"
import agreementsManifest from "../../../../../bundled-apps/agreements/app.manifest.json"

let orgId = ""
let listedId = ""
let adminId = ""
let memberId = ""
let closedId = ""
let openId = ""
let scope = ""

function agreements() {
  return {
    ...agreementsManifest,
    trusted: false,
    _format: "manifest" as const,
    _bundlePath: new URL(
      `../../../../../bundled-apps/agreements/${agreementsManifest.version}/bundle.js`,
      import.meta.url,
    ).pathname,
  } as unknown as Parameters<typeof registerApps>[0][number]
}

async function held(userId: string): Promise<UserContext> {
  const perms = await withSystemDb("restricted-taint-perms", (tx) =>
    loadEffectivePermissions(tx as never, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants ?? {},
    roles: perms.roles,
  }
}

type Outcome = Record<string, any>
type Call = (toolName: string, params: Record<string, unknown>) => Promise<Outcome>

/** One agent turn of `userId` in `threadId`: every call shares the turn's taint. */
async function turn<T>(
  userId: string,
  threadId: string,
  steps: (call: Call, taint: () => string[]) => Promise<T>,
): Promise<T> {
  const actor = await held(userId)
  const accumulator = createTurnScopeAccumulator({ orgId })
  const runId = crypto.randomUUID()
  const call: Call = (toolName, params) =>
    executeToolCore({
      toolName,
      orgId,
      actor,
      params,
      threadId,
      origin: "in-app-agent",
    } as never) as Promise<Outcome>
  const ctx = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    effectiveScope: actor.scopes,
    turnScopeAccumulator: accumulator,
    humanTurn: true,
  } as unknown as RunContext
  return runContextStore.run(ctx, () => steps(call, () => accumulator.snapshot()))
}

async function postedIn(threadId: string, marker: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.messages
     WHERE thread_id = ${threadId}::uuid AND content LIKE ${`%${marker}%`}`
  return row?.n ?? 0
}

/** How many messages of `threadId` this reader sees under row-level security. */
async function readable(userId: string, threadId: string, marker: string): Promise<number> {
  const actor = await held(userId)
  return withRlsContext(actor, async (tx) => {
    const rows = (await tx.execute(
      dsql`SELECT count(*)::int AS n FROM kernel.messages WHERE thread_id = ${threadId}::uuid AND content LIKE ${`%${marker}%`}`,
    )) as unknown as Array<{ n: number }>
    return Number(rows[0]?.n ?? 0)
  })
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  orgId = (await createTestOrg()).id
  listedId = (await minimal.adminSession(orgId)).userId
  adminId = (await minimal.session(orgId, { role: "admin" })).userId
  memberId = (await minimal.session(orgId, { role: "member" })).userId
  await ensureAppsForOrg(orgId)
  await initSandboxPool()
  await initWorkerPool()
  const { failedApps } = await registerApps([agreements()], orgId)
  expect(failedApps).toEqual([])
  await primeOrgApps(orgId, 0)
  await registerKernelAgentTools(orgId)
  closedId = crypto.randomUUID()
  openId = crypto.randomUUID()
  await withPrivilegedDb(orgId, "test:restricted-agreements", async (tx) => {
    await insertAppRow(tx, "agreements", "agreements", {
      org_id: orgId,
      id: closedId,
      number: "AG-2026-101",
      kind: "nda",
      title: "Closed supplier terms",
      org_access: "none",
    })
    await insertAppRow(tx, "agreements", "agreement_shares", {
      org_id: orgId,
      agreement_id: closedId,
      user_id: listedId,
      role: "editor",
    })
    await insertAppRow(tx, "agreements", "agreements", {
      org_id: orgId,
      id: openId,
      number: "AG-2026-102",
      kind: "nda",
      title: "Open supplier terms",
      org_access: "editor",
    })
  })
  scope = restrictedScope("agreements", "agreement", closedId)
}, 240_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  await sql`DELETE FROM kernel.apps WHERE org_id = ${orgId}`.catch(() => {})
  await releaseTestLock()
})

describe("a read of a restricted agreement stamps the turn", () => {
  it("the kernel's lookup names each restricted id a result returns, and only those", async () => {
    const stamp = await restrictedStampOf(
      orgId,
      { kind: "agreements.agreement", idPath: "items[].id" },
      { items: [{ id: closedId }, { id: openId }, { id: crypto.randomUUID() }] },
    )
    expect(stamp).toEqual([scope])
  })

  it("a search by a person on the list adds the restricted scope; one by an admin off the list finds nothing to add", async () => {
    const dm = await minimal.agentDm(orgId, listedId)
    await turn(listedId, dm, async (call, taint) => {
      const read = await call("agreements:agreements_search", {})
      expect(JSON.stringify(read)).toContain("AG-2026-101")
      expect(taint()).toContain(scope)
    })
    const adminDm = await minimal.agentDm(orgId, adminId)
    await turn(adminId, adminDm, async (call, taint) => {
      const read = await call("agreements:agreements_search", {})
      expect(JSON.stringify(read)).not.toContain("AG-2026-101")
      expect(taint()).not.toContain(scope)
    })
  })
})

describe("what the turn writes next stays with the list", () => {
  it("a summary posted into a thread with an admin off the list parks, owner-routed to the person who asked", async () => {
    const dm = await minimal.agentDm(orgId, listedId)
    const room = await minimal.thread(orgId, listedId, {
      title: "Suppliers",
      participantIds: [adminId],
    })
    const out = await turn(listedId, dm, async (call) => {
      await call("agreements:agreements_search", {})
      return call("kernel:threads_reply", { threadId: room, content: "Terms summary (mixed-case)" })
    })
    expect("data" in out).toBe(false)
    expect(await postedIn(room, "mixed-case")).toBe(0)
    const approvalId = out.blocked?.approvalRequestId as string | undefined
    expect(typeof approvalId).toBe("string")
    const [row] = await sql<{ resource_owner_id: string | null; requested_by: string }[]>`
      SELECT resource_owner_id, requested_by FROM kernel.approval_requests WHERE id = ${approvalId as string}::uuid`
    expect(row?.resource_owner_id).toBe(listedId)
  })

  it("the same summary in the person's own direct messages runs, and is read by the list only", async () => {
    const dm = await minimal.agentDm(orgId, listedId)
    const own = await minimal.thread(orgId, listedId, { title: "My notes" })
    const out = await turn(listedId, dm, async (call) => {
      await call("agreements:agreements_search", {})
      return call("kernel:threads_reply", { threadId: own, content: "Terms summary (dm-case)" })
    })
    expect(out.error).toBeUndefined()
    expect(out.blocked).toBeUndefined()
    expect(await postedIn(own, "dm-case")).toBe(1)
    const [row] = await sql<{ required_scopes: string[]; disclosure_list: string[] | null }[]>`
      SELECT required_scopes, disclosure_list FROM kernel.messages
       WHERE thread_id = ${own}::uuid AND content LIKE '%dm-case%'`
    expect(row?.required_scopes).toContain(scope)
    expect(row?.disclosure_list).toEqual([listedId])
    expect(await readable(listedId, own, "dm-case")).toBe(1)
  })

  it("an admin holding every scope, in the conversation but off the list, reads no such message", async () => {
    const room = await minimal.thread(orgId, listedId, {
      title: "Suppliers again",
      participantIds: [adminId],
    })
    const actor = await held(listedId)
    await withRlsContext(actor, (tx) =>
      sendMessage(
        tx as never,
        {
          orgId,
          userId: listedId,
          threadId: room,
          content: "Restricted note (stamped-case)",
          authorType: "user",
          requiredScopes: [scope],
        } as never,
      ),
    )
    expect(await postedIn(room, "stamped-case")).toBe(1)
    expect(await readable(adminId, room, "stamped-case")).toBe(0)
    expect(await readable(listedId, room, "stamped-case")).toBe(1)
  })

  it("the approval audience judges a restricted scope by the list, never by a grant", async () => {
    expect(
      await taintApprovalAudienceGapDetail({
        orgId,
        requesterUserId: listedId,
        requesterScopes: ["*"],
        taintScopes: [scope],
      }),
    ).toBeNull()
    const gap = await taintApprovalAudienceGapDetail({
      orgId,
      requesterUserId: adminId,
      requesterScopes: ["*"],
      taintScopes: [scope],
    })
    expect(gap?.audience).toBe("requester")
    expect(gap?.missingScopes).toEqual([scope])
    // A member who holds nothing is no more on the list than the admin.
    const member = await taintApprovalAudienceGapDetail({
      orgId,
      requesterUserId: memberId,
      requesterScopes: [],
      taintScopes: [scope],
    })
    expect(member?.audience).toBe("requester")
  })

  it("once the agreement is open again its scope asks nothing of anyone", async () => {
    await withPrivilegedDb(orgId, "test:reopen", (tx) =>
      tx.execute(
        dsql`UPDATE app_agreements.agreements SET org_access = 'viewer' WHERE id = ${closedId}::uuid` as never,
      ),
    )
    try {
      expect(
        await taintApprovalAudienceGapDetail({
          orgId,
          requesterUserId: adminId,
          requesterScopes: ["*"],
          taintScopes: [scope],
        }),
      ).toBeNull()
    } finally {
      await withPrivilegedDb(orgId, "test:reclose", (tx) =>
        tx.execute(
          dsql`UPDATE app_agreements.agreements SET org_access = 'none' WHERE id = ${closedId}::uuid` as never,
        ),
      )
    }
  })
})

describe("what is derived from a restricted agreement follows its list", () => {
  const signed = () => ({
    app: "agreements",
    entity: "agreement",
    action: "signed",
    orgId,
    entityId: closedId,
    data: { number: "AG-2026-101" },
  })

  it("a routine owned off the list gets no tick from its events; one owned on the list does", async () => {
    expect(await ownerCanSeeEventEntity(await held(adminId), signed())).toBe(false)
    expect(await ownerCanSeeEventEntity(await held(listedId), signed())).toBe(true)
    // An evidence event names the agreement beside its version id.
    const mismatch = {
      app: "agreements",
      entity: "evidence",
      action: "mismatch",
      orgId,
      entityId: crypto.randomUUID(),
      data: { agreement_id: closedId },
    }
    expect(await ownerCanSeeEventEntity(await held(adminId), mismatch)).toBe(false)
    expect(await ownerCanSeeEventEntity(await held(listedId), mismatch)).toBe(true)
    // An open agreement ticks for any owner who reads agreements.
    expect(
      await ownerCanSeeEventEntity(await held(adminId), { ...signed(), entityId: openId }),
    ).toBe(true)
  })

  it("its attention and notifications reach the people on its list only, whatever the recipient kind", async () => {
    const everyone = [listedId, adminId, memberId]
    expect(await keepRestrictedReaders(orgId, signed(), everyone)).toEqual([listedId])
    expect(await keepRestrictedReaders(orgId, { ...signed(), entityId: openId }, everyone)).toEqual(
      everyone,
    )
    expect(
      await keepRestrictedReaders(
        orgId,
        { app: "projects", entity: "task", entityId: closedId },
        everyone,
      ),
    ).toEqual(everyone)
  })

  it("an access change narrows the record's client actions to the list and drops an ex-reader from its discussion", async () => {
    const versionId = crypto.randomUUID()
    const actionId = await insertClientAction(
      { orgId, clientA: { email: "signer@maison-roux.example", name: "Signer" } } as never,
      { company_id: null, target_id: versionId },
    )
    const discussion = await minimal.thread(orgId, listedId, {
      title: "Agreement discussion",
      participantIds: [adminId],
    })
    await sql`UPDATE kernel.threads SET handle = ${`entity:agreements:agreement:${closedId}`}
               WHERE id = ${discussion}::uuid`
    const followed = await followRestrictedAccess({
      app: "agreements",
      entity: "agreement",
      action: "access_changed",
      orgId,
      entityId: closedId,
      actorId: listedId,
      data: { org_access: "none", visible_to: [listedId], version_ids: [versionId] },
    })
    expect(followed).toBe(true)
    const [action] = await sql<{ visible_to: string[] | null }[]>`
      SELECT visible_to FROM kernel.client_actions WHERE id = ${actionId}::uuid`
    expect(action?.visible_to).toEqual([listedId])
    const seats = await sql<{ user_id: string }[]>`
      SELECT user_id::text AS user_id FROM kernel.thread_participants
       WHERE thread_id = ${discussion}::uuid AND user_id IS NOT NULL`
    expect(seats.map((r) => r.user_id)).toEqual([listedId])
    // Open again: the client actions are no longer narrowed.
    await followRestrictedAccess({
      app: "agreements",
      entity: "agreement",
      action: "access_changed",
      orgId,
      entityId: closedId,
      actorId: listedId,
      data: { org_access: "editor", visible_to: null, version_ids: [versionId] },
    })
    const [reopened] = await sql<{ visible_to: string[] | null }[]>`
      SELECT visible_to FROM kernel.client_actions WHERE id = ${actionId}::uuid`
    expect(reopened?.visible_to).toBeNull()
  })
})
