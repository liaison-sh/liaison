// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { bridgeAuditSchema, ks } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

/** The org's untrusted-content posture, through the org settings an admin saves. */
async function patchWebContentProtection(
  serverUrl: string,
  adminToken: string,
  protection: "standard" | "hardened",
): Promise<void> {
  const res = await api(serverUrl, "/api/org", {
    method: "PATCH",
    token: adminToken,
    body: { settings: { webContentProtection: protection } },
  })
  if (res.status !== 200)
    throw new Error(`PATCH /api/org: ${res.status} ${JSON.stringify(res.body)}`)
}

// Bridge handlers in test-bridge-{a,b} double-wrap their results as `{ data: env.data }`,
// while executeToolCore adds another `{ data: ... }` wrapper at every frame. Rather than
// hard-coding a depth, recursively unwrap `.data` chains and search for the leaf value.
function findValue(obj: any, key: string): any {
  const seen = new Set<unknown>()
  const stack: any[] = [obj]
  while (stack.length > 0) {
    const cur = stack.shift()
    if (cur == null || typeof cur !== "object" || seen.has(cur)) continue
    seen.add(cur)
    if (Array.isArray(cur)) {
      stack.push(...cur)
      continue
    }
    if (key in cur) return (cur as Record<string, unknown>)[key]
    stack.push(...Object.values(cur))
  }
  return undefined
}

function findErrorCode(body: any): string | undefined {
  const seen = new Set<unknown>()
  const stack: any[] = [body]
  while (stack.length > 0) {
    const cur = stack.shift()
    if (cur == null || typeof cur !== "object" || seen.has(cur)) continue
    seen.add(cur)
    if (Array.isArray(cur)) {
      stack.push(...cur)
      continue
    }
    const c = cur as Record<string, unknown>
    if (
      c.error &&
      typeof c.error === "object" &&
      typeof (c.error as Record<string, unknown>).code === "string"
    ) {
      return (c.error as Record<string, string>).code
    }
    stack.push(...Object.values(cur))
  }
  return undefined
}

describe("Bridge Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let dualScopeUser: { id: string; token: string }
  let aOnlyUser: { id: string; token: string }
  let bOnlyUser: { id: string; token: string }

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 711,
      org: { name: "Bridge E2E" },
      populate: {
        users: { count: 10 },
        threads: { count: 20, participants: "random(2-4)", messages: "random(1-3)" },
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl

    dualScopeUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      name: "Bridge Dual",
      scopes: ["test-bridge-a:thing:write", "test-bridge-b:thing:write"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    aOnlyUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      name: "Bridge A-only",
      scopes: ["test-bridge-a:thing:write"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    bOnlyUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      name: "Bridge B-only",
      scopes: ["test-bridge-b:thing:write"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  // ─── S14: Cycle + depth limits ───

  it("S14: bridge cycle (a→b→a) returns call_chain_limit", async () => {
    const res = await api(url, "/api/apps/tools/test-bridge-a:callB", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params: { cycle: true } },
    })
    expect(findErrorCode(res.body)).toBe("call_chain_limit")
  })

  it("S14: bridge self-recursion returns call_chain_limit", async () => {
    const res = await api(url, "/api/apps/tools/test-bridge-a:recurse", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params: { depth: 0 } },
    })
    expect(findErrorCode(res.body)).toBe("call_chain_limit")
  })

  // ─── S15: Scope inheritance — inner call rejected without inner scope ───

  it("S15: inner call rejected when caller lacks inner scope", async () => {
    const res = await api(url, "/api/apps/tools/test-bridge-a:callB", {
      method: "POST",
      token: aOnlyUser.token,
      body: { params: { payload: "scope-check" } },
    })
    expect(findErrorCode(res.body)).toBe("forbidden")
  })

  // ─── S16: Internal-helper trust rule ───

  it("S16: direct HTTP to internal helper is forbidden", async () => {
    const res = await api(url, "/api/apps/tools/test-bridge-b:internalCallback", {
      method: "POST",
      token: bOnlyUser.token,
      body: { params: { payload: "hi" } },
    })
    expect(res.status).toBe(403)
    expect(res.body.error?.code).toBe("forbidden")
  })

  it("S16: via-bridge call to internal helper succeeds", async () => {
    const res = await api(url, "/api/apps/tools/test-bridge-a:callB", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params: { payload: "hi" } },
    })
    expect(res.status).toBe(200)
    expect(findValue(res.body, "received")).toBe("hi")
  })

  // ─── S17: Webhook fixture — typed verifier outcomes + body limit ───

  it("S17: webhook drop returns 200 with empty body and no handler invocation", async () => {
    const beforeRows = await env.db.sql.unsafe(
      `SELECT COUNT(*)::int AS c FROM ${bridgeAuditSchema(env)}.audit`,
    )
    const before = beforeRows[0].c

    const res = await fetch(`${url}/webhooks/${world.org.id}/test-bridge-a/outcomes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Outcome": "drop" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe("")

    const afterRows = await env.db.sql.unsafe(
      `SELECT COUNT(*)::int AS c FROM ${bridgeAuditSchema(env)}.audit`,
    )
    expect(afterRows[0].c).toBe(before)
  })

  it("S17: webhook rate_limited returns 429 with Retry-After", async () => {
    const res = await fetch(`${url}/webhooks/${world.org.id}/test-bridge-a/outcomes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Outcome": "rate_limited" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("30")
  })

  it("S17: webhook reject returns 401", async () => {
    const res = await fetch(`${url}/webhooks/${world.org.id}/test-bridge-a/outcomes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Outcome": "reject" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(401)
  })

  it("S17: webhook accept invokes handler with verifier-returned scopes", async () => {
    const before = (
      await env.db.sql.unsafe(`SELECT COUNT(*)::int AS c FROM ${bridgeAuditSchema(env)}.audit`)
    )[0].c

    const res = await fetch(`${url}/webhooks/${world.org.id}/test-bridge-a/outcomes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Outcome": "accept" },
      body: JSON.stringify({ marker: "outcome-accept" }),
    })
    expect(res.status).toBe(200)

    const deadline = Date.now() + 5000
    let row: any = null
    while (Date.now() < deadline) {
      const rows = await env.db.sql.unsafe(
        `SELECT key, payload, at FROM ${bridgeAuditSchema(env)}.audit
           WHERE key = 'outcome-accepted' ORDER BY at DESC LIMIT 1`,
      )
      if (rows.length > 0) {
        row = rows[0]
        break
      }
      await Bun.sleep(50)
    }
    expect(row).toBeTruthy()
    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
    expect(payload.observedScopeWebhookWrite).toBe(true)

    const after = (
      await env.db.sql.unsafe(`SELECT COUNT(*)::int AS c FROM ${bridgeAuditSchema(env)}.audit`)
    )[0].c
    expect(after).toBe(before + 1)
  })

  it("S17: webhook body exceeding bodyLimitBytes returns 413", async () => {
    const oversized = "x".repeat(5000)
    const res = await fetch(`${url}/webhooks/${world.org.id}/test-bridge-a/outcomes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversized,
    })
    expect(res.status).toBe(413)
  })

  // ─── S18: Idempotency over the bridge ───

  it("S18: bridge idempotency cache hit returns identical computedAt", async () => {
    const key = `e2e-k1-${Date.now()}`
    const first = await api(url, "/api/apps/tools/test-bridge-a:callIdempotent", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params: { idempotencyKey: key, payload: "p1" } },
    })
    expect(first.status).toBe(200)
    const firstComputedAt = findValue(first.body, "computedAt")
    expect(typeof firstComputedAt).toBe("number")

    await Bun.sleep(20)

    const second = await api(url, "/api/apps/tools/test-bridge-a:callIdempotent", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params: { idempotencyKey: key, payload: "p1" } },
    })
    expect(second.status).toBe(200)
    expect(findValue(second.body, "computedAt")).toBe(firstComputedAt)
  })

  it("S18: bridge idempotency conflict on differing payload", async () => {
    const key = `e2e-conflict-${Date.now()}`
    const first = await api(url, "/api/apps/tools/test-bridge-a:callIdempotent", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params: { idempotencyKey: key, payload: "p1" } },
    })
    expect(first.status).toBe(200)

    const second = await api(url, "/api/apps/tools/test-bridge-a:callIdempotent", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params: { idempotencyKey: key, payload: "p2" } },
    })
    expect(findErrorCode(second.body)).toBe("idempotency_conflict")
  })

  it("S18: bridge in-flight reservation surfaces idempotency_in_flight", async () => {
    // The QuickJS sandbox lacks setTimeout, so we cannot stretch the inner handler's
    // execution window. Instead, pre-stamp the idempotency Redis key as "pending" with
    // the same params hash that the upcoming call will produce — the bridge frame will
    // observe the pre-existing reservation and return idempotency_in_flight.
    const { createHash } = await import("node:crypto")
    const key = `e2e-inflight-${Date.now()}`
    const params = { idempotencyKey: key, payload: "p1" }
    const innerParams: Record<string, unknown> = { idempotencyKey: key, payload: "p1" }
    const canonicalize = (v: unknown): string => {
      if (v === null || typeof v !== "object") return JSON.stringify(v)
      if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`
      const keys = Object.keys(v as Record<string, unknown>).sort()
      return `{${keys
        .map((k) => `${JSON.stringify(k)}:${canonicalize((v as Record<string, unknown>)[k])}`)
        .join(",")}}`
    }
    const requestHash = createHash("sha256").update(canonicalize(innerParams)).digest("hex")
    const redisKey = `${env.redisPrefix}app_idem:${world.org.id}:test-bridge-a:idempotent:${key}`
    await env.redis.redis.set(
      redisKey,
      JSON.stringify({ status: "pending", requestHash }),
      "EX",
      60,
    )

    const res = await api(url, "/api/apps/tools/test-bridge-a:callIdempotent", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params },
    })
    expect(findErrorCode(res.body)).toBe("idempotency_in_flight")

    await env.redis.redis.del(redisKey)
  })

  it("S18: cleanup invalidates cache, next call computes fresh", async () => {
    const key = `e2e-cleanup-${Date.now()}`
    const first = await api(url, "/api/apps/tools/test-bridge-a:callIdempotent", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params: { idempotencyKey: key, payload: "v1" } },
    })
    expect(first.status).toBe(200)
    const firstComputedAt = findValue(first.body, "computedAt") as number

    await api(url, "/api/apps/tools/test-bridge-a:cleanup", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params: { idempotencyKey: key } },
    })

    await Bun.sleep(15)
    const fresh = await api(url, "/api/apps/tools/test-bridge-a:callIdempotent", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params: { idempotencyKey: key, payload: "v1" } },
    })
    expect(fresh.status).toBe(200)
    expect(findValue(fresh.body, "computedAt")).not.toBe(firstComputedAt)
  })

  it("S18: direct HTTP call honors params.idempotencyKey", async () => {
    const key = `e2e-bypass-${Date.now()}`
    const a = await api(url, "/api/apps/tools/test-bridge-a:idempotent", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params: { idempotencyKey: key, payload: "direct" } },
    })
    await Bun.sleep(15)
    const b = await api(url, "/api/apps/tools/test-bridge-a:idempotent", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params: { idempotencyKey: key, payload: "direct" } },
    })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(findValue(a.body, "computedAt")).toBe(findValue(b.body, "computedAt"))

    const conflict = await api(url, "/api/apps/tools/test-bridge-a:idempotent", {
      method: "POST",
      token: dualScopeUser.token,
      body: { params: { idempotencyKey: key, payload: "changed" } },
    })
    expect(findErrorCode(conflict.body)).toBe("idempotency_conflict")
  })

  // ─── S18a: Bridge taint propagation across a subsequent bridge frame ───

  it("S18a: tainted bridge frame causes following trust-boundary frame to block", async () => {
    await patchWebContentProtection(url, world.admin.token, "hardened")
    try {
      const insertResult = (await env.db.sql.unsafe(
        `INSERT INTO ${ks(env)}.threads (id, org_id, handle, type, created_by, tainted)
         VALUES (gen_random_uuid(), $1, $2, 'agent_chat', $3, false) RETURNING id, tainted`,
        [world.org.id, `bridge-taint-${Date.now()}`, dualScopeUser.id],
      )) as unknown as Array<{ id: string; tainted: boolean }>
      const thread = insertResult[0]
      expect(thread.tainted).toBe(false)

      await env.db.sql.unsafe(
        `INSERT INTO ${ks(env)}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
        [thread.id, dualScopeUser.id, world.org.id],
      )

      const res = await api(url, "/api/apps/tools/test-bridge-a:callTaintedThenTrustBoundary", {
        method: "POST",
        token: dualScopeUser.token,
        body: { threadId: thread.id, params: {} },
      })
      expect(res.status).toBe(200)

      const [tRow] = await env.db.sql.unsafe(
        `SELECT tainted FROM ${ks(env)}.threads WHERE id = $1`,
        [thread.id],
      )
      expect(tRow.tainted).toBe(true)

      const observed = findValue(res.body, "taintObserved")
      expect(observed).toBe(true)

      const blockedReason = findValue(res.body, "reason")
      if (blockedReason !== "taint_escalation") {
        const approvals = await env.db.sql.unsafe(
          `SELECT reason FROM ${ks(env)}.approval_requests
             WHERE org_id = $1 AND originating_thread_id = $2 AND status = 'pending'`,
          [world.org.id, thread.id],
        )
        expect(approvals.some((a: any) => a.reason === "taint_escalation")).toBe(true)
      }
    } finally {
      await patchWebContentProtection(url, world.admin.token, "standard")
    }
  })
})
