// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who reaches dashboards without an administrator: the kernel member tier
// (KERNEL_MEMBER_SCOPES) carries `kernel:dashboards:write` and `:share`, through
// the `member` preset and through the system-managed "Full Member" role alike,
// so an ordinary person makes a personal dashboard with the scopes they actually
// hold. What stays gated: the agent's org dashboards wait for a holder of
// `kernel:dashboards:admin`, and a role agent may be given `:write` but never
// `:admin`.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { composeRoleAgentCeiling } from "~/cli/provisioners/agents"
import { withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { dashboards } from "~/db/schema/kernel"
import { assertNoAdminScopesInRoleCeiling } from "~/modules/agent/directory/ceiling-guard"
import { toolRegistry } from "~/modules/apps/app-registries"
import { extendFullMemberRole } from "~/modules/apps/runtime"
import {
  createDashboard,
  DashboardError,
  getDashboard,
  listDashboards,
} from "~/modules/dashboards/service"
import { registerDashboardTools } from "~/modules/dashboards/tools"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""

async function asHeld(userId: string): Promise<UserContext> {
  const perms = await withSystemDb("dash-member-perms", (tx) =>
    loadEffectivePermissions(tx as never, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants ?? {},
  }
}

const EMPTY = { v: 1, blocks: [] }

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Dashboards Member Access Org" })).orgId
})

afterAll(releaseTestLock)

describe("a member makes dashboards with the scopes they hold", () => {
  it("a plain member creates a personal dashboard nobody else sees", async () => {
    const member = await asHeld((await minimal.person(orgId)).id)
    const other = await asHeld((await minimal.person(orgId)).id)
    expect(member.scopes).toContain("kernel:dashboards:write")

    const mine = await createDashboard(member, {
      title: "My week",
      visibility: "personal",
      spec: EMPTY,
    })
    expect(mine.canEdit).toBe(true)
    expect((await listDashboards(member)).map((d) => d.id)).toContain(mine.id)
    expect((await listDashboards(other)).map((d) => d.id)).not.toContain(mine.id)
    await expect(getDashboard(other, mine.id)).rejects.toBeInstanceOf(DashboardError)
  })

  it("a person holding only Full Member gets the kernel member tier with it", async () => {
    await withSystemDb("dash-member-full-member", (tx) =>
      extendFullMemberRole(tx, orgId, { member: { scopes: ["kernel:threads:read"] } }),
    )
    const p = await minimal.person(orgId)
    await minimal.privilegedAssignRole(p.id, "Full Member")
    await minimal.revokeRole(p.id, "member")
    const person = await asHeld(p.id)
    expect(person.scopes).toContain("kernel:dashboards:write")
    expect(person.scopes).toContain("kernel:data:read")

    const row = await createDashboard(person, {
      title: "Full member's",
      visibility: "personal",
      spec: EMPTY,
    })
    expect(row.visibility).toBe("personal")
  })

  it("an org dashboard still needs share, and RLS refuses it without the scope", async () => {
    const p = await asHeld((await minimal.person(orgId)).id)
    const writeOnly: UserContext = {
      ...p,
      scopes: p.scopes.filter((s) => s !== "kernel:dashboards:share"),
    }
    await expect(
      createDashboard(writeOnly, { title: "Everyone", visibility: "org", spec: EMPTY }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" })
    // The row policy agrees with the service when the service is skipped.
    await expect(
      withRlsContext(writeOnly, (tx) =>
        tx.insert(dashboards).values({
          orgId,
          title: "sneak",
          visibility: "org",
          ownerUserId: p.userId,
          spec: EMPTY,
        }),
      ),
    ).rejects.toThrow()
  })
})

describe("the agent's dashboards", () => {
  it("an agent's org dashboard waits for a kernel:dashboards:admin holder; a personal one does not", async () => {
    registerDashboardTools(orgId)
    const create = toolRegistry.get([orgId, "kernel", "dashboards_create"])
    expect(create?.requiredScopes).toEqual(["kernel:dashboards:write"])
    expect(create?.approveScope).toBe("kernel:dashboards:admin")
    const gated = create?.gatedWhen as (p: unknown, c: { orgId: string }) => Promise<boolean>
    expect(await gated({ visibility: "org" }, { orgId })).toBe(true)
    expect(await gated({ visibility: "personal" }, { orgId })).toBe(false)
  })

  it("a role agent may be given kernel:dashboards:write, never kernel:dashboards:admin", () => {
    expect(() =>
      assertNoAdminScopesInRoleCeiling(
        "role",
        composeRoleAgentCeiling(["kernel:dashboards:write", "kernel:dashboards:share"]),
      ),
    ).not.toThrow()
    expect(() =>
      assertNoAdminScopesInRoleCeiling(
        "role",
        composeRoleAgentCeiling(["kernel:dashboards:admin"]),
      ),
    ).toThrow()
  })
})
