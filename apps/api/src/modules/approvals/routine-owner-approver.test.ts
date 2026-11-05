// SPDX-License-Identifier: FSL-1.1-ALv2
// Routine owner as approver (S29, A33, A52/F2).
//
// A routine set to `approver: "owner"` routes the gated drafts it raises to
// its owner alone, on a SHARED mailbox too. Owner routing lets the owner
// decide with no scope check, so it is granted only to an owner who holds the
// tool's deciding scope; anyone else gets the default deciding-scope audience.
// On a tainted turn the owner-routed draft is read by the owner alone, so the
// owner must also hold what the turn read.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { extractRows, sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { initEventBus } from "~/infra/events/event-bus"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import {
  handleCreateRoutine,
  handleUpdateRoutine,
} from "~/modules/agent/tools/skills-routines-tools"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import {
  loadRoutineApproverSetting,
  type RoutineApproverSetting,
  routineApproverSource,
  routineOwnerMayApprove,
} from "~/modules/approvals/resource-owner"
import { resetAppRegistries, setDeclaredEmits } from "~/modules/apps/app-registries"
import { createApprovalRequestInBundle } from "~/modules/apps/execute-tool"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool } from "~/modules/apps/sandbox/pool"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

const ORG = randomUUID()
const OWNER_NO_SCOPE = randomUUID()
const OWNER_SCOPED = randomUUID()
const ADMIN = randomUUID()
const APPROVER = randomUUID()
const THREAD = randomUUID()
const ROUTINE = randomUUID()
const ACC_SHARED = randomUUID()
const CONV_SHARED = randomUUID()
const TAINT = "crm:deals:read"

const actor = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes,
  dimensionGrants: {},
})
const adminActor = { ...actor(ADMIN, ["*"]), dimensionGrants: { "*": ["*"] } }
const SUMMARY = { kind: "mail:reply", title: "Reply draft", lines: ["To: someone"] }
const OWNER_SCOPED_GRANTS = ["mail:conversations:read", "mail:conversations:write", "mail:approve"]
const OWNER_NO_SCOPE_GRANTS = ["mail:conversations:read", "mail:conversations:write"]

/** The routine tool context of `owner`, as the create/update handlers receive it. */
const toolCtx = (userId: string, scopes: string[]) =>
  ({ orgId: ORG, userId, actorType: "user", scopes, approverUserId: userId }) as never

/** A shared-mailbox drafting routine, created through create_routine. */
function draftingRoutine(name: string, approver?: "default" | "owner") {
  return {
    name,
    description: "Draft replies on the sales mailbox",
    kind: "recurring" as const,
    cron: "0 9 * * *",
    timezone: "UTC",
    prompt: "Draft a reply to each new message on the sales mailbox.",
    scopes: ["mail:conversations:read", "mail:conversations:write"],
    ...(approver ? { approver } : {}),
  }
}

const realLoad = routineApproverSource.load
function setting(s: RoutineApproverSetting | null) {
  routineApproverSource.load = async () => s
}

/** Stage a shared-mailbox reply as a routine tick of `routineId` run by `owner`. */
async function stageAsRoutine(
  owner: string,
  audienceMustHold?: string[],
  routineId: string = ROUTINE,
): Promise<string> {
  const runId = randomUUID()
  return runContextStore.run(
    { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, routineId },
    () =>
      createApprovalRequestInBundle({
        orgId: ORG,
        threadId: THREAD,
        toolName: "mail:reply",
        toolParams: { conversationId: CONV_SHARED, textBody: "routine draft" },
        requestedBy: owner,
        summary: SUMMARY,
        appName: "mail",
        toolShortName: "reply",
        requesterCanApprove: false,
        origin: "in-app-agent",
        stepBundleId: null,
        ...(audienceMustHold ? { audienceMustHold } : {}),
      }),
  )
}

async function approvalRow(id: string) {
  const [row] = await sql`
    SELECT notify_user_ids, resource_owner_id FROM kernel.approval_requests WHERE id = ${id}`
  return row as { notify_user_ids: string[]; resource_owner_id: string | null }
}

async function visibleTo(ctx: UserContext, id: string): Promise<boolean> {
  return withRlsContext(ctx, async (tx) => {
    const rows = extractRows(
      await tx.execute(drizzleSql`SELECT id FROM kernel.approval_requests WHERE id = ${id}`),
    )
    return rows.length > 0
  })
}

describe("routine owner approver (S29, F2)", () => {
  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_mail")
    await acquireAppSchemaJsLock("app_tickets")
    try {
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${ORG}, 'Routine Approver Org', ${`routine-approver-${ORG}`})`
      const grants: Array<[string, string[]]> = [
        [OWNER_NO_SCOPE, ["mail:conversations:read", "mail:conversations:write"]],
        [OWNER_SCOPED, ["mail:conversations:read", "mail:conversations:write", "mail:approve"]],
        [ADMIN, ["*"]],
        [APPROVER, ["mail:conversations:read", "mail:approve", TAINT]],
      ]
      for (const [id, scopes] of grants) {
        await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
          VALUES (${id}, ${ORG}, ${`${id}@ra.test`}, 'U', 'active', 'hash')`
        for (const scope of scopes) {
          await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
            VALUES (${id}, ${ORG}, ${scope})`
        }
      }
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${THREAD}, ${ORG}, ${`ra-${THREAD}`}, 'agent_chat', ${OWNER_SCOPED})`
      await sql`INSERT INTO kernel.routines
          (id, org_id, owner_user_id, name, description, kind, cron, timezone, prompt, scopes,
           created_by_actor_type)
        VALUES (${ROUTINE}, ${ORG}, ${OWNER_SCOPED}, 'ra', 'ra', 'recurring', '0 9 * * *', 'UTC',
                'draft replies', ${sql.array(["mail:conversations:write"])}, 'user')`

      await initSandboxPool()
      initEventBus()
      setDeclaredEmits(
        "*",
        "kernel",
        new Set(["connected_account:create", "connected_account:disconnect"]),
      )
      await registerApps(
        [
          mailAppManifest as unknown as AppDescriptor,
          ticketsAppManifest as unknown as AppDescriptor,
        ],
        ORG,
      )
      await sql.unsafe(
        `INSERT INTO app_mail.accounts
           (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
         VALUES ('${ACC_SHARED}', '${ORG}', gen_random_uuid(), 'org', NULL, 'gmail', 'sales@ra.test', 'idle')`,
      )
      await sql.unsafe(
        `INSERT INTO app_mail.conversations
           (id, org_id, account_id, owner_type, owner_id, external_thread_id, status,
            labels, is_read, is_starred, message_count)
         VALUES ('${CONV_SHARED}', '${ORG}', '${ACC_SHARED}', 'org', NULL, 'ext-ra', 'open',
                 '[]', false, false, 0)`,
      )
    } catch (err) {
      await releaseAppSchemaJsLock("app_tickets")
      await releaseAppSchemaJsLock("app_mail")
      throw err
    }
  }, 60_000)

  afterEach(() => {
    routineApproverSource.load = realLoad
  })

  afterAll(async () => {
    try {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
      await sql.unsafe(`DELETE FROM app_mail.conversations WHERE org_id = '${ORG}'`)
      await sql.unsafe(`DELETE FROM app_mail.accounts WHERE org_id = '${ORG}'`)
      await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
      resetAppRegistries()
    } finally {
      await releaseAppSchemaJsLock("app_tickets")
      await releaseAppSchemaJsLock("app_mail")
    }
  })

  it("a routine never set reads as default", async () => {
    expect(await loadRoutineApproverSetting(ORG, ROUTINE)).toEqual({
      ownerUserId: OWNER_SCOPED,
      approver: "default",
    })
  })

  it("routineOwnerMayApprove: the deciding scope and every taint scope are required", async () => {
    const base = { orgId: ORG, approveScope: "mail:approve", dimensionConstraint: null }
    expect(await routineOwnerMayApprove({ ...base, ownerUserId: OWNER_NO_SCOPE })).toBe(false)
    expect(await routineOwnerMayApprove({ ...base, ownerUserId: OWNER_SCOPED })).toBe(true)
    expect(
      await routineOwnerMayApprove({ ...base, ownerUserId: OWNER_SCOPED, mustHold: [TAINT] }),
    ).toBe(false)
  })

  it("an owner without the deciding scope: default-routed, cannot approve, admins see it", async () => {
    setting({ ownerUserId: OWNER_NO_SCOPE, approver: "owner" })
    const id = await stageAsRoutine(OWNER_NO_SCOPE)
    const row = await approvalRow(id)
    expect(row.resource_owner_id).toBeNull()
    expect(row.notify_user_ids).toContain(ADMIN)
    expect(row.notify_user_ids).toContain(APPROVER)
    expect(await visibleTo(adminActor, id)).toBe(true)
    await expect(
      decideApproval({
        orgId: ORG,
        requestId: id,
        actor: actor(OWNER_NO_SCOPE, ["mail:conversations:read", "mail:conversations:write"]),
        decision: "approve",
      }),
    ).rejects.toThrow(ApprovalDecisionError)
  })

  it("an owner holding the deciding scope: owner-routed on a shared mailbox", async () => {
    setting({ ownerUserId: OWNER_SCOPED, approver: "owner" })
    const id = await stageAsRoutine(OWNER_SCOPED)
    const row = await approvalRow(id)
    expect(row.resource_owner_id).toBe(OWNER_SCOPED)
    expect(row.notify_user_ids).toEqual([OWNER_SCOPED])
    expect(await visibleTo(adminActor, id)).toBe(false)
    expect(await visibleTo(actor(APPROVER, ["mail:approve"]), id)).toBe(false)
  })

  it("approver default keeps the deciding-scope audience even for a scoped owner", async () => {
    setting({ ownerUserId: OWNER_SCOPED, approver: "default" })
    const id = await stageAsRoutine(OWNER_SCOPED)
    const row = await approvalRow(id)
    expect(row.resource_owner_id).toBeNull()
    expect(row.notify_user_ids).toContain(APPROVER)
    expect(await visibleTo(adminActor, id)).toBe(true)
  })

  it("a tainted owner-routed draft is read by the owner alone, and only if the owner holds the taint", async () => {
    // The owner lacks the taint: the draft falls back to the default audience, narrowed to
    // approvers holding the taint (APPROVER), never owner-routed.
    setting({ ownerUserId: OWNER_SCOPED, approver: "owner" })
    const fallback = await approvalRow(await stageAsRoutine(OWNER_SCOPED, [TAINT]))
    expect(fallback.resource_owner_id).toBeNull()
    expect(fallback.notify_user_ids).toContain(APPROVER)

    // The owner holds it: owner-routed, and nobody but the owner can read the row.
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${OWNER_SCOPED}, ${ORG}, ${TAINT})`
    try {
      const id = await stageAsRoutine(OWNER_SCOPED, [TAINT])
      const row = await approvalRow(id)
      expect(row.resource_owner_id).toBe(OWNER_SCOPED)
      expect(row.notify_user_ids).toEqual([OWNER_SCOPED])
      expect(await visibleTo(actor(OWNER_SCOPED, ["mail:approve", TAINT]), id)).toBe(true)
      expect(await visibleTo(adminActor, id)).toBe(false)
      expect(await visibleTo(actor(APPROVER, ["mail:approve", TAINT]), id)).toBe(false)
    } finally {
      await sql`DELETE FROM kernel.user_scope_grants
        WHERE user_id = ${OWNER_SCOPED} AND scope = ${TAINT}`
    }
  })
  // P5-T4: the setting is saved through create/update_routine, only when the owner may decide.
  it("create_routine refuses approver owner for an owner lacking the deciding scope", async () => {
    const res = (await handleCreateRoutine(
      draftingRoutine("ra-no-scope", "owner"),
      toolCtx(OWNER_NO_SCOPE, OWNER_NO_SCOPE_GRANTS),
    )) as { error?: { code: string; message: string } }
    expect(res.error?.code).toBe("approver_not_allowed")
    expect(res.error?.message).toContain("mail:approve")
    const rows =
      await sql`SELECT id FROM kernel.routines WHERE org_id = ${ORG} AND name = 'ra-no-scope'`
    expect(rows.length).toBe(0)
  })

  it("an owner holding the deciding scope saves owner, and the stored setting routes the draft", async () => {
    const res = (await handleCreateRoutine(
      draftingRoutine("ra-scoped", "owner"),
      toolCtx(OWNER_SCOPED, OWNER_SCOPED_GRANTS),
    )) as { routine?: { id: string; approver: string }; error?: unknown }
    expect(res.error).toBeUndefined()
    expect(res.routine!.approver).toBe("owner")
    const routineId = res.routine!.id
    expect(await loadRoutineApproverSetting(ORG, routineId)).toEqual({
      ownerUserId: OWNER_SCOPED,
      approver: "owner",
    })
    // No override of the setting's source: the row reads the persisted column.
    const id = await stageAsRoutine(OWNER_SCOPED, undefined, routineId)
    const row = await approvalRow(id)
    expect(row.resource_owner_id).toBe(OWNER_SCOPED)
    expect(row.notify_user_ids).toEqual([OWNER_SCOPED])

    // Back to default: the next draft goes to the deciding-scope audience again.
    const back = (await handleUpdateRoutine(
      { id: routineId, approver: "default" },
      toolCtx(OWNER_SCOPED, OWNER_SCOPED_GRANTS),
    )) as { routine?: { approver: string }; error?: unknown }
    expect(back.routine?.approver).toBe("default")
    const again = await approvalRow(await stageAsRoutine(OWNER_SCOPED, undefined, routineId))
    expect(again.resource_owner_id).toBeNull()
    expect(again.notify_user_ids).toContain(APPROVER)
  })

  it("update_routine refuses approver owner for an owner lacking the deciding scope", async () => {
    const created = (await handleCreateRoutine(
      draftingRoutine("ra-no-scope-update"),
      toolCtx(OWNER_NO_SCOPE, OWNER_NO_SCOPE_GRANTS),
    )) as { routine?: { id: string; approver: string } }
    expect(created.routine!.approver).toBe("default")
    const res = (await handleUpdateRoutine(
      { id: created.routine!.id, approver: "owner" },
      toolCtx(OWNER_NO_SCOPE, OWNER_NO_SCOPE_GRANTS),
    )) as { error?: { code: string } }
    expect(res.error?.code).toBe("approver_not_allowed")
    expect((await loadRoutineApproverSetting(ORG, created.routine!.id))?.approver).toBe("default")
  })
})
