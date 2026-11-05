// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T1 (S16, A31): personal MCP connections, end to end.
//
// A plain member (the default roles a real org seeds: kernel `member` plus the
// auto-maintained "Full Member" role every installed app extends) can:
//  - create a PERSONAL connection from the wizard (REST) without any admin,
//  - ask their agent to add one: the call stays GATED, but the approval is
//    routed to the member alone (owner-routed, like a personal-mailbox draft),
//    an admin can neither see nor decide it, and nothing exists before the
//    owner approves,
//  - test it and run the OAuth (DCR) dance on it, the tokens landing on the
//    personal row.
// Once dialed, the connection's tools reach the owner's agent and a routine the
// owner owns, and never another user's agent or routine.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { sql } from "~/db/connection"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { encryptionKey } from "~/lib/env"
import { errorHandler } from "~/middleware/error-handler"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { decideApproval } from "~/modules/approvals/decide"
import { initializedOrgRuntimes, registeredApps, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initMcpClient, McpClientTestAccess } from "~/modules/mcp-client/index"
import { seedDefaultRoles } from "~/modules/permissions/default-roles"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { type MockMcpHandle, startMockMcp } from "~/tests/e2e/helpers/mock-mcp"
import { type MockMcpOauthHandle, startMockMcpOauth } from "~/tests/e2e/helpers/mock-mcp-oauth"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { mcpManagerOAuthRoutes } from "./oauth-routes"
import { mcpManagerRoutes } from "./routes"

const ORG = "00000000-0000-4000-8000-0000003f1a01"
const MEMBER = "00000000-0000-4000-8000-0000003f1a02"
const OTHER = "00000000-0000-4000-8000-0000003f1a03"
const ADMIN = "00000000-0000-4000-8000-0000003f1a04"
const THREAD = "00000000-0000-4000-8000-0000003f1a05"
const EDITOR = "00000000-0000-4000-8000-0000003f1a06"
// Holds the kernel `member` preset alone (no "Full Member"), like the demo org's members.
const PRESET_ONLY = "00000000-0000-4000-8000-0000003f1a07"

function appAs(actor: UserContext) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", actor.userId)
    c.set("orgId", actor.orgId)
    c.set("scopes", actor.scopes as never)
    c.set("dimensionGrants", actor.dimensionGrants ?? {})
    await next()
  })
  app.route("/apps/mcp-manager", mcpManagerRoutes)
  app.route("/apps/mcp-manager", mcpManagerOAuthRoutes)
  app.onError(errorHandler)
  return app
}

async function post(actor: UserContext, path: string, body: unknown) {
  return appAs(actor).request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function contextOf(userId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(ORG, "p3t1-perms", (tx) =>
    loadEffectivePermissions(tx, userId, ORG),
  )
  return {
    actorType: "user",
    userId,
    orgId: ORG,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
}

async function connectionBySlug(slug: string) {
  const [row] = await withSystemDb("p3t1-row", (db) =>
    db.select().from(mcpConnections).where(eq(mcpConnections.slug, slug)),
  )
  return row ?? null
}

describe("P3-T1 personal MCP connections", () => {
  let mockMcp: MockMcpHandle
  let mockOauth: MockMcpOauthHandle
  const prevAllowPrivate = process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP

  beforeAll(async () => {
    await acquireTestLock()
    await initSandboxPool()
    // The mock MCP servers listen on 127.0.0.1; the test-only allowance lets the
    // SSRF guard admit them (inert outside NODE_ENV=test).
    process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP = "1"
    mockMcp = await startMockMcp()
    mockOauth = await startMockMcpOauth()

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'P3T1 Personal MCP', 'p3t1-personal-mcp') ON CONFLICT (id) DO NOTHING`
    for (const [id, email] of [
      [MEMBER, "p3t1-member@test.com"],
      [OTHER, "p3t1-other@test.com"],
      [ADMIN, "p3t1-admin@test.com"],
      [EDITOR, "p3t1-editor@test.com"],
      [PRESET_ONLY, "p3t1-preset-only@test.com"],
    ]) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${email}, ${email}, 'active', 'hash') ON CONFLICT (id) DO NOTHING`
    }
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'p3t1-thread', 'agent_chat', ${MEMBER}) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${MEMBER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`

    // A real org: the default kernel roles, then every default app registered,
    // which seeds each app's roles and extends the "Full Member" role.
    await withSystemDb("p3t1-default-roles", (tx) => seedDefaultRoles(tx, ORG))
    await ensureAppsForOrg(ORG)
    const roleRows = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM kernel.roles WHERE org_id = ${ORG}
        AND name IN ('member', 'Full Member', 'admin')`
    const roleId = (name: string) => roleRows.find((r) => r.name === name)!.id
    for (const user of [MEMBER, OTHER, EDITOR]) {
      for (const role of ["member", "Full Member"]) {
        await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
          VALUES (${user}, ${roleId(role)}, ${ORG}) ON CONFLICT DO NOTHING`
      }
    }
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${ADMIN}, ${roleId("admin")}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${PRESET_ONLY}, ${roleId("member")}, ${ORG}) ON CONFLICT DO NOTHING`
    // A member who also holds the org-connection write scope (the editor grant).
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${EDITOR}, ${ORG}, 'mcp_manager:connection:write') ON CONFLICT DO NOTHING`

    await initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true })
  })

  afterAll(async () => {
    McpClientTestAccess.reset()
    await mockMcp?.kill()
    await mockOauth?.kill()
    if (prevAllowPrivate === undefined) delete process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP
    else process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP = prevAllowPrivate
    await shutdownSandboxPool()
    toolRegistry.deleteByPrefix([ORG])
    for (const key of [...registeredApps.keys()]) {
      if (key.startsWith(`${ORG}:`)) registeredApps.delete(key)
    }
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM app_mcp_manager.mcp_connections WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN
      (SELECT id FROM kernel.roles WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("every member holds mcp_manager:personal_connection:write by default, not connection:write", async () => {
    const member = await contextOf(MEMBER)
    expect(member.scopes).toContain("mcp_manager:personal_connection:write")
    expect(member.scopes).not.toContain("mcp_manager:connection:write")
  })

  it("a member creates a personal connection from the wizard with no admin involved", async () => {
    const member = await contextOf(MEMBER)
    const res = await post(member, "/apps/mcp-manager/connections", {
      slug: "member-echo",
      displayName: "My echo",
      transport: "http",
      ownershipScope: "personal",
      httpUrl: `${mockMcp.url}/mcp`,
      authFlavor: "none",
    })
    expect(res.status).toBe(200)
    const row = await connectionBySlug("member-echo")
    expect(row?.ownershipScope).toBe("personal")
    expect(row?.ownerUserId).toBe(MEMBER)
    const approvals = await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(approvals).toHaveLength(0)
  })

  // Regression smoke 0759b0f89 (2026-10-08): a member holding only the kernel
  // `member` preset got the personal write scope (0133, memberPresetScopes) but
  // not mcp_manager:connection:read, which the list route and the row's SELECT
  // policy need, so Settings > My connections crashed on a permission error and
  // no personal connection could be added from it.
  it("a member holding only the kernel member preset lists My connections and adds a personal one", async () => {
    const member = await contextOf(PRESET_ONLY)
    expect(member.scopes).toContain("mcp_manager:personal_connection:write")
    expect(member.scopes).not.toContain("mcp_manager:connection:write")
    const before = await appAs(member).request("/apps/mcp-manager/connections")
    expect(before.status).toBe(200)
    const res = await post(member, "/apps/mcp-manager/connections", {
      slug: "preset-only-echo",
      displayName: "Preset echo",
      transport: "http",
      ownershipScope: "personal",
      httpUrl: `${mockMcp.url}/mcp`,
      authFlavor: "none",
    })
    expect(res.status).toBe(200)
    const after = await appAs(member).request("/apps/mcp-manager/connections")
    expect(after.status).toBe(200)
    const listed = ((await after.json()) as { data: { slug: string; ownerUserId: string }[] }).data
    expect(listed.find((r) => r.slug === "preset-only-echo")?.ownerUserId).toBe(PRESET_ONLY)
  })

  it("a member still cannot create an org connection, nor a stdio one (no such transport)", async () => {
    const member = await contextOf(MEMBER)
    const org = await post(member, "/apps/mcp-manager/connections", {
      slug: "member-org",
      displayName: "Org attempt",
      transport: "http",
      ownershipScope: "org",
      httpUrl: "https://mcp.example.com/mcp",
    })
    expect(org.status).toBe(403)
    const stdio = await post(member, "/apps/mcp-manager/connections", {
      slug: "member-stdio",
      displayName: "Stdio attempt",
      transport: "stdio",
      ownershipScope: "personal",
      stdioCommand: "/bin/echo",
    })
    expect(stdio.status).toBe(400)
    expect(await connectionBySlug("member-org")).toBeNull()
    expect(await connectionBySlug("member-stdio")).toBeNull()
  })

  it("the agent's personal add_connection is owner-routed and not live until the owner approves", async () => {
    const member = await contextOf(MEMBER)
    const admin = await contextOf(ADMIN)
    const result = await executeTool({
      toolName: "mcp-manager:add_connection",
      orgId: ORG,
      actor: member,
      params: {
        displayName: "Agent HubSpot",
        httpUrl: "https://mcp.hubspot.example/mcp",
        ownershipScope: "personal",
      },
      threadId: THREAD,
      origin: "in-app-agent",
    })
    expect(result.blocked?.reason).toBe("gated")
    // The member decides their own personal connection (owner-routed), so the
    // agent must be told THEY are the approver, not "whoever holds the approve scope".
    expect(result.blocked?.requesterCanApprove).toBe(true)
    const requestId = result.blocked!.approvalRequestId!
    const [approval] = await sql<{ resource_owner_id: string | null; notify_user_ids: string[] }[]>`
      SELECT resource_owner_id, notify_user_ids FROM kernel.approval_requests WHERE id = ${requestId}`
    expect(approval.resource_owner_id).toBe(MEMBER)
    expect(approval.notify_user_ids).toEqual([MEMBER])
    expect(await connectionBySlug("agent-hubspot")).toBeNull()

    // An admin is not the approver of somebody's personal connection.
    await expect(
      decideApproval({ orgId: ORG, requestId, actor: admin, decision: "approve" }),
    ).rejects.toThrow()
    expect(await connectionBySlug("agent-hubspot")).toBeNull()

    const decided = await decideApproval({
      orgId: ORG,
      requestId,
      actor: member,
      decision: "approve",
    })
    expect(decided.status).toBe("approved")
    const row = await connectionBySlug("agent-hubspot")
    expect(row?.ownershipScope).toBe("personal")
    expect(row?.ownerUserId).toBe(MEMBER)
    // The owner (and so the owner's agent) holds the connection's tool namespace.
    const after = await contextOf(MEMBER)
    expect(after.scopes).toContain("mcp:agent-hubspot")
    expect((await contextOf(OTHER)).scopes).not.toContain("mcp:agent-hubspot")
  })

  // A31: add_connection declares only the personal scope, so the ORG case is
  // checked by the tool's preflight at stage time, before any approval exists.
  it("an org add_connection needs connection:write at stage time; personal needs only the personal scope", async () => {
    const stage = async (actor: UserContext, displayName: string, ownershipScope: string) =>
      executeTool({
        toolName: "mcp-manager:add_connection",
        orgId: ORG,
        actor,
        params: { displayName, httpUrl: "https://mcp.stage.example/mcp", ownershipScope },
        threadId: THREAD,
        origin: "in-app-agent",
      })
    const approvalCount = async () =>
      (await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${ORG}`).length

    // A plain member asking for an ORG connection is refused, nothing queued.
    const member = await contextOf(MEMBER)
    const before = await approvalCount()
    const refused = await stage(member, "Member Org Stage", "org").then(
      () => null,
      (err: Error & { code?: string; status?: number }) => err,
    )
    expect(refused?.code).toBe("forbidden")
    expect(refused?.status).toBe(403)
    expect(await approvalCount()).toBe(before)
    expect(await connectionBySlug("member-org-stage")).toBeNull()

    // The same member asking for a PERSONAL one still stages an approval.
    const personal = await stage(member, "Member Personal Stage", "personal")
    expect(personal.blocked?.reason).toBe("gated")
    expect(await approvalCount()).toBe(before + 1)

    // A holder of connection:write still stages an org request, and an admin's
    // approval creates the org connection.
    const editor = await contextOf(EDITOR)
    expect(editor.scopes).toContain("mcp_manager:connection:write")
    const staged = await stage(editor, "Editor Org Stage", "org")
    expect(staged.blocked?.reason).toBe("gated")
    const requestId = staged.blocked!.approvalRequestId!
    expect(await connectionBySlug("editor-org-stage")).toBeNull()
    const decided = await decideApproval({
      orgId: ORG,
      requestId,
      actor: await contextOf(ADMIN),
      decision: "approve",
    })
    expect(decided.status).toBe("approved")
    const row = await connectionBySlug("editor-org-stage")
    expect(row?.ownershipScope).toBe("org")
    expect(row?.ownerUserId ?? null).toBeNull()
  })

  it("after its test dial, only the owner's agent and the owner's routine see the tools", async () => {
    const member = await contextOf(MEMBER)
    const row = await connectionBySlug("member-echo")
    expect(row).not.toBeNull()
    const res = await post(member, `/apps/mcp-manager/connections/${row!.id}/test`, {})
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)

    const toolsOf = (actor: UserContext) =>
      Object.keys(buildToolSet(ORG, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)).filter((n) =>
        n.startsWith("mcp__member-echo"),
      )

    // The owner's agent (the owner's own scopes).
    const ownerTools = toolsOf(await contextOf(MEMBER))
    expect(ownerTools.length).toBeGreaterThan(0)
    expect(ownerTools.some((n) => n.endsWith("echo"))).toBe(true)

    // Another member's agent.
    expect(toolsOf(await contextOf(OTHER))).toEqual([])

    // A routine tick runs as its owner with the routine's own scopes
    // (kernel-jobs agentInvoker). One owned by the creator that asks for the
    // connection sees it; the same scopes on another user's routine do not.
    const routineScopes = ["mcp:member-echo"]
    const ownerRoutine: UserContext = { ...member, scopes: routineScopes }
    const otherRoutine: UserContext = {
      ...(await contextOf(OTHER)),
      scopes: routineScopes,
    }
    expect(toolsOf(ownerRoutine).length).toBeGreaterThan(0)
    expect(toolsOf(otherRoutine)).toEqual([])
  })

  // P3-T1b: the member's "My connections" view reads this list. It carries the
  // member's own personal row with when it was last checked (the test dial
  // above), and never shows it to another member.
  it("the list gives the owner their personal row with its last check, and hides it from others", async () => {
    type Listed = {
      slug: string
      ownershipScope: string
      ownerUserId: string | null
      lastCheckedAt: string | null
      lastError: string | null
    }
    const list = async (actor: UserContext) => {
      const res = await appAs(actor).request("/apps/mcp-manager/connections")
      expect(res.status).toBe(200)
      return ((await res.json()) as { data: Listed[] }).data
    }
    const mine = (await list(await contextOf(MEMBER))).find((r) => r.slug === "member-echo")
    expect(mine).toMatchObject({ ownershipScope: "personal", ownerUserId: MEMBER, lastError: null })
    expect(Number.isNaN(Date.parse(mine?.lastCheckedAt ?? ""))).toBe(false)
    expect((await list(await contextOf(OTHER))).some((r) => r.slug === "member-echo")).toBe(false)
  })

  // S16 walk (2026-10-08): calling a personal connection's tool BY NAME. Another
  // user's call used to park as an approval for the org's approvers (who then saw
  // its payload), and the owner's own gated call was decided by the org's mcp
  // approvers, never by the owner, and failed when they approved it.
  it("a non-owner's call (an admin's too) to someone's personal tool is refused at once; the owner's gated call is theirs to approve and runs", async () => {
    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
    // Neither another member nor an admin (whose `*` covers every mcp:<slug>).
    for (const who of [OTHER, ADMIN]) {
      await expect(
        executeTool({
          toolName: "mcp:member-echo:echo",
          orgId: ORG,
          actor: await contextOf(who),
          params: { message: "from someone else" },
          threadId: THREAD,
          origin: "mcp",
        }),
      ).rejects.toThrow()
    }
    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(after[0]!.n).toBe(before[0]!.n)

    const mine = await executeTool({
      toolName: "mcp:member-echo:echo",
      orgId: ORG,
      actor: await contextOf(MEMBER),
      params: { message: "mine" },
      threadId: THREAD,
      origin: "mcp",
    })
    if (mine.blocked) {
      expect(mine.blocked.requesterCanApprove).toBe(true)
      const requestId = mine.blocked.approvalRequestId!
      const [row] = await sql<{ resource_owner_id: string | null }[]>`
        SELECT resource_owner_id FROM kernel.approval_requests WHERE id = ${requestId}`
      expect(row!.resource_owner_id).toBe(MEMBER)
      await expect(
        decideApproval({
          orgId: ORG,
          requestId,
          actor: await contextOf(ADMIN),
          decision: "approve",
        }),
      ).rejects.toThrow()
      const decided = await decideApproval({
        orgId: ORG,
        requestId,
        actor: await contextOf(MEMBER),
        decision: "approve",
      })
      expect(decided.status).toBe("approved")
    } else {
      expect(mine.data).toBeDefined()
    }
  })

  // Deleting a personal connection takes its tool namespace back from the owner,
  // so an ORG connection that later reuses the slug does not hand the former
  // owner its tools through a stale `mcp:<slug>` grant.
  it("deleting a personal connection revokes the owner's namespace; a later org reuse of the slug stays closed to them", async () => {
    const member = await contextOf(MEMBER)
    const created = await post(member, "/apps/mcp-manager/connections", {
      slug: "member-reuse",
      displayName: "Soon gone",
      transport: "http",
      ownershipScope: "personal",
      httpUrl: `${mockMcp.url}/mcp`,
      authFlavor: "none",
    })
    expect(created.status).toBe(200)
    const { id } = (await created.json()) as { id: string }
    expect((await contextOf(MEMBER)).scopes).toContain("mcp:member-reuse")

    const deleted = await appAs(member).request(`/apps/mcp-manager/connections/${id}`, {
      method: "DELETE",
    })
    expect(deleted.status).toBe(200)
    expect(await connectionBySlug("member-reuse")).toBeNull()
    expect((await contextOf(MEMBER)).scopes).not.toContain("mcp:member-reuse")

    // An admin now adds an org connection under the same slug and dials it.
    const admin = await contextOf(ADMIN)
    const orgCreated = await post(admin, "/apps/mcp-manager/connections", {
      slug: "member-reuse",
      displayName: "Org reuse",
      transport: "http",
      ownershipScope: "org",
      httpUrl: `${mockMcp.url}/mcp`,
      authFlavor: "none",
    })
    expect(orgCreated.status).toBe(200)
    const orgId = ((await orgCreated.json()) as { id: string }).id
    const dial = await post(admin, `/apps/mcp-manager/connections/${orgId}/test`, {})
    expect(dial.status).toBe(200)
    expect(((await dial.json()) as { ok: boolean }).ok).toBe(true)

    const toolsOf = (actor: UserContext) =>
      Object.keys(buildToolSet(ORG, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)).filter((n) =>
        n.startsWith("mcp__member-reuse"),
      )
    // The connection is live (an actor holding the namespace sees its tools)...
    expect(toolsOf({ ...member, scopes: ["mcp:member-reuse"] }).length).toBeGreaterThan(0)
    // ...but nothing of the deleted personal grant carries over: with the org
    // server restricted to nobody, the former owner holds no grant for it.
    const restricted = await appAs(admin).request(`/apps/mcp-manager/connections/${orgId}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "restricted", roleIds: [], userIds: [] }),
    })
    expect(restricted.status).toBe(200)
    const former = await contextOf(MEMBER)
    expect(former.scopes).not.toContain("mcp:member-reuse")
    expect(toolsOf(former)).toEqual([])
    // An org server open to everyone (the default) reaches them as any member.
    const reopened = await appAs(admin).request(`/apps/mcp-manager/connections/${orgId}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "everyone" }),
    })
    expect(reopened.status).toBe(200)
    expect(toolsOf(await contextOf(MEMBER)).length).toBeGreaterThan(0)
  })

  it("the OAuth (DCR) round trip stores the tokens on the member's personal row", async () => {
    const member = await contextOf(MEMBER)
    mockMcp.setOauthDiscovery({
      issuer: mockOauth.issuer,
      authorizationEndpoint: mockOauth.authorizationEndpoint,
      tokenEndpoint: mockOauth.tokenEndpoint,
      registrationEndpoint: mockOauth.registrationEndpoint,
    })
    const created = await post(member, "/apps/mcp-manager/connections", {
      slug: "member-oauth",
      displayName: "My OAuth server",
      transport: "http",
      ownershipScope: "personal",
      httpUrl: `${mockMcp.url}/mcp`,
      authFlavor: "oauth_dcr",
    })
    expect(created.status).toBe(200)
    const { id } = (await created.json()) as { id: string }

    const start = await post(member, `/apps/mcp-manager/connections/${id}/oauth/start`, {})
    expect(start.status).toBe(200)
    const { authorizationUrl } = (await start.json()) as { authorizationUrl: string }

    // The browser leg: the issuer auto-approves and redirects to our callback.
    const authorize = await fetch(authorizationUrl, { redirect: "manual" })
    expect(authorize.status).toBe(302)
    const back = new URL(authorize.headers.get("location")!)
    // The callback lands in the browser that started the flow: it carries the
    // binding cookie the start response set.
    const bindingCookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!
    const callback = await appAs(member).request(
      `/apps/mcp-manager/oauth/callback?code=${encodeURIComponent(back.searchParams.get("code")!)}&state=${encodeURIComponent(back.searchParams.get("state")!)}`,
      { headers: { cookie: bindingCookie } },
    )
    expect(callback.status).toBe(302)

    const row = await connectionBySlug("member-oauth")
    expect(row?.ownershipScope).toBe("personal")
    expect(row?.ownerUserId).toBe(MEMBER)
    const secrets = JSON.parse(
      decryptSecret(row!.secretsEncrypted!, encryptionKey, CryptoContext.mcpConnectionSecrets),
    ) as { accessToken?: string; refreshToken?: string }
    expect(secrets.accessToken).toMatch(/^at-/)
    expect(secrets.refreshToken).toMatch(/^rt-/)
    expect(mockOauth.lastTokenRequest()?.grant_type).toBe("authorization_code")
  })
})
