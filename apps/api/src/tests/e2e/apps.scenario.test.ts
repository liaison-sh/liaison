// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { allocatePorts, api, createUserWithScopes } from "@liaison/test-helpers"
import { startMockOidc } from "./helpers/mock-oidc"
import { setupScenario, teardownScenario } from "./setup"

function makeWebhookHeaders(
  body: string,
  deliveryId = crypto.randomUUID(),
  timestamp = Math.floor(Date.now() / 1000),
) {
  const signature = createHmac("sha256", "test-webhook-secret")
    .update(`${timestamp}.${body}`)
    .digest("hex")
  return {
    "Content-Type": "application/json",
    "x-webhook-signature": signature,
    "x-webhook-delivery": deliveryId,
    "x-webhook-timestamp": String(timestamp),
  }
}

describe("Apps Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let oidc: Awaited<ReturnType<typeof startMockOidc>>
  let oidcPort: number

  // Shared across sequential tests
  let testUserToken: string

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 4,
      org: { name: "Apps Test Org" },
      populate: {
        users: { count: 10 },
        threads: { count: 20, participants: "random(2-4)", messages: "random(1-3)" },
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl

    // Seed placeholder org for device flow tests (FK constraint)
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    await env.db.sql.unsafe(`INSERT INTO ${ks}.organizations (id, name, slug)
      VALUES ('00000000-0000-0000-0000-000000000000', 'Placeholder Org', 'placeholder')
      ON CONFLICT (id) DO NOTHING`)

    // Start mock OIDC provider on a dynamically allocated port
    const [oidcAllocatedPort] = await allocatePorts(1)
    oidcPort = oidcAllocatedPort
    oidc = await startMockOidc(oidcPort)

    // Create a test user with test app scopes + wildcard dimensions
    const tu = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["test:items", "test:external:read", "kernel:contacts:read"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
    testUserToken = tu.token
  }, 120_000)

  afterAll(async () => {
    if (oidc) oidc.stop()
    await teardownScenario(env, world)
  }, 15_000)

  // ─── S16: Test App Registration ───

  it("S16: test app registered and schema created", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    const _as = env.schemaPrefix ? `"${env.schemaPrefix}app_test"` : "app_test"

    // Verify app is registered as active
    const [appRow] = await env.db.sql.unsafe(
      `SELECT name, status, version FROM ${ks}.apps WHERE name = 'test'`,
    )
    expect(appRow).toBeDefined()
    expect(appRow.status).toBe("active")

    // Verify app_test schema exists
    const schemaName = env.schemaPrefix ? `${env.schemaPrefix}app_test` : "app_test"
    const schemas = await env.db.sql`
      SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${schemaName}`
    expect(schemas.length).toBe(1)

    // Verify tool is accessible
    const res = await api(url, "/api/apps/tools/test:listItems", {
      method: "POST",
      token: testUserToken,
      body: {},
    })
    expect(res.status).toBe(200)
  })

  // ─── S23: Gated Tool Execution ───

  // Approvals are for agents, not persons: a person's own call to a gated tool
  // is decided by the tool's OWN permission. Holding test:items:write (not
  // test:approve) it runs at once; without it, it is refused (403). It never
  // parks an approval.
  it("S23: a person's own call to a gated tool runs on the tool's scope, or is refused (403); nothing parks", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    const countRows = async () =>
      (
        (await env.db.sql.unsafe(
          `SELECT count(*)::int AS n FROM ${ks}.approval_requests WHERE tool_name = 'test:riskyAction'`,
        )) as Array<{ n: number }>
      )[0].n
    const before = await countRows()
    const res = await api(url, "/api/apps/tools/test:riskyAction", {
      method: "POST",
      token: testUserToken,
      body: { itemId: "some-id", action: "delete" },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data?.blocked).toBeUndefined()
    expect(res.body.data?.executed).toBe(true)
    expect(await countRows()).toBe(before)

    const reader = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["test:items:read", "test:approve"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
    const refused = await api(url, "/api/apps/tools/test:riskyAction", {
      method: "POST",
      token: reader.token,
      body: { itemId: "some-id", action: "delete" },
    })
    expect(refused.status).toBe(403)
    expect(refused.body.data?.blocked).toBeUndefined()
    expect(refused.body.error?.message ?? "").toContain("test:items:write")
    expect(await countRows()).toBe(before)
  })

  // ─── S17: Event Bus ───

  it("S17: event bus — mutation triggers audit and timeline", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    const createRes = await api(url, "/api/apps/tools/test:createItem", {
      method: "POST",
      token: testUserToken,
      body: { title: "Event Test", team: "alpha" },
    })
    expect(createRes.status).toBe(200)
    const itemId = createRes.body.data.id

    // Poll for audit log entry
    let auditFound = false
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const entries = await env.db.sql.unsafe(
        `SELECT * FROM ${ks}.audit_log WHERE app = 'test' AND entity_id = $1`,
        [itemId],
      )
      if (entries.length > 0) {
        auditFound = true
        break
      }
      await Bun.sleep(50)
    }
    expect(auditFound).toBe(true)

    // Poll for timeline entry (may lag behind audit due to separate handler execution)
    let timelineFound = false
    const tlDeadline = Date.now() + 5000
    while (Date.now() < tlDeadline) {
      const timeline = await env.db.sql.unsafe(
        `SELECT * FROM ${ks}.timeline_entries WHERE app = 'test' AND entity_id = $1`,
        [itemId],
      )
      if (timeline.length > 0) {
        timelineFound = true
        break
      }
      await Bun.sleep(50)
    }
    expect(timelineFound).toBe(true)
  })

  // ─── S22: Timeline — Auto-generated, Access-controlled ───

  it("S22: timeline auto-generated and access-controlled", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    // Create an item (triggers timeline entry via publishEvent)
    const createRes = await api(url, "/api/apps/tools/test:createItem", {
      method: "POST",
      token: testUserToken,
      body: { title: "Timeline Test", team: "alpha" },
    })
    expect(createRes.status).toBe(200)
    const entityId = createRes.body.data.id

    // Poll for timeline creation entry
    let found = false
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const entries = await env.db.sql.unsafe(
        `SELECT * FROM ${ks}.timeline_entries WHERE entity_id = $1`,
        [entityId],
      )
      if (entries.length > 0) {
        found = true
        break
      }
      await Bun.sleep(50)
    }
    expect(found).toBe(true)

    // Access via API with authorized user
    const reader = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["test:items:read"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    const tlRes = await api(url, `/api/timeline/test/items/${entityId}`, {
      token: reader.token,
    })
    expect(tlRes.status).toBe(200)
    expect(tlRes.body.data.length).toBeGreaterThanOrEqual(1)

    // Unauthorized user
    const noScopeUser = await createUserWithScopes(
      url,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        scopes: ["kernel:contacts:read"],
        schemaPrefix: env.schemaPrefix,
      },
    )

    const tlForbid = await api(url, `/api/timeline/test/items/${entityId}`, {
      token: noScopeUser.token,
    })
    expect(tlForbid.status).toBe(403)
  })

  // ─── S26: Jobs Runtime ───

  it("S26: jobs runtime — scheduled + failure/DLQ", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    const redisPrefix = env.redisPrefix ?? ""

    // Verify BullMQ keys exist for the app-test queue in Redis
    const repeatableKeys = await env.redis.redis.keys(`${redisPrefix}bull:app-test:*`)
    expect(repeatableKeys.length).toBeGreaterThan(0)

    // Create an item to trigger the event pipeline
    const createRes = await api(url, "/api/apps/tools/test:createItem", {
      method: "POST",
      token: testUserToken,
      body: { title: "Jobs Test Item", team: "alpha" },
    })
    expect(createRes.status).toBe(200)
    const itemId = createRes.body.data.id

    // Poll for audit log entry — proves the event bus processed the job
    let auditEntry: Record<string, unknown> | null = null
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const entries = await env.db.sql.unsafe(
        `SELECT * FROM ${ks}.audit_log WHERE app = 'test' AND entity_id = $1`,
        [itemId],
      )
      if (entries.length > 0) {
        auditEntry = entries[0]
        break
      }
      await Bun.sleep(50)
    }
    expect(auditEntry).not.toBeNull()
    expect(auditEntry?.app).toBe("test")
    expect(auditEntry?.entity_id).toBe(itemId)

    // Verify queue infrastructure is still intact after job execution
    const keysAfter = await env.redis.redis.keys(`${redisPrefix}bull:app-test:*`)
    expect(keysAfter.length).toBeGreaterThan(0)
  })

  // ─── S27: App Dependency Resolution ───

  it("S27: required dependency missing → app not registered", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    // test-missing-required should not be active
    const rows = await env.db.sql.unsafe(
      `SELECT name, status FROM ${ks}.apps WHERE name = 'test-missing-required'`,
    )
    // Should either not exist or have error status
    if (rows.length > 0) {
      expect(rows[0].status).toBe("error")
    }
    // No row means it was rejected before registration

    // Server logs should contain error about missing dependency
    const stderr = env.getStderr()
    const stdout = env.getStdout()
    const combined = stderr + stdout
    expect(combined.includes("nonexistent-app") || combined.includes("test-missing-required")).toBe(
      true,
    )
  })

  it("S27: optional dependency missing → app still active", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    const rows = await env.db.sql.unsafe(
      `SELECT name, status FROM ${ks}.apps WHERE name = 'test-optional-dep'`,
    )
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe("active")
  })

  it("S27: main test app active (no unmet dependencies)", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    const rows = await env.db.sql.unsafe(`SELECT status FROM ${ks}.apps WHERE name = 'test'`)
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe("active")
  })

  // ─── S28: Schema Migration Lifecycle ───

  it("S28: schema migration — version tracked", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    const as = env.schemaPrefix ? `${env.schemaPrefix}app_test` : "app_test"

    // Verify the test app is registered with correct version
    const [app] = await env.db.sql.unsafe(
      `SELECT name, status, version FROM ${ks}.apps WHERE name = 'test'`,
    )
    expect(app).toBeDefined()
    expect(app.name).toBe("test")
    expect(app.status).toBe("active")
    expect(app.version).toBe("1.0.0")

    // Verify the app_test schema exists
    const schemas = await env.db.sql`
      SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${as}`
    expect(schemas.length).toBe(1)

    // Verify the items table columns include expected fields
    const columns = await env.db.sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${as} AND table_name = 'items'
      ORDER BY ordinal_position`
    const columnNames = columns.map((c: any) => c.column_name)
    expect(columnNames).toContain("title")
    expect(columnNames).toContain("team")
    expect(columnNames).toContain("org_id")

    // Create items via API and verify they persist
    await api(url, "/api/apps/tools/test:createItem", {
      method: "POST",
      token: testUserToken,
      body: { title: "Migration Test 1", team: "alpha" },
    })
    await api(url, "/api/apps/tools/test:createItem", {
      method: "POST",
      token: testUserToken,
      body: { title: "Migration Test 2", team: "beta" },
    })

    const items = await env.db.sql.unsafe(
      `SELECT * FROM "${as}".items WHERE title LIKE 'Migration Test%'`,
    )
    expect(items.length).toBeGreaterThanOrEqual(2)
  })

  // ─── S29: Device Flow Data Model and Expiry ───

  it("S29: device flow data model — expired requests transition", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    const deviceCode = `test-device-code-${Date.now()}`

    // Insert an expired device flow request
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.device_flow_requests
       (org_id, device_code, user_code, client_id, state, scopes, expires_at)
       VALUES ($1, $2, 'TEST-1234', 'test-client', 'pending', '["openid"]', $3)`,
      [world.org.id, deviceCode, new Date(Date.now() - 60000)],
    )

    // Verify it was inserted as pending
    const [before] = await env.db.sql.unsafe(
      `SELECT state FROM ${ks}.device_flow_requests WHERE device_code = $1`,
      [deviceCode],
    )
    expect(before.state).toBe("pending")

    // Execute the expiry logic directly (same SQL the job runs)
    await env.db.sql.unsafe(
      `UPDATE ${ks}.device_flow_requests SET state = 'expired'
       WHERE state = 'pending' AND expires_at < NOW()`,
    )

    // Verify transition
    const [after] = await env.db.sql.unsafe(
      `SELECT state FROM ${ks}.device_flow_requests WHERE device_code = $1`,
      [deviceCode],
    )
    expect(after.state).toBe("expired")
  })

  // ─── S32: Device Flow Full Cycle ───

  it("S32: device flow full cycle — initiate, approve, poll with token", async () => {
    // Initiate (public endpoint)
    const initRes = await api(url, "/api/auth/device-flow/initiate", {
      method: "POST",
      body: { clientId: "claude-code-test", scopes: ["kernel:threads:read"] },
    })
    expect(initRes.status).toBe(200)
    expect(initRes.body.data.deviceCode).toBeDefined()
    expect(initRes.body.data.userCode).toBeDefined()
    expect(initRes.body.data.verificationUri).toBeDefined()
    expect(initRes.body.data.expiresIn).toBeGreaterThan(0)

    const { deviceCode, userCode } = initRes.body.data

    // Poll — should be pending
    const pendingRes = await api(
      url,
      `/api/auth/device-flow/poll/${deviceCode}?client_id=claude-code-test`,
      {
        method: "GET",
      },
    )
    expect(pendingRes.status).toBe(200)
    expect(pendingRes.body.data.status).toBe("authorization_pending")

    // Approve (authenticated as admin)
    const approveRes = await api(url, `/api/auth/device-flow/approve/${userCode}`, {
      method: "POST",
      token: world.admin.token,
      body: {},
    })
    expect(approveRes.status).toBe(200)
    expect(approveRes.body.data.approved).toBe(true)

    // Expire the device-flow rate limit window (1 poll/second per RFC 8628):
    // the key the server sets with EX 1, under its Redis key prefix.
    await env.redis.redis.del(`${env.redisPrefix ?? ""}device-poll:${deviceCode}`)

    // Poll — should be approved with access token
    const approvedRes = await api(
      url,
      `/api/auth/device-flow/poll/${deviceCode}?client_id=claude-code-test`,
      {
        method: "GET",
      },
    )
    expect(approvedRes.status).toBe(200)
    expect(approvedRes.body.data.status).toBe("approved")
    expect(approvedRes.body.data.accessToken).toBeDefined()

    // Verify the issued token works — call a protected endpoint
    const meRes = await api(url, "/api/users/me", {
      token: approvedRes.body.data.accessToken,
    })
    expect(meRes.status).toBe(200)
    expect(meRes.body.data.id).toBeDefined()
  })

  // ─── S32b: Device Flow Deny Cycle ───

  it("S32b: device flow deny cycle — initiate, deny, poll returns denied", async () => {
    const initRes = await api(url, "/api/auth/device-flow/initiate", {
      method: "POST",
      body: { clientId: "claude-code-deny-test", scopes: ["kernel:threads:read"] },
    })
    expect(initRes.status).toBe(200)
    const { deviceCode, userCode } = initRes.body.data

    // Deny (authenticated as admin)
    const denyRes = await api(url, `/api/auth/device-flow/deny/${userCode}`, {
      method: "POST",
      token: world.admin.token,
      body: {},
    })
    expect(denyRes.status).toBe(200)
    expect(denyRes.body.data.denied).toBe(true)

    // Poll — should be denied
    const deniedRes = await api(
      url,
      `/api/auth/device-flow/poll/${deviceCode}?client_id=claude-code-deny-test`,
      {
        method: "GET",
      },
    )
    expect(deniedRes.status).toBe(200)
    expect(deniedRes.body.data.status).toBe("denied")
  })

  // ─── S32c: Device Flow Unknown Code ───

  it("S32c: device flow poll for unknown code returns 404", async () => {
    const res = await api(url, "/api/auth/device-flow/poll/nonexistent-code-xyz", {
      method: "GET",
    })
    expect(res.status).toBe(404)
  })

  // ─── S33: Export Endpoint ───

  // The per-app export endpoint is gated on kernel:users:admin (same gate as
  // the multi-app export): a member holding only app scopes must NOT be able
  // to bulk-export an app's dataset.
  it("S33: export endpoint returns data for registered app (admin)", async () => {
    const res = await api(url, "/api/apps/export/test?format=json", {
      method: "GET",
      token: world.admin.token,
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toBeDefined()
  })

  it("S33a: export endpoint denies a non-admin member holding app scopes", async () => {
    const res = await api(url, "/api/apps/export/test?format=json", {
      method: "GET",
      token: testUserToken,
    })
    expect(res.status).toBe(403)
  })

  it("S33b: export endpoint returns 404 for unknown app", async () => {
    const res = await api(url, "/api/apps/export/nonexistent?format=json", {
      method: "GET",
      token: world.admin.token,
    })
    expect(res.status).toBe(404)
  })

  it("S33c: export endpoint returns 400 for unsupported format", async () => {
    const res = await api(url, "/api/apps/export/test?format=xml", {
      method: "GET",
      token: world.admin.token,
    })
    expect(res.status).toBe(400)
  })

  // ─── S34: Entity Registry ───

  it("S34: entity registry populated from test app", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    const as = env.schemaPrefix ? `${env.schemaPrefix}app_test` : "app_test"

    // Verify the app is active (registration completed including entities)
    const appStatus = await env.db.sql.unsafe(`SELECT status FROM ${ks}.apps WHERE name = 'test'`)
    expect(appStatus[0]?.status).toBe("active")

    // Verify the items table columns include entity-specific fields
    const columns = await env.db.sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${as} AND table_name = 'items'
      ORDER BY ordinal_position`
    const columnNames = columns.map((c: any) => c.column_name)
    expect(columnNames).toContain("title")
    expect(columnNames).toContain("team")
    expect(columnNames).toContain("sensitivity")
  })

  // ─── S19: Webhooks ───

  it("S19: valid webhook signature accepted", async () => {
    const body = JSON.stringify({ event: "test", ts: Date.now() })
    const res = await fetch(`${url}/webhooks/${world.org.id}/test/test-hook`, {
      method: "POST",
      headers: makeWebhookHeaders(body),
      body,
    })
    expect(res.status).toBe(200)
  })

  it("S19: invalid webhook signature rejected", async () => {
    const body = JSON.stringify({ event: "test-invalid", ts: Date.now() })
    const res = await fetch(`${url}/webhooks/${world.org.id}/test/test-hook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": "bad-signature",
        "x-webhook-delivery": crypto.randomUUID(),
        "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body,
    })
    expect(res.status).toBe(401)
  })

  it("S19: missing webhook signature rejected", async () => {
    const body = JSON.stringify({ event: "test-nosig", ts: Date.now() })
    const res = await fetch(`${url}/webhooks/${world.org.id}/test/test-hook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-delivery": crypto.randomUUID(),
        "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body,
    })
    expect(res.status).toBe(401)
  })

  it("S19: webhook wrong method → 405", async () => {
    const res = await fetch(`${url}/webhooks/${world.org.id}/test/test-hook`)
    expect(res.status).toBe(405)
  })

  it("S19: webhook unknown endpoint → 404", async () => {
    const body = JSON.stringify({ event: "test" })
    const res = await fetch(`${url}/webhooks/${world.org.id}/test/nonexistent`, {
      method: "POST",
      headers: makeWebhookHeaders(body),
      body,
    })
    expect(res.status).toBe(404)
  })

  it("S19: webhook handler failure returns 200, enqueues retry", async () => {
    const redisPrefix = env.redisPrefix ?? ""

    const body = JSON.stringify({ event: "fail", ts: Date.now() })
    const res = await fetch(`${url}/webhooks/${world.org.id}/test/test-hook`, {
      method: "POST",
      headers: makeWebhookHeaders(body),
      body,
    })
    // Spec: return 200 to prevent external retries
    expect(res.status).toBe(200)

    // Poll for retry job in BullMQ
    let retryFound = false
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      // retry-webhook is a kernel cron-class job (infra/jobs/queue-classes.ts).
      const keys = await env.redis.redis.keys(`${redisPrefix}bull:kernel-cron:*`)
      if (keys.length > 0) {
        retryFound = true
        break
      }
      await Bun.sleep(100)
    }
    // The retry job should have been enqueued
    expect(retryFound).toBe(true)
  })

  // ─── S25: OAuth ───

  it("S25: register OAuth provider", async () => {
    const res = await api(url, "/api/admin/oauth-providers", {
      token: world.admin.token,
      body: {
        name: "mock-oidc",
        issuerUrl: `http://localhost:${oidcPort}`,
        clientId: "test-client",
        clientSecret: "test-secret",
        scopes: "openid email profile",
        autoProvision: true,
      },
    })
    expect(res.status).toBe(200)
    expect(typeof res.body.data.id).toBe("string")
    expect(res.body.data.id.length).toBeGreaterThan(0)
    expect(res.body.data.name).toBe("mock-oidc")
  })

  it("S25: OAuth authorize redirects to provider", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    // Get provider ID
    const [provider] = await env.db.sql.unsafe(
      `SELECT id FROM ${ks}.oauth_providers WHERE name = 'mock-oidc'`,
    )
    expect(provider).toBeDefined()

    // Authorize — follow redirect manually
    const res = await fetch(`${url}/api/auth/oauth/${provider.id}/authorize`, {
      redirect: "manual",
    })
    expect(res.status).toBe(302)
    const location = res.headers.get("location")
    expect(location).toContain(`localhost:${oidcPort}/authorize`)
    expect(location).toContain("state=")
  })

  it("S25: OAuth callback provisions user", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    const [provider] = await env.db.sql.unsafe(
      `SELECT id FROM ${ks}.oauth_providers WHERE name = 'mock-oidc'`,
    )

    // Step 1: Initiate authorize to capture state + session cookie
    const authRes = await fetch(`${url}/api/auth/oauth/${provider.id}/authorize`, {
      redirect: "manual",
    })
    const location = authRes.headers.get("location")!
    // Extract OAuth state cookie set during authorize (session binding)
    const oauthCookie = authRes.headers.get("set-cookie") ?? ""

    // Step 2: The mock OIDC /authorize redirects to callback with code and state
    const callbackRes = await fetch(location, { redirect: "manual" })
    const callbackLocation = callbackRes.headers.get("location")!
    const callbackUrl = new URL(callbackLocation)
    const code = callbackUrl.searchParams.get("code")!
    const state = callbackUrl.searchParams.get("state")!

    // Step 3: Hit the callback endpoint — returns a redirect with one-time code in query params
    // Must include the OAuth state cookie from step 1
    const cbRes = await fetch(`${url}/api/auth/oauth/callback?code=${code}&state=${state}`, {
      redirect: "manual",
      headers: { cookie: oauthCookie.split(";")[0] },
    })
    expect(cbRes.status).toBe(302)
    const redirectLocation = cbRes.headers.get("location")!
    expect(redirectLocation).toContain("/login/oauth-complete?code=")

    // Exchange the one-time code for access token (refresh token is in HttpOnly cookie)
    const oauthCode = new URL(redirectLocation, url).searchParams.get("code")!
    const exchangeRes = await api(url, "/api/auth/oauth/exchange", {
      body: { code: oauthCode },
    })
    expect(exchangeRes.status).toBe(200)
    const accessToken = exchangeRes.body.data.accessToken
    expect(accessToken.length).toBeGreaterThan(10)

    // Step 4: Verify user is provisioned
    const me = await api(url, "/api/users/me", { token: accessToken })
    expect(me.status).toBe(200)
    expect(me.body.data.email).toBe("oauth-user@e2e.test")
  })
})
