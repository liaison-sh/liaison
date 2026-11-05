// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 14 A3 — Billing-admin endpoints honour the env matrix and the
// idempotency contract (E2E plan 16-phase-14-e2e-plan.md).
//
// Three sibling worker processes — one per env profile — exercise the boot-time
// route mount decision in app.ts:186-202 and the per-request requireControlPlaneAuth
// guard in middleware/control-plane-auth.ts.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { setupScenario, teardownScenario } from "./setup"

const ADMIN_KEY = "a3-control-plane-key-32-chars-padded-padded"

async function postJson(
  url: string,
  path: string,
  body: unknown,
  authHeader?: string,
): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authHeader ? { authorization: authHeader } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: r.status, body: parsed }
}

describe("Self-hosted: /api/admin/billing routes 404", () => {
  let env: WorkerEnv
  let world: TestWorld

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 1431,
      org: { name: "Billing Admin SH" },
      // Both unset — boots in self_hosted mode; the route group still mounts
      // but requireControlPlaneAuth(undefined) returns 404 on every call.
      serverEnv: { CONTROL_PLANE_URL: undefined, CONTROL_PLANE_API_KEY: undefined },
    })
    env = result.env
    world = result.world
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  it("404s every billing-admin route regardless of auth", async () => {
    const credits = await postJson(env.serverUrl, "/api/admin/billing/credits", {
      orgId: world.org.id,
      amountCredits: "100",
      externalPaymentRef: "sh-1",
    })
    expect(credits.status).toBe(404)

    const reset = await postJson(env.serverUrl, "/api/admin/billing/credits/reset", {
      orgId: world.org.id,
      cycleId: "2026-05",
    })
    expect(reset.status).toBe(404)

    // PATCH /org/:orgId/tier
    const tier = await fetch(`${env.serverUrl}/api/admin/billing/org/${world.org.id}/tier`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "team" }),
    })
    expect(tier.status).toBe(404)

    // /api/billing/state still answers self_hosted mode.
    const state = await fetch(`${env.serverUrl}/api/billing/state`, {
      headers: { authorization: `Bearer ${world.admin.token}` },
    })
    expect(state.status).toBe(200)
    const body = (await state.json()) as { data: { mode: string } }
    expect(body.data.mode).toBe("self_hosted")
  })
})

describe("Half-configured: only CONTROL_PLANE_URL set", () => {
  let env: WorkerEnv
  let world: TestWorld

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 1432,
      org: { name: "Billing Admin Half" },
      // In non-production NODE_ENV (test), validateControlPlaneEnv warns and
      // returns self_hosted. The API key is undefined so the admin routes 404.
      serverEnv: {
        CONTROL_PLANE_URL: "http://127.0.0.1:1",
        CONTROL_PLANE_API_KEY: undefined,
      },
    })
    env = result.env
    world = result.world
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  it("404s the admin routes and reports self_hosted via /api/billing/state", async () => {
    const credits = await postJson(env.serverUrl, "/api/admin/billing/credits", {
      orgId: world.org.id,
      amountCredits: "100",
      externalPaymentRef: "half-1",
    })
    expect(credits.status).toBe(404)

    const state = await fetch(`${env.serverUrl}/api/billing/state`, {
      headers: { authorization: `Bearer ${world.admin.token}` },
    })
    expect(state.status).toBe(200)
    const body = (await state.json()) as { data: { mode: string } }
    expect(body.data.mode).toBe("self_hosted")
  })
})

describe("Managed: auth required, idempotent replay, conflict on differing body", () => {
  let env: WorkerEnv
  let world: TestWorld

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 1433,
      org: { name: "Billing Admin Managed" },
      serverEnv: {
        CONTROL_PLANE_URL: "http://127.0.0.1:65535",
        CONTROL_PLANE_API_KEY: ADMIN_KEY,
      },
    })
    env = result.env
    world = result.world
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  it("401s without auth, 401s with wrong key, 200s with correct key + replays idempotently", async () => {
    const orgId = world.org.id
    const ref = `a3-managed-${Date.now()}`

    const noAuth = await postJson(env.serverUrl, "/api/admin/billing/credits", {
      orgId,
      amountCredits: "500",
      externalPaymentRef: ref,
    })
    expect(noAuth.status).toBe(401)
    expect(JSON.stringify(noAuth.body)).not.toContain(ADMIN_KEY)

    const wrong = await postJson(
      env.serverUrl,
      "/api/admin/billing/credits",
      { orgId, amountCredits: "500", externalPaymentRef: ref },
      "Bearer wrong-key-totally-not-it",
    )
    expect(wrong.status).toBe(401)

    const ok = await postJson(
      env.serverUrl,
      "/api/admin/billing/credits",
      { orgId, amountCredits: "500", externalPaymentRef: ref },
      `Bearer ${ADMIN_KEY}`,
    )
    expect(ok.status).toBe(200)
    const body = ok.body as { data: { transactionId: string; balanceAfter: string } }
    expect(body.data.transactionId).toBeTruthy()
    expect(body.data.balanceAfter).toBeDefined()

    // Replay: same ref + same body → 200, identical result (no second tx row).
    const replay = await postJson(
      env.serverUrl,
      "/api/admin/billing/credits",
      { orgId, amountCredits: "500", externalPaymentRef: ref },
      `Bearer ${ADMIN_KEY}`,
    )
    expect(replay.status).toBe(200)
    const replayBody = replay.body as { data: { transactionId: string; balanceAfter: string } }
    expect(replayBody.data.transactionId).toBe(body.data.transactionId)
    expect(replayBody.data.balanceAfter).toBe(body.data.balanceAfter)

    // Conflict: same ref + different amount → 409 idempotency_conflict.
    const conflict = await postJson(
      env.serverUrl,
      "/api/admin/billing/credits",
      { orgId, amountCredits: "1000", externalPaymentRef: ref },
      `Bearer ${ADMIN_KEY}`,
    )
    expect(conflict.status).toBe(409)
    const conflictBody = conflict.body as { error: { code: string; diff?: unknown } }
    expect(conflictBody.error.code).toBe("idempotency_conflict")
    expect(conflictBody.error.diff).toBeDefined()
  })

  it("PATCH /org/:orgId/tier requires auth and updates the tier when authorized", async () => {
    const orgId = world.org.id
    const unauth = await fetch(`${env.serverUrl}/api/admin/billing/org/${orgId}/tier`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "team" }),
    })
    expect(unauth.status).toBe(401)

    const ok = await fetch(`${env.serverUrl}/api/admin/billing/org/${orgId}/tier`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({ tier: "team" }),
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { data: { tier: string } }
    expect(body.data.tier).toBe("team")
  })
})
