// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { type PrivilegedDb, type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import * as emailInfra from "~/infra/email"
import { env } from "~/lib/env"
import { deactivateUser } from "~/modules/users/service"

const publishedEvents: any[] = []
const rlsDb = db as unknown as RlsClient
;(rlsDb as any).queueEvent = async (event: any) => {
  publishedEvents.push(event)
}
const originalTransaction = (rlsDb as any).transaction.bind(rlsDb)
;(rlsDb as any).transaction = async (fn: any) => {
  return originalTransaction(async (tx: any) => {
    tx.queueEvent = async (event: any) => {
      publishedEvents.push(event)
    }
    return fn(tx)
  })
}

import { organizations } from "~/db/schema/kernel"
import { createInvitation } from "~/modules/users/invites"

const ORG_A = "00000000-0000-0000-0000-c10000000001"
const ORG_B = "00000000-0000-0000-0000-c20000000001"
const INVITER = "00000000-0000-0000-0000-c10000000002"
let roleAId: string
let scopedRoleId: string

describe("invites service", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_A}, 'InviteOrgA', 'invite-orga') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_B}, 'InviteOrgB', 'invite-orgb') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${INVITER}, ${ORG_A}, 'inviter@test.com', 'Inviter') ON CONFLICT (id) DO NOTHING`

    // Create a role belonging to ORG_A
    const [role] = await sql`
      INSERT INTO kernel.roles (org_id, name) VALUES (${ORG_A}, 'member')
      ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `
    roleAId = role.id

    // Create a role with a restricted scope that the inviter does NOT hold
    const [scopedRole] = await sql`
      INSERT INTO kernel.roles (org_id, name) VALUES (${ORG_A}, 'auditor-invite-test')
      ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `
    scopedRoleId = scopedRole.id
    await sql`
      INSERT INTO kernel.role_scope_grants (role_id, scope)
      VALUES (${scopedRoleId}, 'kernel:audit:read')
      ON CONFLICT DO NOTHING
    `
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.invitations WHERE org_id IN (${ORG_A}, ${ORG_B})`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${scopedRoleId}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_A} AND name IN ('member', 'auditor-invite-test')`
    await sql`DELETE FROM kernel.users WHERE id = ${INVITER}`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
  })

  it("the invitation link is on the org's host with org hosts, and BASE_URL's link without", async () => {
    const saved = env.LIAISON_ORG_HOST_TEMPLATE
    const invite = (email: string) =>
      createInvitation(rlsDb, {
        orgId: ORG_A,
        email,
        roleId: roleAId,
        invitedBy: INVITER,
        actorScopes: ["kernel"],
        actorDimensionGrants: {},
      })
    try {
      env.LIAISON_ORG_HOST_TEMPLATE = undefined
      const plain = await invite("org-host-off@example.com")
      if (!plain || "error" in plain) throw new Error("invitation refused")
      expect(plain.inviteUrl).toBe(`${env.BASE_URL}/register?token=${plain.inviteToken}`)

      env.LIAISON_ORG_HOST_TEMPLATE = "https://{slug}.example.com"
      const hosted = await invite("org-host-on@example.com")
      if (!hosted || "error" in hosted) throw new Error("invitation refused")
      expect(hosted.inviteUrl).toBe(
        `https://invite-orga.example.com/register?token=${hosted.inviteToken}`,
      )
    } finally {
      env.LIAISON_ORG_HOST_TEMPLATE = saved
    }
  })

  it("creates an invitation for a valid same-org role", async () => {
    const result = await createInvitation(rlsDb, {
      orgId: ORG_A,
      email: "newuser@example.com",
      roleId: roleAId,
      invitedBy: INVITER,
      actorScopes: ["kernel"],
      actorDimensionGrants: {},
    })
    expect(result).not.toBeNull()
    expect(result).toHaveProperty("inviteToken")
    expect(result).toHaveProperty("inviteUrl")
    const invite = result as { inviteToken: string; inviteUrl: string }
    expect(invite.inviteToken).toBeDefined()
    // `?token=`, the param Register actually reads. It accepts a legacy
    // `?invite=` too, for invite mails sent before the server was corrected.
    expect(invite.inviteUrl).toContain(`/register?token=${invite.inviteToken}`)
  })

  it("returns null when role belongs to a different org (T-18 — cross-org role guard)", async () => {
    // ORG_B makes no sense for roleAId which is owned by ORG_A
    const result = await createInvitation(rlsDb, {
      orgId: ORG_B,
      email: "attacker@evil.com",
      roleId: roleAId,
      invitedBy: INVITER,
      actorScopes: ["kernel"],
      actorDimensionGrants: {},
    })
    expect(result).toBeNull()
  })

  it("names the organization in the mail even when the caller's RLS client cannot read organizations", async () => {
    const sent: Array<{ subject: string; text?: string }> = []
    const spy = spyOn(emailInfra, "getSystemEmailProvider").mockReturnValue({
      name: "capture",
      send: async (m: { subject: string; text?: string }) => {
        sent.push(m)
        return { id: "m1" }
      },
    } as never)
    // organizations has a deny-all policy for the app role: a plain select on the RLS client gets no row.
    const blind = new Proxy(rlsDb as object, {
      get(target, prop, recv) {
        if (prop !== "select") return Reflect.get(target, prop, recv)
        return (...args: unknown[]) => {
          const q = (target as any).select(...args)
          return new Proxy(q, {
            get(qt, qp, qr) {
              if (qp !== "from") return Reflect.get(qt, qp, qr)
              return (table: unknown) =>
                table === organizations
                  ? { where: () => ({ limit: async () => [] }) }
                  : (qt as any).from(table)
            },
          })
        }
      },
    }) as unknown as RlsClient
    try {
      await createInvitation(blind, {
        orgId: ORG_A,
        email: "named-org@example.com",
        roleId: roleAId,
        invitedBy: INVITER,
        actorScopes: ["*"],
      } as never)
    } finally {
      spy.mockRestore()
    }
    expect(sent[0]?.subject).toBe("You're invited to InviteOrgA")
    expect(sent[0]?.text).toContain("join InviteOrgA on Liaison")
  })

  it("returns USER_EXISTS error when inviting an already-registered email", async () => {
    const result = await createInvitation(rlsDb, {
      orgId: ORG_A,
      email: "inviter@test.com", // INVITER's own email — already exists in ORG_A
      roleId: roleAId,
      invitedBy: INVITER,
      actorScopes: ["kernel"],
      actorDimensionGrants: {},
    })
    expect(result).toEqual({ error: "USER_EXISTS" })
  })

  it("returns SCOPE_ESCALATION when actor lacks a scope held by the target role", async () => {
    // The actor has only 'kernel:users:write' but the target role grants 'kernel:audit:read'.
    // The invite must be rejected to prevent privilege escalation via invitation.
    const result = await createInvitation(rlsDb, {
      orgId: ORG_A,
      email: "escalation-attempt@example.com",
      roleId: scopedRoleId,
      invitedBy: INVITER,
      actorScopes: ["kernel:users:write"], // does NOT cover kernel:audit:read
      actorDimensionGrants: {},
    })
    expect(result).toEqual({ error: "SCOPE_ESCALATION" })
  })

  it("allows invitation when actor holds the required scope via wildcard", async () => {
    // An actor with the full wildcard ('*') should be able to invite to any role.
    const result = await createInvitation(rlsDb, {
      orgId: ORG_A,
      email: "wildcard-actor@example.com",
      roleId: scopedRoleId,
      invitedBy: INVITER,
      actorScopes: ["*"],
      actorDimensionGrants: {},
    })
    // Should succeed (not a SCOPE_ESCALATION), though email/role combo may succeed or conflict
    expect(result).not.toEqual({ error: "SCOPE_ESCALATION" })
  })

  // roleName resolution — the onboarding flow raises create_role + invite_user in ONE turn, so
  // the role has no uuid yet when the invite is raised; the agent names the role and the invite's
  // own (later) approval resolves it. createInvitation must resolve roleName → the org's role at
  // EXECUTION time. Before this fix, invite_user required a uuid, so the agent passed a fabricated
  // id → NOT_FOUND on approval (the onboard-july 3x-gate failure: 2/3 runs invite-NOT_FOUND).
  it("resolves the role by roleName when no roleId is given (onboarding: create_role + invite same turn)", async () => {
    const result = await createInvitation(rlsDb, {
      orgId: ORG_A,
      email: "by-name@example.com",
      roleName: "member", // the role exists under this exact name in ORG_A
      invitedBy: INVITER,
      actorScopes: ["kernel"],
      actorDimensionGrants: {},
    })
    expect(result).not.toBeNull()
    expect(result).toHaveProperty("inviteToken")
    // The invitation row must carry the RESOLVED role id, not a null/placeholder.
    const [row] = await sql`
      SELECT role_id FROM kernel.invitations
      WHERE org_id = ${ORG_A} AND email = 'by-name@example.com' AND accepted_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `
    expect(row?.role_id).toBe(roleAId)
  })

  it("returns null (NOT_FOUND) when roleName matches no role in the org", async () => {
    const result = await createInvitation(rlsDb, {
      orgId: ORG_A,
      email: "no-such-role@example.com",
      roleName: "this-role-does-not-exist",
      invitedBy: INVITER,
      actorScopes: ["kernel"],
      actorDimensionGrants: {},
    })
    expect(result).toBeNull()
  })

  it("enforces SCOPE_ESCALATION through roleName resolution (no escalation bypass by naming)", async () => {
    // Naming the over-scoped role must run the SAME escalation guard as passing its id.
    const result = await createInvitation(rlsDb, {
      orgId: ORG_A,
      email: "escalation-by-name@example.com",
      roleName: "auditor-invite-test", // grants kernel:audit:read
      invitedBy: INVITER,
      actorScopes: ["kernel:users:write"], // does NOT cover kernel:audit:read
      actorDimensionGrants: {},
    })
    expect(result).toEqual({ error: "SCOPE_ESCALATION" })
  })

  it("returns null when neither roleId nor roleName is provided", async () => {
    const result = await createInvitation(rlsDb, {
      orgId: ORG_A,
      email: "no-role-at-all@example.com",
      invitedBy: INVITER,
      actorScopes: ["kernel"],
      actorDimensionGrants: {},
    })
    expect(result).toBeNull()
  })

  it("returns DIMENSION_ESCALATION when the role widens data visibility past the inviter's grants", async () => {
    const [dimRole] = await sql`
      INSERT INTO kernel.roles (org_id, name) VALUES (${ORG_A}, 'dim-wide-invite-test')
      ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `
    await sql`DELETE FROM kernel.role_dimension_grants WHERE role_id = ${dimRole.id}`
    await sql`INSERT INTO kernel.role_dimension_grants (role_id, dimension_key, dimension_values)
      VALUES (${dimRole.id}, 'team', '["sales", "finance"]'::jsonb)`
    try {
      // Even a wildcard-scope inviter is bound by its own dimension grants.
      const narrow = await createInvitation(rlsDb, {
        orgId: ORG_A,
        email: "dim-narrow@example.com",
        roleId: dimRole.id,
        invitedBy: INVITER,
        actorScopes: ["*"],
        actorDimensionGrants: { team: ["sales"] },
      })
      expect(narrow).toEqual({ error: "DIMENSION_ESCALATION" })

      const covered = await createInvitation(rlsDb, {
        orgId: ORG_A,
        email: "dim-covered@example.com",
        roleId: dimRole.id,
        invitedBy: INVITER,
        actorScopes: ["*"],
        actorDimensionGrants: { team: ["sales", "finance"] },
      })
      expect(covered).toHaveProperty("inviteToken")
    } finally {
      await sql`DELETE FROM kernel.invitations WHERE org_id = ${ORG_A} AND email LIKE 'dim-%'`
      await sql`DELETE FROM kernel.role_dimension_grants WHERE role_id = ${dimRole.id}`
      await sql`DELETE FROM kernel.roles WHERE id = ${dimRole.id}`
    }
  })
})

describe("user deactivation guard", () => {
  it("throws when an actor attempts to deactivate their own account", async () => {
    const ACTOR_ID = "00000000-0000-0000-0000-d10000000001"
    await expect(
      deactivateUser(db as unknown as PrivilegedDb, {
        targetId: ACTOR_ID,
        actorId: ACTOR_ID,
        orgId: ORG_A,
        actorScopes: ["*"],
      }),
    ).rejects.toThrow("Cannot deactivate own account")
  })
})
