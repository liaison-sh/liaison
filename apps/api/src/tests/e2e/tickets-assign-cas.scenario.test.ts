// SPDX-License-Identifier: FSL-1.1-ALv2
// BL-266 — Shared-inbox claim contention: tickets:assign compare-and-swap.
//
// The defect (catalog `multi-agent-shared-inbox-contention`): tickets:assign was
// a BLIND SET — `UPDATE tickets SET assigned_to = :me WHERE id = :id` with no
// guard on the CURRENT assignee. Two agents racing the same shared-inbox queue
// could BOTH "claim" the same ticket (last-writer-wins), then both report owning
// it — a double-claim the queue can never reconcile.
//
// The fix: an `onlyIfUnassigned` (and general `expectedAssignee`) guard that makes
// the UPDATE a compare-and-swap at the DB layer — `... WHERE id=:id AND
// assigned_to IS NULL RETURNING id`. The loser of the race matches ZERO rows and
// gets a TYPED `conflict` envelope (HTTP 409) carrying the current owner, instead
// of clobbering the winner's claim.
//
// These tests drive the REAL executeTool → rpc-bridge → Postgres path over
// `POST /api/apps/tools/tickets:assign`, racing two concurrent requests.
//
//   FAILS-WITHOUT proof: the no-guard blind assign STILL double-assigns (both
//     succeed, last-writer-wins) — demonstrating the exact defect the guard fixes.
//   PASSES-WITH proof:   with onlyIfUnassigned:true exactly ONE concurrent claim
//     wins (2xx) and the other gets a 409 conflict with currentAssignee — and the
//     ticket ends owned by EXACTLY ONE of them (the queue invariant).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { seedTicket } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

const TICKETS_SCOPES = ["tickets:tickets:read", "tickets:tickets:write", "kernel:contacts:read"]

interface AssignResult {
  status: number
  data?: { ticketId?: string; assignedTo?: string | null }
  error?: { code?: string; message?: string; currentAssignee?: string | null }
}

describe("tickets:assign compare-and-swap (BL-266 shared-inbox contention)", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let ts: string
  let sofia: { id: string; token: string }
  let liam: { id: string; token: string }

  beforeAll(async () => {
    ;({ env, world } = await setupScenario())
    url = env.serverUrl
    ts = env.schemaPrefix ? `"${env.schemaPrefix}app_tickets"` : "app_tickets"

    sofia = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: TICKETS_SCOPES,
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
    liam = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: TICKETS_SCOPES,
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  async function assign(
    token: string,
    ticketId: string,
    assignedTo: string,
    guard?: { onlyIfUnassigned?: boolean; expectedAssignee?: string | null },
  ): Promise<AssignResult> {
    const res = await api(url, "/api/apps/tools/tickets:assign", {
      method: "POST",
      token,
      body: { ticketId, assignedTo, ...(guard ?? {}) },
    })
    return {
      status: res.status,
      data: res.body.data as AssignResult["data"],
      error: res.body.error as AssignResult["error"],
    }
  }

  // Raw POST so a test can OMIT assignedTo entirely (the no-op-claim case).
  async function assignRaw(token: string, body: Record<string, unknown>): Promise<AssignResult> {
    const res = await api(url, "/api/apps/tools/tickets:assign", { method: "POST", token, body })
    return {
      status: res.status,
      data: res.body.data as AssignResult["data"],
      error: res.body.error as AssignResult["error"],
    }
  }

  async function currentAssignee(ticketId: string): Promise<string | null> {
    const rows = await env.db.sql.unsafe(
      `SELECT assigned_to::text AS a FROM ${ts}.tickets WHERE id = $1`,
      [ticketId],
    )
    return (rows[0]?.a as string | null) ?? null
  }

  it("FAILS-WITHOUT the guard: a blind concurrent assign double-claims (last-writer-wins)", async () => {
    // This is the legacy behavior the CAS fixes: with NO guard, two concurrent
    // assigns BOTH succeed and the row is silently overwritten — neither caller
    // is told they lost. This is the double-claim the contention scenario must
    // never allow once agents use onlyIfUnassigned.
    const t = await seedTicket(env, {
      orgId: world.org.id,
      subject: "VIP — blind race",
      priority: "high",
      assignedTo: null,
    })

    const [a, b] = await Promise.all([
      assign(sofia.token, t.id, sofia.id), // no guard — blind set
      assign(liam.token, t.id, liam.id), // no guard — blind set
    ])

    // BOTH blind assigns report success (HTTP 2xx) — the defect: no conflict is
    // surfaced, so a weak model would have both agents report owning the ticket.
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)

    // And the final owner is whichever write committed last — a single owner, but
    // arrived at via last-writer-wins with no signal to the loser (the ambiguity
    // the rubric forbids: two agents both believe they own it).
    const owner = await currentAssignee(t.id)
    expect(owner).not.toBeNull()
    expect([sofia.id, liam.id]).toContain(owner as string)
  })

  it("PASSES-WITH onlyIfUnassigned: exactly ONE concurrent claim wins, the other gets a typed 409 conflict", async () => {
    const t = await seedTicket(env, {
      orgId: world.org.id,
      subject: "VIP — Claudine (contended)",
      priority: "high",
      assignedTo: null,
    })

    const [a, b] = await Promise.all([
      assign(sofia.token, t.id, sofia.id, { onlyIfUnassigned: true }),
      assign(liam.token, t.id, liam.id, { onlyIfUnassigned: true }),
    ])

    const results = [a, b]
    const winners = results.filter((r) => r.status === 200)
    const losers = results.filter((r) => r.status === 409)

    // EXACTLY one winner, exactly one conflict — the double-claim is impossible.
    expect(winners.length).toBe(1)
    expect(losers.length).toBe(1)

    const winner = winners[0]
    const loser = losers[0]

    // The winner's claim landed on the row.
    const owner = await currentAssignee(t.id)
    expect(owner).not.toBeNull()
    expect(owner).toBe(winner.data?.assignedTo ?? null)
    expect([sofia.id, liam.id]).toContain(owner as string)

    // The loser got a TYPED conflict whose message names the current owner — so
    // the agent can truthfully acknowledge "already taken" and SKIP, never claim
    // ownership. (The structured currentAssignee id is also carried in the tool
    // envelope's `body` for the in-process agent; the external HTTP error response
    // exposes code+message only, so the test asserts on the message.)
    expect(loser.error?.code).toBe("conflict")
    expect(loser.error?.message?.toLowerCase()).toContain("already claimed")
    expect(loser.error?.message).toContain(owner as string)
  })

  it("onlyIfUnassigned rejects a claim on an ALREADY-OWNED ticket without clobbering it", async () => {
    const t = await seedTicket(env, {
      orgId: world.org.id,
      subject: "already owned by Sofia",
      priority: "high",
      assignedTo: sofia.id, // pre-owned
    })

    const res = await assign(liam.token, t.id, liam.id, { onlyIfUnassigned: true })

    expect(res.status).toBe(409)
    expect(res.error?.code).toBe("conflict")
    expect(res.error?.message).toContain(sofia.id)
    // The owner is UNCHANGED — Liam's blind grab was rejected.
    expect(await currentAssignee(t.id)).toBe(sofia.id)
  })

  it("expectedAssignee CAS: only swaps when the current owner matches; mismatch is a 409", async () => {
    const t = await seedTicket(env, {
      orgId: world.org.id,
      subject: "hand-off CAS",
      assignedTo: sofia.id,
    })

    // Mismatch — expecting Liam but Sofia owns it → rejected, unchanged.
    const bad = await assign(sofia.token, t.id, liam.id, { expectedAssignee: liam.id })
    expect(bad.status).toBe(409)
    expect(bad.error?.code).toBe("conflict")
    expect(await currentAssignee(t.id)).toBe(sofia.id)

    // Match — expecting Sofia (the real owner) → swap succeeds.
    const ok = await assign(sofia.token, t.id, liam.id, { expectedAssignee: sofia.id })
    expect(ok.status).toBe(200)
    expect(await currentAssignee(t.id)).toBe(liam.id)
  })

  it("a guard-less assign is unchanged (legacy idempotent reassign still works)", async () => {
    const t = await seedTicket(env, {
      orgId: world.org.id,
      subject: "plain reassign",
      assignedTo: sofia.id,
    })
    const res = await assign(liam.token, t.id, liam.id) // no guard
    expect(res.status).toBe(200)
    expect(await currentAssignee(t.id)).toBe(liam.id)
  })

  it("onlyIfUnassigned with NO assignee FAILS loudly — never a success-shaped null no-op", async () => {
    // The run-3 gate fail: a weak model called assign({ticketId, onlyIfUnassigned:true})
    // and FORGOT assignedTo:'me'. The legacy blind SET would UPDATE assigned_to=null on the
    // unowned row (matches `assigned_to IS NULL`), return one row, and report {assignedTo:null}
    // — a silent no-op the agent fabricated as "claimed". The ticket stayed ORPHANED.
    // Fix: claiming with a null assignee must FAIL with invalid_params, leaving the ticket
    // untouched and giving the agent an actionable error to re-claim with assignedTo.
    const t = await seedTicket(env, {
      orgId: world.org.id,
      subject: "no-op claim guard",
      priority: "high",
      assignedTo: null,
    })

    const res = await assignRaw(liam.token, { ticketId: t.id, onlyIfUnassigned: true })
    expect(res.status).toBe(400)
    expect(res.error?.code).toBe("invalid_params")
    expect(res.error?.message?.toLowerCase()).toContain("assignee")
    // The ticket is UNTOUCHED — still unassigned, not silently nulled by a fake "claim".
    expect(await currentAssignee(t.id)).toBeNull()

    // And the correct call (assignedTo:'me' + onlyIfUnassigned) actually claims it.
    const ok = await assign(liam.token, t.id, liam.id, { onlyIfUnassigned: true })
    expect(ok.status).toBe(200)
    expect(ok.data?.assignedTo).toBe(liam.id)
    expect(await currentAssignee(t.id)).toBe(liam.id)
  })
})
