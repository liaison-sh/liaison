// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dashboards shared as Knowledge documents are (migration 0293, sharing.ts): a dashboard
// restricted to some people or roles is invisible to everyone else by every path (list, open,
// block data, drill rows, filter options, exports, history, viewer state, the snapshot tool,
// scheduled-send recipients, raw RLS reads), org admins included; an editor-shared person edits;
// a role share reaches the role's holders; today's personal and org dashboards keep their
// meaning; an agent's share waits for a person whose card says who gains and loses access.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { dashboards, dashboardVersions, resourceGrants, roles, userRoles } from "~/db/schema/kernel"
import { executeTool } from "~/modules/apps/execute-tool"
import { checkRecipients, computeDashboard } from "~/modules/dashboards/export"
import {
  createDashboard,
  DashboardError,
  deleteDashboard,
  editDashboard,
  getBlockData,
  getBlockRows,
  getDashboard,
  getFilterOptions,
  getVersion,
  listDashboards,
  listVersions,
  setViewerRange,
  updateDashboard,
} from "~/modules/dashboards/service"
import { getDashboardSharing, setDashboardSharing } from "~/modules/dashboards/sharing"
import { registerDashboardTools } from "~/modules/dashboards/tools"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let roleId = ""
let ownerId = ""
let employeeId = ""
let adminId = ""
let editorId = ""
let clevelId = ""

async function asHeld(userId: string): Promise<UserContext> {
  const perms = await withSystemDb("dash-sharing-perms", (tx) =>
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

const SPEC = {
  v: 1,
  filters: [{ id: "market", label: "Market", type: "multi", options: ["FR", "DE"] }],
  blocks: [{ id: "note", type: "text", title: "Board notes", text: "Q4 margin target" }],
}

async function restricted(title: string) {
  const owner = await asHeld(ownerId)
  const row = await createDashboard(owner, { title, visibility: "personal", spec: SPEC })
  // Edited once so it has two versions.
  await updateDashboard(owner, row.id, { title: `${title}.`, ifVersion: 1 })
  await setDashboardSharing(owner, row.id, {
    orgAccess: "none",
    users: [{ userId: editorId, role: "editor" }],
    roles: [{ roleId, role: "viewer" }],
  })
  return row.id
}

const notFound = { code: "NOT_FOUND" }

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Dashboards Sharing Org" })).orgId
  ownerId = (await minimal.person(orgId, { name: "Owner" })).id
  employeeId = (await minimal.person(orgId, { name: "Employee" })).id
  editorId = (await minimal.person(orgId, { name: "Editor" })).id
  clevelId = (await minimal.person(orgId, { name: "Board Member" })).id
  adminId = (await minimal.person(orgId, { role: "admin", name: "Admin" })).id
  roleId = await withPrivilegedDb(orgId, "dash-sharing-role", async (tx) => {
    const [r] = await tx.insert(roles).values({ orgId, name: "Board" }).returning({ id: roles.id })
    await tx.insert(userRoles).values({ userId: clevelId, roleId: r!.id, orgId })
    return r!.id
  })
  registerDashboardTools(orgId)
})

afterAll(releaseTestLock)

describe("a restricted dashboard", () => {
  it("is invisible to an employee by every path", async () => {
    const id = await restricted("Board view")
    const employee = await asHeld(employeeId)
    expect((await listDashboards(employee)).map((d) => d.id)).not.toContain(id)
    await expect(getDashboard(employee, id)).rejects.toMatchObject(notFound)
    await expect(getBlockData(employee, id, "note")).rejects.toMatchObject(notFound)
    await expect(getBlockRows(employee, id, "note")).rejects.toMatchObject(notFound)
    await expect(getFilterOptions(employee, id, "market")).rejects.toMatchObject(notFound)
    await expect(listVersions(employee, id)).rejects.toMatchObject(notFound)
    await expect(getVersion(employee, id, 1)).rejects.toMatchObject(notFound)
    await expect(setViewerRange(employee, id, { compare: "none" })).rejects.toMatchObject(notFound)
    // The CSV and PDF routes compute the dashboard as the viewer first.
    await expect(computeDashboard(employee, id)).rejects.toMatchObject(notFound)
    await expect(getDashboardSharing(employee, id)).rejects.toMatchObject(notFound)
    await expect(updateDashboard(employee, id, { title: "mine now" })).rejects.toBeInstanceOf(
      DashboardError,
    )
    await expect(deleteDashboard(employee, id)).rejects.toBeInstanceOf(DashboardError)

    // Raw reads under the employee's RLS: the row, its versions, its grants.
    const raw = await withRlsContext(employee, async (tx) => ({
      rows: await tx.select().from(dashboards).where(eq(dashboards.id, id)),
      versions: await tx
        .select()
        .from(dashboardVersions)
        .where(eq(dashboardVersions.dashboardId, id)),
      grants: await tx.select().from(resourceGrants).where(eq(resourceGrants.resourceId, id)),
    }))
    expect(raw).toEqual({ rows: [], versions: [], grants: [] })
  })

  it("is invisible to an org admin it is not shared with (no admin bypass)", async () => {
    const id = await restricted("Board admin check")
    const admin = await asHeld(adminId)
    expect(admin.scopes.some((s) => s === "*" || s.startsWith("kernel"))).toBe(true)
    expect((await listDashboards(admin)).map((d) => d.id)).not.toContain(id)
    await expect(getDashboard(admin, id)).rejects.toMatchObject(notFound)
    await expect(deleteDashboard(admin, id)).rejects.toMatchObject(notFound)
    const updated = await withRlsContext(admin, (tx) =>
      tx.update(dashboards).set({ title: "taken" }).where(eq(dashboards.id, id)).returning(),
    )
    expect(updated).toEqual([])
  })

  it("an editor-shared person reads and edits it, but does not own it", async () => {
    const id = await restricted("Board editor")
    const editor = await asHeld(editorId)
    const view = await getDashboard(editor, id)
    expect(view).toMatchObject({ canEdit: true, canDelete: false, shared: true, orgAccess: "none" })
    const edited = await editDashboard(editor, id, {
      ifVersion: view.version,
      operations: [{ op: "setTitle", title: "Board, edited" }],
    })
    expect(edited.title).toBe("Board, edited")
    // The history it reads is the shared one.
    expect((await listVersions(editor, id)).length).toBeGreaterThan(0)
    await expect(deleteDashboard(editor, id)).rejects.toMatchObject({ code: "SCOPE_DENIED" })
  })

  it("a role share reaches the role's holders, as viewers", async () => {
    const id = await restricted("Board role")
    const member = await asHeld(clevelId)
    expect(member.roles).toContain(roleId)
    const view = await getDashboard(member, id)
    expect(view).toMatchObject({ canEdit: false, canShare: false })
    expect((await listDashboards(member)).find((d) => d.id === id)).toMatchObject({
      shared: true,
      orgAccess: "none",
    })
    await expect(updateDashboard(member, id, { title: "x" })).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    })
    // Without the role, nothing.
    await expect(getDashboard({ ...member, roles: [] }, id)).rejects.toMatchObject(notFound)
  })

  it("scheduled-send recipients are only the people it is shared with", async () => {
    const id = await restricted("Board send")
    const owner = await asHeld(ownerId)
    const checks = await checkRecipients(owner, id, [employeeId, editorId, adminId])
    const by = new Map(checks.map((c) => [c.userId, c]))
    expect(by.get(employeeId)?.mayReceive).toBe(false)
    expect(by.get(adminId)?.mayReceive).toBe(false)
    expect(by.get(employeeId)?.reason).toContain("not shared with them")
  })

  it("the snapshot tool reads it for the people it is shared with only", async () => {
    const id = await restricted("Board snapshot")
    const run = async (userId: string) =>
      executeTool({
        toolName: "kernel:dashboards_snapshot",
        orgId,
        actor: await asHeld(userId),
        params: { dashboardId: id },
        threadId: await minimal.thread(orgId, userId, { title: "Snapshot" }),
        origin: "in-app-agent",
      })
    const denied = await run(employeeId).then(
      (r) => JSON.stringify(r),
      (e: { code?: string; message?: string }) => `${e.code} ${e.message}`,
    )
    expect(denied).toContain("not_found")
    const allowed = await run(editorId)
    expect(JSON.stringify(allowed)).toContain("Board snapshot")
  })

  it("the sharing reads back with names, and only managers change it", async () => {
    const id = await restricted("Board names")
    const editor = await asHeld(editorId)
    const sharing = await getDashboardSharing(editor, id)
    expect(sharing).toMatchObject({ orgAccess: "none", ownerName: "Owner", canManage: true })
    expect(sharing.users).toEqual([{ userId: editorId, role: "editor", name: "Editor" }])
    expect(sharing.roles).toEqual([{ roleId, role: "viewer", name: "Board" }])
    const member = await asHeld(clevelId)
    expect((await getDashboardSharing(member, id)).canManage).toBe(false)
    await expect(setDashboardSharing(member, id, { orgAccess: "viewer" })).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    })
    await expect(
      setDashboardSharing(editor, id, {
        users: [{ userId: "00000000-0000-4000-8000-000000000000", role: "viewer" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
  })
})

describe("today's dashboards keep their meaning", () => {
  it("personal is its owner's alone, org is everyone's to read and the admins' to edit", async () => {
    const owner = await asHeld(ownerId)
    const employee = await asHeld(employeeId)
    const admin = await asHeld(adminId)
    const mine = await createDashboard(owner, { title: "Mine", visibility: "personal", spec: SPEC })
    expect(mine).toMatchObject({ orgAccess: "none", shared: false, visibility: "personal" })
    await expect(getDashboard(employee, mine.id)).rejects.toMatchObject(notFound)
    await expect(getDashboard(admin, mine.id)).rejects.toMatchObject(notFound)

    const team = await createDashboard(owner, { title: "Team", visibility: "org", spec: SPEC })
    expect(team).toMatchObject({ orgAccess: "viewer", shared: true, visibility: "org" })
    expect((await getDashboard(employee, team.id)).canEdit).toBe(false)
    expect((await getDashboard(admin, team.id)).canEdit).toBe(true)
    // Switching it back to personal is a sharing change: the whole org loses it.
    await updateDashboard(owner, team.id, { visibility: "personal" })
    await expect(getDashboard(employee, team.id)).rejects.toMatchObject(notFound)
  })

  it("a write naming only visibility (the previous release) moves org_access with it", async () => {
    const owner = await asHeld(ownerId)
    const [row] = await withRlsContext(owner, (tx) =>
      tx
        .insert(dashboards)
        .values({
          orgId,
          title: "Old release",
          visibility: "org",
          ownerUserId: ownerId,
          spec: SPEC,
        })
        .returning(),
    )
    expect(row?.orgAccess).toBe("viewer")
    const [after] = await withRlsContext(owner, (tx) =>
      tx
        .update(dashboards)
        .set({ visibility: "personal" })
        .where(eq(dashboards.id, row!.id))
        .returning(),
    )
    expect(after).toMatchObject({ orgAccess: "none", visibility: "personal" })
  })
})

describe("the agent's share", () => {
  it("waits for the owner, and its card says who gains and loses access", async () => {
    const id = await restricted("Board agent")
    const res = await executeTool({
      toolName: "kernel:dashboards_share",
      orgId,
      actor: await asHeld(editorId),
      params: {
        id,
        people: [
          { userId: employeeId, access: "viewer" },
          { userId: editorId, access: "none" },
        ],
      },
      threadId: await minimal.thread(orgId, editorId, { title: "Share it" }),
      origin: "in-app-agent",
    })
    const lines = res.blocked?.summary?.lines.join("\n") ?? ""
    expect(lines).toContain("Employee gains access: can view.")
    expect(lines).toContain("Editor loses access")
    const [request] = await sql`
      SELECT resource_owner_id FROM kernel.approval_requests WHERE id = ${String(res.blocked?.approvalRequestId)}`
    // Routed to its owner alone: nobody who cannot see it reads the card.
    expect(request?.resource_owner_id).toBe(ownerId)
    // Nothing changed yet.
    await expect(getDashboard(await asHeld(employeeId), id)).rejects.toMatchObject(notFound)
  })

  it("an agent's edit of a restricted dashboard waits for its owner too", async () => {
    const id = await restricted("Board agent edit")
    const editor = await asHeld(editorId)
    const res = await executeTool({
      toolName: "kernel:dashboards_edit",
      orgId,
      actor: editor,
      params: {
        dashboardId: id,
        ifVersion: (await getDashboard(editor, id)).version,
        operations: [{ op: "setTitle", title: "Board, by the agent" }],
      },
      threadId: await minimal.thread(orgId, editorId, { title: "Edit it" }),
      origin: "in-app-agent",
    })
    expect(res.blocked?.summary?.title).toContain("Change the shared dashboard")
    const [request] = await sql`
      SELECT resource_owner_id FROM kernel.approval_requests WHERE id = ${String(res.blocked?.approvalRequestId)}`
    expect(request?.resource_owner_id).toBe(ownerId)
  })
})
