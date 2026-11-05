// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHO DECIDES A GATED KERNEL TOOL: WHOEVER HOLDS THE TOOL'S OWN SCOPE.
//
// Holding `kernel:contacts:write` IS the right to update contacts, so it alone decides a parked
// contact edit, the requester's own included. The admin-grade `kernel:approve` is not the
// fallback deciding scope of ordinary kernel writes: it stays only on the tools that declare it
// (role, user, policy, app-access, configuration, routine and connection administration).
// Driven through the real chat seam (buildToolSet → executeToolCore) and the real decide path.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { resolveToolApprovalAuthority } from "~/modules/approvals/authority"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import {
  agentInstructionsRegistry,
  initializedOrgRuntimes,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000c9b01"
const ADMIN = "00000000-0000-4000-8000-0000000c9b02"
const MEMBER = "00000000-0000-4000-8000-0000000c9b03"
const OUTSIDER = "00000000-0000-4000-8000-0000000c9b04"
const DM = "00000000-0000-4000-8000-0000000c9b05"
const CONTACT = "00000000-0000-4000-8000-0000000c9b06"
const AGENT = "00000000-0000-4000-8000-0000000c9b07"

/** A member who edits contacts and decides app approvals, but holds no `kernel:approve`. */
const MEMBER_SCOPES = [
  "kernel:contacts:read",
  "kernel:contacts:write",
  "kernel:threads:read",
  "kernel:threads:write",
  "kernel:approvals:read",
  "kernel:approvals:write",
  "mail:approve",
]
/** An approver of everything admin-grade, but no contact editor. */
const OUTSIDER_SCOPES = [
  "kernel:approve",
  "kernel:contacts:read",
  "kernel:threads:read",
  "kernel:approvals:read",
  "kernel:approvals:write",
]

async function asUser(userId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(ORG, "deciding-scope-perms", (tx) =>
    loadEffectivePermissions(tx, userId, ORG),
  )
  return {
    actorType: "user",
    userId,
    orgId: ORG,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants ?? {},
  }
}

function turnFrame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
}

async function memberAgentWrite(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const frame = turnFrame()
  const tools = buildToolSet(
    ORG,
    await asUser(MEMBER),
    DM,
    ALL_DEFERRED_TOOLS_UNLOCKED,
    "agent",
    frame,
  )
  const t = tools.kernel__contacts_write
  if (!t) throw new Error("kernel__contacts_write is not in the member's catalog")
  return (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {}),
  )) as Record<string, unknown>
}

async function parkedEdit(company: string): Promise<{
  id: string
  approve_scope: string
  notify_user_ids: string[]
}> {
  const write = await memberAgentWrite({ contactId: CONTACT, company })
  expect(write).toMatchObject({ blocked: true, status: "pending_approval" })
  const [row] = await sql<{ id: string; approve_scope: string; notify_user_ids: string[] }[]>`
    SELECT id::text, approve_scope, notify_user_ids FROM kernel.approval_requests
     WHERE org_id = ${ORG} AND tool_name = 'kernel:contacts_write' AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`
  if (!row) throw new Error("no parked contacts_write")
  return row
}

async function company(): Promise<string | null> {
  const [row] = await sql<{ company: string | null }[]>`
    SELECT company FROM kernel.contacts WHERE id = ${CONTACT}`
  return row?.company ?? null
}

describe("a gated kernel tool is decided by the holders of its own scope", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Deciding Scope Org', 'deciding-scope-org') ON CONFLICT DO NOTHING`
    for (const [id, email] of [
      [ADMIN, "deciding-admin@test.com"],
      [MEMBER, "deciding-member@test.com"],
      [OUTSIDER, "deciding-outsider@test.com"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${email}, ${email}, 'active', 'x') ON CONFLICT DO NOTHING`
    }
    const grants: Array<[string, string]> = [
      [ADMIN, "*"],
      ...MEMBER_SCOPES.map((s) => [MEMBER, s] as [string, string]),
      ...OUTSIDER_SCOPES.map((s) => [OUTSIDER, s] as [string, string]),
    ]
    for (const [user, scope] of grants) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${user}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.agents (id, org_id, kind, owner_user_id, handle, display_name, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'personal', ${MEMBER}, '@deciding-member', 'Member agent', '["*"]'::jsonb)
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${DM}, ${ORG}, 'deciding-scope-dm', 'agent_chat', ${MEMBER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${DM}, ${MEMBER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${MEMBER}, ${DM}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_by, org_access)
      VALUES (${CONTACT}, ${ORG}, '@deciding-contact', 'Ines Garnier', 'ines@example.com', ${ADMIN}, 'editor')
      ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(ORG)
  }, 120_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG} AND handle LIKE 'contact-primary:%'`
    await sql`DELETE FROM kernel.timeline_entries WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await releaseTestLock()
  })

  it("a contact editor without kernel:approve is offered their own parked edit and decides it", async () => {
    const row = await parkedEdit("Garnier Acoustics")
    expect(row.approve_scope).toBe("kernel:contacts:write")
    // Offered: the requester is in the decide audience (the card's "you can approve this").
    expect(row.notify_user_ids).toContain(MEMBER)
    const decided = await decideApproval({
      orgId: ORG,
      requestId: row.id,
      actor: await asUser(MEMBER),
      decision: "approve",
    })
    expect(decided.status).toBe("approved")
    expect(await company()).toBe("Garnier Acoustics")
  })

  it("a holder of kernel:approve without kernel:contacts:write cannot decide it", async () => {
    const row = await parkedEdit("Garnier Studio")
    expect(row.notify_user_ids).not.toContain(OUTSIDER)
    // Even placed in the audience by hand, the deciding scope refuses them.
    await sql`UPDATE kernel.approval_requests
      SET notify_user_ids = array_append(notify_user_ids, ${OUTSIDER}::uuid) WHERE id = ${row.id}`
    const refused = await decideApproval({
      orgId: ORG,
      requestId: row.id,
      actor: await asUser(OUTSIDER),
      decision: "approve",
    }).catch((e: unknown) => e)
    // Refused at the data layer: the row's deciding scope hides it from them (RLS, 404), and
    // the decide path would refuse a decider who saw it (403).
    expect(refused).toBeInstanceOf(ApprovalDecisionError)
    expect([403, 404]).toContain((refused as ApprovalDecisionError).status)
    expect(await company()).toBe("Garnier Acoustics")
  })

  it("admin-grade kernel tools keep kernel:approve; ordinary kernel writes take their own scope", async () => {
    const decidedBy = async (tool: string) =>
      (
        await resolveToolApprovalAuthority({
          orgId: ORG,
          appName: "kernel",
          toolShortName: tool,
          params: {},
        })
      ).approveScope
    for (const tool of [
      "create_role",
      "edit_role",
      "delete_role",
      "invite_user",
      "assign_role",
      "remove_user_from_role",
      "grant_dimension_value",
      "grant_user_scope",
      "merge_imported_user",
      "policy_set",
      "approval_policy_set",
      "enable_app",
      "apps_set_enabled",
      "apps_set_access",
      "config_users",
      "create_routine",
      "update_routine",
      "toggle_app_skill",
      "connection_disconnect",
      "connect_link_send",
    ]) {
      expect([tool, await decidedBy(tool)]).toEqual([tool, "kernel:approve"])
    }
    expect(await decidedBy("contacts_write")).toBe("kernel:contacts:write")
    expect(await decidedBy("contacts_merge")).toBe("kernel:contacts:write")
    expect(await decidedBy("contacts_export")).toBe("kernel:contacts:export")
    expect(await decidedBy("import_start")).toBe("kernel:imports:run")
    // Skills keep their own domain approver scope.
    expect(await decidedBy("update_skill")).toBe("kernel:skills:approve")
  })
})
