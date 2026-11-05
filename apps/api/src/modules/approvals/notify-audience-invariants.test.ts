// SPDX-License-Identifier: FSL-1.1-ALv2
//
// NOTIFY-AUDIENCE INVARIANTS. `createApprovalRequest` is the single writer of
// `notify_user_ids`; these tests pin the audience rules that have failed (or
// nearly failed) in prod:
//
//  * SELF-APPROVABLE FAN-OUT (2026-08-06): a request whose requester can
//    self-approve must STILL notify every other eligible approver. The old
//    `else if (!requesterCanApprove)` shortcut notified the requester alone,
//    so three pending skill edits sat invisible to the admin for days.
//  * FAIL-CLOSED SENTINEL: when a tool's approvalDimension resolver fails, the
//    `__unresolved__` constraint must collapse the audience to super-admin
//    bypass holders (+ the requester) — never silently widen to every
//    approve-scope holder. Deliberate error-path behavior, documented here.
//  * SEQUENCED STEPS: the audience is FROZEN from the source row (a bundle
//    renders and decides as one unit; approval rows are frozen snapshots), but
//    the deciding SCOPE is per-step — each step persists its OWN
//    `approve_scope`, never a copy of the source's. Audience and scope are
//    different questions.
//
// (Owner-routed `notify == [owner]` is pinned in resource-owner.test.ts.)

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  createApprovalRequestInBundle,
  createSequencedApprovalStep,
} from "~/modules/apps/execute-tool"
import { insertThreadWithParticipants } from "~/modules/threads/thread"

let orgId: string
let threadId: string
let requesterId: string
let peerApproverId: string
let adminId: string

async function insertUser(email: string, scopes: string[]): Promise<string> {
  const id = await withSystemDb("nai-user", async (tx) => {
    const r = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${email}, 'NAI User', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    return (r.rows ?? r)[0].id as string
  })
  for (const scope of scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${id}, ${orgId}, ${scope}) ON CONFLICT DO NOTHING`
  }
  return id
}

async function rowById(id: string) {
  const [row] = await sql`
    SELECT notify_user_ids, approve_scope, dimension_constraint, status
    FROM kernel.approval_requests WHERE id = ${id}`
  return row as {
    notify_user_ids: string[]
    approve_scope: string | null
    dimension_constraint: { key: string; values: string[] } | null
    status: string
  }
}

beforeAll(async () => {
  const slug = `nai-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("nai-org", async (tx) => {
    const o = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'NAI Test', ${slug}) RETURNING id
    `)) as any
    orgId = (o.rows ?? o)[0].id
  })
  // Requester HOLDS the approve scope (self-approvable) — the incident shape.
  requesterId = await insertUser(`req-${slug}@x.test`, ["test:approve", "test:gated:write"])
  peerApproverId = await insertUser(`peer-${slug}@x.test`, ["test:approve"])
  adminId = await insertUser(`admin-${slug}@x.test`, ["*"])

  // No ensureAppsForOrg: staging an approval touches only the DB (audience
  // fan-out) and in-memory registries that tolerate absence; nothing here
  // decides, so no handler re-entry needs a registered app. Keeps the fixture
  // seconds, not minutes.

  threadId = await withPrivilegedDb(orgId, "nai-thread", async (tx) => {
    const { thread } = await insertThreadWithParticipants(tx, {
      orgId,
      userId: requesterId,
      participantIds: [requesterId],
      title: "NAI thread",
      isPinned: false,
      createdFrom: null,
    })
    return thread.id
  })
}, 60_000)

async function stage(over: Partial<Parameters<typeof createApprovalRequestInBundle>[0]> = {}) {
  return createApprovalRequestInBundle({
    orgId,
    threadId,
    toolName: "test:gatedEcho",
    toolParams: { message: "hi" },
    requestedBy: requesterId,
    summary: { kind: "gatedEcho", title: "Echo", lines: [] },
    appName: "test",
    toolShortName: "gatedEcho",
    requesterCanApprove: true,
    origin: "in-app-agent",
    stepBundleId: null,
    ...over,
  })
}

describe("notify-audience invariants", () => {
  it("a SELF-APPROVABLE request still fans out to every other eligible approver, requester first", async () => {
    const id = await stage()
    const row = await rowById(id)
    expect(row.notify_user_ids[0]).toBe(requesterId)
    expect(row.notify_user_ids).toContain(peerApproverId)
    expect(row.notify_user_ids).toContain(adminId) // '*' covers test:approve
  })

  it("the __unresolved__ sentinel collapses the audience to super-admins (+ requester), never widens", async () => {
    const id = await stage({
      approveScope: "test:approve",
      dimensionConstraint: { key: "__unresolved__", values: ["__unresolved__"] },
    })
    const row = await rowById(id)
    expect(row.notify_user_ids).toContain(requesterId)
    expect(row.notify_user_ids).toContain(adminId) // bypass holder
    // The peer holds test:approve but no dimension grant can cover the
    // sentinel — they must NOT be in the audience.
    expect(row.notify_user_ids).not.toContain(peerApproverId)
    expect(row.dimension_constraint?.key).toBe("__unresolved__")
  })

  it("a sequenced step freezes the AUDIENCE from its source but persists its OWN deciding scope", async () => {
    const headId = await stage()
    const head = await rowById(headId)
    const stepId = await createSequencedApprovalStep({
      orgId,
      threadId,
      toolName: "kernel:update_skill",
      toolParams: { name: "x" },
      requestedBy: requesterId,
      summary: { kind: "update_skill", title: "Step", lines: [] },
      appName: "kernel",
      toolShortName: "update_skill",
      approveScope: "kernel:skills:approve",
      dimensionConstraint: null,
      bundle: { bundleId: headId, dependsOnId: headId, position: -1 },
    })
    const step = await rowById(stepId)
    expect(step.status).toBe("deferred")
    // Audience: frozen copy of the source's (bundle decides as one unit).
    expect(step.notify_user_ids).toEqual(head.notify_user_ids)
    // Scope: the STEP's own tool's scope — never the source's derived scope.
    expect(step.approve_scope).toBe("kernel:skills:approve")
    expect(head.approve_scope).toBe("test:approve")
  })

  // Review 2026-10-30: a step re-proposed by a later turn is restaged in place.
  // Its source may have been NARROWED meanwhile (a tainted turn re-proposed it,
  // scope-taint.ts rule 8g): the restaged step takes the source's audience and
  // demand again, never keeping its older, wider one.
  it("a restaged step takes its source's narrowed audience and demand", async () => {
    const headId = await stage()
    const step = (params: Record<string, unknown>) =>
      createSequencedApprovalStep({
        orgId,
        threadId,
        toolName: "kernel:update_skill",
        toolParams: params,
        requestedBy: requesterId,
        summary: { kind: "update_skill", title: "Step", lines: [] },
        appName: "kernel",
        toolShortName: "update_skill",
        approveScope: "kernel:skills:approve",
        dimensionConstraint: null,
        bundle: { bundleId: headId, dependsOnId: headId, position: -1 },
      })
    const stepId = await step({ name: "first" })
    expect((await rowById(stepId)).notify_user_ids).toContain(peerApproverId)
    // The source narrowed to its requester, demanding a scope the peer lacks.
    await sql`UPDATE kernel.approval_requests
      SET notify_user_ids = ${sql.array([requesterId])}::uuid[],
          metadata = COALESCE(metadata, '{}'::jsonb) || '{"taintAudienceMustHold":["test:gated:write"]}'::jsonb
      WHERE id = ${headId}`
    expect(await step({ name: "second" })).toBe(stepId)
    const [restaged] = await sql`SELECT notify_user_ids, metadata, current_payload
      FROM kernel.approval_requests WHERE id = ${stepId}`
    const r = restaged as {
      notify_user_ids: string[]
      metadata: { taintAudienceMustHold?: string[] }
      current_payload: { name: string }
    }
    expect(r.current_payload.name).toBe("second")
    expect(r.notify_user_ids).toEqual([requesterId])
    expect(r.metadata.taintAudienceMustHold).toEqual(["test:gated:write"])
  })
})
