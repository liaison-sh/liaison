// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every gated kernel tool must REFUSE AT STAGING when the data it needs is missing or
// invalid. Before these preflights, such a call was parked as a pending approval, a human
// spent a decision on it, and only THEN did the handler come back with USER_NOT_FOUND /
// ROLE_NOT_FOUND / INVALID_DIMENSION: an error only the agent could have fixed.
//
// Each case below drives the real staging path (executeTool) and asserts BOTH halves: the
// refusal carries the right error code, AND no approval request row was created for the org
// (so no human was ever asked). The pure-unit cases cover the shared guards the preflight and
// the handler both call, so the two can never drift.
import { describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import {
  approvalRequests,
  contacts as contactsTable,
  roleScopeGrants,
  roles as rolesTable,
  routines as routinesTbl,
  userRoles,
  users,
} from "~/db/schema/kernel"
import {
  editRoleNoOpRefusal,
  grantDimensionValueCatalogRefusal,
  setUserScopeNoOpRefusal,
} from "~/modules/agent/tools/admin-tools"
import {
  contactsMergePreflight,
  contactsMergeSelfRefusal,
} from "~/modules/agent/tools/contact-tools"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import {
  enableRoutineTemplatePreflight,
  toggleAppSkillMissingRefusal,
  toggleAppSkillPreflight,
} from "~/modules/agent/tools/skills-routines-tools"
import { routineTemplateRegistry, skillRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

// --- pure unit cases -------------------------------------------------------

describe("gated staging preflights: shared guards (pure)", () => {
  it("contacts_merge refuses a self-merge with the handler's own error, no DB needed", async () => {
    const id = crypto.randomUUID()
    expect(contactsMergeSelfRefusal({ sourceId: id, targetId: id })).toEqual({
      code: "INVALID_ARGUMENT",
      message: "Cannot merge a contact with itself",
    })
    const res = await contactsMergePreflight({ sourceId: id, targetId: id }, { orgId: "org" })
    expect(res).toEqual({
      error: { code: "INVALID_ARGUMENT", message: "Cannot merge a contact with itself" },
    })
  })

  it("contacts_merge accepts two DIFFERENT ids as far as the self-merge guard goes", () => {
    expect(
      contactsMergeSelfRefusal({ sourceId: crypto.randomUUID(), targetId: crypto.randomUUID() }),
    ).toBeNull()
  })

  it("grant_dimension_value refuses a dimension that is not in the org catalog", () => {
    const r = grantDimensionValueCatalogRefusal("org-with-no-dimensions", {
      dimension: "territory",
      values: ["US"],
    })
    expect(r?.code).toBe("INVALID_DIMENSION")
    expect(r?.message).toContain("Unknown dimension: territory")
  })

  it("grant_dimension_value refuses the wildcard dimension", () => {
    const r = grantDimensionValueCatalogRefusal("org", { dimension: "*", values: ["x"] })
    expect(r?.code).toBe("INVALID_DIMENSION")
  })

  it("grant_user_scope refuses a call with nothing to grant and nothing to revoke", () => {
    expect(setUserScopeNoOpRefusal({})?.code).toBe("NO_OP")
    expect(setUserScopeNoOpRefusal({ grant: [], revoke: [] })?.code).toBe("NO_OP")
    expect(setUserScopeNoOpRefusal({ grant: ["tickets:tickets:read"] })).toBeNull()
  })

  it("edit_role refuses a call with no field to change", () => {
    expect(editRoleNoOpRefusal({})?.code).toBe("NO_OP")
    expect(editRoleNoOpRefusal({ grantScopes: [] })?.code).toBe("NO_OP")
    expect(editRoleNoOpRefusal({ name: "X" })).toBeNull()
  })

  it("toggle_app_skill refuses a skill name no installed app ships", async () => {
    const orgId = crypto.randomUUID()
    expect(
      toggleAppSkillMissingRefusal(orgId, { appName: "social", skillName: "no-such-skill" })?.code,
    ).toBe("app_skill_not_found")
    const res = await toggleAppSkillPreflight(
      { appName: "social", skillName: "no-such-skill", scope: "user" },
      { orgId } as never,
    )
    expect((res as { error?: { code: string } }).error?.code).toBe("app_skill_not_found")
  })

  it("toggle_app_skill accepts a skill the app actually ships", async () => {
    const orgId = crypto.randomUUID()
    skillRegistry.set([orgId, "social", "triage"], {
      name: "triage",
      description: "d",
      body: "b",
      requiredScopes: [],
    })
    const res = await toggleAppSkillPreflight(
      { appName: "social", skillName: "triage", scope: "user" },
      { orgId } as never,
    )
    expect(res).toEqual({ ok: true })
    skillRegistry.deleteByPrefix([orgId])
  })

  it("enable_routine_template refuses a template key that resolves to nothing", async () => {
    const orgId = crypto.randomUUID()
    const res = await enableRoutineTemplatePreflight(
      { appName: "boxtal", templateKey: "no-such-template" },
      { orgId } as never,
    )
    expect((res as { error?: { code: string } }).error?.code).toBe("template_not_found")
  })

  it("enable_routine_template accepts a template the app actually ships", async () => {
    const orgId = crypto.randomUUID()
    routineTemplateRegistry.set([orgId, "boxtal", "daily"], {
      description: "d",
      kind: "recurring",
      cron: "0 9 * * *",
      promptTemplate: "p",
      scopes: [],
    } as never)
    const res = await enableRoutineTemplatePreflight({ appName: "boxtal", templateKey: "daily" }, {
      orgId,
    } as never)
    expect(res).toEqual({ ok: true })
    routineTemplateRegistry.deleteByPrefix([orgId])
  })
})

// --- staging path (executeTool): refused, and nothing parked for a human ----

interface Fixture {
  orgId: string
  userId: string
  threadId: string
  scopes: string[]
}

async function withFixture(scopes: string[], run: (f: Fixture) => Promise<void>): Promise<void> {
  const org = await createTestOrg()
  const orgId = org.id
  const userId = await withSystemDb("preflight-test-user", async (db) => {
    const [u] = await db
      .insert(users)
      .values({
        orgId,
        email: `pf-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Preflight Tester",
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
  for (const scope of scopes) await minimal.grantScope(userId, scope)
  const threadId = crypto.randomUUID()
  await withPrivilegedDb(orgId, "preflight-thread-seed", async (db) => {
    await db.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${threadId}, ${orgId}, ${`t-${crypto.randomUUID()}`}, 'thread', ${userId})
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${threadId}, ${userId}, ${orgId}, 'admin')
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${userId}, ${threadId}, ${orgId})
    `)
  })
  await registerKernelAgentTools(orgId)
  try {
    await run({ orgId, userId, threadId, scopes })
  } finally {
    toolRegistry.deleteByPrefix([orgId])
  }
}

function actorFor(f: Fixture): UserContext {
  return {
    actorType: "user",
    userId: f.userId,
    orgId: f.orgId,
    scopes: f.scopes,
    dimensionGrants: {},
  }
}

async function approvalCount(orgId: string): Promise<number> {
  return withSystemDb("preflight-approval-count", async (db) => {
    const rows = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.orgId, orgId))
    return rows.length
  })
}

/** Stage a gated call and assert it was refused with `code` and parked NOTHING for a human.
 *  `executeTool` surfaces a tool error by throwing a typed Error carrying `code`. */
async function expectStagingRefusal(
  f: Fixture,
  toolName: string,
  params: Record<string, unknown>,
  code: string,
): Promise<void> {
  let thrown: unknown
  let result: unknown
  try {
    result = await executeTool({
      toolName,
      orgId: f.orgId,
      actor: actorFor(f),
      threadId: f.threadId,
      params,
      origin: "in-app-agent",
    })
  } catch (e) {
    thrown = e
  }
  if (thrown === undefined) {
    throw new Error(
      `${toolName} was NOT refused at staging: ${JSON.stringify(result)} (expected ${code})`,
    )
  }
  expect((thrown as { code?: string }).code).toBe(code)
  // The whole point: nothing was queued for a human to decide.
  expect(await approvalCount(f.orgId)).toBe(0)
}

async function seedRole(orgId: string, name: string, scopes: string[]): Promise<string> {
  return withSystemDb("preflight-seed-role", async (db) => {
    const [r] = await db
      .insert(rolesTable)
      .values({ orgId, name, description: null })
      .returning({ id: rolesTable.id })
    for (const scope of scopes) await db.insert(roleScopeGrants).values({ roleId: r.id, scope })
    return r.id
  })
}

describe("gated staging preflights: refused before any approval is parked", () => {
  it("grant_user_scope with an unknown target user is refused at staging", async () => {
    await withFixture(["kernel:users:admin", "tickets:tickets:read"], async (f) => {
      await expectStagingRefusal(
        f,
        "kernel:grant_user_scope",
        { userId: crypto.randomUUID(), grant: ["tickets:tickets:read"] },
        "USER_NOT_FOUND",
      )
    })
  }, 60_000)

  it("grant_dimension_value with a dimension that is not in the catalog is refused at staging", async () => {
    await withFixture(["kernel:users:admin"], async (f) => {
      await expectStagingRefusal(
        f,
        "kernel:grant_dimension_value",
        { userId: f.userId, dimension: "territory", values: ["US"] },
        "INVALID_DIMENSION",
      )
    })
  }, 60_000)

  it("edit_role with an unknown roleId is refused at staging", async () => {
    await withFixture(["kernel:roles:admin"], async (f) => {
      await expectStagingRefusal(
        f,
        "kernel:edit_role",
        { roleId: crypto.randomUUID(), grantScopes: ["tickets:tickets:read"] },
        "ROLE_NOT_FOUND",
      )
    })
  }, 60_000)

  it("delete_role with an unknown roleId is refused at staging", async () => {
    await withFixture(["kernel:roles:admin"], async (f) => {
      await expectStagingRefusal(
        f,
        "kernel:delete_role",
        { roleId: crypto.randomUUID() },
        "ROLE_NOT_FOUND",
      )
    })
  }, 60_000)

  it("delete_role on a role a member still holds is refused at staging", async () => {
    // The requester can see the members via get_role, so no human should ever spend a
    // decision on a delete that the handler would refuse anyway.
    await withFixture(["kernel:roles:admin", "tickets:tickets:read"], async (f) => {
      const roleId = await seedRole(f.orgId, "Still Held", ["tickets:tickets:read"])
      await withSystemDb("preflight-hold-role", (db) =>
        db.insert(userRoles).values({ userId: f.userId, roleId, orgId: f.orgId }),
      )
      await expectStagingRefusal(f, "kernel:delete_role", { roleId }, "ROLE_IN_USE")
    })
  }, 60_000)

  it("delete_role on a system-managed role is refused at staging", async () => {
    await withFixture(["kernel:roles:admin"], async (f) => {
      const roleId = await withSystemDb("preflight-sys-role", async (db) => {
        const [r] = await db
          .insert(rolesTable)
          .values({ orgId: f.orgId, name: `Sys-${crypto.randomUUID()}`, systemManaged: true })
          .returning({ id: rolesTable.id })
        return r.id
      })
      await expectStagingRefusal(f, "kernel:delete_role", { roleId }, "ROLE_SYSTEM_MANAGED")
    })
  }, 60_000)

  it("invite_user for an email that is already a member is refused at staging", async () => {
    await withFixture(["kernel:users:admin", "tickets:tickets:read"], async (f) => {
      const roleId = await seedRole(f.orgId, "Support Agent", ["tickets:tickets:read"])
      const email = await withSystemDb("preflight-existing-user", async (db) => {
        const addr = `member-${crypto.randomUUID()}@t.co`
        await db
          .insert(users)
          .values({ orgId: f.orgId, email: addr, passwordHash: "x", name: addr, status: "active" })
        return addr
      })
      await expectStagingRefusal(f, "kernel:invite_user", { email, roleId }, "USER_EXISTS")
    })
  }, 60_000)

  it("invite_user with a roleName for a role that does NOT exist yet is still ACCEPTED at staging", async () => {
    // The onboarding flow raises create_role and invite_user in the SAME turn: the role has no
    // uuid yet because it materializes only when its own approval runs. A preflight must NOT
    // reject the name it cannot resolve, or that flow becomes impossible.
    await withFixture(["kernel:users:admin", "tickets:tickets:read"], async (f) => {
      const result = await executeTool({
        toolName: "kernel:invite_user",
        orgId: f.orgId,
        actor: actorFor(f),
        threadId: f.threadId,
        params: {
          email: `newhire-${crypto.randomUUID()}@t.co`,
          roleName: "Customer Success Lead (not created yet)",
        },
        origin: "in-app-agent",
      })
      expect((result as { error?: unknown }).error).toBeFalsy()
      expect(result.blocked?.reason).toBe("gated")
      expect(result.blocked?.approvalRequestId).toBeTruthy()
      expect(await approvalCount(f.orgId)).toBe(1)
    })
  }, 60_000)

  it("assign_role with an unknown roleId is refused at staging", async () => {
    await withFixture(["kernel:users:admin"], async (f) => {
      await expectStagingRefusal(
        f,
        "kernel:assign_role",
        { userId: f.userId, roleId: crypto.randomUUID() },
        "NOT_FOUND",
      )
    })
  }, 60_000)

  it("remove_user_from_role with an unknown userId is refused at staging", async () => {
    await withFixture(["kernel:users:admin", "tickets:tickets:read"], async (f) => {
      const roleId = await seedRole(f.orgId, "Support Agent", ["tickets:tickets:read"])
      await expectStagingRefusal(
        f,
        "kernel:remove_user_from_role",
        { userId: crypto.randomUUID(), roleId },
        "NOT_FOUND",
      )
    })
  }, 60_000)

  it("create_role with a name that is already taken is refused at staging", async () => {
    await withFixture(["kernel:roles:admin", "tickets:tickets:read"], async (f) => {
      const name = `Support-${crypto.randomUUID()}`
      await seedRole(f.orgId, name, [])
      await expectStagingRefusal(
        f,
        "kernel:create_role",
        { name, scopes: ["tickets:tickets:read"] },
        "tool_error",
      )
    })
  }, 60_000)

  it("contacts_merge with a contact id that does not exist is refused at staging", async () => {
    await withFixture(["kernel:contacts:write"], async (f) => {
      const targetId = await withPrivilegedDb(f.orgId, "preflight-seed-contact", async (tx) => {
        const [c] = await tx
          .insert(contactsTable)
          .values({
            orgId: f.orgId,
            handle: `c-${crypto.randomUUID().slice(0, 8)}`,
            name: "Real Contact",
            email: `c-${crypto.randomUUID()}@t.co`,
          })
          .returning({ id: contactsTable.id })
        return c.id
      })
      await expectStagingRefusal(
        f,
        "kernel:contacts_merge",
        { sourceId: crypto.randomUUID(), targetId },
        "NOT_FOUND",
      )
    })
  }, 60_000)

  it("contacts_export scoped to a segment that does not exist is refused at staging", async () => {
    await withFixture(["kernel:contacts:export", "kernel:contacts:read"], async (f) => {
      await expectStagingRefusal(
        f,
        "kernel:contacts_export",
        { segmentId: crypto.randomUUID() },
        "NOT_FOUND",
      )
    })
  }, 60_000)

  it("enable_routine_template with an unknown template is refused at staging", async () => {
    await withFixture(["kernel:routines:write"], async (f) => {
      await expectStagingRefusal(
        f,
        "kernel:enable_routine_template",
        { appName: "boxtal", templateKey: `missing-${crypto.randomUUID()}` },
        "template_not_found",
      )
    })
  }, 60_000)

  it("reset_routine_to_template on a routine that was not created from a template is refused at staging", async () => {
    await withFixture(["kernel:routines:write"], async (f) => {
      const routineId = await withPrivilegedDb(f.orgId, "preflight-seed-routine", async (tx) => {
        const [r] = await tx
          .insert(routinesTbl)
          .values({
            orgId: f.orgId,
            ownerUserId: f.userId,
            name: `hand-authored-${crypto.randomUUID()}`,
            description: "hand authored",
            kind: "recurring",
            cron: "0 9 * * *",
            timezone: "UTC",
            prompt: "do the thing",
            scopes: [],
            visibility: "personal",
            enabled: true,
            status: "active",
            createdByUserId: f.userId,
            createdByActorType: "user",
          })
          .returning({ id: routinesTbl.id })
        return r.id
      })
      await expectStagingRefusal(
        f,
        "kernel:reset_routine_to_template",
        { id: routineId },
        "not_a_template_routine",
      )
    })
  }, 60_000)

  it("reset_routine_to_template on an unknown routine id is refused at staging", async () => {
    await withFixture(["kernel:routines:write"], async (f) => {
      await expectStagingRefusal(
        f,
        "kernel:reset_routine_to_template",
        { id: crypto.randomUUID() },
        "routine_not_found",
      )
    })
  }, 60_000)

  it("toggle_app_skill naming a skill no app ships is refused at staging", async () => {
    await withFixture(["kernel:skills:write"], async (f) => {
      await expectStagingRefusal(
        f,
        "kernel:toggle_app_skill",
        { appName: "social", skillName: `ghost-${crypto.randomUUID()}`, scope: "user" },
        "app_skill_not_found",
      )
    })
  }, 60_000)
})
