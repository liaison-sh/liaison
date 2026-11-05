// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dimension-constrained approvals (generic kernel primitive; skills are its first
// user). A gated tool may declare a CUSTOM decision scope (approve_scope, e.g.
// kernel:skills:approve) plus an optional dimension constraint
// (kernel:skills_domain = [<domain>]). Only holders of the custom scope whose
// dimension grant covers the constraint may decide the approval; super-admins
// bypass; plain custom-scope holders without the grant are denied.
//
// Covers: the persisted approve_scope + dimension_constraint columns, the
// notify-audience filter, the decide authz matrix (granted / other-domain /
// undomained / '*' grant / super-admin bypass / no-grant denied / unconstrained
// unchanged), RLS visibility of a constrained row to a custom-scope holder in the
// notify set, and the grant path + list_dimensions catalog for kernel:skills_domain.

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import { createApprovalRequestInBundle } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { getDimensionCatalog } from "~/modules/permissions/dimension-catalog"
import { eligibleApproversWithDimension } from "~/modules/permissions/eligible-approvers"
import { grantUserDimension } from "~/modules/permissions/roles"
import type { PermissionMutationContext } from "~/modules/permissions/types"
import { insertThreadWithParticipants } from "~/modules/threads/thread"

const ADMIN_SCOPES = ["*"] as PermissionMutationContext["actorScopes"]
const DIM_KEY = "kernel:skills_domain"

let orgId: string
let adminId: string // '*' super-admin
let requesterId: string // stages the approvals (no approve scope)
let shipApproverId: string // kernel:skills:approve + skills_domain=[shipping]
let finApproverId: string // kernel:skills:approve + skills_domain=[finance]
let starApproverId: string // kernel:skills:approve + skills_domain=['*']
let plainApproverId: string // kernel:skills:approve, no dimension grant
let threadId: string

async function insertUser(email: string): Promise<string> {
  return withSystemDb("dca-user", async (tx) => {
    const r = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${email}, 'DCA User', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    return (r.rows ?? r)[0].id as string
  })
}

async function grantScope(userId: string, scope: string): Promise<void> {
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
    VALUES (${userId}, ${orgId}, ${scope}) ON CONFLICT DO NOTHING`
}

function actor(userId: string, scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
}

async function admin(): Promise<UserContext> {
  return { actorType: "user", userId: adminId, orgId, scopes: ["*"], dimensionGrants: {} }
}

// The granting admin holds every dimension value (the admin wildcard): a
// dimension the actor holds no grant on is an empty grant, never unrestricted.
const ADMIN_DIMENSIONS = { "*": ["*"] }

async function grantDomain(userId: string, values: string[]): Promise<void> {
  const a = await admin()
  await withRlsContext(a, (tx) =>
    grantUserDimension(tx, {
      orgId,
      userId,
      dimension: DIM_KEY,
      values,
      actorId: adminId,
      actorScopes: ADMIN_SCOPES,
      actorDimensionGrants: ADMIN_DIMENSIONS,
    }),
  )
}

let skillNameSeq = 0
/** A valid, unique create_skill param set so the approved handler re-entry
 *  succeeds (the authz decision is what we assert, but approveFlow runs the
 *  handler, which validates params). */
function validSkillParams(domain?: string) {
  skillNameSeq += 1
  return {
    name: `dca-skill-${skillNameSeq}`,
    description: "test skill",
    body: "body",
    requiredScopes: [] as string[],
    visibility: "personal" as const,
    ...(domain ? { domain } : {}),
  }
}

/** Stage a constrained kernel:skills:approve approval for a given domain. */
async function stageSkillApproval(domain: string): Promise<string> {
  return createApprovalRequestInBundle({
    orgId,
    threadId,
    toolName: "kernel:create_skill",
    toolParams: validSkillParams(domain),
    requestedBy: requesterId,
    summary: { kind: "create_skill", title: "Create skill", lines: [`Domain: ${domain}`] },
    appName: "kernel",
    toolShortName: "create_skill",
    requesterCanApprove: false,
    origin: "in-app-agent",
    approveScope: "kernel:skills:approve",
    dimensionConstraint: { key: DIM_KEY, values: [domain] },
    stepBundleId: null,
  })
}

async function rowById(id: string) {
  const [row] = await sql`
    SELECT approve_scope, dimension_constraint, notify_user_ids, status
    FROM kernel.approval_requests WHERE id = ${id}`
  return row as {
    approve_scope: string | null
    dimension_constraint: { key: string; values: string[] } | null
    notify_user_ids: string[]
    status: string
  }
}

beforeAll(async () => {
  const slug = `dca-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("dca-fixture", async (tx) => {
    const o = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'DCA Test', ${slug}) RETURNING id
    `)) as any
    orgId = (o.rows ?? o)[0].id
  })
  adminId = await insertUser(`admin-${slug}@x.test`)
  requesterId = await insertUser(`req-${slug}@x.test`)
  shipApproverId = await insertUser(`ship-${slug}@x.test`)
  finApproverId = await insertUser(`fin-${slug}@x.test`)
  starApproverId = await insertUser(`star-${slug}@x.test`)
  plainApproverId = await insertUser(`plain-${slug}@x.test`)

  await ensureAppsForOrg(orgId, {})

  // A thread for the approval surface (requester participates).
  threadId = await withPrivilegedDb(orgId, "dca-thread", async (tx) => {
    const { thread } = await insertThreadWithParticipants(tx, {
      orgId,
      userId: requesterId,
      participantIds: [requesterId],
      title: "DCA thread",
      isPinned: false,
      createdFrom: null,
    })
    return thread.id
  })

  await grantScope(adminId, "*")
  // The requester must retain the tool scope so the approved handler re-entry
  // (which runs under the requester's identity) is not blocked as forbidden.
  await grantScope(requesterId, "kernel:skills:write")
  await grantScope(shipApproverId, "kernel:skills:approve")
  await grantScope(finApproverId, "kernel:skills:approve")
  await grantScope(starApproverId, "kernel:skills:approve")
  await grantScope(plainApproverId, "kernel:skills:approve")
  await grantDomain(shipApproverId, ["shipping"])
  await grantDomain(finApproverId, ["finance"])
  await grantDomain(starApproverId, ["*"])
})

describe("kernel:skills_domain dimension catalog + grant path", () => {
  it("lists kernel:skills_domain in the dimension catalog", () => {
    const cat = getDimensionCatalog(orgId)
    const entry = cat.find((e) => e.key === DIM_KEY)
    expect(entry).toBeTruthy()
    expect(entry?.type).toBe("value")
  })

  it("grant_dimension_value accepts arbitrary slug values for the value-type dim", async () => {
    const a = await admin()
    const grant = (await withRlsContext(a, (tx) =>
      grantUserDimension(tx, {
        orgId,
        userId: plainApproverId,
        dimension: DIM_KEY,
        values: ["warehouse-ops"],
        actorId: adminId,
        actorScopes: ADMIN_SCOPES,
        actorDimensionGrants: ADMIN_DIMENSIONS,
      }),
    )) as { dimensionValues?: string[] } | null
    expect(grant?.dimensionValues).toEqual(["warehouse-ops"])
    // Clean it up so plainApprover stays grant-free for the shipping/finance rows.
    await sql`DELETE FROM kernel.user_dimension_grants
      WHERE user_id = ${plainApproverId} AND org_id = ${orgId} AND dimension_key = ${DIM_KEY}`
  })
})

describe("createApprovalRequest persists scope + constraint and filters audience", () => {
  it("persists approve_scope and dimension_constraint on the row", async () => {
    const id = await stageSkillApproval("shipping")
    const row = await rowById(id)
    expect(row.approve_scope).toBe("kernel:skills:approve")
    expect(row.dimension_constraint).toEqual({ key: DIM_KEY, values: ["shipping"] })
  })

  it("filters notify_user_ids by the dimension: shipping grantholder in, finance grantholder out", async () => {
    const id = await stageSkillApproval("shipping")
    const row = await rowById(id)
    expect(row.notify_user_ids).toContain(shipApproverId)
    expect(row.notify_user_ids).toContain(starApproverId) // '*' domain covers all
    expect(row.notify_user_ids).toContain(adminId) // super-admin bypass
    expect(row.notify_user_ids).not.toContain(finApproverId)
    expect(row.notify_user_ids).not.toContain(plainApproverId) // no grant
  })

  it("eligibleApproversWithDimension returns only covering + bypassing users", async () => {
    const ids = await withPrivilegedDb(orgId, "dca-eaw", (tx) =>
      eligibleApproversWithDimension(tx, orgId, "kernel:skills:approve", {
        key: DIM_KEY,
        values: ["finance"],
      }),
    )
    const set = new Set(ids)
    expect(set.has(finApproverId)).toBe(true)
    expect(set.has(starApproverId)).toBe(true)
    expect(set.has(adminId)).toBe(true)
    expect(set.has(shipApproverId)).toBe(false)
    expect(set.has(plainApproverId)).toBe(false)
  })
})

describe("decide authz matrix", () => {
  async function approve(id: string, userId: string, scopes: string[]) {
    return decideApproval({
      orgId,
      requestId: id,
      actor: actor(userId, scopes),
      decision: "approve",
    })
  }

  it("domain-granted approver approves a matching-domain skill approval", async () => {
    const id = await stageSkillApproval("shipping")
    const res = await approve(id, shipApproverId, ["kernel:skills:approve"])
    expect(res.status).toBe("approved")
  })

  it("denies a domain-granted approver on a DIFFERENT domain", async () => {
    const id = await stageSkillApproval("finance")
    await expect(approve(id, shipApproverId, ["kernel:skills:approve"])).rejects.toBeInstanceOf(
      ApprovalDecisionError,
    )
  })

  it("'*' dimension grant approves any domain", async () => {
    const id = await stageSkillApproval("finance")
    const res = await approve(id, starApproverId, ["kernel:skills:approve"])
    expect(res.status).toBe("approved")
  })

  it("plain kernel:skills:approve holder WITHOUT a domain grant is denied on a constrained row", async () => {
    const id = await stageSkillApproval("shipping")
    await expect(approve(id, plainApproverId, ["kernel:skills:approve"])).rejects.toBeInstanceOf(
      ApprovalDecisionError,
    )
  })

  it("super-admin scope bypasses the dimension constraint", async () => {
    const id = await stageSkillApproval("shipping")
    const res = await approve(id, adminId, ["*"])
    expect(res.status).toBe("approved")
  })

  it("kernel:approvals:admin scope bypasses the dimension constraint", async () => {
    // The admin also needs to be IN the audience OR hold a generic admin scope.
    // kernel:approvals:admin satisfies the generic admin visibility branch.
    const id = await stageSkillApproval("finance")
    const res = await approve(id, adminId, ["kernel:approvals:admin", "kernel:skills:approve"])
    expect(res.status).toBe("approved")
  })

  it("a non-constrained approval is decidable by a plain approve-scope holder (unchanged)", async () => {
    const id = await createApprovalRequestInBundle({
      orgId,
      threadId,
      toolName: "kernel:create_skill",
      toolParams: validSkillParams(),
      requestedBy: requesterId,
      summary: { kind: "create_skill", title: "Create skill y", lines: [] },
      appName: "kernel",
      toolShortName: "create_skill",
      requesterCanApprove: false,
      origin: "in-app-agent",
      approveScope: "kernel:skills:approve",
      dimensionConstraint: null,
      stepBundleId: null,
    })
    const res = await approve(id, plainApproverId, ["kernel:skills:approve"])
    expect(res.status).toBe("approved")
  })
})

describe("RLS visibility of a constrained approval row", () => {
  it("a kernel:skills:approve holder in notify_user_ids can SELECT the row; a random member cannot", async () => {
    const id = await stageSkillApproval("shipping")

    const seenByShip = await withRlsContext(
      actor(shipApproverId, ["kernel:skills:approve"]),
      async (tx) => {
        const r = await tx.execute(
          drizzleSql`SELECT id FROM kernel.approval_requests WHERE id = ${id}`,
        )
        return ((r as any).rows ?? r) as unknown[]
      },
    )
    expect(seenByShip.length).toBe(1)

    // finApprover is NOT in the notify set (different domain), and holds only the
    // custom approve scope; the COALESCE(approve_scope,...) RLS branch requires
    // membership in notify_user_ids, so the row is invisible.
    const seenByFin = await withRlsContext(
      actor(finApproverId, ["kernel:skills:approve"]),
      async (tx) => {
        const r = await tx.execute(
          drizzleSql`SELECT id FROM kernel.approval_requests WHERE id = ${id}`,
        )
        return ((r as any).rows ?? r) as unknown[]
      },
    )
    expect(seenByFin.length).toBe(0)
  })
})
