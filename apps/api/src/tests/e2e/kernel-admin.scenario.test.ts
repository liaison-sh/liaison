// SPDX-License-Identifier: FSL-1.1-ALv2
//
// E2E — Module F: kernel-admin agent tools, over the running e2e server.
//
// The governance surface (roles_list / users_list / audit_search / approvals_list
// reads + the gated invite_user / assign_role writes) is registered on the kernel
// agent-tool registry by `registerKernelAgentTools` during the org's runtime init,
// and is reachable through the SAME executeTool HTTP path the in-app agent uses:
//   POST /api/apps/tools/kernel:<tool>  →  executeTool → resolveActor →
//   withRlsContext(actor) → the real kernel service (listRoles / listUsers /
//   queryAuditLogPage / listApprovals / createInvitation / assignRole).
//
// This is NOT the handler-level unit test (admin-tools.test.ts, which calls the
// handlers directly against an RLS test org). Here the full production path runs:
// auth-resolved scopes on a real JWT → the executeTool scope gate (a non-admin is
// 403'd AND filtered out of buildToolSet) → the gating substrate (a non-approver's
// invite_user PROPOSES a real approval row rather than executing) → the escalation
// guards (assignRole above the actor's own scope ceiling returns SCOPE_ESCALATION).
//
// Driving-user discipline (the load-bearing setup choice):
//   - `adminReader` holds the admin READ scopes but NOT kernel:approve / "*", so a
//     direct human call to a gated tool does NOT auto-execute past the gate
//     (isDirectHumanCall && requesterCanApprove === false) — it PROPOSES.
//   - `world.admin` is the org owner ("*"), so it would auto-execute a gated tool;
//     it is used only as the approver / fixture-seeding identity, never as the
//     gated caller under test.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { setupScenario, teardownScenario } from "./setup"

describe("Kernel-admin E2E — governance reads + gated invite/assign (real tools)", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let prefix: string

  // Admin reader/writer: holds the kernel-admin scopes, plus shopify:approve so it
  // is a decidable approver for the seeded shopify approvals (approvals_list). It
  // deliberately lacks kernel:approve and "*", so a gated kernel write it makes
  // PROPOSES (does not auto-execute).
  let adminReader: { id: string; token: string }
  // A non-admin caller (holds only an unrelated read scope) used to prove the
  // tools are scope-filtered out + 403 at the HTTP boundary.
  let nonAdmin: { id: string; token: string }

  function kernelSchema(): string {
    return prefix ? `"${prefix}kernel"` : "kernel"
  }

  async function callTool(
    token: string,
    tool: string,
    params: Record<string, unknown>,
    opts?: { threadId?: string; asAgent?: boolean },
  ) {
    // A proposal is an AGENT's call: a person's own call never parks an
    // approval (it runs on their scope or is refused), so `asAgent` makes the
    // call as the agent acting for `token`'s user (origin in-app-agent).
    if (opts?.asAgent) {
      return api(url, "/api/_test/agent-tool-call", {
        method: "POST",
        token,
        body: {
          toolName: `kernel:${tool}`,
          params,
          ...(opts.threadId ? { threadId: opts.threadId } : {}),
        },
      })
    }
    return api(url, `/api/apps/tools/kernel:${tool}`, {
      method: "POST",
      token,
      body: { params, ...(opts?.threadId ? { threadId: opts.threadId } : {}) },
    })
  }

  /** Seed a role with scope grants directly (superuser DB). Returns its id. */
  async function seedRole(name: string, scopes: string[]): Promise<string> {
    const ks = kernelSchema()
    const [role] = await env.db.sql.unsafe(
      `INSERT INTO ${ks}.roles (org_id, name, description) VALUES ($1, $2, 'kernel-admin e2e role') RETURNING id`,
      [world.org.id, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
    )
    for (const scope of scopes) {
      await env.db.sql.unsafe(
        `INSERT INTO ${ks}.role_scope_grants (role_id, scope) VALUES ($1, $2)`,
        [role.id, scope],
      )
    }
    return role.id as string
  }

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 77,
      org: { name: "Kernel-admin E2E Org" },
      populate: { users: { count: 3 } },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    prefix = env.schemaPrefix ?? ""

    // Admin reader/writer — the kernel-admin scopes + shopify:approve (so the
    // seeded shopify approvals are decidable by it), but NOT kernel:approve / "*".
    // `kernel:approvals:read` is REQUIRED to call the `approvals_list` tool (its
    // declared scope) — without it the S3 approvals-list assertion 403s before it
    // can even read the decidable queue.
    adminReader = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "kernel:users:admin",
        // kernel:roles:admin — the scope get_role / edit_role declare; without it
        // the S7 role-editing assertions 403 at the scope gate before the tool runs.
        "kernel:roles:admin",
        "kernel:audit:read",
        "kernel:approvals:read",
        "shopify:approve",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    // A non-admin caller — only an unrelated read scope.
    nonAdmin = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["kernel:threads:read"],
      schemaPrefix: env.schemaPrefix,
    })
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  // ─── S1: roles_list + users_list happy path (correct data, linkage) ───

  it("S1: admin lists roles (zero-member role included) and users (with id/name/email)", async () => {
    // Seed a role with two scopes but no members — it must still list.
    await seedRole("Finance Lead", ["invoicing:documents:write", "invoicing:approve"])

    const rolesRes = await callTool(adminReader.token, "roles_list", {})
    expect(rolesRes.status).toBe(200)
    const roles = rolesRes.body.data.roles as Array<{
      id: string
      name: string
      memberCount: number
      scopeCount: number
    }>
    expect(Array.isArray(roles)).toBe(true)
    const finance = roles.find((r) => r.name.startsWith("Finance Lead"))
    expect(finance).toBeDefined()
    // A zero-member role still lists (member-count is a join, not a filter).
    expect(finance?.memberCount).toBe(0)
    expect(finance?.scopeCount).toBe(2)

    const usersRes = await callTool(adminReader.token, "users_list", {})
    expect(usersRes.status).toBe(200)
    const users = usersRes.body.data.users as Array<{
      id: string
      name: string
      email: string
      roles: unknown
    }>
    expect(Array.isArray(users)).toBe(true)
    // The org owner + 3 populated users + adminReader + nonAdmin = at least 6.
    expect(users.length).toBeGreaterThanOrEqual(4)
    for (const u of users) {
      expect(typeof u.id).toBe("string")
      expect(typeof u.name).toBe("string")
      expect(typeof u.email).toBe("string")
    }
    // adminReader itself surfaces, carrying its role membership (linkage).
    const me = users.find((u) => u.id === adminReader.id)
    expect(me).toBeDefined()
    expect(Array.isArray(me?.roles)).toBe(true)
    expect((me!.roles as unknown[]).length).toBeGreaterThanOrEqual(1)
  }, 60_000)

  // ─── S2: audit_search — date window + approver linkage projected ───

  it("S2: audit_search windows by date and projects approver linkage", async () => {
    const ks = kernelSchema()
    const approverId = world.admin.id
    // Two gated-action audit rows: one in-window, one out-of-window, each carrying
    // the approver in metadata (the "who approved X" linkage the projection reads).
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.audit_log (org_id, action, actor_type, actor_id, app, metadata, timestamp)
       VALUES
         ($1, 'shopify:refund_create', 'agent', $2, 'shopify', $3, '2026-06-05T10:00:00Z'),
         ($1, 'shopify:refund_create', 'agent', $2, 'shopify', $3, '2026-05-10T10:00:00Z')`,
      [world.org.id, approverId, JSON.stringify({ approverUserId: approverId })],
    )

    const res = await callTool(adminReader.token, "audit_search", {
      action: "shopify:refund_create",
      since: "2026-06-01T00:00:00Z",
      until: "2026-06-30T23:59:59Z",
    })
    expect(res.status).toBe(200)
    const entries = res.body.data.entries as Array<{
      action: string
      approverUserId: string | null
      actorId: string | null
      at: string
      app: string | null
    }>
    // Only the in-window row matches; the May row is excluded.
    expect(entries.length).toBe(1)
    expect(entries[0].action).toBe("shopify:refund_create")
    expect(entries[0].app).toBe("shopify")
    expect(entries[0].at.startsWith("2026-06-05")).toBe(true)
    // The approver linkage is projected from metadata.approverUserId.
    expect(entries[0].approverUserId).toBe(approverId)

    // A non-admin caller cannot reach audit_search — scope-gated 403.
    const denied = await callTool(nonAdmin.token, "audit_search", {
      action: "shopify:refund_create",
    })
    expect(denied.status).toBe(403)
  }, 60_000)

  // ─── S3: approvals_list — oldest-first, origin app + aging ───

  it("S3: approvals_list returns decidable pending approvals oldest-first with app + ageDays", async () => {
    const ks = kernelSchema()
    const now = Date.now()
    // A surface thread for the approvals (origin apps differ; both notify the
    // admin reader so the decidable filter — notify-set ∩ shopify:approve — passes).
    const [thread] = await env.db.sql.unsafe(
      `INSERT INTO ${ks}.threads (org_id, handle, type, created_by)
       VALUES ($1, $2, 'thread', $3) RETURNING id`,
      [
        world.org.id,
        `appr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        adminReader.id,
      ],
    )
    const threadId = thread.id as string

    // Two pending shopify approvals: 3 days old and 2 days old.
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.approval_requests
         (org_id, handle, status, tool_name, tool_params, current_payload, thread_id,
          originating_thread_id, requested_by, notify_user_ids, created_at, expires_at)
       VALUES
         ($1, $2, 'pending', 'shopify:refund_create', '{}'::jsonb, '{}'::jsonb, $5, $5, $6,
          ARRAY[$6]::uuid[], $3, $7),
         ($1, $8, 'pending', 'shopify:order_cancel', '{}'::jsonb, '{}'::jsonb, $5, $5, $6,
          ARRAY[$6]::uuid[], $4, $7)`,
      [
        world.org.id,
        `req-${Date.now()}-a`,
        new Date(now - 2 * 86_400_000).toISOString(),
        new Date(now - 3 * 86_400_000).toISOString(),
        threadId,
        adminReader.id,
        new Date(now + 86_400_000).toISOString(),
        `req-${Date.now()}-b`,
      ],
    )

    const res = await callTool(adminReader.token, "approvals_list", {
      status: "pending",
      sort: "oldest",
    })
    expect(res.status).toBe(200)
    const approvals = res.body.data.approvals as Array<{
      id: string
      app: string
      ageDays: number
      requester: string
    }>
    expect(approvals.length).toBe(2)
    // Oldest-first: the 3-day request precedes the 2-day request.
    expect(approvals[0].ageDays).toBe(3)
    expect(approvals[1].ageDays).toBe(2)
    // Origin app is decoded from the tool name and tagged on each row.
    expect(approvals[0].app).toBe("shopify")
    // The requester is reported by NAME, never by id (modules/approvals/requester.ts):
    // an agent handed a user id once named the routine's owner as the requester.
    const [requesterRow] = await env.db.sql.unsafe(`SELECT name FROM ${ks}.users WHERE id = $1`, [
      adminReader.id,
    ])
    expect(requesterRow?.name).toBeTruthy()
    expect(approvals[0].requester).toBe(requesterRow.name as string)
    expect(approvals[0].requester).not.toBe(adminReader.id)
  }, 60_000)

  // ─── S4: gated invite_user PROPOSES (lands an approval, does NOT execute) ───

  it("S4: gated invite_user by a non-approver PROPOSES — approval row lands, no user created", async () => {
    const ks = kernelSchema()
    // A role the admin reader fully covers (it only grants a scope adminReader holds),
    // so the invite's own escalation guard would pass — keeping this scenario focused
    // purely on the PROPOSE-not-execute gate, not entangled with escalation.
    const roleId = await seedRole("Support Reader", ["kernel:audit:read"])

    // A thread the caller participates in — a gated tool with no threadId 403s
    // before createApprovalRequest, so the approval needs a surface thread.
    const [thread] = await env.db.sql.unsafe(
      `INSERT INTO ${ks}.threads (org_id, handle, type, created_by)
       VALUES ($1, $2, 'thread', $3) RETURNING id`,
      [world.org.id, `inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, adminReader.id],
    )
    const threadId = thread.id as string
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id, role)
       VALUES ($1, $2, $3, 'admin')`,
      [threadId, adminReader.id, world.org.id],
    )

    const inviteEmail = `newhire-${Date.now()}@example.test`
    const res = await callTool(
      adminReader.token,
      "invite_user",
      { email: inviteEmail, roleId },
      { threadId, asAgent: true },
    )
    // Gated → 200 with a blocked/approval envelope (NOT the inviteUrl payload).
    expect(res.status).toBe(200)
    expect(res.body.data.blocked).toBeDefined()
    expect(res.body.data.blocked.reason).toBe("gated")
    expect(/^[0-9a-f-]{36}$/.test(res.body.data.blocked.approvalRequestId)).toBe(true)
    // The agent never executed: no inviteUrl came back.
    expect(res.body.data.blocked.inviteUrl).toBeUndefined()

    // A real, pending approval row landed for the gated kernel write.
    const approvals = (await env.db.sql.unsafe(
      `SELECT id, tool_name, status, summary FROM ${ks}.approval_requests
       WHERE tool_name = 'kernel:invite_user' AND requested_by = $1`,
      [adminReader.id],
    )) as unknown as Array<{ id: string; tool_name: string; status: string; summary: unknown }>
    expect(approvals.length).toBe(1)
    expect(approvals[0].status).toBe("pending")
    // The summarizer surfaces the invitee email in the approval card.
    expect(JSON.stringify(approvals[0].summary)).toContain(inviteEmail)

    // Negative assertion (the whole point of the gate): NO invitation was created —
    // the tool proposed, it did not execute.
    const invites = (await env.db.sql.unsafe(
      `SELECT id FROM ${ks}.invitations WHERE org_id = $1 AND email = $2`,
      [world.org.id, inviteEmail],
    )) as unknown as Array<{ id: string }>
    expect(invites.length).toBe(0)
  }, 60_000)

  // ─── S5: non-admin caller does NOT see the tools (scope-gated absence) ───

  it("S5: a non-admin caller is scope-gated out of every kernel-admin tool (403, no data)", async () => {
    // buildToolSet (the agent's assembled tool set) silently omits a tool whose
    // scope the actor lacks — the "no message, just absent" contract — and is
    // asserted at the in-process handler-unit layer (admin-tools.test.ts). Across
    // the E2E process boundary the equivalent guarantee is the executeTool scope
    // gate: the same `checkToolScopes(tool, actorScopes)` check fails closed with a
    // 403 (`missing scope`) for a non-admin, returning NO filtered/empty admin
    // data — the agent simply cannot reach the surface.
    //
    // adminReader (with the admin scopes) reaches the same tools just fine —
    // proven green by S1/S2/S3 above — so this is a true scope discriminator,
    // not a blanket denial.
    for (const tool of ["roles_list", "users_list", "audit_search", "approvals_list"]) {
      const denied = await callTool(nonAdmin.token, tool, {})
      expect(denied.status).toBe(403)
      // Fail-closed: an error envelope, never a data payload with rows.
      expect(denied.body.error).toBeDefined()
      expect(denied.body.error.code).toBe("forbidden")
      // The scope-gate names the exact missing scope (the admin scope the tool needs).
      expect(denied.body.error.message).toContain("missing scope")
      expect(denied.body.data).toBeUndefined()
    }

    // The gated writes are equally unreachable for a non-admin (scope gate runs
    // before the approval gate, so it 403s rather than proposing).
    for (const tool of ["invite_user", "assign_role"]) {
      const denied = await callTool(
        nonAdmin.token,
        tool,
        tool === "invite_user"
          ? { email: "x@example.test", roleId: crypto.randomUUID() }
          : { userId: crypto.randomUUID(), roleId: crypto.randomUUID() },
      )
      expect(denied.status).toBe(403)
      expect(denied.body.error.code).toBe("forbidden")
    }
  }, 60_000)

  // ─── S6: escalation guard — assign_role above the actor's ceiling is blocked ───

  it("S6: assign_role above the actor's own scope ceiling returns SCOPE_ESCALATION", async () => {
    const ks = kernelSchema()
    // An over-ceiling role: it grants invoicing scopes the admin reader does NOT hold.
    const elevatedRoleId = await seedRole("Billing Admin", [
      "invoicing:documents:write",
      "invoicing:approve",
    ])
    // A target user to (attempt to) assign the elevated role to.
    const target = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["kernel:threads:read"],
      schemaPrefix: env.schemaPrefix,
    })

    // Drive assign_role through an APPROVER who lacks the ceiling. A direct human
    // call by a holder of kernel:approve auto-executes past the gate, so the
    // handler runs inline and the escalation guard (assignRole under the actor's
    // RLS scopes) fires SCOPE_ESCALATION — the agent can never grant beyond the
    // approving human's own scopes.
    const escalationApprover = await createUserWithScopes(
      url,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        // admin write scope + approve, but NOT the invoicing:* scopes the role grants.
        scopes: ["kernel:users:admin", "kernel:approve"],
        dimensions: { "*": ["*"] },
        schemaPrefix: env.schemaPrefix,
      },
    )

    // A thread the approver participates in (the auto-execute path still wants a
    // surface for any approval bookkeeping).
    const [thread] = await env.db.sql.unsafe(
      `INSERT INTO ${ks}.threads (org_id, handle, type, created_by)
       VALUES ($1, $2, 'thread', $3) RETURNING id`,
      [
        world.org.id,
        `esc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        escalationApprover.id,
      ],
    )
    const threadId = thread.id as string
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id, role)
       VALUES ($1, $2, $3, 'admin')`,
      [threadId, escalationApprover.id, world.org.id],
    )

    const res = await callTool(
      escalationApprover.token,
      "assign_role",
      { userId: target.id, roleId: elevatedRoleId },
      { threadId },
    )
    // The call auto-executes past the gate (approver), runs the handler, and the
    // escalation guard rejects the over-reach. A handler `{ error: { code } }`
    // result is surfaced by executeTool as a thrown error whose `code` is carried
    // verbatim onto the HTTP error envelope (SCOPE_ESCALATION is not in the
    // status map → the default 500), so the OBSERVABLE escalation signal is the
    // preserved `body.error.code` — the assignment never lands.
    expect(res.status).toBe(500)
    expect(res.body.error).toBeDefined()
    expect(res.body.error.code).toBe("SCOPE_ESCALATION")
    expect(res.body.data).toBeUndefined()

    // The over-reaching assignment was NOT persisted — the guard blocked it.
    const assigned = (await env.db.sql.unsafe(
      `SELECT user_id FROM ${ks}.user_roles WHERE user_id = $1 AND role_id = $2`,
      [target.id, elevatedRoleId],
    )) as unknown as Array<{ user_id: string }>
    expect(assigned.length).toBe(0)

    // Control: a role whose only scope the approver explicitly holds
    // (kernel:users:admin) assigns cleanly through the SAME path — proving the
    // block above is the escalation guard, not a blanket failure of the path.
    const coveredRoleId = await seedRole("Covered Role", ["kernel:users:admin"])
    const ok = await callTool(
      escalationApprover.token,
      "assign_role",
      { userId: target.id, roleId: coveredRoleId },
      { threadId },
    )
    expect(ok.status).toBe(200)
    expect(ok.body.data.assigned).toBe(true)
    const okAssigned = (await env.db.sql.unsafe(
      `SELECT user_id FROM ${ks}.user_roles WHERE user_id = $1 AND role_id = $2`,
      [target.id, coveredRoleId],
    )) as unknown as Array<{ user_id: string }>
    expect(okAssigned.length).toBe(1)
  }, 60_000)

  // ─── S7: get_role reads exact scopes; gated edit_role PROPOSES (no modification) ───

  it("S7: get_role returns exact scopes; gated edit_role by a non-approver proposes, role unchanged", async () => {
    const ks = kernelSchema()
    // A role to strengthen — starts with a single read scope.
    const roleId = await seedRole("Approver Team", ["shopify:orders:read"])

    // get_role returns the EXACT scope strings (not just a count like roles_list).
    const getRes = await callTool(adminReader.token, "get_role", { roleId })
    expect(getRes.status).toBe(200)
    const scopeStrings = (getRes.body.data.role.scopes as Array<{ scope: string }>).map(
      (s) => s.scope,
    )
    expect(scopeStrings).toContain("shopify:orders:read")
    expect(scopeStrings).not.toContain("shopify:approve")

    // A surface thread the caller participates in (a gated tool with no threadId
    // 403s before createApprovalRequest).
    const [thread] = await env.db.sql.unsafe(
      `INSERT INTO ${ks}.threads (org_id, handle, type, created_by)
       VALUES ($1, $2, 'thread', $3) RETURNING id`,
      [
        world.org.id,
        `edit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        adminReader.id,
      ],
    )
    const threadId = thread.id as string
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id, role)
       VALUES ($1, $2, $3, 'admin')`,
      [threadId, adminReader.id, world.org.id],
    )

    // adminReader holds kernel:roles:admin (reaches the tool) but NOT kernel:approve
    // / "*", so the gated edit PROPOSES rather than auto-executing.
    const res = await callTool(
      adminReader.token,
      "edit_role",
      { roleId, grantScopes: ["shopify:approve"] },
      { threadId, asAgent: true },
    )
    expect(res.status).toBe(200)
    expect(res.body.data.blocked).toBeDefined()
    expect(res.body.data.blocked.reason).toBe("gated")
    expect(/^[0-9a-f-]{36}$/.test(res.body.data.blocked.approvalRequestId)).toBe(true)

    // A real, pending approval row landed, and its summary names the scope being added.
    const approvals = (await env.db.sql.unsafe(
      `SELECT id, status, summary FROM ${ks}.approval_requests
       WHERE tool_name = 'kernel:edit_role' AND requested_by = $1`,
      [adminReader.id],
    )) as unknown as Array<{ id: string; status: string; summary: unknown }>
    expect(approvals.length).toBe(1)
    expect(approvals[0].status).toBe("pending")
    expect(JSON.stringify(approvals[0].summary)).toContain("shopify:approve")

    // Negative assertion (the gate's whole point): the role was NOT modified.
    const grants = (await env.db.sql.unsafe(
      `SELECT scope FROM ${ks}.role_scope_grants WHERE role_id = $1`,
      [roleId],
    )) as unknown as Array<{ scope: string }>
    expect(grants.map((g) => g.scope)).not.toContain("shopify:approve")
    expect(grants.map((g) => g.scope)).toContain("shopify:orders:read")
  }, 60_000)

  // ─── S8: non-admin caller is scope-gated out of get_role + edit_role too ───

  it("S8: a non-admin is 403'd from get_role (read) and edit_role (gated write)", async () => {
    const denied = await callTool(nonAdmin.token, "get_role", { roleId: crypto.randomUUID() })
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe("forbidden")
    expect(denied.body.data).toBeUndefined()

    const deniedEdit = await callTool(nonAdmin.token, "edit_role", {
      roleId: crypto.randomUUID(),
      grantScopes: ["tickets:tickets:read"],
    })
    expect(deniedEdit.status).toBe(403)
    expect(deniedEdit.body.error.code).toBe("forbidden")
  }, 60_000)
})
