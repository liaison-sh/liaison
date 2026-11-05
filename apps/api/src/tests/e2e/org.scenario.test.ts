// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { pollUntil } from "./helpers/approvals"
import { setupScenario, teardownScenario } from "./setup"

describe("Org Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 3,
      org: { name: "Org Test Org" },
      populate: {
        users: { count: 10 },
        threads: { count: 20, participants: "random(2-4)", messages: "random(1-3)" },
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  // ─── Permissions: Scope Hierarchy (from permissions.e2e.test.ts S13) ───

  it("S13: parent scope grants all children", async () => {
    // User A: has parent scope test:items (grants all children) + wildcard dimensions
    const userA = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["test:items"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    // User B: has only test:items:read + wildcard dimensions
    const userB = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["test:items:read"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    // User A can read (child scope implied)
    const aRead = await api(url, "/api/apps/tools/test:listItems", {
      method: "POST",
      token: userA.token,
      body: {},
    })
    expect(aRead.status).toBe(200)
    expect(aRead.body.data).toBeArray()

    // User A can write (child scope implied)
    const aWrite = await api(url, "/api/apps/tools/test:createItem", {
      method: "POST",
      token: userA.token,
      body: { title: "Scope Test A", team: "alpha" },
    })
    expect(aWrite.status).toBe(200)
    expect(aWrite.body.data).toBeDefined()
    expect(aWrite.body.data.title).toBe("Scope Test A")
    expect(aWrite.body.data.team).toBe("alpha")

    // User B can read
    const bRead = await api(url, "/api/apps/tools/test:listItems", {
      method: "POST",
      token: userB.token,
      body: {},
    })
    expect(bRead.status).toBe(200)
    expect(bRead.body.data).toBeArray()

    // User B cannot write (no write scope)
    const bWrite = await api(url, "/api/apps/tools/test:createItem", {
      method: "POST",
      token: userB.token,
      body: { title: "Scope Test B", team: "alpha" },
    })
    expect(bWrite.status).toBe(403)

    // User B cannot access external (different scope tree)
    const bExternal = await api(url, "/api/apps/tools/test:externalSearch", {
      method: "POST",
      token: userB.token,
      body: { query: "test" },
    })
    expect(bExternal.status).toBe(403)
  })

  // ─── Permissions: Dimension-Filtered RLS (from permissions.e2e.test.ts S14) ───

  it("S14: dimension-filtered RLS — membership type", async () => {
    const appTest = env.schemaPrefix ? `"${env.schemaPrefix}app_test"` : "app_test"

    // Insert test items directly
    await env.db.sql.unsafe(
      `INSERT INTO ${appTest}.items (org_id, title, status, team, sensitivity)
       VALUES
         ($1, 'Alpha 1', 'open', 'alpha', 'public'),
         ($1, 'Alpha 2', 'open', 'alpha', 'public'),
         ($1, 'Beta 1', 'open', 'beta', 'public'),
         ($1, 'Beta 2', 'open', 'beta', 'public'),
         ($1, 'Beta 3', 'open', 'beta', 'public')`,
      [world.org.id],
    )

    // Create user with dimension grants: team=["alpha"], sensitivity=["public"]
    const user = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["test:items:read"],
      dimensions: { "test:team": ["alpha"], "test:sensitivity": ["public"] },
      schemaPrefix: env.schemaPrefix,
    })

    const res = await api(url, "/api/apps/tools/test:listItems", {
      method: "POST",
      token: user.token,
      body: {},
    })
    expect(res.status).toBe(200)

    const items = res.body.data
    expect(Array.isArray(items)).toBe(true)

    // Should see only alpha items (2 from above + any from S13)
    for (const item of items) {
      expect(item.team).toBe("alpha")
    }
    // At minimum 2 alpha items
    expect(items.length).toBeGreaterThanOrEqual(2)
  })

  // ─── Permissions: Response Filtering (from permissions.e2e.test.ts S15) ───

  it("S15: response filtering — external data", async () => {
    // Create user with scope test:external:read and dimension test:market=["us"]
    const user = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["test:external:read"],
      dimensions: { "test:market": ["us"] },
      schemaPrefix: env.schemaPrefix,
    })

    const res = await api(url, "/api/apps/tools/test:externalSearch", {
      method: "POST",
      token: user.token,
      body: { query: "test" },
    })
    expect(res.status).toBe(200)

    const items = res.body.data
    expect(Array.isArray(items)).toBe(true)
    // Mock returns 3 US items out of 10
    expect(items.length).toBe(3)
    for (const item of items) {
      expect(item.market).toBe("us")
    }
  })

  // ─── Permissions: Zero-Knowledge Denial (from permissions.e2e.test.ts S30) ───

  it("S30: zero-knowledge denial — user B sees nothing about user A's data", async () => {
    // User A: has test:items scope + team:["alpha"] dimension
    const userA = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["test:items"],
      dimensions: {
        "test:team": ["alpha"],
        "test:sensitivity": ["confidential", "internal", "public"],
      },
      schemaPrefix: env.schemaPrefix,
    })

    // Create item as user A with team=alpha
    const createRes = await api(url, "/api/apps/tools/test:createItem", {
      method: "POST",
      token: userA.token,
      body: { title: "Alpha Secret", team: "alpha" },
    })
    expect(createRes.status).toBe(200)
    expect(createRes.body.data.id).toBeDefined()

    // User B: has test:items scope + team:["beta"] dimension (different team)
    const userB = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["test:items"],
      dimensions: {
        "test:team": ["beta"],
        "test:sensitivity": ["confidential", "internal", "public"],
      },
      schemaPrefix: env.schemaPrefix,
    })

    // User B lists items — should see zero alpha items (zero-knowledge: no error, just empty/filtered)
    const listRes = await api(url, "/api/apps/tools/test:listItems", {
      method: "POST",
      token: userB.token,
      body: {},
    })
    expect(listRes.status).toBe(200)
    expect(Array.isArray(listRes.body.data)).toBe(true)

    // User B must never see any alpha-team items
    for (const item of listRes.body.data) {
      expect(item.team).not.toBe("alpha")
    }
  })

  // ─── Permissions: No Scope = 403 (from permissions.e2e.test.ts S31) ───

  it("S31: user without scope gets 403, not filtered data", async () => {
    // User C: has kernel:contacts:read but NOT test:items scope
    const userC = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["kernel:contacts:read"],
      schemaPrefix: env.schemaPrefix,
    })

    const res = await api(url, "/api/apps/tools/test:listItems", {
      method: "POST",
      token: userC.token,
      body: {},
    })
    expect(res.status).toBe(403)
  })

  // ─── Org Settings (from org.e2e.test.ts S20) ───

  it("S20: read org settings defaults", async () => {
    const res = await api(url, "/api/org", { token: world.admin.token })
    expect(res.status).toBe(200)
    expect(res.body.data.timezone).toBe("UTC")
    expect(typeof res.body.data.settings).toBe("object")
    expect(res.body.data.settings).not.toBeNull()
  })

  it("S20: admin can update org settings", async () => {
    const patchRes = await api(url, "/api/org", {
      method: "PATCH",
      token: world.admin.token,
      body: { timezone: "America/New_York", settings: { rateLimitPerMinute: 5000 } },
    })
    expect(patchRes.status).toBe(200)

    const getRes = await api(url, "/api/org", { token: world.admin.token })
    expect(getRes.status).toBe(200)
    expect(getRes.body.data.timezone).toBe("America/New_York")
    expect(getRes.body.data.settings.rateLimitPerMinute).toBe(5000)

    // Restore
    await api(url, "/api/org", {
      method: "PATCH",
      token: world.admin.token,
      body: { timezone: "UTC", settings: { rateLimitPerMinute: 10000 } },
    })
  })

  it("S20: non-admin cannot update org", async () => {
    const user = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["test:items:read"],
      schemaPrefix: env.schemaPrefix,
    })

    const patchRes = await api(url, "/api/org", {
      method: "PATCH",
      token: user.token,
      body: { timezone: "Asia/Tokyo" },
    })
    expect(patchRes.status).toBe(403)
  })

  // ─── Audit Log (from audit.e2e.test.ts S21) ───

  it("S21: admin can query audit log", async () => {
    // Create a test app item to generate audit entries via event bus
    const user = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["test:items", "kernel:contacts:read"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
    await api(url, "/api/apps/tools/test:createItem", {
      method: "POST",
      token: user.token,
      body: { title: "Audit Test Item", team: "alpha" },
    })

    // Wait for outbox worker to process events and async audit write
    const res = await pollUntil(async () => {
      const r = await api(url, "/api/audit", { token: world.admin.token })
      return r.status === 200 && Array.isArray(r.body.data) && r.body.data.length > 0 ? r : null
    }, 10_000)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.data.length).toBeGreaterThan(0)
  })

  it("S21: audit entries have required fields", async () => {
    const res = await api(url, "/api/audit", { token: world.admin.token })
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeGreaterThan(0)
    const entry = res.body.data[0]
    expect(typeof entry.action).toBe("string")
    expect(entry.action.length).toBeGreaterThan(0)
    expect(typeof entry.timestamp).toBe("string")
    expect(entry.actorType).toMatch(/^(user|agent|system|mcp)$/)
  })

  it("S21: non-admin cannot access audit log", async () => {
    const user = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["test:items:read"],
      schemaPrefix: env.schemaPrefix,
    })
    const res = await api(url, "/api/audit", { token: user.token })
    expect(res.status).toBe(403)
  })

  // ─── Contacts (from contacts.e2e.test.ts S18) ───

  it("S18: contact resolution — create and deduplicate", async () => {
    // Create contact
    const res1 = await api(url, "/api/contacts/resolve", {
      token: world.admin.token,
      body: { email: "hans@acme.de", name: "Hans" },
    })
    expect(res1.status).toBe(200)
    const contactId = res1.body.data.id
    expect(contactId).toBeDefined()

    // Resolve same email with externalId → same contact, merged
    const res2 = await api(url, "/api/contacts/resolve", {
      token: world.admin.token,
      body: { email: "hans@acme.de", externalId: { shopify: "cust_123" } },
    })
    expect(res2.status).toBe(200)
    expect(res2.body.data.id).toBe(contactId)

    // Verify merge
    const getRes = await api(url, `/api/contacts/${contactId}`, { token: world.admin.token })
    expect(getRes.status).toBe(200)
    expect(getRes.body.data.name).toBe("Hans")
    expect(getRes.body.data.externalIds?.shopify).toBe("cust_123")

    // Case-insensitive match
    const res3 = await api(url, "/api/contacts/resolve", {
      token: world.admin.token,
      body: { email: "HANS@ACME.DE" },
    })
    expect(res3.status).toBe(200)
    expect(res3.body.data.id).toBe(contactId)

    // List should have exactly 1 contact
    const listRes = await api(url, "/api/contacts", { token: world.admin.token })
    expect(listRes.status).toBe(200)
    expect(listRes.body.data.length).toBe(1)
  })
})
