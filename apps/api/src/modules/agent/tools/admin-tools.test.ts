// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { sql as sqlRaw } from "~/db/connection"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import {
  agents,
  auditLog,
  organizations,
  roleScopeGrants,
  roles as rolesTable,
  userRoles,
  userScopeGrants,
  users,
} from "~/db/schema/kernel"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  handleApprovalsList,
  handleAssignRole,
  handleAuditSearch,
  handleDeleteRole,
  handleDescribeUserAccess,
  handleEditRole,
  handleGetRole,
  handleInviteUser,
  handleListScopes,
  handleRemoveRole,
  handleRolesList,
  handleSetUserScope,
  handleUsersList,
} from "~/modules/agent/tools/admin-tools"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import type { OrgConfigToolCtx } from "~/modules/agent/tools/org-config-tools"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { approvalEditableFieldsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  cleanupSeededOrg,
  mutatingTicketTool,
  seedAgentForOrg,
  seedMcpConnection,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { handleToolCall } from "~/modules/mcp/tool-call"
import { KERNEL_EVERY_MEMBER_SCOPES } from "~/modules/permissions/every-member-scopes"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

interface AdminToolTest {
  orgId: string
  userId: string
  ctx: OrgConfigToolCtx
  callHandler: (name: string, params: Record<string, unknown>) => Promise<any>
  seedRole: (name: string, scopes: string[]) => Promise<string>
  seedUser: (email: string) => Promise<string>
}

const HANDLERS: Record<string, (params: any, ctx: OrgConfigToolCtx) => Promise<unknown>> = {
  roles_list: handleRolesList,
  users_list: handleUsersList,
  describe_user_access: handleDescribeUserAccess,
  audit_search: handleAuditSearch,
  approvals_list: handleApprovalsList,
  invite_user: handleInviteUser,
  assign_role: handleAssignRole,
  remove_user_from_role: handleRemoveRole,
  list_scopes: handleListScopes,
  grant_user_scope: handleSetUserScope,
  get_role: handleGetRole,
  edit_role: handleEditRole,
  delete_role: handleDeleteRole,
}

async function withAdminToolTest(
  opts: { scopes: string[] },
  run: (t: AdminToolTest) => Promise<void>,
): Promise<void> {
  const org = await createTestOrg()
  const orgId = org.id
  const userId = await withSystemDb("admin-tools-test-user", async (db) => {
    const [u] = await db
      .insert(users)
      .values({
        orgId,
        email: `admin-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Admin Tester",
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
  for (const scope of opts.scopes) {
    await minimal.grantScope(userId, scope)
  }
  const ctx: OrgConfigToolCtx = { orgId, userId }
  const t: AdminToolTest = {
    orgId,
    userId,
    ctx,
    callHandler: (name, params) => {
      const h = HANDLERS[name]
      if (!h) throw new Error(`no handler ${name}`)
      return h(params, ctx)
    },
    seedRole: (name, scopes) =>
      withSystemDb("admin-tools-seed-role", async (db) => {
        const [r] = await db
          .insert(rolesTable)
          .values({ orgId, name, description: null })
          .returning({ id: rolesTable.id })
        for (const scope of scopes) {
          await db.insert(roleScopeGrants).values({ roleId: r.id, scope })
        }
        return r.id
      }),
    seedUser: (email) =>
      withSystemDb("admin-tools-seed-user", async (db) => {
        const [u] = await db
          .insert(users)
          .values({ orgId, email, passwordHash: "x", name: email, status: "active" })
          .returning({ id: users.id })
        return u.id
      }),
  }
  await run(t)
}

function actor(orgId: string, userId: string, scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
}

describe("kernel-admin reads — roles_list / users_list", () => {
  it("roles_list lists every role (zero-member role included)", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      await t.seedRole("Support Agent", ["tickets:tickets:read"])
      await t.seedRole("Finance", ["invoicing:documents:write"])
      const r = await t.callHandler("roles_list", {})
      const names = r.roles.map((x: { name: string }) => x.name)
      expect(names).toContain("Support Agent")
      expect(names).toContain("Finance")
      const sa = r.roles.find((x: { name: string }) => x.name === "Support Agent")
      expect(sa.memberCount).toBeGreaterThanOrEqual(0)
    })
  })

  it("users_list lists org members with id/name/email", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      await t.seedUser(`u1-${crypto.randomUUID()}@t.co`)
      const r = await t.callHandler("users_list", {})
      expect(r.users.length).toBeGreaterThanOrEqual(2)
      for (const u of r.users) {
        expect(typeof u.id).toBe("string")
        expect(typeof u.name).toBe("string")
        expect(typeof u.email).toBe("string")
      }
    })
  })

  it("non-admin actor: roles_list is silently filtered out of the tool set", async () => {
    await withAdminToolTest({ scopes: ["tickets:tickets:read"] }, async (t) => {
      await registerKernelAgentTools(t.orgId)
      const set = buildToolSet(t.orgId, actor(t.orgId, t.userId, ["tickets:tickets:read"]))
      expect(set.kernel__roles_list).toBeUndefined()
      // defense-in-depth: the tool IS in the registry for an admin actor
      const adminSet = buildToolSet(
        t.orgId,
        actor(t.orgId, t.userId, ["kernel:users:admin"]),
        undefined,
        ALL_DEFERRED_TOOLS_UNLOCKED,
      )
      expect(adminSet.kernel__roles_list).toBeDefined()
      toolRegistry.deleteByPrefix([t.orgId])
    })
  })
})

describe("kernel-admin reads — describe_user_access (per-user effective-scope DIAGNOSIS)", () => {
  // The permissions-troubleshoot-tomas-quotes diagnosis half: the agent VERIFIES a teammate's RESOLVED
  // effective scopes instead of guessing. These pin that describe_user_access returns the exact scope
  // STRINGS with provenance, so a missing capability (e.g. the quote-send scope) is provably absent.
  it("returns a teammate's effective scopes — read present, the missing quote-send scope absent", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      // Theo on a 'Dealer Sales' role: can READ/draft quotes, but NOT invoicing:documents:write.
      const roleId = await t.seedRole("Dealer Sales", [
        "invoicing:documents:read",
        "invoicing:contacts:read",
      ])
      const theoId = await t.seedUser(`theo-${crypto.randomUUID()}@t.co`)
      await withSystemDb("describe-access-assign", (db) =>
        db.insert(userRoles).values({ userId: theoId, roleId, orgId: t.orgId }),
      )
      const r = await t.callHandler("describe_user_access", { userId: theoId })
      const scopes = r.effectiveScopes.map((s: { scope: string }) => s.scope)
      expect(scopes, "Theo can READ/draft quotes").toContain("invoicing:documents:read")
      expect(scopes, "the diagnosable bug: Theo LACKS the quote-send scope").not.toContain(
        "invoicing:documents:write",
      )
      // Provenance: the read scope is inherited from the Dealer Sales role (not a direct grant).
      const readEntry = r.effectiveScopes.find(
        (s: { scope: string }) => s.scope === "invoicing:documents:read",
      )
      expect(readEntry.fromRoles).toContain("Dealer Sales")
      expect(readEntry.direct).toBe(false)
      expect(r.roles.map((x: { name: string }) => x.name)).toContain("Dealer Sales")
    })
  })

  it("a direct per-user grant shows direct:true (so a fix applied via grant_user_scope is verifiable)", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      const theoId = await t.seedUser(`theo2-${crypto.randomUUID()}@t.co`)
      await withSystemDb("describe-access-direct", (db) =>
        db
          .insert(userScopeGrants)
          .values({ userId: theoId, orgId: t.orgId, scope: "invoicing:documents:write" }),
      )
      const r = await t.callHandler("describe_user_access", { userId: theoId })
      const entry = r.effectiveScopes.find(
        (s: { scope: string }) => s.scope === "invoicing:documents:write",
      )
      expect(entry, "the directly-granted quote-send scope now resolves").toBeDefined()
      expect(entry.direct).toBe(true)
    })
  })

  // checkScopes — the DETERMINISTIC SoD-audit lever (founder-day chaos journey S9 root). A who-can-issue-vs-
  // approve audit needs a grounded YES/NO per decision scope, but a long effectiveScopes array gets
  // truncated in the agent's view, so the agent guessed. `checkScopes` returns an EXACT, untruncatable
  // per-scope `scopeChecks` map (held + provenance), honoring scope hierarchy. Without it the agent can
  // only eyeball the (possibly-truncated) array; with it the answer is deterministic and grounded.
  it("checkScopes returns a deterministic per-scope held/absent map with provenance (the SoD-audit lever)", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      // A finance teammate who CAN issue a refund (exact create scope, via a role) but CANNOT approve one.
      const roleId = await t.seedRole("Finance Assistant", [
        "shopify:refunds:create",
        "invoicing:documents:read",
      ])
      const userId = await t.seedUser(`fin-${crypto.randomUUID()}@t.co`)
      await withSystemDb("checkscopes-assign", (db) =>
        db.insert(userRoles).values({ userId, roleId, orgId: t.orgId }),
      )
      const r = await t.callHandler("describe_user_access", {
        userId,
        checkScopes: ["shopify:refunds:create", "shopify:approve"],
      })
      // The create scope is HELD (exact), grounded to the role — the audit cites this, never guesses.
      expect(r.scopeChecks["shopify:refunds:create"].held).toBe(true)
      expect(r.scopeChecks["shopify:refunds:create"].via).toBe("exact")
      expect(r.scopeChecks["shopify:refunds:create"].fromRoles).toContain("Finance Assistant")
      // The approver scope is NOT held — a deterministic false (the SoD model: this person can issue, not approve).
      expect(r.scopeChecks["shopify:approve"].held).toBe(false)
      expect(r.scopeChecks["shopify:approve"].via).toBeNull()
    })
  })

  it("checkScopes honors scope HIERARCHY — a covering parent grant satisfies a child decision scope", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      // An admin-ish role holding the PARENT `shopify:refunds` (covers `shopify:refunds:create`) — the
      // hierarchical match the engine enforces; a naive string-equality check would wrongly miss it.
      const roleId = await t.seedRole("Refund Manager", ["shopify:refunds"])
      const userId = await t.seedUser(`rm-${crypto.randomUUID()}@t.co`)
      await withSystemDb("checkscopes-parent", (db) =>
        db.insert(userRoles).values({ userId, roleId, orgId: t.orgId }),
      )
      const r = await t.callHandler("describe_user_access", {
        userId,
        checkScopes: ["shopify:refunds:create"],
      })
      expect(r.scopeChecks["shopify:refunds:create"].held).toBe(true)
      expect(r.scopeChecks["shopify:refunds:create"].via).toBe("parent")
    })
  })

  it("omitting checkScopes leaves scopeChecks absent (additive, behavior unchanged for diagnosis)", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      const userId = await t.seedUser(`noc-${crypto.randomUUID()}@t.co`)
      const r = await t.callHandler("describe_user_access", { userId })
      expect(r.scopeChecks).toBeUndefined()
      expect(Array.isArray(r.effectiveScopes)).toBe(true)
    })
  })

  // Parity with enforcement: the scope set is exactly the token's (loadEffectivePermissions), so the
  // every-member scopes a plain member holds without any role or direct grant are reported as held.
  it("a plain member's effective scopes equal the token's resolved scopes (every-member scopes included)", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      const roleId = await t.seedRole("Reader", ["tickets:read"])
      const userId = await t.seedUser(`plain-${crypto.randomUUID()}@t.co`)
      await withSystemDb("describe-access-parity", (db) =>
        db.insert(userRoles).values({ userId, roleId, orgId: t.orgId }),
      )
      const token = await withPrivilegedDb(t.orgId, "describe-access-parity-token", (tx) =>
        loadEffectivePermissions(tx, userId, t.orgId),
      )
      const r = await t.callHandler("describe_user_access", {
        userId,
        checkScopes: ["kernel:dashboards:read"],
      })
      const reported = r.effectiveScopes.map((s: { scope: string }) => s.scope).sort()
      expect(reported).toEqual([...token.scopes].sort())
      for (const scope of KERNEL_EVERY_MEMBER_SCOPES) expect(reported).toContain(scope)
      const dash = r.effectiveScopes.find(
        (s: { scope: string }) => s.scope === "kernel:dashboards:read",
      )
      expect(dash).toMatchObject({
        fromRoles: [],
        direct: false,
        everyMember: true,
        mcpAccess: false,
      })
      expect(r.scopeChecks["kernel:dashboards:read"]).toMatchObject({
        held: true,
        via: "exact",
        everyMember: true,
      })
      const fromRole = r.effectiveScopes.find((s: { scope: string }) => s.scope === "tickets:read")
      expect(fromRole).toMatchObject({ fromRoles: ["Reader"], everyMember: false })
      expect(r.deniedApps).toEqual([])
    })
  })

  it("returns USER_NOT_FOUND for an unknown id (no fabricated scope set)", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      const r = await t.callHandler("describe_user_access", { userId: crypto.randomUUID() })
      expect(r.error?.code).toBe("USER_NOT_FOUND")
    })
  })

  it("non-admin actor: describe_user_access is silently filtered out of the tool set", async () => {
    await withAdminToolTest({ scopes: ["tickets:tickets:read"] }, async (t) => {
      await registerKernelAgentTools(t.orgId)
      const set = buildToolSet(t.orgId, actor(t.orgId, t.userId, ["tickets:tickets:read"]))
      expect(set.kernel__describe_user_access).toBeUndefined()
      const adminSet = buildToolSet(
        t.orgId,
        actor(t.orgId, t.userId, ["kernel:users:admin"]),
        undefined,
        ALL_DEFERRED_TOOLS_UNLOCKED,
      )
      expect(adminSet.kernel__describe_user_access).toBeDefined()
      toolRegistry.deleteByPrefix([t.orgId])
    })
  })
})

describe("kernel-admin reads — audit_search / approvals_list", () => {
  it("audit_search windows by date and projects approver linkage", async () => {
    await withAdminToolTest({ scopes: ["kernel:audit:read"] }, async (t) => {
      const approverId = await t.seedUser(`approver-${crypto.randomUUID()}@t.co`)
      await withPrivilegedDb(t.orgId, "audit-seed", async (db) => {
        await db.insert(auditLog).values({
          orgId: t.orgId,
          action: "shopify:refund_create",
          actorType: "agent",
          actorId: t.userId,
          app: "shopify",
          metadata: { approverUserId: approverId },
          timestamp: new Date("2026-06-05T10:00:00Z"),
        })
        await db.insert(auditLog).values({
          orgId: t.orgId,
          action: "shopify:refund_create",
          actorType: "agent",
          actorId: t.userId,
          app: "shopify",
          metadata: { approverUserId: approverId },
          timestamp: new Date("2026-05-10T10:00:00Z"),
        })
      })
      const r = await t.callHandler("audit_search", {
        action: "shopify:refund_create",
        since: "2026-06-01T00:00:00Z",
        until: "2026-06-30T23:59:59Z",
      })
      expect(r.entries.length).toBe(1)
      expect(r.entries[0].approverUserId).toBe(approverId)
      expect(r.entries[0].at).toMatch(/^2026-06-05/)
    })
  })

  it("audit_search action is a SUBSTRING match — a keyword finds the exact action (l436)", async () => {
    // Regression: the agent passes a KEYWORD ('refund'), not the exact internal action string.
    // Before the fix the filter was exact `eq`, so 'refund' matched nothing; now it is ILIKE so it
    // finds 'shopify:refund_create' (and excludes a non-refund action), filtering at the DB.
    await withAdminToolTest({ scopes: ["kernel:audit:read"] }, async (t) => {
      const approverId = await t.seedUser(`approver-${crypto.randomUUID()}@t.co`)
      await withPrivilegedDb(t.orgId, "audit-seed-substr", async (db) => {
        await db.insert(auditLog).values({
          orgId: t.orgId,
          action: "shopify:refund_create",
          actorType: "agent",
          actorId: t.userId,
          app: "shopify",
          metadata: { approverUserId: approverId },
          timestamp: new Date("2026-06-08T10:00:00Z"),
        })
        await db.insert(auditLog).values({
          orgId: t.orgId,
          action: "invoicing:invoice_issue",
          actorType: "agent",
          actorId: t.userId,
          app: "invoicing",
          metadata: { approverUserId: approverId },
          timestamp: new Date("2026-06-09T10:00:00Z"),
        })
      })
      const r = await t.callHandler("audit_search", {
        action: "refund",
        since: "2026-06-01T00:00:00Z",
        until: "2026-06-30T23:59:59Z",
      })
      expect(r.entries.length).toBe(1)
      expect(r.entries[0].action).toBe("shopify:refund_create")
      expect(r.entries[0].approverUserId).toBe(approverId)
    })
  })

  it("approvals_list returns oldest-first with origin app + ageDays", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin", "shopify:approve"] }, async (t) => {
      // Seed two pending approvals via direct row inserts (origin apps differ),
      // both notifying the asking user so the decidable filter passes.
      const now = Date.now()
      const { sql: drizzleSql } = await import("drizzle-orm")
      const threadId = crypto.randomUUID()
      await withPrivilegedDb(t.orgId, "approvals-seed", async (db) => {
        await db.execute(drizzleSql`
          INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
          VALUES (${threadId}, ${t.orgId}, ${`appr-${crypto.randomUUID()}`}, 'thread', ${t.userId})
        `)
        await db.execute(drizzleSql`
          INSERT INTO kernel.approval_requests
            (org_id, handle, status, tool_name, tool_params, current_payload, thread_id, originating_thread_id, requested_by, notify_user_ids, created_at, expires_at)
          VALUES
            (${t.orgId}, 'request-9002', 'pending', 'shopify:refund_create', '{}'::jsonb, '{}'::jsonb, ${threadId}, ${threadId}, ${t.userId}, ARRAY[${t.userId}]::uuid[], ${new Date(now - 2 * 86400000).toISOString()}, ${new Date(now + 86400000).toISOString()})
        `)
        await db.execute(drizzleSql`
          INSERT INTO kernel.approval_requests
            (org_id, handle, status, tool_name, tool_params, current_payload, thread_id, originating_thread_id, requested_by, notify_user_ids, created_at, expires_at)
          VALUES
            (${t.orgId}, 'request-9001', 'pending', 'shopify:order_cancel', '{}'::jsonb, '{}'::jsonb, ${threadId}, ${threadId}, ${t.userId}, ARRAY[${t.userId}]::uuid[], ${new Date(now - 3 * 86400000).toISOString()}, ${new Date(now + 86400000).toISOString()})
        `)
      })
      const r = await t.callHandler("approvals_list", { status: "pending", sort: "oldest" })
      expect(r.approvals.length).toBe(2)
      // The AUTHORITATIVE count an agent reports after a fan-out — never truncated,
      // always === approvals.length. This is what a fanning-out parent cites for
      // "how many drafts are queued" instead of a self-tallied (over-countable)
      // number of its own spawn calls.
      expect(r.total).toBe(2)
      expect(r.total).toBe(r.approvals.length)
      expect(r.approvals[0].ageDays).toBe(3)
      expect(r.approvals[1].ageDays).toBe(2)
      expect(r.approvals[0].app).toBe("shopify")
      // Each row carries its `request-N` handle: the label the approval card
      // prints, so the agent can name a queued approval the way the UI does.
      expect(r.approvals.map((a: { handle: string }) => a.handle)).toEqual([
        "request-9001",
        "request-9002",
      ])
    })
  })

  it("approvals_list names who asked: the role agent, else the person, never an id", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin", "shopify:approve"] }, async (t) => {
      const { sql: drizzleSql } = await import("drizzle-orm")
      const threadId = crypto.randomUUID()
      const agentId = crypto.randomUUID()
      const expires = new Date(Date.now() + 86400000).toISOString()
      await withPrivilegedDb(t.orgId, "approvals-requester-seed", async (db) => {
        await db.execute(drizzleSql`
          INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
          VALUES (${agentId}, ${t.orgId}, 'role', ${`@support-${agentId.slice(0, 8)}`}, 'Support')
        `)
        await db.execute(drizzleSql`
          INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
          VALUES (${threadId}, ${t.orgId}, ${`appr-${crypto.randomUUID()}`}, 'thread', ${t.userId})
        `)
        await db.execute(drizzleSql`
          INSERT INTO kernel.approval_requests
            (org_id, handle, status, tool_name, tool_params, current_payload, thread_id, originating_thread_id, requested_by, notify_user_ids, expires_at, agent_id)
          VALUES
            (${t.orgId}, 'request-9101', 'pending', 'shopify:order_cancel', '{}'::jsonb, '{}'::jsonb, ${threadId}, ${threadId}, ${t.userId}, ARRAY[${t.userId}]::uuid[], ${expires}, ${agentId}),
            (${t.orgId}, 'request-9102', 'pending', 'shopify:order_cancel', '{}'::jsonb, '{}'::jsonb, ${threadId}, ${threadId}, ${t.userId}, ARRAY[${t.userId}]::uuid[], ${expires}, NULL)
        `)
      })
      const r = await t.callHandler("approvals_list", { status: "pending" })
      const by = (handle: string) =>
        r.approvals.find((a: { handle: string }) => a.handle === handle)?.requester
      expect(by("request-9101")).toBe("Support")
      expect(by("request-9102")).toBe("Admin Tester")
    })
  })

  it("approvals_list also returns requests decided in the last 24h, apart from the pending queue (a denied request is reported as denied, never as pending)", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin", "shopify:approve"] }, async (t) => {
      const { sql: drizzleSql } = await import("drizzle-orm")
      const threadId = crypto.randomUUID()
      const now = Date.now()
      const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()
      const otherUserId = await t.seedUser(`other-${crypto.randomUUID()}@t.co`)
      await withPrivilegedDb(t.orgId, "approvals-decided-seed", async (db) => {
        await db.execute(drizzleSql`
          INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
          VALUES (${threadId}, ${t.orgId}, ${`appr-${crypto.randomUUID()}`}, 'thread', ${t.userId})
        `)
        await db.execute(drizzleSql`
          INSERT INTO kernel.approval_requests
            (org_id, handle, status, tool_name, tool_params, current_payload, thread_id, originating_thread_id, requested_by, notify_user_ids, created_at, expires_at, decided_by, decided_at, reason)
          VALUES
            (${t.orgId}, 'request-9201', 'pending', 'shopify:order_cancel', '{}'::jsonb, '{}'::jsonb, ${threadId}, ${threadId}, ${t.userId}, ARRAY[${t.userId}]::uuid[], ${iso(-7200000)}, ${iso(86400000)}, NULL, NULL, NULL),
            (${t.orgId}, 'request-9202', 'denied', 'shopify:refund_create', '{}'::jsonb, '{}'::jsonb, ${threadId}, ${threadId}, ${t.userId}, ARRAY[${t.userId}]::uuid[], ${iso(-7200000)}, ${iso(86400000)}, ${t.userId}, ${iso(-3600000)}, 'Wrong customer'),
            (${t.orgId}, 'request-9203', 'withdrawn', 'shopify:order_cancel', '{}'::jsonb, '{}'::jsonb, ${threadId}, ${threadId}, ${t.userId}, ARRAY[${t.userId}]::uuid[], ${iso(-7200000)}, ${iso(86400000)}, ${t.userId}, ${iso(-1800000)}, NULL),
            (${t.orgId}, 'request-9204', 'approved', 'shopify:order_cancel', '{}'::jsonb, '{}'::jsonb, ${threadId}, ${threadId}, ${t.userId}, ARRAY[${t.userId}]::uuid[], ${iso(-40 * 3600000)}, ${iso(86400000)}, ${t.userId}, ${iso(-30 * 3600000)}, NULL),
            (${t.orgId}, 'request-9205', 'denied', 'shopify:order_cancel', '{}'::jsonb, '{}'::jsonb, ${threadId}, ${threadId}, ${otherUserId}, ARRAY[${otherUserId}]::uuid[], ${iso(-7200000)}, ${iso(86400000)}, ${otherUserId}, ${iso(-600000)}, NULL),
            (${t.orgId}, 'request-9206', 'expired', 'shopify:order_cancel', '{}'::jsonb, '{}'::jsonb, ${threadId}, ${threadId}, ${t.userId}, ARRAY[${t.userId}]::uuid[], ${iso(-5 * 3600000)}, ${iso(-1200000)}, NULL, NULL, NULL)
        `)
      })
      const r = await t.callHandler("approvals_list", {})
      // The pending queue is unchanged: only the undecided request, counted by `total`.
      expect(r.approvals.map((a: { handle: string }) => a.handle)).toEqual(["request-9201"])
      expect(r.total).toBe(1)
      // Decided within 24h, newest decision first; the 30h-old one and another
      // user's private request (not requester, not notified) are absent.
      const decided = r.recentlyDecided as Array<{
        handle: string
        status: string
        decidedAt: string | null
        decidedBy: string | null
        reason: string | null
      }>
      expect(decided.map((d) => d.handle)).toEqual(["request-9206", "request-9203", "request-9202"])
      const denied = decided.find((d) => d.handle === "request-9202")
      expect(denied?.status).toBe("denied")
      expect(denied?.decidedBy).toBe("Admin Tester")
      expect(denied?.reason).toBe("Wrong customer")
      expect(denied?.decidedAt).toBe(iso(-3600000))
      const expired = decided.find((d) => d.handle === "request-9206")
      expect(expired?.status).toBe("expired")
      expect(expired?.decidedBy).toBeNull()
      // Expiry stamps no decided_at: the request closed at its deadline.
      expect(expired?.decidedAt).toBe(iso(-1200000))
    })
  })

  it("approvals_list says a pending request was approved, attempted and failed, and why (walk N3)", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin", "shopify:approve"] }, async (t) => {
      const { sql: drizzleSql } = await import("drizzle-orm")
      const threadId = crypto.randomUUID()
      const requestId = crypto.randomUUID()
      await withPrivilegedDb(t.orgId, "approvals-list-failure-seed", async (db) => {
        await db.execute(drizzleSql`
          INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
          VALUES (${threadId}, ${t.orgId}, ${`appr-${crypto.randomUUID()}`}, 'thread', ${t.userId})
        `)
        await db.execute(drizzleSql`
          INSERT INTO kernel.approval_requests
            (id, org_id, handle, status, tool_name, tool_params, current_payload, thread_id, originating_thread_id, requested_by, notify_user_ids, expires_at)
          VALUES
            (${requestId}, ${t.orgId}, 'request-9301', 'pending', 'shopify:order_cancel', '{}'::jsonb, '{}'::jsonb, ${threadId}, ${threadId}, ${t.userId}, ARRAY[${t.userId}]::uuid[], now() + interval '1 day')
        `)
        await db.execute(drizzleSql`
          INSERT INTO kernel.approved_handler_executions
            (org_id, approval_request_id, tool_name, status, actor_id, attempts, last_attempt_at, finished_at, error)
          VALUES
            (${t.orgId}, ${requestId}, 'shopify:order_cancel', 'failed_no_effect', ${t.userId}, 1, now(), now(), ${JSON.stringify({ code: "order_closed", message: "The order is already closed" })}::jsonb)
        `)
      })
      const r = await t.callHandler("approvals_list", {})
      const failure = r.approvals[0].lastFailure as Record<string, unknown>
      expect(failure.code).toBe("order_closed")
      expect(failure.message).toBe("The order is already closed")
      expect(failure.state).toContain("was approved and its call was attempted")
      expect(failure.state).toContain("waiting for a decision again")
    })
  })

  it("approvals_list carries no failure line on a request that never failed", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin", "shopify:approve"] }, async (t) => {
      const { sql: drizzleSql } = await import("drizzle-orm")
      const threadId = crypto.randomUUID()
      await withPrivilegedDb(t.orgId, "approvals-list-clean-seed", async (db) => {
        await db.execute(drizzleSql`
          INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
          VALUES (${threadId}, ${t.orgId}, ${`appr-${crypto.randomUUID()}`}, 'thread', ${t.userId})
        `)
        await db.execute(drizzleSql`
          INSERT INTO kernel.approval_requests
            (org_id, handle, status, tool_name, tool_params, current_payload, thread_id, originating_thread_id, requested_by, notify_user_ids, expires_at)
          VALUES
            (${t.orgId}, 'request-9302', 'pending', 'shopify:order_cancel', '{}'::jsonb, '{}'::jsonb, ${threadId}, ${threadId}, ${t.userId}, ARRAY[${t.userId}]::uuid[], now() + interval '1 day')
        `)
      })
      const r = await t.callHandler("approvals_list", {})
      expect("lastFailure" in r.approvals[0]).toBe(false)
    })
  })

  it("approvals_list surfaces editableFields + currentPayload + toolName so the agent can correct an editable field (edit-gated-invoice-payment-terms-before-approve)", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin", "invoicing:approve"] }, async (t) => {
      // Register an editable `due_at` field for the gated invoice-issue tool, exactly as the manifest
      // does at app registration — approvals_list must echo it so the agent learns the terms can be
      // corrected on the pending request (rather than guessing whether it is editable).
      approvalEditableFieldsRegistry.set(
        [t.orgId, "invoicing", "invoice_issue"],
        [{ field: "due_at", label: "Payment due date (terms)", widget: "text" }],
      )
      const now = Date.now()
      const { sql: drizzleSql } = await import("drizzle-orm")
      const threadId = crypto.randomUUID()
      await withPrivilegedDb(t.orgId, "approvals-editable-seed", async (db) => {
        await db.execute(drizzleSql`
          INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
          VALUES (${threadId}, ${t.orgId}, ${`appr-${crypto.randomUUID()}`}, 'thread', ${t.userId})
        `)
        await db.execute(drizzleSql`
          INSERT INTO kernel.approval_requests
            (org_id, handle, status, tool_name, tool_params, current_payload, thread_id, originating_thread_id, requested_by, notify_user_ids, created_at, expires_at)
          VALUES
            (${t.orgId}, ${crypto.randomUUID()}, 'pending', 'invoicing:invoice_issue',
             ${'{"draft_id":"d1","due_at":"2026-07-20"}'}::jsonb, ${'{"draft_id":"d1","due_at":"2026-07-20"}'}::jsonb,
             ${threadId}, ${threadId}, ${t.userId}, ARRAY[${t.userId}]::uuid[],
             ${new Date(now - 86400000).toISOString()}, ${new Date(now + 86400000).toISOString()})
        `)
      })
      const r = (await t.callHandler("approvals_list", { status: "pending" })) as {
        approvals: Array<{
          toolName: string
          editableFields: Array<{ field: string; label: string; widget: string }>
          currentPayload: unknown
        }>
      }
      const item = r.approvals.find((a) => a.toolName === "invoicing:invoice_issue")
      expect(item).toBeDefined()
      expect(item?.editableFields).toEqual([
        { field: "due_at", label: "Payment due date (terms)", widget: "text" },
      ])
      expect(item?.currentPayload).toEqual({ draft_id: "d1", due_at: "2026-07-20" })
    })
  })
})

describe("kernel-admin writes — invite_user / assign_role", () => {
  it("invite_user under approver RLS returns an invite url", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:users:admin", "tickets:tickets:read"] },
      async (t) => {
        const roleId = await t.seedRole("Support Agent", ["tickets:tickets:read"])
        const r = await t.callHandler("invite_user", {
          email: `newhire-${crypto.randomUUID()}@example.test`,
          roleId,
        })
        expect(r.inviteUrl).toMatch(/^https?:\/\//)
      },
    )
  })

  it("invite_user resolves the role by roleName (onboarding: create_role + invite same turn → no uuid yet)", async () => {
    // The onboard-july 3x-gate failure: the agent raised create_role + invite_user in one turn, so
    // the role had no uuid to pass to invite_user → it passed a placeholder → NOT_FOUND on approval.
    // The fix lets invite_user reference the role by NAME, resolved at execution time once the role
    // exists. Here the role exists by name; the invite must resolve it and return an invite url.
    await withAdminToolTest(
      { scopes: ["kernel:users:admin", "tickets:tickets:read", "tickets:tickets:reply"] },
      async (t) => {
        await t.seedRole("Customer Success Lead", ["tickets:tickets:read", "tickets:tickets:reply"])
        const r = await t.callHandler("invite_user", {
          email: `july-${crypto.randomUUID()}@example.test`,
          roleName: "Customer Success Lead", // no roleId — resolved by name
        })
        expect(r.inviteUrl).toMatch(/^https?:\/\//)
      },
    )
  })

  it("invite_user surfaces a precise NOT_FOUND when the named role does not exist (never silently swallowed)", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      const r = await t.callHandler("invite_user", {
        email: `ghost-${crypto.randomUUID()}@example.test`,
        roleName: "No Such Role",
      })
      expect(r.error.code).toBe("NOT_FOUND")
      expect(r.error.message).toContain("No Such Role")
    })
  }, 60_000)

  it("assign_role returns SCOPE_ESCALATION when approver lacks a role scope", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      const roleId = await t.seedRole("Finance", ["invoicing:documents:write", "invoicing:approve"])
      const targetUser = await t.seedUser(`target-${crypto.randomUUID()}@t.co`)
      const r = await t.callHandler("assign_role", { userId: targetUser, roleId })
      expect(r.error.code).toBe("SCOPE_ESCALATION")
    })
  })

  it("gated invite_user via executeTool yields an approval request, not execution", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:users:admin", "tickets:tickets:read"] },
      async (t) => {
        await registerKernelAgentTools(t.orgId)
        const roleId = await t.seedRole("Support Agent", ["tickets:tickets:read"])
        // a thread the actor participates in (gated approval lives in a thread)
        const threadId = crypto.randomUUID()
        await withPrivilegedDb(t.orgId, "gated-thread-seed", async (db) => {
          await db.execute(
            (await import("drizzle-orm")).sql`
              INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
              VALUES (${threadId}, ${t.orgId}, ${`t-${crypto.randomUUID()}`}, 'thread', ${t.userId})
            `,
          )
          await db.execute(
            (await import("drizzle-orm")).sql`
              INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
              VALUES (${threadId}, ${t.userId}, ${t.orgId}, 'admin')
            `,
          )
          await db.execute(
            (await import("drizzle-orm")).sql`
              INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
              VALUES (${t.userId}, ${threadId}, ${t.orgId})
            `,
          )
        })
        const result = await executeTool({
          toolName: "kernel:invite_user",
          orgId: t.orgId,
          actor: actor(t.orgId, t.userId, ["kernel:users:admin"]),
          threadId,
          params: { email: `gated-${crypto.randomUUID()}@example.test`, roleId },
          origin: "in-app-agent",
        })
        expect(result.blocked?.reason).toBe("gated")
        expect(result.blocked?.approvalRequestId).toBeTruthy()
        toolRegistry.deleteByPrefix([t.orgId])
      },
    )
  })
})

describe("kernel-admin writes — remove_user_from_role (offboarding the access half)", () => {
  it("removes a role the member holds (removed:true) and deletes the user_roles row", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:users:admin", "tickets:tickets:read"] },
      async (t) => {
        const roleId = await t.seedRole("Support Agent", ["tickets:tickets:read"])
        const target = await t.seedUser(`leaver-${crypto.randomUUID()}@t.co`)
        // Member holds the role.
        await withSystemDb("seed-user-role", (db) =>
          db.insert(userRoles).values({ userId: target, roleId, orgId: t.orgId }),
        )
        const r = await t.callHandler("remove_user_from_role", { userId: target, roleId })
        expect(r.removed).toBe(true)
        const rows = await withSystemDb("verify-remove", (db) =>
          db
            .select({ roleId: userRoles.roleId })
            .from(userRoles)
            .where(eq(userRoles.userId, target)),
        )
        expect(rows.map((x) => x.roleId)).not.toContain(roleId)
      },
    )
  })

  it("removing a role the member does NOT hold is an idempotent no-op (removed:false), not an error", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:users:admin", "tickets:tickets:read"] },
      async (t) => {
        const roleId = await t.seedRole("Support Agent", ["tickets:tickets:read"])
        const target = await t.seedUser(`never-held-${crypto.randomUUID()}@t.co`)
        const r = await t.callHandler("remove_user_from_role", { userId: target, roleId })
        expect(r.error).toBeUndefined()
        expect(r.removed).toBe(false)
      },
    )
  })

  it("returns SCOPE_ESCALATION when the approver lacks a scope the role grants", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      // Approver holds kernel:users:admin but NOT invoicing scopes, so it cannot
      // remove a role that grants them (symmetric escalation guard).
      const roleId = await t.seedRole("Finance", ["invoicing:documents:write", "invoicing:approve"])
      const target = await t.seedUser(`finance-${crypto.randomUUID()}@t.co`)
      await withSystemDb("seed-user-role", (db) =>
        db.insert(userRoles).values({ userId: target, roleId, orgId: t.orgId }),
      )
      const r = await t.callHandler("remove_user_from_role", { userId: target, roleId })
      expect(r.error.code).toBe("SCOPE_ESCALATION")
    })
  })

  it("is registered as a GATED tool — executeTool yields an approval request, not execution", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:users:admin", "tickets:tickets:read"] },
      async (t) => {
        await registerKernelAgentTools(t.orgId)
        const roleId = await t.seedRole("Support Agent", ["tickets:tickets:read"])
        const target = await t.seedUser(`leaver-${crypto.randomUUID()}@t.co`)
        await withSystemDb("seed-user-role", (db) =>
          db.insert(userRoles).values({ userId: target, roleId, orgId: t.orgId }),
        )
        const threadId = crypto.randomUUID()
        await withPrivilegedDb(t.orgId, "gated-thread-seed", async (db) => {
          await db.execute(
            (await import("drizzle-orm")).sql`
              INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
              VALUES (${threadId}, ${t.orgId}, ${`t-${crypto.randomUUID()}`}, 'thread', ${t.userId})
            `,
          )
          await db.execute(
            (await import("drizzle-orm")).sql`
              INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
              VALUES (${threadId}, ${t.userId}, ${t.orgId}, 'admin')
            `,
          )
          await db.execute(
            (await import("drizzle-orm")).sql`
              INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
              VALUES (${t.userId}, ${threadId}, ${t.orgId})
            `,
          )
        })
        const result = await executeTool({
          toolName: "kernel:remove_user_from_role",
          orgId: t.orgId,
          actor: actor(t.orgId, t.userId, ["kernel:users:admin", "tickets:tickets:read"]),
          threadId,
          params: { userId: target, roleId },
          origin: "in-app-agent",
        })
        expect(result.blocked?.reason).toBe("gated")
        expect(result.blocked?.approvalRequestId).toBeTruthy()
        // The role row is still present — gating means the removal did NOT execute yet.
        const rows = await withSystemDb("verify-still-held", (db) =>
          db
            .select({ roleId: userRoles.roleId })
            .from(userRoles)
            .where(eq(userRoles.userId, target)),
        )
        expect(rows.map((x) => x.roleId)).toContain(roleId)
        toolRegistry.deleteByPrefix([t.orgId])
      },
    )
  })
})

describe("kernel-admin reads — list_scopes", () => {
  it("returns the full scope catalog including kernel scopes", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      const r = await t.callHandler("list_scopes", {})
      const scopes = r.scopes.map((s: { scope: string }) => s.scope)
      // The hardcoded kernel catalog is always present.
      expect(scopes).toContain("kernel:users:admin")
      expect(scopes).toContain("kernel:approvals:write")
      // Every entry carries its owning app.
      for (const s of r.scopes) expect(typeof s.app).toBe("string")
    })
  })

  it("the `app` filter narrows the catalog to one app's scopes", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      const kernelOnly = await t.callHandler("list_scopes", { app: "kernel" })
      expect(kernelOnly.scopes.length).toBeGreaterThan(0)
      expect(kernelOnly.scopes.every((s: { app: string }) => s.app === "kernel")).toBe(true)
      // An app with no registered scopes returns an empty list (never throws).
      const none = await t.callHandler("list_scopes", { app: "no-such-app" })
      expect(none.scopes).toEqual([])
    })
  })
})

describe("kernel-admin writes — grant_user_scope (granular per-user)", () => {
  it("grants a direct user-level scope the approver holds", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:users:admin", "tickets:tickets:read"] },
      async (t) => {
        const target = await t.seedUser(`grantee-${crypto.randomUUID()}@t.co`)
        const r = await t.callHandler("grant_user_scope", {
          userId: target,
          grant: ["tickets:tickets:read"],
        })
        expect(r.granted).toEqual(["tickets:tickets:read"])
        const rows = await withSystemDb("verify-grant", (db) =>
          db
            .select({ scope: userScopeGrants.scope })
            .from(userScopeGrants)
            .where(eq(userScopeGrants.userId, target)),
        )
        expect(rows.map((x) => x.scope)).toContain("tickets:tickets:read")
      },
    )
  })

  it("SCOPE_ESCALATION when the approver does not hold the scope being granted", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      const target = await t.seedUser(`grantee-${crypto.randomUUID()}@t.co`)
      const r = await t.callHandler("grant_user_scope", {
        userId: target,
        grant: ["invoicing:documents:write"],
      })
      expect(r.error.code).toBe("SCOPE_ESCALATION")
    })
  })

  it("revoke removes a direct grant; empty grant+revoke is a NO_OP", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:users:admin", "tickets:tickets:read"] },
      async (t) => {
        const target = await t.seedUser(`grantee-${crypto.randomUUID()}@t.co`)
        await t.callHandler("grant_user_scope", { userId: target, grant: ["tickets:tickets:read"] })
        const rev = await t.callHandler("grant_user_scope", {
          userId: target,
          revoke: ["tickets:tickets:read"],
        })
        expect(rev.revoked).toEqual(["tickets:tickets:read"])
        const rows = await withSystemDb("verify-revoke", (db) =>
          db
            .select({ scope: userScopeGrants.scope })
            .from(userScopeGrants)
            .where(eq(userScopeGrants.userId, target)),
        )
        expect(rows.map((x) => x.scope)).not.toContain("tickets:tickets:read")

        const noop = await t.callHandler("grant_user_scope", { userId: target })
        expect(noop.error.code).toBe("NO_OP")
      },
    )
  })
})

describe("kernel-admin reads — get_role (exact per-role scope strings)", () => {
  it("returns a role's exact scope STRINGS, name, and members", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      const roleId = await t.seedRole("Finance Detail", [
        "invoicing:documents:write",
        "invoicing:approve",
      ])
      const r = await t.callHandler("get_role", { roleId })
      expect(r.role.id).toBe(roleId)
      const scopeStrings = r.role.scopes.map((s: { scope: string }) => s.scope)
      expect(scopeStrings).toContain("invoicing:documents:write")
      expect(scopeStrings).toContain("invoicing:approve")
      expect(Array.isArray(r.role.members)).toBe(true)
    })
  })

  it("returns ROLE_NOT_FOUND for a bad id (never a fabricated scope list)", async () => {
    await withAdminToolTest({ scopes: ["kernel:users:admin"] }, async (t) => {
      const r = await t.callHandler("get_role", { roleId: crypto.randomUUID() })
      expect(r.error.code).toBe("ROLE_NOT_FOUND")
    })
  })
})

describe("kernel-admin writes — edit_role (role-level rename / re-describe / scope edits)", () => {
  it("adds and removes scopes on a role and returns the resulting scope set", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:roles:admin", "tickets:tickets:read", "shopify:approve"] },
      async (t) => {
        const roleId = await t.seedRole("Approvers", ["tickets:tickets:read"])
        const r = await t.callHandler("edit_role", {
          roleId,
          grantScopes: ["shopify:approve"],
          revokeScopes: ["tickets:tickets:read"],
        })
        expect(r.scopes).toContain("shopify:approve")
        expect(r.scopes).not.toContain("tickets:tickets:read")
        const rows = await withSystemDb("verify-edit-role", (db) =>
          db
            .select({ scope: roleScopeGrants.scope })
            .from(roleScopeGrants)
            .where(eq(roleScopeGrants.roleId, roleId)),
        )
        const dbScopes = rows.map((x) => x.scope)
        expect(dbScopes).toContain("shopify:approve")
        expect(dbScopes).not.toContain("tickets:tickets:read")
      },
    )
  }, 60_000)

  it("renames and re-describes a role", async () => {
    await withAdminToolTest({ scopes: ["kernel:roles:admin"] }, async (t) => {
      const roleId = await t.seedRole("Old Name", [])
      const r = await t.callHandler("edit_role", {
        roleId,
        name: "New Name",
        description: "the new description",
      })
      expect(r.name).toBe("New Name")
      expect(r.description).toBe("the new description")
    })
  }, 60_000)

  it("SCOPE_ESCALATION when a scope in the batch exceeds the actor — and the WHOLE edit rolls back", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:roles:admin", "tickets:tickets:read"] },
      async (t) => {
        const roleId = await t.seedRole("Mixed Grant", [])
        // One scope the actor holds (tickets:tickets:read) + one it does NOT
        // (invoicing:documents:write). The batch is atomic, so NEITHER should land.
        const r = await t.callHandler("edit_role", {
          roleId,
          grantScopes: ["tickets:tickets:read", "invoicing:documents:write"],
        })
        expect(r.error.code).toBe("SCOPE_ESCALATION")
        const rows = await withSystemDb("verify-edit-rollback", (db) =>
          db
            .select({ scope: roleScopeGrants.scope })
            .from(roleScopeGrants)
            .where(eq(roleScopeGrants.roleId, roleId)),
        )
        // Atomic rollback: the scope the actor DID hold was not persisted either.
        expect(rows.length).toBe(0)
      },
    )
  }, 60_000)

  it("ROLE_NOT_FOUND for a bad roleId", async () => {
    await withAdminToolTest({ scopes: ["kernel:roles:admin"] }, async (t) => {
      const r = await t.callHandler("edit_role", {
        roleId: crypto.randomUUID(),
        grantScopes: ["tickets:tickets:read"],
      })
      expect(r.error.code).toBe("ROLE_NOT_FOUND")
    })
  }, 60_000)

  it("NO_OP when no field is passed", async () => {
    await withAdminToolTest({ scopes: ["kernel:roles:admin"] }, async (t) => {
      const roleId = await t.seedRole("Untouched", [])
      const r = await t.callHandler("edit_role", { roleId })
      expect(r.error.code).toBe("NO_OP")
    })
  }, 60_000)

  it("INVALID_EDIT when renaming a system-managed role, but scope edits still apply", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:roles:admin", "tickets:tickets:read"] },
      async (t) => {
        const sysRoleId = await withSystemDb("seed-sys-role", async (db) => {
          const [r] = await db
            .insert(rolesTable)
            .values({
              orgId: t.orgId,
              name: `Sys-${crypto.randomUUID()}`,
              systemManaged: true,
            })
            .returning({ id: rolesTable.id })
          return r.id
        })
        const renamed = await t.callHandler("edit_role", { roleId: sysRoleId, name: "Nope" })
        expect(renamed.error.code).toBe("INVALID_EDIT")
        // Scope edits on a system role ARE allowed (only rename is refused).
        const scoped = await t.callHandler("edit_role", {
          roleId: sysRoleId,
          grantScopes: ["tickets:tickets:read"],
        })
        expect(scoped.scopes).toContain("tickets:tickets:read")
      },
    )
  }, 60_000)
})

describe("kernel-admin writes — delete_role (retiring a role definition outright)", () => {
  async function roleExists(roleId: string): Promise<boolean> {
    const rows = await withSystemDb("verify-delete-role", (db) =>
      db.select({ id: rolesTable.id }).from(rolesTable).where(eq(rolesTable.id, roleId)),
    )
    return rows.length > 0
  }

  it("deletes a role nobody holds and the row is gone", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:roles:admin", "tickets:tickets:read"] },
      async (t) => {
        const roleId = await t.seedRole("Superseded", ["tickets:tickets:read"])
        const r = await t.callHandler("delete_role", { roleId })
        expect(r.deleted).toBe(true)
        expect(r.name).toBe("Superseded")
        expect(await roleExists(roleId)).toBe(false)
      },
    )
  }, 60_000)

  it("ROLE_IN_USE while a member still holds it — and the role SURVIVES", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:roles:admin", "tickets:tickets:read"] },
      async (t) => {
        const roleId = await t.seedRole("Still Held", ["tickets:tickets:read"])
        const target = await t.seedUser(`holder-${crypto.randomUUID()}@t.co`)
        await withSystemDb("seed-user-role-delete", (db) =>
          db.insert(userRoles).values({ userId: target, roleId, orgId: t.orgId }),
        )
        const r = await t.callHandler("delete_role", { roleId })
        expect(r.error.code).toBe("ROLE_IN_USE")
        // The whole safety property of delete_role: it can never strip a live member.
        expect(await roleExists(roleId)).toBe(true)
      },
    )
  }, 60_000)

  it("ROLE_SYSTEM_MANAGED for a system-managed role — and the role SURVIVES", async () => {
    await withAdminToolTest({ scopes: ["kernel:roles:admin"] }, async (t) => {
      const sysRoleId = await withSystemDb("seed-sys-role-delete", async (db) => {
        const [r] = await db
          .insert(rolesTable)
          .values({ orgId: t.orgId, name: `Sys-${crypto.randomUUID()}`, systemManaged: true })
          .returning({ id: rolesTable.id })
        return r.id
      })
      const r = await t.callHandler("delete_role", { roleId: sysRoleId })
      expect(r.error.code).toBe("ROLE_SYSTEM_MANAGED")
      // Deleting it would be undone by the runtime, so it must not report success.
      expect(await roleExists(sysRoleId)).toBe(true)
    })
  }, 60_000)

  it("SCOPE_ESCALATION when the role grants a scope the actor does NOT hold — role SURVIVES", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:roles:admin", "tickets:tickets:read"] },
      async (t) => {
        // The actor may administer roles, but does not hold invoicing:documents:write.
        // Without the guard it could erase a more powerful role's definition.
        const roleId = await t.seedRole("Finance", ["invoicing:documents:write"])
        const r = await t.callHandler("delete_role", { roleId })
        expect(r.error.code).toBe("SCOPE_ESCALATION")
        expect(r.error.message).toContain("invoicing:documents:write")
        expect(await roleExists(roleId)).toBe(true)
      },
    )
  }, 60_000)

  it("ROLE_NOT_FOUND for a bad roleId", async () => {
    await withAdminToolTest({ scopes: ["kernel:roles:admin"] }, async (t) => {
      const r = await t.callHandler("delete_role", { roleId: crypto.randomUUID() })
      expect(r.error.code).toBe("ROLE_NOT_FOUND")
    })
  }, 60_000)
})

describe("kernel-admin gated writes — create_role / grant_user_scope require approval", () => {
  async function seedActorThread(t: AdminToolTest): Promise<string> {
    const threadId = crypto.randomUUID()
    const { sql: drizzleSql } = await import("drizzle-orm")
    await withPrivilegedDb(t.orgId, "gated-thread-seed", async (db) => {
      await db.execute(drizzleSql`
        INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${threadId}, ${t.orgId}, ${`t-${crypto.randomUUID()}`}, 'thread', ${t.userId})
      `)
      await db.execute(drizzleSql`
        INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
        VALUES (${threadId}, ${t.userId}, ${t.orgId}, 'admin')
      `)
      await db.execute(drizzleSql`
        INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
        VALUES (${t.userId}, ${threadId}, ${t.orgId})
      `)
    })
    return threadId
  }

  it("gated create_role via executeTool yields an approval request, not execution", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:roles:admin", "tickets:tickets:read"] },
      async (t) => {
        await registerKernelAgentTools(t.orgId)
        const threadId = await seedActorThread(t)
        const result = await executeTool({
          toolName: "kernel:create_role",
          orgId: t.orgId,
          actor: actor(t.orgId, t.userId, ["kernel:roles:admin", "tickets:tickets:read"]),
          threadId,
          params: { name: `CS-${crypto.randomUUID()}`, scopes: ["tickets:tickets:read"] },
          origin: "in-app-agent",
        })
        expect(result.blocked?.reason).toBe("gated")
        expect(result.blocked?.approvalRequestId).toBeTruthy()
        toolRegistry.deleteByPrefix([t.orgId])
      },
    )
  })

  it("gated grant_user_scope via executeTool yields an approval request, not execution", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:users:admin", "tickets:tickets:read"] },
      async (t) => {
        await registerKernelAgentTools(t.orgId)
        const target = await t.seedUser(`grantee-${crypto.randomUUID()}@t.co`)
        const threadId = await seedActorThread(t)
        const result = await executeTool({
          toolName: "kernel:grant_user_scope",
          orgId: t.orgId,
          actor: actor(t.orgId, t.userId, ["kernel:users:admin", "tickets:tickets:read"]),
          threadId,
          params: { userId: target, grant: ["tickets:tickets:read"] },
          origin: "in-app-agent",
        })
        expect(result.blocked?.reason).toBe("gated")
        expect(result.blocked?.approvalRequestId).toBeTruthy()
        toolRegistry.deleteByPrefix([t.orgId])
      },
    )
  })

  it("gated edit_role via executeTool PROPOSES an approval request, does not modify the role", async () => {
    await withAdminToolTest(
      { scopes: ["kernel:roles:admin", "tickets:tickets:read"] },
      async (t) => {
        await registerKernelAgentTools(t.orgId)
        const roleId = await t.seedRole("To Strengthen", [])
        const threadId = await seedActorThread(t)
        const result = await executeTool({
          toolName: "kernel:edit_role",
          orgId: t.orgId,
          actor: actor(t.orgId, t.userId, ["kernel:roles:admin", "tickets:tickets:read"]),
          threadId,
          params: { roleId, grantScopes: ["tickets:tickets:read"] },
          origin: "in-app-agent",
        })
        expect(result.blocked?.reason).toBe("gated")
        expect(result.blocked?.approvalRequestId).toBeTruthy()
        // Proposed, not executed: the role still has no scope grants.
        const rows = await withSystemDb("verify-edit-not-executed", (db) =>
          db
            .select({ scope: roleScopeGrants.scope })
            .from(roleScopeGrants)
            .where(eq(roleScopeGrants.roleId, roleId)),
        )
        expect(rows.length).toBe(0)
        toolRegistry.deleteByPrefix([t.orgId])
      },
    )
  })
})

// ---------------------------------------------------------------------------
// P2b-T27: audit history keyed by the ACTING AGENT (A11). "What did the
// logistics agent do" must be answerable from the agent id alone, independent
// of which human triggered the turn and of the row's actorType. Authorization
// is unchanged: audit_search stays behind kernel:audit:read, and the /api/audit
// route keeps its own requireScope gate; nothing here adds a second one.
// Every case seeds a DECOY row under a different agent sharing the action
// keyword, so a query that ignored agentId would over-return and fail.
// ---------------------------------------------------------------------------
describe("kernel-admin reads: audit_search keyed by agentId", () => {
  /** A kernel.agents row. `archivedAt` marks it archived, never deleted. */
  async function seedAgent(
    orgId: string,
    handle: string,
    opts: { ownerUserId?: string; archivedAt?: Date } = {},
  ): Promise<string> {
    return withSystemDb("t27-seed-agent", async (db) => {
      const [a] = await db
        .insert(agents)
        .values({
          orgId,
          kind: opts.ownerUserId ? "personal" : "role",
          handle,
          displayName: handle,
          ownerUserId: opts.ownerUserId ?? null,
          archivedAt: opts.archivedAt ?? null,
        })
        .returning({ id: agents.id })
      return a.id
    })
  }

  /** One audit_log row. `agentId: null` is a human-only row. */
  async function seedAuditRow(row: {
    orgId: string
    action: string
    actorType: "user" | "agent" | "system" | "mcp"
    actorId: string | null
    agentId: string | null
  }): Promise<void> {
    await withSystemDb("t27-seed-audit", (db) =>
      db.insert(auditLog).values({
        orgId: row.orgId,
        action: row.action,
        actorType: row.actorType,
        actorId: row.actorId,
        agentId: row.agentId,
        app: "kernel",
      }),
    )
  }

  const actionsOf = (r: { entries: Array<{ action: string }> }): string[] =>
    r.entries.map((e) => e.action).sort()

  it("audit_search filtered by agentId returns rows across every actorType (user, agent, mcp, system)", async () => {
    await withAdminToolTest({ scopes: ["kernel:audit:read"] }, async (t) => {
      const tag = crypto.randomUUID().slice(0, 8)
      const agentId = await seedAgent(t.orgId, `@t27-multi-${tag}`)
      const other = await seedAgent(t.orgId, `@t27-multi-other-${tag}`)
      for (const actorType of ["user", "agent", "mcp", "system"] as const) {
        await seedAuditRow({
          orgId: t.orgId,
          action: `t27multi.${actorType}`,
          actorType,
          actorId: actorType === "user" || actorType === "agent" ? t.userId : null,
          agentId,
        })
      }
      // Decoy: same keyword, a different agent.
      await seedAuditRow({
        orgId: t.orgId,
        action: "t27multi.decoy",
        actorType: "agent",
        actorId: t.userId,
        agentId: other,
      })

      const r = await t.callHandler("audit_search", { agentId, action: "t27multi" })
      expect(actionsOf(r)).toEqual([
        "t27multi.agent",
        "t27multi.mcp",
        "t27multi.system",
        "t27multi.user",
      ])
    })
  })

  it("two agents in one org are separable by agent id", async () => {
    await withAdminToolTest({ scopes: ["kernel:audit:read"] }, async (t) => {
      const tag = crypto.randomUUID().slice(0, 8)
      const logistics = await seedAgent(t.orgId, `@t27-logistics-${tag}`)
      const finance = await seedAgent(t.orgId, `@t27-finance-${tag}`)
      await seedAuditRow({
        orgId: t.orgId,
        action: "t27sep.logistics.a",
        actorType: "agent",
        actorId: t.userId,
        agentId: logistics,
      })
      await seedAuditRow({
        orgId: t.orgId,
        action: "t27sep.logistics.b",
        actorType: "user",
        actorId: t.userId,
        agentId: logistics,
      })
      await seedAuditRow({
        orgId: t.orgId,
        action: "t27sep.finance",
        actorType: "agent",
        actorId: t.userId,
        agentId: finance,
      })

      expect(
        actionsOf(await t.callHandler("audit_search", { agentId: logistics, action: "t27sep" })),
      ).toEqual(["t27sep.logistics.a", "t27sep.logistics.b"])
      expect(
        actionsOf(await t.callHandler("audit_search", { agentId: finance, action: "t27sep" })),
      ).toEqual(["t27sep.finance"])
    })
  })

  it("the same agent's rows come back whatever human triggered the turn", async () => {
    await withAdminToolTest({ scopes: ["kernel:audit:read"] }, async (t) => {
      const tag = crypto.randomUUID().slice(0, 8)
      const agentId = await seedAgent(t.orgId, `@t27-shared-${tag}`)
      const other = await seedAgent(t.orgId, `@t27-shared-other-${tag}`)
      const secondHuman = await t.seedUser(`t27-second-${tag}@t.co`)
      await seedAuditRow({
        orgId: t.orgId,
        action: "t27humans.first",
        actorType: "agent",
        actorId: t.userId,
        agentId,
      })
      await seedAuditRow({
        orgId: t.orgId,
        action: "t27humans.second",
        actorType: "agent",
        actorId: secondHuman,
        agentId,
      })
      await seedAuditRow({
        orgId: t.orgId,
        action: "t27humans.decoy",
        actorType: "agent",
        actorId: t.userId,
        agentId: other,
      })

      const r = await t.callHandler("audit_search", { agentId, action: "t27humans" })
      expect(actionsOf(r)).toEqual(["t27humans.first", "t27humans.second"])
      // Both triggering humans are represented: the agent id, not the human, is the key.
      expect(r.entries.map((e: { actorId: string | null }) => e.actorId).sort()).toEqual(
        [t.userId, secondHuman].sort(),
      )
    })
  })

  it("a human-only row is excluded from an agent filtered query and still returned unfiltered", async () => {
    await withAdminToolTest({ scopes: ["kernel:audit:read"] }, async (t) => {
      const tag = crypto.randomUUID().slice(0, 8)
      const agentId = await seedAgent(t.orgId, `@t27-null-${tag}`)
      await seedAuditRow({
        orgId: t.orgId,
        action: "t27null.human",
        actorType: "user",
        actorId: t.userId,
        agentId: null,
      })
      await seedAuditRow({
        orgId: t.orgId,
        action: "t27null.agent",
        actorType: "agent",
        actorId: t.userId,
        agentId,
      })

      expect(
        actionsOf(await t.callHandler("audit_search", { agentId, action: "t27null" })),
      ).toEqual(["t27null.agent"])
      // Unfiltered, the human-only row is still part of the trail.
      expect(actionsOf(await t.callHandler("audit_search", { action: "t27null" }))).toEqual([
        "t27null.agent",
        "t27null.human",
      ])
    })
  })

  it("one org's agent filtered query never returns another org's rows", async () => {
    await withAdminToolTest({ scopes: ["kernel:audit:read"] }, async (t) => {
      const tag = crypto.randomUUID().slice(0, 8)
      const otherOrgId = crypto.randomUUID()
      await withSystemDb("t27-seed-other-org", (db) =>
        db
          .insert(organizations)
          .values({ id: otherOrgId, name: "T27 Other", slug: `t27-other-${tag}` }),
      )
      const foreignAgent = await seedAgent(otherOrgId, `@t27-foreign-${tag}`)
      await seedAuditRow({
        orgId: otherOrgId,
        action: "t27iso.foreign",
        actorType: "agent",
        actorId: null,
        agentId: foreignAgent,
      })
      const mine = await seedAgent(t.orgId, `@t27-mine-${tag}`)
      await seedAuditRow({
        orgId: t.orgId,
        action: "t27iso.mine",
        actorType: "agent",
        actorId: t.userId,
        agentId: mine,
      })

      // The foreign row really exists, so the emptiness below is isolation, not absence.
      const foreign = await withSystemDb("t27-verify-foreign", (db) =>
        db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.agentId, foreignAgent)),
      )
      expect(foreign.length).toBe(1)

      expect(
        actionsOf(await t.callHandler("audit_search", { agentId: foreignAgent, action: "t27iso" })),
      ).toEqual([])
      expect(actionsOf(await t.callHandler("audit_search", { action: "t27iso" }))).toEqual([
        "t27iso.mine",
      ])

      await withSystemDb("t27-cleanup-other-org", async (db) => {
        await db.delete(auditLog).where(eq(auditLog.orgId, otherOrgId))
        await db.delete(agents).where(eq(agents.orgId, otherOrgId))
        await db.delete(organizations).where(eq(organizations.id, otherOrgId))
      })
    })
  })

  it("an archived agent's history is still queryable", async () => {
    await withAdminToolTest({ scopes: ["kernel:audit:read"] }, async (t) => {
      const tag = crypto.randomUUID().slice(0, 8)
      const archived = await seedAgent(t.orgId, `@t27-archived-${tag}`, {
        archivedAt: new Date("2026-01-01T00:00:00Z"),
      })
      const live = await seedAgent(t.orgId, `@t27-live-${tag}`)
      await seedAuditRow({
        orgId: t.orgId,
        action: "t27archived.act",
        actorType: "agent",
        actorId: t.userId,
        agentId: archived,
      })
      await seedAuditRow({
        orgId: t.orgId,
        action: "t27archived.decoy",
        actorType: "agent",
        actorId: t.userId,
        agentId: live,
      })

      // Agents are archived, not deleted, so the FK still resolves and the history stands.
      expect(
        actionsOf(
          await t.callHandler("audit_search", { agentId: archived, action: "t27archived" }),
        ),
      ).toEqual(["t27archived.act"])
    })
  })
})

// ---------------------------------------------------------------------------
// P3-T20: one agent, two runtimes, one trail. A tool call made in the in-app
// sandbox and the same tool called through the MCP gateway must BOTH come back
// from `audit_search` keyed by the agent id — the whole point of A11 is that
// "what did this agent do" does not depend on where the agent was driven from.
// The rows are produced by driving the real paths, never by seeding audit rows.
// ---------------------------------------------------------------------------
describe("kernel-admin reads: audit_search spans the in-app and MCP runtimes", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
    resetEventBus()
    initEventBus()
    registerEventSubscribers({
      bufferAndBroadcast: async () => {},
      broadcast: async () => {},
    } as never)
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  async function drainOutbox() {
    for (let i = 0; i < 10; i++) {
      await processOutboxBatch()
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it("audit_search by agentId returns the in-app row and the MCP row, and the MCP row is not runLocation local", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await sqlRaw`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${seed.ownerId}, ${seed.orgId}, 'kernel:audit:read') ON CONFLICT DO NOTHING`
    const { agentId } = await seedAgentForOrg(seed.orgId, { scopeCeiling: seed.scopes })
    const mcpActor = userContextFor(seed.orgId, seed.ownerId, seed.scopes)

    // (1) The in-app turn: the real tool, dispatched inside the turn's run
    // frame the way agent-service opens one.
    const rootRunId = crypto.randomUUID()
    await runContextStore.run(
      {
        runId: rootRunId,
        parentRunId: null,
        rootRunId,
        nestingDepth: 0,
        background: false,
        agentId,
        agentCeiling: [...seed.scopes],
        effectiveScope: [...seed.scopes],
        turnScopeAccumulator: createTurnScopeAccumulator(),
      },
      () =>
        executeTool({
          toolName: mutatingTicketTool.canonical,
          orgId: seed.orgId,
          actor: mcpActor,
          params: { title: "in-app turn item", team: "alpha" },
          origin: "in-app-agent",
        }),
    )
    await drainOutbox()
    const afterInApp = await withSystemDb("t20-rows-after-in-app", (db) =>
      db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.agentId, agentId)),
    )
    expect(afterInApp.length).toBeGreaterThan(0)
    const inAppIds = new Set(afterInApp.map((r) => r.id))

    // (2) The same agent over the MCP gateway.
    const conn = await seedMcpConnection({
      orgId: seed.orgId,
      userId: seed.ownerId,
      clientId: "claude-code",
      label: "Claude Code",
    })
    const res = await handleToolCall(
      {
        orgId: seed.orgId,
        actor: mcpActor,
        connectionId: conn.id,
        ownerUserId: seed.ownerId,
        connectionThreadId: null,
        discovered: new Set(),
        agentId,
      },
      "test__createItem",
      { title: "gateway item", team: "alpha" },
    )
    expect(res.isError).toBeFalsy()
    await drainOutbox()

    const all = await withSystemDb("t20-rows-final", (db) =>
      db.select().from(auditLog).where(eq(auditLog.agentId, agentId)),
    )
    const mcpRows = all.filter((r) => !inAppIds.has(r.id))
    expect(mcpRows.length).toBeGreaterThan(0)

    // The gateway row is NOT marked as a locally-run session: "local" is
    // reserved for the desktop SDK path, and the gateway is not it. No such
    // field exists on an audit row today, so the assertion is that nothing
    // anywhere on the row claims one.
    for (const r of mcpRows) {
      const blob = JSON.stringify({ changes: r.changes, metadata: r.metadata })
      expect(blob).not.toContain("runLocation")
      expect((r.metadata as Record<string, unknown> | null)?.runLocation).toBeUndefined()
    }

    // The tool itself answers with both runtimes' rows for that agent.
    const found = (await handleAuditSearch(
      { agentId, limit: 100 },
      { orgId: seed.orgId, userId: seed.ownerId },
    )) as { entries: Array<{ action: string }> }
    expect(found.entries.length).toBe(all.length)
    expect(found.entries.length).toBeGreaterThanOrEqual(2)
  }, 60_000)
})
