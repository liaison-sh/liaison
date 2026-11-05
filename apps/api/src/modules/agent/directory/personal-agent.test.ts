// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { userScopeGrants, users } from "~/db/schema/kernel"
import {
  createPersonalAgent,
  getOrCreatePersonalAgentId,
  personalAgentBaseHandle,
  personalCeiling,
  syncPersonalAgentCeilingsForEvent,
} from "~/modules/agent/directory/personal-agent"
import { bootstrapRegister } from "~/modules/auth/auth"
import { everyMemberScopeGrants } from "~/modules/permissions/permissions"
import { grantUserScope, revokeUserScope } from "~/modules/permissions/roles"
import { createScope } from "~/modules/permissions/types"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Mock RlsClient with queueEvent, mirroring roles.test.ts's setup: grantUserScope
// and revokeUserScope both queue an event on the tx they receive.
const rlsDb = db as unknown as RlsClient
;(rlsDb as any).queueEvent = async () => {}
const originalTransaction = (rlsDb as any).transaction.bind(rlsDb)
;(rlsDb as any).transaction = async (fn: any) => {
  return originalTransaction(async (tx: any) => {
    tx.queueEvent = async () => {}
    return fn(tx)
  })
}

const scopes = (...s: string[]) => s.map(createScope)

// Each describe block below is a fresh bootstrap (one org per DB), so each
// gets its own acquireTestLock/releaseTestLock pair (truncates first).

describe("PERSONAL AGENT CEILING: granting a scope", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("granting a new scope to a user updates their personal agent's scopeCeiling to include it", async () => {
    const admin = await bootstrapRegister("ceiling-grant@test.com", "Passw0rd!", "Ceiling Grant")

    await grantUserScope(rlsDb, {
      userId: admin.userId,
      orgId: admin.orgId,
      scope: "test:ceiling:granted",
      actorId: admin.userId,
      actorScopes: scopes("*"),
      actorDimensionGrants: {},
    })

    const [row] = await sql`
      SELECT scope_ceiling FROM kernel.agents
      WHERE owner_user_id = ${admin.userId} AND kind = 'personal'
    `
    expect(row).toBeTruthy()
    expect(row.scope_ceiling as string[]).toContain("test:ceiling:granted")
  })
})

describe("PERSONAL AGENT CEILING: revoking a scope", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("revoking a scope removes it from the ceiling", async () => {
    const admin = await bootstrapRegister("ceiling-revoke@test.com", "Passw0rd!", "Ceiling Revoke")

    await grantUserScope(rlsDb, {
      userId: admin.userId,
      orgId: admin.orgId,
      scope: "test:ceiling:toberevoked",
      actorId: admin.userId,
      actorScopes: scopes("*"),
      actorDimensionGrants: {},
    })

    const [granted] = await sql`
      SELECT scope_ceiling FROM kernel.agents
      WHERE owner_user_id = ${admin.userId} AND kind = 'personal'
    `
    expect(granted.scope_ceiling as string[]).toContain("test:ceiling:toberevoked")

    await revokeUserScope(rlsDb, {
      userId: admin.userId,
      orgId: admin.orgId,
      scope: "test:ceiling:toberevoked",
      actorId: admin.userId,
      actorScopes: scopes("*"),
      actorDimensionGrants: {},
    })

    const [revoked] = await sql`
      SELECT scope_ceiling FROM kernel.agents
      WHERE owner_user_id = ${admin.userId} AND kind = 'personal'
    `
    expect(revoked.scope_ceiling as string[]).not.toContain("test:ceiling:toberevoked")
  })
})

describe("PERSONAL AGENT CEILING: scopeCeiling is always a subset of the owner's current grants, never a superset", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("ceiling equals the owner's grants exactly after a grant, then exactly again after a revoke (no stale widening)", async () => {
    const admin = await bootstrapRegister("ceiling-exact@test.com", "Passw0rd!", "Ceiling Exact")

    // The bootstrapping admin's own grants are role scope "*" plus whatever
    // is granted directly below — the ceiling must track exactly that set,
    // never more (a stale scope surviving a revoke) and never less.
    await grantUserScope(rlsDb, {
      userId: admin.userId,
      orgId: admin.orgId,
      scope: "test:ceiling:exact:a",
      actorId: admin.userId,
      actorScopes: scopes("*"),
      actorDimensionGrants: {},
    })
    await grantUserScope(rlsDb, {
      userId: admin.userId,
      orgId: admin.orgId,
      scope: "test:ceiling:exact:b",
      actorId: admin.userId,
      actorScopes: scopes("*"),
      actorDimensionGrants: {},
    })

    const [afterGrants] = await sql`
      SELECT scope_ceiling FROM kernel.agents
      WHERE owner_user_id = ${admin.userId} AND kind = 'personal'
    `
    // The owner's grants include the scopes the org's apps give every active
    // member (manifest `everyMemberScopes`): the ceiling carries those too.
    const everyMember = (
      await withSystemDb("test-ceiling-every-member", (tx) =>
        everyMemberScopeGrants(tx, admin.userId, admin.orgId),
      )
    ).map((g) => g.scope)
    expect([...(afterGrants.scope_ceiling as string[])].sort()).toEqual(
      [...new Set(["*", ...everyMember, "test:ceiling:exact:a", "test:ceiling:exact:b"])].sort(),
    )

    await revokeUserScope(rlsDb, {
      userId: admin.userId,
      orgId: admin.orgId,
      scope: "test:ceiling:exact:b",
      actorId: admin.userId,
      actorScopes: scopes("*"),
      actorDimensionGrants: {},
    })

    const [afterRevoke] = await sql`
      SELECT scope_ceiling FROM kernel.agents
      WHERE owner_user_id = ${admin.userId} AND kind = 'personal'
    `
    // Exact equality, not just "no longer contains b" — a superset such as
    // {"*", a, b} surviving the revoke would pass a mere not-toContain check
    // but must fail here.
    expect([...(afterRevoke.scope_ceiling as string[])].sort()).toEqual(
      [...new Set(["*", ...everyMember, "test:ceiling:exact:a"])].sort(),
    )
  })
})

describe("PERSONAL AGENT CEILING: granting a TEAMMATE's scope on a real RLS connection", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("an actor holding only kernel:users:admin (no kernel:agents:admin, no *) still updates the TARGET teammate's ceiling", async () => {
    const admin = await bootstrapRegister(
      "ceiling-teammate-admin@test.com",
      "Passw0rd!",
      "Ceiling Teammate Admin",
    )

    // A limited admin: holds kernel:users:admin only, never kernel:agents:admin
    // or '*'. Seeded directly (not through grantUserScope, which is what this
    // test exercises) so its own grant carries no ceiling side effect to
    // confound the assertion below.
    const limitedAdminId = await withSystemDb("ceiling-teammate-seed-limited-admin", async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          orgId: admin.orgId,
          email: `ceiling-limited-admin-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Limited Admin",
          status: "active",
        })
        .returning({ id: users.id })
      await tx.insert(userScopeGrants).values({
        userId: u.id,
        orgId: admin.orgId,
        scope: "kernel:users:admin",
      })
      await createPersonalAgent(tx, {
        orgId: admin.orgId,
        userId: u.id,
        email: `ceiling-limited-admin-${u.id}@t.co`,
      })
      return u.id
    })

    // The target teammate whose ceiling must move — a DIFFERENT user than
    // the actor, so migration 0052's owner-or-agents-admin USING/WITH CHECK
    // on kernel.agents cannot be satisfied by identity.
    const teammateId = await withSystemDb("ceiling-teammate-seed-teammate", async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          orgId: admin.orgId,
          email: `ceiling-teammate-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Teammate",
          status: "active",
        })
        .returning({ id: users.id })
      await createPersonalAgent(tx, {
        orgId: admin.orgId,
        userId: u.id,
        email: `ceiling-teammate-${u.id}@t.co`,
      })
      return u.id
    })

    // A GENUINE RLS connection (GUCs set from the limited admin's own actual
    // scopes) — not the privileged-db-disguised-as-RlsClient `rlsDb` the
    // other describe blocks in this file use, which never exercises RLS at
    // all and is why this gap was invisible.
    await withRlsContext(
      {
        actorType: "user",
        userId: limitedAdminId,
        orgId: admin.orgId,
        scopes: ["kernel:users:admin"],
        dimensionGrants: {},
      },
      async (tx) => {
        await grantUserScope(tx, {
          userId: teammateId,
          orgId: admin.orgId,
          scope: "kernel:users:admin",
          actorId: limitedAdminId,
          actorScopes: scopes("kernel:users:admin"),
          actorDimensionGrants: {},
        })
      },
    )

    const [teammateAgent] = await sql`
      SELECT scope_ceiling FROM kernel.agents
      WHERE owner_user_id = ${teammateId} AND kind = 'personal'
    `
    expect(teammateAgent).toBeTruthy()
    expect(teammateAgent.scope_ceiling as string[]).toContain("kernel:users:admin")
  })
})

describe("PERSONAL AGENT HANDLE: two users slugifying to the same base handle", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("both get a personal agent, in the same org, with distinct handles derived from the same base", async () => {
    const admin = await bootstrapRegister("handle-collide@test.com", "Passw0rd!", "Handle Collide")

    // Same literal name on two DIFFERENT users in the SAME org: both slugify
    // to the identical base handle. Without a collision-safe allocator the
    // second lazy personal-agent creation fails on kernel.agents'
    // agents_org_handle_idx (org_id, handle) unique index.
    const userAId = await withSystemDb("handle-collide-seed-a", async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          orgId: admin.orgId,
          email: `handle-collide-a-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Dup Name",
          status: "active",
        })
        .returning({ id: users.id })
      return u.id
    })
    const userBId = await withSystemDb("handle-collide-seed-b", async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          orgId: admin.orgId,
          email: `handle-collide-b-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Dup Name",
          status: "active",
        })
        .returning({ id: users.id })
      return u.id
    })

    const agentAId = await withSystemDb("handle-collide-get-a", (tx) =>
      getOrCreatePersonalAgentId(tx, { orgId: admin.orgId, userId: userAId }),
    )
    const agentBId = await withSystemDb("handle-collide-get-b", (tx) =>
      getOrCreatePersonalAgentId(tx, { orgId: admin.orgId, userId: userBId }),
    )

    expect(agentAId).not.toBe(agentBId)

    const [rowA] = await sql`SELECT handle FROM kernel.agents WHERE id = ${agentAId}::uuid`
    const [rowB] = await sql`SELECT handle FROM kernel.agents WHERE id = ${agentBId}::uuid`
    expect(rowA.handle).toBe("@dup-names-agent")
    expect(rowB.handle).not.toBe(rowA.handle)
    expect(rowB.handle as string).toMatch(/^@dup-names-agent\d+$/)
  })
})

describe("PERSONAL AGENT HANDLE: two users whose EMAIL local parts slugify the same", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("both register and both get a distinct handle derived from that local part", async () => {
    const admin = await bootstrapRegister("email-collide@test.com", "Passw0rd!", "Email Collide")

    // No display name at all, so the handle comes from the email local part
    // (createPersonalAgent's fallback). Different domains, identical local
    // part: the derived base handle is the same for both users, which is the
    // shape the Playwright agent-reasoning scenarios hit in one org.
    const seedUser = async (domain: string) =>
      withSystemDb(`email-collide-seed-${domain}`, async (tx) => {
        const [u] = await tx
          .insert(users)
          .values({
            orgId: admin.orgId,
            email: `reasoning@${domain}-${crypto.randomUUID().slice(0, 8)}.test`,
            passwordHash: "x",
            name: "",
            status: "active",
          })
          .returning({ id: users.id })
        return u.id
      })

    const firstUserId = await seedUser("first")
    const secondUserId = await seedUser("second")

    const firstAgentId = await withSystemDb("email-collide-agent-first", (tx) =>
      getOrCreatePersonalAgentId(tx, { orgId: admin.orgId, userId: firstUserId }),
    )
    const secondAgentId = await withSystemDb("email-collide-agent-second", (tx) =>
      getOrCreatePersonalAgentId(tx, { orgId: admin.orgId, userId: secondUserId }),
    )

    expect(firstAgentId).not.toBe(secondAgentId)
    const [first] = await sql`SELECT handle FROM kernel.agents WHERE id = ${firstAgentId}::uuid`
    const [second] = await sql`SELECT handle FROM kernel.agents WHERE id = ${secondAgentId}::uuid`
    expect(first.handle).toBe("@reasonings-agent")
    expect(second.handle as string).toMatch(/^@reasonings-agent\d+$/)
  })
})

// A personal agent's handle names its owner's AGENT: `@ada` in a message read
// as the person Ada, so a member's agent is `@adas-agent`.
describe("PERSONAL AGENT HANDLE: the handle is the owner's agent, not the owner", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("derives <name>s-agent, and <name>-agent when the name already ends in s", () => {
    expect(personalAgentBaseHandle("ada")).toBe("@adas-agent")
    expect(personalAgentBaseHandle("thomas")).toBe("@thomas-agent")
    expect(personalAgentBaseHandle("dup-name")).toBe("@dup-names-agent")
    expect(personalAgentBaseHandle("")).toBe("@agent")
  })

  it("a signup's agent is @<firstname>s-agent, never @<firstname>", async () => {
    const admin = await bootstrapRegister("ada-owner@test.com", "Passw0rd!", "Ada Lovelace")
    const [row] = await sql`
      SELECT handle FROM kernel.agents WHERE owner_user_id = ${admin.userId} AND kind = 'personal'`
    expect(row.handle).toBe("@adas-agent")

    const seed = (name: string | null, email: string, baseHandle?: string) =>
      withSystemDb(`handle-form-${email}`, async (tx) => {
        const [u] = await tx
          .insert(users)
          .values({
            orgId: admin.orgId,
            email,
            passwordHash: "x",
            name: name ?? "",
            status: "active",
          })
          .returning({ id: users.id })
        const agent = await createPersonalAgent(tx, {
          orgId: admin.orgId,
          userId: u.id,
          email,
          firstName: name,
          ...(baseHandle ? { baseHandle } : {}),
        })
        return agent.handle
      })

    // A name ending in "s" takes no second one.
    expect(await seed("Thomas", "thomas@test.com")).toBe("@thomas-agent")
    // Same first name in the same org: the numeric discriminator still applies.
    expect(await seed("Ada", "ada-two@test.com")).toBe("@adas-agent2")
    // No name: the email local part, in the same form.
    expect(await seed(null, "jdoe@test.com")).toBe("@jdoes-agent")
    // A requested base handle still wins.
    expect(await seed("Ada", "ada-three@test.com", "@front-desk")).toBe("@front-desk")
  })
})

const ceilingOf = async (userId: string) => {
  const [row] = await sql`
    SELECT scope_ceiling FROM kernel.agents
    WHERE owner_user_id = ${userId} AND kind = 'personal'
  `
  return (row?.scope_ceiling ?? []) as string[]
}

describe("PERSONAL AGENT CEILING: a role given later through config apply", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("a role given later to an existing person (config apply) reaches their agent's ceiling", async () => {
    const admin = await bootstrapRegister("late-role@test.com", "Passw0rd!", "Late Role")
    const { userId } = await ensureUser({
      orgId: admin.orgId,
      email: "late-role-viewer@test.com",
      name: "Theo Viewer",
      password: "Passw0rd!",
      role: "viewer",
    })
    expect(await ceilingOf(userId)).not.toContain("kernel:threads:write")

    // The second apply names a role with more scopes for the same person.
    await ensureUser({
      orgId: admin.orgId,
      email: "late-role-viewer@test.com",
      name: "Theo Viewer",
      role: "member",
    })

    const ceiling = await ceilingOf(userId)
    expect(ceiling).toContain("kernel:threads:write")
    expect(ceiling).not.toContain("*")
  })
})

describe("PERSONAL AGENT CEILING: a later grant reaches the ceiling from its permission event", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("a scope added to a role the person holds (an app registration extending it) reaches the ceiling from the permission event", async () => {
    const admin = await bootstrapRegister("late-scope@test.com", "Passw0rd!", "Late Scope")
    const { userId } = await ensureUser({
      orgId: admin.orgId,
      email: "late-scope-member@test.com",
      name: "Mia Member",
      password: "Passw0rd!",
      role: "member",
    })
    expect(await ceilingOf(userId)).not.toContain("test:late:scope")

    const [role] = await sql`
      SELECT id FROM kernel.roles WHERE org_id = ${admin.orgId} AND name = 'member'
    `
    await sql`
      INSERT INTO kernel.role_scope_grants (id, role_id, scope)
      VALUES (gen_random_uuid(), ${role.id}, 'test:late:scope')
    `
    // The write alone leaves the snapshot stale: that was the defect.
    expect(await ceilingOf(userId)).not.toContain("test:late:scope")

    const updated = await syncPersonalAgentCeilingsForEvent({
      app: "kernel",
      entity: "role_scope",
      orgId: admin.orgId,
      data: { roleId: role.id, scopesAdded: ["test:late:scope"] },
    })
    expect(updated).toBeGreaterThanOrEqual(1)
    const ceiling = await ceilingOf(userId)
    expect(ceiling).toContain("test:late:scope")
    // Never wider than the person: the admin's "*" does not leak into it.
    expect(ceiling).not.toContain("*")
    // The admin's own agent keeps exactly the admin's grants.
    expect(await ceilingOf(admin.userId)).toContain("*")
  })
})

describe("PERSONAL AGENT CEILING: an event that names no grant change recomputes nothing", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("an event that is not a permission change, or names no target, recomputes nothing", async () => {
    const admin = await bootstrapRegister("late-none@test.com", "Passw0rd!", "Late None")
    expect(
      await syncPersonalAgentCeilingsForEvent({
        app: "kernel",
        entity: "message",
        orgId: admin.orgId,
        data: { targetUserId: admin.userId },
      }),
    ).toBe(0)
    expect(
      await syncPersonalAgentCeilingsForEvent({
        app: "kernel",
        entity: "role_scope",
        orgId: admin.orgId,
        data: {},
      }),
    ).toBe(0)
  })
})

describe("PERSONAL AGENT CEILING: an admin's narrowing is kept, never widened past the owner", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  it("personalCeiling is the owner's scopes the restriction covers, or the owner's scopes without one", () => {
    const owner = ["kernel:threads:read", "mail:accounts:read", "tickets:tickets:read"]
    expect(personalCeiling(owner, null)).toEqual(owner)
    expect(personalCeiling(owner, ["mail:*", "shopify:orders:read"])).toEqual([
      "mail:accounts:read",
    ])
    expect(personalCeiling(["*"], ["kernel:threads:read"])).toEqual(["kernel:threads:read"])
  })

  it("a narrowed agent keeps its narrowing through grant events, and a scope the owner loses leaves it", async () => {
    const admin = await bootstrapRegister("narrowed@test.com", "Passw0rd!", "Narrowed")
    const { userId } = await ensureUser({
      orgId: admin.orgId,
      email: "narrowed-member@test.com",
      name: "Nora Member",
      password: "Passw0rd!",
      role: "member",
    })
    const [role] = await sql`
      SELECT id FROM kernel.roles WHERE org_id = ${admin.orgId} AND name = 'member'
    `
    await sql`
      INSERT INTO kernel.role_scope_grants (id, role_id, scope)
      VALUES (gen_random_uuid(), ${role.id}, 'test:narrow:kept')
    `
    // The admin narrows the agent to two scopes (as the agent settings PATCH stores it).
    await sql`
      UPDATE kernel.agents
      SET ceiling_restriction = '["test:narrow:kept","kernel:threads:read"]'::jsonb
      WHERE owner_user_id = ${userId} AND kind = 'personal'
    `
    // An app toggle names every member: the narrowing survives the recompute.
    await syncPersonalAgentCeilingsForEvent({
      app: "kernel",
      entity: "user_scope",
      orgId: admin.orgId,
      data: { targetUserIds: [userId] },
    })
    expect((await ceilingOf(userId)).sort()).toEqual(["kernel:threads:read", "test:narrow:kept"])

    // The owner loses a scope the restriction still names: it leaves the agent.
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${role.id} AND scope = 'test:narrow:kept'`
    await syncPersonalAgentCeilingsForEvent({
      app: "kernel",
      entity: "role_scope",
      orgId: admin.orgId,
      data: { roleId: role.id, scopesRemoved: ["test:narrow:kept"] },
    })
    expect(await ceilingOf(userId)).toEqual(["kernel:threads:read"])

    // An unassignment names its member (`targetUserId`), so the recompute
    // reaches them although their assignment row is already gone.
    await sql`DELETE FROM kernel.user_roles WHERE user_id = ${userId} AND role_id = ${role.id}`
    await syncPersonalAgentCeilingsForEvent({
      app: "kernel",
      entity: "role_assignment",
      orgId: admin.orgId,
      data: { targetUserId: userId, roleId: role.id },
    })
    expect(await ceilingOf(userId)).not.toContain("kernel:threads:read")
  })
})
