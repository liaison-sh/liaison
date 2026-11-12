// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CI→projects webhook. A team whose CI is not GitLab's own (TeamCity, say)
// never touches GitLab's pipeline surface, so the projects app cannot learn a
// release status from GitLab. The wire contract here is a small,
// provider-agnostic release-status envelope (mirrors monitoring's alert
// envelope): ANY CI notifier maps its payload onto it.
//
// Tests cover:
//  1. Pure envelope validation (parseCiStatusEnvelope) — via the handlers.ts
//     source text (script-mode bundle; no module exports, see handlers.test.ts
//     convention) is exercised indirectly through the full handler below,
//     since these are plain functions with no sandbox dependency to fake.
//  2. The full ciStatusWebhookHandler against a REAL RPC bridge (same
//     createRpcBridge(...) convention as tools.test.ts) with the webhook's
//     actual actor shape: userId="system" (what modules/webhooks/routes.ts
//     passes for every manifest webhook) — this is the scenario that proves
//     the resolveWebhookFallbackUserId fix in rpc-bridge.ts (a raw "system"
//     string would throw at the created_by::uuid cast).
//  3. HMAC verifier round-trip (ciStatusWebhookVerifier) against a fake
//     crypto/config bridge, mirroring monitoring's hmac.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import * as handlers from "~/apps/projects/handlers"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import projectsManifest from "../app.manifest.json"

// The core module's exports, called directly with plain (non-JSON) args.
const exposed = handlers as unknown as {
  parseCiStatusEnvelope: (payload: unknown) => unknown
  ciTaskTitle: (env: { project: string; status: string; title?: string }) => string
  ciTaskDescription: (env: unknown) => string
  ciStatusWebhookVerifier: (
    params: {
      headers: Record<string, string>
      body: string
      method: string
      query: Record<string, string>
    },
    bridge: {
      config_get: (key: string) => Promise<unknown>
      crypto_hmacSha256Base64: (secret: string, body: string) => Promise<string>
      crypto_timingSafeEqual: (a: string, b: string) => Promise<boolean>
    },
    nowMs?: number,
  ) => Promise<{ ok: boolean; replayKey?: string; replayTtlSeconds?: number; reason?: string }>
  ciStatusWebhookHandler: (
    payload: unknown,
    ctx: Record<string, (...args: unknown[]) => Promise<string>>,
  ) => Promise<{ status: number; body?: string }>
  webhookInfoHandler: (params: unknown, ctx: unknown) => Promise<unknown>
}
const { parseCiStatusEnvelope, ciTaskTitle } = exposed

describe("ci-status envelope parsing", () => {
  const VALID = {
    project: "orders-api",
    externalRef: "teamcity:bt42:1234",
    status: "success",
    ts: "2026-07-06T10:00:00Z",
  }

  it("accepts a minimal valid envelope", () => {
    const result = parseCiStatusEnvelope(VALID) as Record<string, unknown>
    expect(result.error).toBeUndefined()
    expect(result.project).toBe("orders-api")
    expect(result.status).toBe("success")
  })

  it("rejects a missing project", () => {
    const { project: _drop, ...rest } = VALID
    const result = parseCiStatusEnvelope(rest) as { error?: string }
    expect(result.error).toContain("project")
  })

  it("rejects a missing externalRef (the dedup identity)", () => {
    const { externalRef: _drop, ...rest } = VALID
    const result = parseCiStatusEnvelope(rest) as { error?: string }
    expect(result.error).toContain("externalRef")
  })

  it("rejects an invalid status", () => {
    const result = parseCiStatusEnvelope({ ...VALID, status: "bogus" }) as { error?: string }
    expect(result.error).toContain("status")
  })

  it("rejects a missing/unparseable ts", () => {
    const missing = parseCiStatusEnvelope({ ...VALID, ts: undefined }) as { error?: string }
    expect(missing.error).toContain("ts")
    const bad = parseCiStatusEnvelope({ ...VALID, ts: "not-a-date" }) as { error?: string }
    expect(bad.error).toContain("ts")
  })

  it("accepts all declared CI statuses", () => {
    for (const status of ["pending", "running", "success", "failed", "canceled"]) {
      const result = parseCiStatusEnvelope({ ...VALID, status }) as Record<string, unknown>
      expect(result.error).toBeUndefined()
    }
  })

  it("ciTaskTitle names the project and status, falling back when no title given", () => {
    expect(ciTaskTitle({ project: "tailspin-platform", status: "failed" })).toBe(
      "[CI] tailspin-platform release — failed",
    )
    expect(ciTaskTitle({ project: "tc-front", status: "success", title: "v1.83.0" })).toBe(
      "[CI] v1.83.0 — success",
    )
  })
})

describe("ciStatusWebhookVerifier", () => {
  const SECRET = "test-ci-secret"
  function makeBridge(secretOverride: string | null = SECRET, ttlOverride: unknown = undefined) {
    return {
      config_get: async (key: string) => {
        if (key === "ciWebhookSecret") return secretOverride
        if (key === "ciWebhookTtlSeconds") return ttlOverride ?? null
        return null
      },
      crypto_hmacSha256Base64: async (secret: string, body: string) =>
        createHmac("sha256", secret).update(body, "utf8").digest("base64"),
      crypto_timingSafeEqual: async (a: string, b: string) => a === b,
    }
  }

  function sign(body: string, secret = SECRET): string {
    return createHmac("sha256", secret).update(body, "utf8").digest("base64")
  }

  it("accepts a correctly-signed, fresh delivery", async () => {
    const nowMs = Date.parse("2026-07-06T10:00:00Z")
    const body = JSON.stringify({ ts: "2026-07-06T10:00:00Z", project: "x" })
    const res = await exposed.ciStatusWebhookVerifier(
      {
        headers: { "x-projects-ci-signature": sign(body) },
        body,
        method: "POST",
        query: {},
      },
      makeBridge(),
      nowMs,
    )
    expect(res.ok).toBe(true)
    expect(res.replayKey).toBeTruthy()
  })

  it("rejects when no secret has been minted (connection never established)", async () => {
    const body = JSON.stringify({ ts: new Date().toISOString() })
    const res = await exposed.ciStatusWebhookVerifier(
      { headers: { "x-projects-ci-signature": sign(body) }, body, method: "POST", query: {} },
      makeBridge(null),
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("missing_secret")
  })

  it("rejects a tampered body (signature mismatch)", async () => {
    const body = JSON.stringify({ ts: new Date().toISOString(), project: "x" })
    const tamperedBody = JSON.stringify({ ts: new Date().toISOString(), project: "y" })
    const res = await exposed.ciStatusWebhookVerifier(
      {
        headers: { "x-projects-ci-signature": sign(body) },
        body: tamperedBody,
        method: "POST",
        query: {},
      },
      makeBridge(),
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("signature_mismatch")
  })

  it("rejects a stale ts outside the freshness window", async () => {
    const nowMs = Date.parse("2026-07-06T10:00:00Z")
    const staleTs = new Date(nowMs - 700_000).toISOString() // 700s > default 600s TTL
    const body = JSON.stringify({ ts: staleTs, project: "x" })
    const res = await exposed.ciStatusWebhookVerifier(
      { headers: { "x-projects-ci-signature": sign(body) }, body, method: "POST", query: {} },
      makeBridge(),
      nowMs,
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("stale_ts")
  })

  it("rejects a future ts beyond the symmetric bound", async () => {
    const nowMs = Date.parse("2026-07-06T10:00:00Z")
    const futureTs = new Date(nowMs + 700_000).toISOString()
    const body = JSON.stringify({ ts: futureTs, project: "x" })
    const res = await exposed.ciStatusWebhookVerifier(
      { headers: { "x-projects-ci-signature": sign(body) }, body, method: "POST", query: {} },
      makeBridge(),
      nowMs,
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("future_ts")
  })

  it("honors a configured ciWebhookTtlSeconds override", async () => {
    const nowMs = Date.parse("2026-07-06T10:00:00Z")
    const ts = new Date(nowMs - 30).toISOString()
    const body = JSON.stringify({ ts, project: "x" })
    const res = await exposed.ciStatusWebhookVerifier(
      { headers: { "x-projects-ci-signature": sign(body) }, body, method: "POST", query: {} },
      makeBridge(SECRET, 10), // 10s TTL — 30ms-old ts still inside it
      nowMs,
    )
    expect(res.ok).toBe(true)
  })

  it("keys replay on the signed body, ignoring the unsigned delivery-id header", async () => {
    const body = JSON.stringify({ ts: new Date().toISOString(), project: "x" })
    const res = await exposed.ciStatusWebhookVerifier(
      {
        headers: {
          "x-projects-ci-signature": sign(body),
          "x-projects-ci-delivery-id": "delivery-42",
        },
        body,
        method: "POST",
        query: {},
      },
      makeBridge(),
    )
    expect(res.ok).toBe(true)
    expect(res.replayKey).toBeTruthy()
    expect(res.replayKey).not.toBe("delivery-42")
  })
})

describe("ciStatusWebhookHandler — real DB, webhook actor shape", () => {
  let orgId: string
  let adminUserId: string
  const SCOPES = [
    "projects:projects:read",
    "projects:projects:write",
    "projects:tasks:read",
    "projects:tasks:write",
  ]
  const webhookActor: UserContext = {
    actorType: "user",
    // Bridge-internal placeholder; real value is resolved at call time from
    // "system" — see resolveWebhookFallbackUserId in rpc-bridge.ts. Only used
    // here to run withRlsContext with write scopes for the transaction itself.
    userId: "",
    orgId: "",
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }

  beforeAll(async () => {
    await acquireTestLock()
    const slug = `projects-ci-webhook-${Date.now()}`
    const [org] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'CI Webhook Org', ${slug}) RETURNING id
      `),
    )
    orgId = org!.id
    const [admin] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version, created_at)
        VALUES (gen_random_uuid(), ${orgId}::uuid,
                ${`admin-${Date.now()}@test.com`}, 'Admin',
                'active', 'hash', 1, 1, now() - interval '1 day')
        RETURNING id
      `),
    )
    adminUserId = admin!.id
    webhookActor.orgId = orgId
    webhookActor.userId = adminUserId
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  /**
   * Runs ciStatusWebhookHandler(payload, bridge) with the EXACT actor shape
   * the real webhook route (modules/webhooks/routes.ts) now builds for a
   * `requiresUserActor: true` webhook (the projects manifest's `ci-status`
   * entry sets it): resolveWebhookUserActorId(orgId) resolves the org's
   * oldest active user, then withRlsContext + createRpcBridge run with a REAL
   * `UserContext` (actorType:"user", that resolved userId) instead of the
   * `SystemContext` every other webhook (monitoring/tickets/shopify/boxtal/
   * invoicing) still uses. Without this, projects_createTask's kernel.threads
   * + kernel.thread_participants inserts hit `WITH CHECK (user_id =
   * current_setting('app.current_user_id')::uuid OR ...)` RLS denial — a
   * SystemContext's app.current_user_id is the nil uuid, which never matches
   * the real actor.userId createTask resolves for created_by.
   *
   * The bridge (and every service call it makes) must run INSIDE the SAME
   * withRlsContext transaction — createTask/createProject open their own
   * nested `tx.transaction()` (a SAVEPOINT), which requires a live outer
   * transaction. Building the bridge in one withRlsContext call and invoking
   * it after that call resolves (transaction already committed) throws
   * "SAVEPOINT can only be used in transaction blocks" — so the handler call
   * itself must be the withRlsContext callback, not a follow-on step.
   */
  function runWebhookHandler(
    payload: unknown,
    wrap?: (
      bridge: Record<string, (...args: unknown[]) => Promise<string>>,
    ) => Record<string, (...args: unknown[]) => Promise<string>>,
  ): Promise<{ status: number; body?: string }> {
    return withRlsContext(
      {
        actorType: "user",
        userId: adminUserId,
        orgId,
        scopes: SCOPES,
        dimensionGrants: { "*": ["*"] },
      },
      async (tx) => {
        const bridge = createRpcBridge(
          "projects",
          adminUserId,
          orgId,
          tx,
          projectsManifest as never,
          SCOPES,
          "user",
          undefined,
          {
            actor: {
              actorType: "user",
              userId: adminUserId,
              orgId,
              scopes: SCOPES,
              dimensionGrants: { "*": ["*"] },
            },
          },
        )
        const ctx = bridge as unknown as Record<string, (...args: unknown[]) => Promise<string>>
        return exposed.ciStatusWebhookHandler(payload, wrap ? wrap(ctx) : ctx)
      },
    )
  }

  it("creates a Releases project + task on first delivery (success)", async () => {
    const externalRef = `teamcity:bt-success:${Date.now()}`
    const res = await runWebhookHandler({
      project: "orders-api",
      externalRef,
      status: "success",
      title: "v3.351.0",
      url: "https://teamcity.example/viewLog?buildId=1",
      branch: "develop",
      ts: new Date().toISOString(),
    })
    expect(res.status).toBe(200)

    // Verify a task landed with the right title/externalRef via a fresh read.
    const rows = extractRows<{ id: string; title: string; external_ref: string }>(
      await withRlsContext(webhookActor, (tx) =>
        tx.execute(drizzleSql`
          SELECT id, title, external_ref FROM app_projects.tasks
          WHERE org_id = ${orgId}::uuid AND external_ref = ${externalRef}
        `),
      ),
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.title).toBe("[CI] v3.351.0 — success")

    // The Releases project must exist.
    const projRows = extractRows<{ name: string }>(
      await withRlsContext(webhookActor, (tx) =>
        tx.execute(drizzleSql`
          SELECT name FROM app_projects.projects WHERE org_id = ${orgId}::uuid AND name = 'Releases'
        `),
      ),
    )
    expect(projRows.length).toBe(1)
  })

  it("updates the SAME task (never a duplicate) on a repeat delivery for the same externalRef", async () => {
    const externalRef = `teamcity:bt-pending-to-success:${Date.now()}`
    const first = await runWebhookHandler({
      project: "tailspin-platform",
      externalRef,
      status: "pending",
      ts: new Date().toISOString(),
    })
    expect(first.status).toBe(200)

    const second = await runWebhookHandler({
      project: "tailspin-platform",
      externalRef,
      status: "success",
      title: "release complete",
      ts: new Date().toISOString(),
    })
    expect(second.status).toBe(200)

    const rows = extractRows<{ id: string; title: string }>(
      await withRlsContext(webhookActor, (tx) =>
        tx.execute(drizzleSql`
          SELECT id, title FROM app_projects.tasks
          WHERE org_id = ${orgId}::uuid AND external_ref = ${externalRef}
        `),
      ),
    )
    expect(rows.length).toBe(1) // never duplicated
    expect(rows[0]!.title).toBe("[CI] release complete — success")
  })

  it("rejects an invalid envelope with 400 and writes nothing", async () => {
    const res = await runWebhookHandler({ project: "x" })
    expect(res.status).toBe(400)
  })

  it("second Releases delivery reuses the SAME project (never creates a duplicate 'Releases')", async () => {
    await runWebhookHandler({
      project: "data",
      externalRef: `teamcity:bt-a:${Date.now()}`,
      status: "success",
      ts: new Date().toISOString(),
    })
    await runWebhookHandler({
      project: "data",
      externalRef: `teamcity:bt-b:${Date.now()}`,
      status: "failed",
      ts: new Date().toISOString(),
    })
    const projRows = extractRows<{ id: string }>(
      await withRlsContext(webhookActor, (tx) =>
        tx.execute(drizzleSql`
          SELECT id FROM app_projects.projects WHERE org_id = ${orgId}::uuid AND name = 'Releases'
        `),
      ),
    )
    expect(projRows.length).toBe(1)
  })

  it("created_by resolves to a REAL user id, not the literal 'system' sentinel", async () => {
    const externalRef = `teamcity:bt-actor-check:${Date.now()}`
    const res = await runWebhookHandler({
      project: "orders-api",
      externalRef,
      status: "success",
      ts: new Date().toISOString(),
    })
    expect(res.status).toBe(200)
    const rows = extractRows<{ created_by: string }>(
      await withRlsContext(webhookActor, (tx) =>
        tx.execute(drizzleSql`
          SELECT created_by FROM app_projects.tasks
          WHERE org_id = ${orgId}::uuid AND external_ref = ${externalRef}
        `),
      ),
    )
    expect(rows.length).toBe(1)
    // A real uuid — this is exactly the value that would have thrown
    // `invalid input syntax for type uuid: "system"` before the fix.
    expect(rows[0]!.created_by).toBe(adminUserId)
  })

  it("an incomplete checklist never blocks the webhook: the release task closes, 200", async () => {
    const externalRef = `teamcity:bt-checklist:${Date.now()}`
    const first = await runWebhookHandler({
      project: "orders-api",
      externalRef,
      status: "running",
      ts: new Date().toISOString(),
    })
    expect(first.status).toBe(200)
    const [task] = extractRows<{ id: string; status_id: string }>(
      await db.execute(drizzleSql`
        SELECT id, status_id FROM app_projects.tasks
        WHERE org_id = ${orgId}::uuid AND external_ref = ${externalRef}
      `),
    )
    await db.execute(drizzleSql`
      INSERT INTO app_projects.task_checklist_items (org_id, task_id, title, created_by)
      VALUES (${orgId}::uuid, ${task!.id}::uuid, 'release smoke test', ${adminUserId}::uuid)
    `)
    // The handler closes the release task through the real bridge: the update
    // carries the terminal column, as a CI "success" delivery closing it would.
    const res = await runWebhookHandler(
      {
        project: "orders-api",
        externalRef,
        status: "success",
        ts: new Date().toISOString(),
      },
      (ctx) => ({
        ...ctx,
        projects_updateTask: (paramsJson: unknown) =>
          ctx.projects_updateTask!(
            JSON.stringify({ ...JSON.parse(String(paramsJson)), statusLabel: "done" }),
          ),
      }),
    )
    expect(res).toEqual({ status: 200, body: "ok" })
    const [after] = extractRows<{ status_id: string; terminal: boolean }>(
      await db.execute(drizzleSql`
        SELECT t.status_id, s.terminal FROM app_projects.tasks t
        JOIN app_projects.project_statuses s ON s.id = t.status_id
        WHERE t.id = ${task!.id}::uuid
      `),
    )
    expect(after!.status_id).not.toBe(task!.status_id)
    expect(after!.terminal).toBe(true)
  })
})
