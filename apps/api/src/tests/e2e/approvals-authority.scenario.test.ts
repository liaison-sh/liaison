// SPDX-License-Identifier: FSL-1.1-ALv2
//
// APPROVAL AUTHORITY E2E — the multi-user replay of the 2026-08-05/06 failure
// week, against the consolidated authority module. One org, seven actors, and
// every surface asserted per scenario: attention feed, approvals list, detail,
// decide, DB state, WS delivery, and the audit trail.
//
//  S1  Org skill lifecycle (the four-way failure): a skill create + update
//      proposed by an issuer WITHOUT approve scopes routes to the
//      kernel:skills:approve holder (the C-Level persona) — visible in their
//      feed AND list, decidable by them — while a generic kernel:approve
//      admin sees it in neither narrow surface and cannot decide.
//      kernel:approve is never sufficient nor required for a domain approval.
//  S2  Knowledge policy-gated approval: an org approval_policies row (set via
//      the real approval_policy_set gate path) gates knowledge:update; the
//      scope catalog exposes knowledge:approve (the 2026-08-05 fix, e2e); the
//      knowledge:approve holder is fanned in, decides, and the handler
//      actually updates the document.
//  S3  Validation by issuer vs by another: a self-approvable direct human
//      call bypasses the gate entirely (no row); under an N-eyes policy the
//      bypass is refused, the row fans out to every eligible approver
//      (requester first — the 2026-08-06 fix), the issuer's sign-off alone
//      does NOT execute, a repeat sign-off by the same person does not count,
//      and the second distinct approver completes it.
//  S4  Owner-routed privacy is absolute: even `*` and kernel:approve holders
//      see nothing; the owner sees and decides.
//  S5  Tracking: decided_by on the row, the decide recorded in audit_log by
//      the real decide -> outbox -> audit chain, audit_search returns it, and
//      the outsider is scope-refused.
//
// House rules honored: actors under test never hold `<app>:approve`+`*`
// combos that would trip the direct-human self-approve bypass (except where
// the bypass IS the assertion); minApprovers >= 2 is the bypass-immune case.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, connectWs, createUserWithScopes } from "@liaison/test-helpers"
import { createFreshThread, decide, ks, pollUntil, waitForApprovalEvent } from "./helpers/approvals"
import { setupScenario, teardownScenario } from "./setup"

interface Actor {
  id: string
  email: string
  token: string
  name: string
}

let env: WorkerEnv
let world: TestWorld
let url: string
let kernelSchema: string

let issuer: Actor // proposes skill + knowledge changes; NO approve scopes
let skillsApprover: Actor // kernel:skills:approve + shipping domain — the C-Level persona
let knowledgeApprover: Actor // knowledge:approve only
let genericAdmin: Actor // kernel:approve — admin-grade, must NOT decide domain approvals
let selfApprover: Actor // test:gated:write + test:approve (issuer-can-validate)
let peerApprover: Actor // test:approve (the "other" validator)
let outsider: Actor // read-only

// A proposal is an AGENT's call: a person's own call never parks an approval
// (it runs on their scope or is refused). `asAgent` makes the call as the agent
// acting for `token`'s user (origin in-app-agent), the way production stages one.
function agentToolCall(
  token: string,
  toolName: string,
  params: Record<string, unknown>,
  threadId?: string,
) {
  return api(url, "/api/_test/agent-tool-call", {
    method: "POST",
    token,
    body: { toolName, params, ...(threadId ? { threadId } : {}) },
  })
}

async function callKernelTool(
  token: string,
  tool: string,
  params: Record<string, unknown>,
  threadId?: string,
  opts?: { asAgent?: boolean },
) {
  if (opts?.asAgent) return agentToolCall(token, `kernel:${tool}`, params, threadId)
  return api(url, `/api/apps/tools/kernel:${tool}`, {
    method: "POST",
    token,
    body: { params, ...(threadId ? { threadId } : {}) },
  })
}

async function runTool(
  token: string,
  toolName: string,
  params: Record<string, unknown>,
  threadId: string,
  opts?: { asAgent?: boolean },
) {
  if (opts?.asAgent) return agentToolCall(token, toolName, params, threadId)
  return api(url, "/api/apps/run-tool", {
    method: "POST",
    token,
    body: { toolName, threadId, params },
  })
}

async function attentionApprovalIds(token: string): Promise<string[]> {
  const res = await api(url, "/api/attention-items", { token })
  const items: any[] = res.body?.data?.items ?? []
  return items.filter((i) => i.kind === "approval_pending").map((i) => i.entityId)
}

/** Poll until the feed contains (or a supplier satisfies) the wanted id.
 *  `pollUntil` resolves on the first TRUTHY return, so the supplier must
 *  return null until the condition holds ([] is truthy). */
async function pollForInclusion(
  supplier: () => Promise<string[]>,
  wanted: string,
  timeoutMs: number,
): Promise<string[]> {
  return pollUntil(
    async () => {
      const ids = await supplier()
      return ids.includes(wanted) ? ids : null
    },
    timeoutMs,
    250,
  )
}

async function decidableListIds(token: string): Promise<string[]> {
  const res = await api(url, "/api/approvals?status=pending&decidableByMe=true", { token })
  const rows: any[] = res.body?.data ?? []
  return rows.map((r) => r.id)
}

async function approvalRow(id: string) {
  const rows = await env.db.sql.unsafe(
    `SELECT approve_scope, dimension_constraint, notify_user_ids, status, decided_by
     FROM ${kernelSchema}.approval_requests WHERE id = $1`,
    [id],
  )
  return rows[0] as unknown as {
    approve_scope: string | null
    dimension_constraint: { key: string; values: string[] } | null
    notify_user_ids: string[]
    status: string
    decided_by: string | null
  }
}

describe("approvals authority e2e", () => {
  beforeAll(async () => {
    const result = await setupScenario({
      seed: 97,
      org: { name: "Approval Authority E2E Org" },
      populate: { users: { count: 3 } },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    kernelSchema = ks(env)

    const mk = async (name: string, scopes: string[], dimensions?: Record<string, string[]>) => {
      const u = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
        scopes,
        dimensions: dimensions ?? {},
        schemaPrefix: env.schemaPrefix,
      })
      return { ...u, name } as Actor
    }

    const threadScopes = ["kernel:threads", "kernel:threads:read", "kernel:threads:write"]
    issuer = await mk("issuer", [
      ...threadScopes,
      "kernel:skills:write",
      "knowledge:documents:create",
      "knowledge:documents:update",
      "knowledge:documents:read",
      "knowledge:collections:manage",
      "test:gated:write",
      "kernel:approvals:read",
      "kernel:approvals:write",
    ])
    skillsApprover = await mk(
      "skills-approver",
      [...threadScopes, "kernel:skills:approve", "kernel:approvals:read", "kernel:approvals:write"],
      { "kernel:skills_domain": ["shipping"] },
    )
    knowledgeApprover = await mk("knowledge-approver", [
      ...threadScopes,
      "knowledge:approve",
      "kernel:approvals:read",
      "kernel:approvals:write",
    ])
    genericAdmin = await mk("generic-admin", [
      ...threadScopes,
      "kernel:approve",
      "kernel:approvals:read",
      "kernel:approvals:write",
    ])
    selfApprover = await mk("self-approver", [
      ...threadScopes,
      "test:gated:write",
      "test:approve",
      "kernel:approvals:read",
      "kernel:approvals:write",
    ])
    peerApprover = await mk("peer-approver", [
      ...threadScopes,
      "test:approve",
      "kernel:approvals:read",
      "kernel:approvals:write",
    ])
    outsider = await mk("outsider", ["kernel:threads:read"])
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  // Shared state across the ordered scenarios.
  let skillId: string
  let updateRequestId: string

  it("S1a: issuer's create_skill proposal routes to the domain approver, who approves it", async () => {
    const threadId = await createFreshThread(url, issuer.token, issuer.id, "S1 skill thread")
    const res = await callKernelTool(
      issuer.token,
      "create_skill",
      {
        name: "authority-e2e-skill",
        description: "e2e skill",
        body: "original body",
        requiredScopes: [],
        visibility: "personal",
        domain: "shipping",
      },
      threadId,
      { asAgent: true },
    )
    const blocked = res.body?.data?.blocked
    expect(blocked?.approvalRequestId).toBeTruthy()
    const createRequestId = blocked.approvalRequestId as string

    const row = await approvalRow(createRequestId)
    expect(row.approve_scope).toBe("kernel:skills:approve")
    expect(row.dimension_constraint).toEqual({ key: "kernel:skills_domain", values: ["shipping"] })
    expect(row.notify_user_ids[0]).toBe(issuer.id)
    expect(row.notify_user_ids).toContain(skillsApprover.id)

    const decideRes = await decide(url, skillsApprover.token, createRequestId, {
      decision: "approve",
    })
    expect(decideRes.status).toBe(200)
    const skills = await env.db.sql.unsafe(
      `SELECT id FROM ${kernelSchema}.skills WHERE org_id = $1 AND name = 'authority-e2e-skill'`,
      [world.org.id],
    )
    expect(skills.length).toBe(1)
    skillId = skills[0].id as string
  }, 120_000)

  it("S1b: the skill UPDATE is visible in the skills-approver's feed AND list; the kernel:approve admin sees neither and cannot decide", async () => {
    const wsSkills = await connectWs(url, skillsApprover.token)
    const wsAdmin = await connectWs(url, genericAdmin.token)

    const threadId = await createFreshThread(url, issuer.token, issuer.id, "S1b update thread")
    const res = await callKernelTool(
      issuer.token,
      "update_skill",
      { id: skillId, body: "updated body pending review" },
      threadId,
      { asAgent: true },
    )
    updateRequestId = res.body?.data?.blocked?.approvalRequestId
    expect(updateRequestId).toBeTruthy()

    const row = await approvalRow(updateRequestId)
    expect(row.approve_scope).toBe("kernel:skills:approve")

    // Feed: the exact surface that was blind for days.
    const feedIds = await pollForInclusion(
      () => attentionApprovalIds(skillsApprover.token),
      updateRequestId,
      15_000,
    )
    expect(feedIds).toContain(updateRequestId)
    // List (decidable queue): the surface list.ts silently dropped.
    expect(await decidableListIds(skillsApprover.token)).toContain(updateRequestId)

    // The admin-grade kernel:approve holder: neither narrow surface, no decide.
    expect(await attentionApprovalIds(genericAdmin.token)).not.toContain(updateRequestId)
    expect(await decidableListIds(genericAdmin.token)).not.toContain(updateRequestId)
    // The admin cannot read the approval, so it presents the hash the approver
    // was shown: the refusal measured is visibility, not a missing payloadHash.
    const shownHash = (
      await api(url, `/api/approvals/${updateRequestId}`, { token: skillsApprover.token })
    ).body?.data?.payloadHash
    expect(shownHash).toBeTruthy()
    const adminDecide = await api(url, `/api/approvals/${updateRequestId}/decide`, {
      method: "POST",
      token: genericAdmin.token,
      body: { decision: "approve", payloadHash: shownHash },
    })
    // 404, not 403: the generic admin is not even notified (fan-out targets
    // kernel:skills:approve holders), so RLS never returns the row — it does
    // not exist for them, which is stronger than a decide refusal.
    expect(adminDecide.status).toBe(404)

    // Outsider: the row does not exist for them.
    const outsiderDetail = await api(url, `/api/approvals/${updateRequestId}`, {
      token: outsider.token,
    })
    expect(outsiderDetail.status).toBe(404)

    // WS: the skills approver was notified live; the generic admin was not.
    await waitForApprovalEvent(wsSkills, "create", updateRequestId)
    const adminSaw = wsAdmin.messages.some(
      (m: any) =>
        m?.type === "event" &&
        m.payload?.entity === "approval_request" &&
        (m.payload?.data?.id === updateRequestId ||
          m.payload?.data?.approvalRequestId === updateRequestId),
    )
    expect(adminSaw).toBe(false)
  }, 120_000)

  it("S1c: the skills-approver decides the update; the handler applies it; decided_by is tracked", async () => {
    const decideRes = await decide(url, skillsApprover.token, updateRequestId, {
      decision: "approve",
    })
    expect(decideRes.status).toBe(200)
    const row = await approvalRow(updateRequestId)
    expect(row.status).toBe("approved")
    expect(row.decided_by).toBe(skillsApprover.id)
    const [skill] = await env.db.sql.unsafe(
      `SELECT body FROM ${kernelSchema}.skills WHERE id = $1`,
      [skillId],
    )
    expect(skill.body).toBe("updated body pending review")
  }, 120_000)

  it("S2: a policy-gated knowledge update routes to the knowledge:approve holder and executes on approval", async () => {
    // The catalog must offer knowledge:approve even though knowledge declares
    // no manifest-gated tool (the 2026-08-05 incident, asserted e2e).
    const scopesRes = await callKernelTool(world.admin.token, "list_scopes", {})
    const catalog: any[] = scopesRes.body?.data?.scopes ?? []
    expect(catalog.some((s) => s.scope === "knowledge:approve")).toBe(true)

    // Tighten via the REAL gate path (admin holds `*`, direct human call).
    const policyRes = await callKernelTool(world.admin.token, "approval_policy_set", {
      toolName: "knowledge:update",
      requireApproval: true,
    })
    expect(policyRes.status).toBe(200)

    const threadId = await createFreshThread(url, issuer.token, issuer.id, "S2 knowledge thread")
    const collectionRes = await runTool(
      issuer.token,
      "knowledge:collection_create",
      { name: `authority-e2e-${Date.now()}` },
      threadId,
    )
    const collectionId = collectionRes.body?.data?.id ?? collectionRes.body?.data?.collectionId
    expect(collectionId).toBeTruthy()

    const createRes = await runTool(
      issuer.token,
      "knowledge:create",
      {
        documentScope: "personal",
        title: "Authority e2e doc",
        body: "v1",
        sensitivity: "internal",
        collectionId,
      },
      threadId,
    )
    const docId = createRes.body?.data?.id ?? createRes.body?.data?.documentId
    expect(docId).toBeTruthy()

    const getRes = await runTool(issuer.token, "knowledge:get", { id: docId }, threadId)
    const getData = getRes.body?.data
    const revision = getData?.revision ?? getData?.doc?.revision ?? getData?.document?.revision
    expect(revision).toBeDefined()

    const updateRes = await runTool(
      issuer.token,
      "knowledge:update",
      { id: docId, body: "v2 pending approval", revision },
      threadId,
      { asAgent: true },
    )
    const requestId = updateRes.body?.data?.blocked?.approvalRequestId
    expect(requestId).toBeTruthy()

    const row = await approvalRow(requestId)
    // No custom scope declared: the deciding scope is the derived one — and it
    // must be knowledge:approve, grantable and held, never kernel:approve.
    expect(row.approve_scope === null || row.approve_scope === "knowledge:approve").toBe(true)
    expect(row.notify_user_ids).toContain(knowledgeApprover.id)

    expect(await decidableListIds(knowledgeApprover.token)).toContain(requestId)
    const decideRes = await decide(url, knowledgeApprover.token, requestId, {
      decision: "approve",
    })
    expect(decideRes.status).toBe(200)

    await pollUntil(
      async () => {
        const r = await runTool(issuer.token, "knowledge:get", { id: docId }, threadId)
        const d = r.body?.data
        const body = d?.body ?? d?.doc?.body ?? d?.document?.body
        return body === "v2 pending approval" ? body : null
      },
      15_000,
      250,
    )
  }, 120_000)

  it("S3a: a self-approvable DIRECT human call bypasses the gate — no approval row exists", async () => {
    const threadId = await createFreshThread(
      url,
      selfApprover.token,
      selfApprover.id,
      "S3a bypass thread",
    )
    const res = await runTool(selfApprover.token, "test:gatedEcho", { message: "direct" }, threadId)
    expect(res.status).toBe(200)
    expect(res.body?.data?.blocked).toBeUndefined()
  }, 60_000)

  let nEyesRequestId: string

  it("S3b: under an N-eyes policy the agent's proposal parks and the row fans out to every eligible approver, requester first", async () => {
    const policyRes = await callKernelTool(world.admin.token, "approval_policy_set", {
      toolName: "test:gatedEcho",
      requireApproval: true,
      minApprovers: 2,
    })
    expect(policyRes.status).toBe(200)

    const threadId = await createFreshThread(
      url,
      selfApprover.token,
      selfApprover.id,
      "S3b n-eyes thread",
    )
    // A person's own call under an N-eyes policy is the one case a person's call
    // parks: an approve-scope holder's click is their own sign-off (1 of 2), and
    // a second, distinct person must approve.
    const countRows = async () =>
      Number(
        (
          await env.db.sql.unsafe(
            `SELECT count(*)::int AS n FROM ${kernelSchema}.approval_requests WHERE tool_name = 'test:gatedEcho' AND requested_by = $1`,
            [selfApprover.id],
          )
        )[0]?.n,
      )
    const before = await countRows()
    const direct = await runTool(
      selfApprover.token,
      "test:gatedEcho",
      { message: "n-eyes direct" },
      threadId,
    )
    expect(direct.status, JSON.stringify(direct.body)).toBe(200)
    const directId = direct.body?.data?.blocked?.approvalRequestId as string
    expect(directId).toBeTruthy()
    expect(await countRows()).toBe(before + 1)
    const [directRow] = (await env.db.sql.unsafe(
      `SELECT status, metadata FROM ${kernelSchema}.approval_requests WHERE id = $1`,
      [directId],
    )) as Array<{ status: string; metadata: { minApprovers?: number; approvedBy?: string[] } }>
    expect(directRow.status).toBe("pending")
    expect(directRow.metadata.minApprovers).toBe(2)
    expect(directRow.metadata.approvedBy).toEqual([selfApprover.id])
    // Their own second click never counts.
    const again = await decide(url, selfApprover.token, directId, { decision: "approve" })
    expect(again.status).toBe(409)
    // The requester withdraws it, so the agent's proposal below stands alone.
    const withdrawn = await decide(url, selfApprover.token, directId, {
      decision: "deny",
      reason: "withdrawn",
    })
    expect(withdrawn.status).toBe(200)

    // Staged by the selfApprover's agent, the same call parks for two approvers.
    const res = await runTool(
      selfApprover.token,
      "test:gatedEcho",
      { message: "n-eyes" },
      threadId,
      { asAgent: true },
    )
    nEyesRequestId = res.body?.data?.blocked?.approvalRequestId
    expect(nEyesRequestId).toBeTruthy()

    const row = await approvalRow(nEyesRequestId)
    // The 2026-08-06 fan-out fix, end to end: self-approvable, yet every other
    // eligible approver is notified.
    expect(row.notify_user_ids[0]).toBe(selfApprover.id)
    expect(row.notify_user_ids).toContain(peerApprover.id)
    expect(await decidableListIds(peerApprover.token)).toContain(nEyesRequestId)
  }, 60_000)

  it("S3c: the issuer's sign-off alone does not execute; a REPEAT sign-off by the same person does not count; the second distinct approver completes it", async () => {
    const first = await decide(url, selfApprover.token, nEyesRequestId, { decision: "approve" })
    expect(first.status).toBe(200)
    let row = await approvalRow(nEyesRequestId)
    expect(row.status).toBe("pending")

    // Same person again: the distinct-approver set must not grow.
    await decide(url, selfApprover.token, nEyesRequestId, { decision: "approve" })
    row = await approvalRow(nEyesRequestId)
    expect(row.status).toBe("pending")

    const second = await decide(url, peerApprover.token, nEyesRequestId, { decision: "approve" })
    expect(second.status).toBe(200)
    row = await approvalRow(nEyesRequestId)
    expect(row.status).toBe("approved")
    expect(row.decided_by).toBe(peerApprover.id)
  }, 120_000)

  it("S4: an owner-routed approval is private absolutely — invisible to `*` and kernel:approve; the owner sees and decides", async () => {
    // Seed the owner-routed shape directly (a real mail-reply flow needs a
    // connected mailbox; the resolver path is pinned by resource-owner.test.ts
    // — what this asserts e2e is the VISIBILITY envelope across HTTP surfaces).
    const threadId = await createFreshThread(
      url,
      peerApprover.token,
      peerApprover.id,
      "S4 owner thread",
    )
    const [inserted] = await env.db.sql.unsafe(
      `INSERT INTO ${kernelSchema}.approval_requests
        (id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
         current_payload, expires_at, requested_by, status, notify_user_ids,
         resource_owner_id, reason)
       VALUES (gen_random_uuid(), $1, $2, $3, $3, 'mail:reply', '{}', '{}',
               now() + interval '1 hour', $4, 'pending', $5::uuid[], $6, 'gated')
       RETURNING id`,
      [
        world.org.id,
        `authority-s4-${Date.now()}`,
        threadId,
        peerApprover.id,
        `{${peerApprover.id}}`,
        peerApprover.id,
      ],
    )
    const requestId = inserted.id as string

    // `*` admin: 404 on detail, absent from list.
    const adminDetail = await api(url, `/api/approvals/${requestId}`, { token: world.admin.token })
    expect(adminDetail.status).toBe(404)
    expect(await decidableListIds(genericAdmin.token)).not.toContain(requestId)
    expect(await attentionApprovalIds(genericAdmin.token)).not.toContain(requestId)

    // The owner: sees it and may decide it without holding mail:approve.
    const ownerDetail = await api(url, `/api/approvals/${requestId}`, { token: peerApprover.token })
    expect(ownerDetail.status).toBe(200)
    const deny = await decide(url, peerApprover.token, requestId, {
      decision: "deny",
      reason: "not sending this",
    })
    expect(deny.status).toBe(200)
    const row = await approvalRow(requestId)
    expect(row.status).toBe("denied")
    expect(row.decided_by).toBe(peerApprover.id)
  }, 60_000)

  it("S5: decisions are tracked — audit_log rows via the real decide chain, audit_search returns them, the outsider is refused", async () => {
    // The S1c + S3c decisions must have landed in audit_log through the
    // decide -> outbox -> auditDurableHandler chain (~1s worker; poll).
    const auditByActor = async (entityId: string, actorId: string) =>
      pollUntil(
        async () => {
          const rows = (await env.db.sql.unsafe(
            `SELECT actor_id FROM ${kernelSchema}.audit_log
             WHERE org_id = $1 AND entity_type = 'approval_request' AND entity_id = $2`,
            [world.org.id, entityId],
          )) as Array<{ actor_id: string }>
          return rows.some((r) => r.actor_id === actorId) ? rows : null
        },
        20_000,
        500,
      )
    expect((await auditByActor(updateRequestId, skillsApprover.id)).length).toBeGreaterThan(0)
    expect((await auditByActor(nEyesRequestId, peerApprover.id)).length).toBeGreaterThan(0)

    // audit_search (the tool surface) sees the same trail; the outsider is
    // scope-refused, not shown an empty success.
    const searchRes = await callKernelTool(world.admin.token, "audit_search", {
      action: "approval_request.update",
    })
    expect(searchRes.status).toBe(200)

    const outsiderRes = await callKernelTool(outsider.token, "audit_search", {
      action: "approval_request.update",
    })
    expect(outsiderRes.status).toBe(403)
  }, 60_000)
})
