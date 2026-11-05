// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { exportRegistry, slotRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("GET /api/apps/dimensions", () => {
  const ORG = "00000000-0000-4000-8000-00000000a120"
  const ADMIN = "00000000-0000-4000-8000-00000000a121"
  const MEMBER = "00000000-0000-4000-8000-00000000a122"
  const ACCOUNT_1 = "00000000-0000-4000-8000-00000000a123"
  const ACCOUNT_2 = "00000000-0000-4000-8000-00000000a124"
  let adminToken: string
  let memberToken: string

  beforeAll(async () => {
    await acquireTestLock()
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS app_mail`)
    await sql.unsafe(`GRANT USAGE ON SCHEMA app_mail TO liaison_rls, liaison_app, liaison_admin`)
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS app_mail.accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id UUID NOT NULL,
        connected_account_id UUID NOT NULL,
        owner_type TEXT NOT NULL DEFAULT 'user',
        owner_id UUID,
        provider TEXT NOT NULL,
        email_address TEXT NOT NULL,
        display_name TEXT,
        sync_status TEXT NOT NULL,
        sync_state JSONB,
        last_sync_at TIMESTAMPTZ,
        last_sync_error TEXT,
        disconnected_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (org_id, email_address)
      )
    `)
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON app_mail.accounts TO liaison_rls, liaison_app`,
    )
    await sql`DELETE FROM app_mail.accounts WHERE org_id = ${ORG}`
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'App Dimensions Org', 'app-dimensions-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ADMIN}, ${ORG}, 'apps-admin@test.com', 'Apps Admin')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${MEMBER}, ${ORG}, 'apps-member@test.com', 'Apps Member')`
    await sql`
      INSERT INTO app_mail.accounts (id, org_id, connected_account_id, owner_type, provider, email_address, display_name, sync_status, disconnected_at)
      VALUES
        (${ACCOUNT_1}, ${ORG}, gen_random_uuid(), 'org', 'gmail', 'shared-a@example.com', 'Shared A', 'connected', null),
        (${ACCOUNT_2}, ${ORG}, gen_random_uuid(), 'org', 'gmail', 'shared-b@example.com', null, 'connected', null),
        (gen_random_uuid(), ${ORG}, gen_random_uuid(), 'user', 'gmail', 'personal@example.com', 'Personal', 'connected', null),
        (gen_random_uuid(), ${ORG}, gen_random_uuid(), 'org', 'gmail', 'disconnected@example.com', 'Disconnected', 'connected', now())
    `
    adminToken = await signAccessToken(
      {
        userId: ADMIN,
        orgId: ORG,
        name: "Apps Admin",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:users:admin", "mail:accounts:read"],
        dimensionGrants: { "mail:inbox": ["*"] },
      },
      env.JWT_SECRET,
    )
    memberToken = await signAccessToken(
      { userId: MEMBER, orgId: ORG, name: "Apps Member", authVersion: 1, permissionVersion: 1 },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM app_mail.accounts WHERE org_id = ${ORG}`
    await releaseTestLock()
  })

  it("returns 403 without kernel:users:admin", async () => {
    const res = await app.request("/api/apps/dimensions", {
      headers: { Authorization: `Bearer ${memberToken}` },
    })

    expect(res.status).toBe(403)
  })

  it("returns dimension definitions visible in the org", async () => {
    const res = await app.request("/api/apps/dimensions", {
      headers: { Authorization: `Bearer ${adminToken}` },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const inbox = body.data.find((d: any) => d.key === "mail:inbox" && d.app === "mail")
    expect(inbox.type).toBe("membership")
    expect(inbox.label).toBe("Inbox access")
    expect(inbox.valueSource).toEqual({ kind: "mail_accounts" })

    // Mail access is the inbox membership alone: the never-enforced sensitivity
    // level was dropped (migration 0119), so the access screen must not offer it.
    expect(body.data.filter((d: any) => d.app === "mail").map((d: any) => d.key)).toEqual([
      "mail:inbox",
    ])
  })

  it("resolves mail:inbox to connected org mail accounts", async () => {
    const res = await app.request("/api/apps/dimensions/mail:inbox/values", {
      headers: { Authorization: `Bearer ${adminToken}` },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.length).toBe(2)
    expect(body.data).toEqual(
      expect.arrayContaining([
        { value: ACCOUNT_1, label: "Shared A", sublabel: "shared-a@example.com" },
        { value: ACCOUNT_2, label: "shared-b@example.com", sublabel: "shared-b@example.com" },
      ]),
    )
  })

  it("returns 404 for unknown dimension values", async () => {
    const res = await app.request("/api/apps/dimensions/unknown:dim/values", {
      headers: { Authorization: `Bearer ${adminToken}` },
    })

    expect(res.status).toBe(404)
  })
})

describe("POST /api/apps/run-tool", () => {
  const ORG = "00000000-0000-4000-8000-00000000a130"
  const USER = "00000000-0000-4000-8000-00000000a131"
  const THREAD = "00000000-0000-4000-8000-00000000a132"
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Run Tool Org', 'run-tool-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'run-tool@test.com', 'Run Tool') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD}, ${ORG}, 'run-tool-thread', 'agent_chat', ${USER}) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG}) ON CONFLICT DO NOTHING`
    toolRegistry.set([ORG, "route_test", "gated"], {
      appName: "route_test",
      name: "gated",
      description: "Route test gated tool",
      requiredScopes: ["route_test:write"],
      gated: true,
      handler: async () => ({ ok: true }),
    } as any)
    // Non-gated tool guarded by a scope the run-tool caller does NOT hold, so a
    // denied call exercises the forbidden path (criterion: per-user enforcement).
    toolRegistry.set([ORG, "route_test", "scoped"], {
      appName: "route_test",
      name: "scoped",
      description: "Route test scope-guarded tool",
      requiredScopes: ["route_test:admin"],
      handler: async () => ({ ok: true }),
    } as any)
    registerApprovalSummarizer(ORG, "route_test", "gated", async () => ({
      kind: "route.gated",
      title: "Needs approval",
      lines: ["Line"],
    }))
    token = await signAccessToken(
      {
        userId: USER,
        orgId: ORG,
        name: "Run Tool",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["route_test:write", "route_test:approve"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    toolRegistry.delete([ORG, "route_test", "gated"])
    toolRegistry.delete([ORG, "route_test", "scoped"])
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_references WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("direct HTTP call with approve scope auto-executes past the gate (user click = approval)", async () => {
    const res = await app.request("/api/apps/run-tool", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        toolName: "route_test:gated",
        threadId: THREAD,
        params: { name: "x" },
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    // No `blocked` — the gate is auto-cleared because the caller is the approver.
    expect(body.data.blocked).toBeUndefined()
    expect(body.data).toEqual({ ok: true })
  })

  it("a person holding the tool's own scope runs it without the approve scope, and nothing parks", async () => {
    // A person's own call is decided by the tool's requiredScopes, never the
    // approve scope: route_test:write alone runs route_test:gated.
    const noApproveToken = await signAccessToken(
      {
        userId: USER,
        orgId: ORG,
        name: "Run Tool",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["route_test:write"],
      },
      env.JWT_SECRET,
    )
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    const res = await app.request("/api/apps/run-tool", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${noApproveToken}` },
      body: JSON.stringify({
        toolName: "route_test:gated",
        threadId: THREAD,
        params: { name: "x" },
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.blocked).toBeUndefined()
    expect(body.data).toEqual({ ok: true })
    const parked = await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(parked.length).toBe(0)
  })

  it("POST /api/apps/tools/:toolName also auto-executes for the human approver", async () => {
    const res = await app.request("/api/apps/tools/route_test:gated", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ threadId: THREAD, params: { name: "x" } }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.blocked).toBeUndefined()
    expect(body.data).toEqual({ ok: true })
  })

  it("POST /api/apps/:appName/tools/:toolName denies a scope-lacking call with a 403 error envelope (not 200 {data:undefined})", async () => {
    // `token` holds route_test:write + route_test:approve, NOT route_test:admin.
    const res = await app.request("/api/apps/route_test/tools/scoped", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ threadId: THREAD, params: {} }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as any
    // Error envelope, not a success envelope with undefined data.
    expect(body.data).toBeUndefined()
    expect(body.error).toBeDefined()
    expect(body.error.code).toBe("forbidden")
    expect(body.error.message).toContain("route_test:admin")
  })

  // — K1b: `kernel:slots.list` host-route shim (Phase 18) —

  it("POST /api/apps/<app>/tools/kernel:slots.list returns live tab panels from listSlotPanels", async () => {
    slotRegistry.set([ORG, "boxtal", "invoicing"], {
      document_detail: {
        tabs: [{ id: "shipment", label: "Shipment", component: "BoxtalShipmentTab", order: 25 }],
      },
    })
    try {
      const res = await app.request("/api/apps/invoicing/tools/kernel:slots.list", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ slot: "invoicing.document_detail.tabs" }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(Array.isArray(body.data.panels)).toBe(true)
      expect(body.data.panels).toHaveLength(1)
      expect(body.data.panels[0]).toMatchObject({
        id: "shipment",
        component: "BoxtalShipmentTab",
        app: "boxtal",
      })
    } finally {
      slotRegistry.deleteByPrefix([ORG, "boxtal"])
    }
  })

  it("kernel:slots.list with a blank slot → { panels: [] } (not a 500)", async () => {
    const res = await app.request("/api/apps/invoicing/tools/kernel:slots.list", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.panels).toEqual([])
  })

  it("an unknown kernel:foo toolName still falls through to executeTool (unknown tool error)", async () => {
    const res = await app.request("/api/apps/invoicing/tools/kernel:foo", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ params: {} }),
    })
    // Falls through to executeTool, which does NOT return a `panels` payload.
    const body = (await res.json()) as any
    expect(body.data?.panels).toBeUndefined()
  })
})

describe("GET /api/apps/export/:appName — admin gate", () => {
  const ORG = "00000000-0000-4000-8000-00000000a140"
  const ADMIN = "00000000-0000-4000-8000-00000000a141"
  const MEMBER = "00000000-0000-4000-8000-00000000a142"
  const EXPORT_APP = "exp_route_test"
  let adminToken: string
  let memberToken: string

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Export Gate Org', 'export-gate-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ADMIN}, ${ORG}, 'export-admin@test.com', 'Export Admin') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${MEMBER}, ${ORG}, 'export-member@test.com', 'Export Member') ON CONFLICT (id) DO NOTHING`

    // Plain (non-manifest) export handler returning a JSON array. No declared
    // `scope`/`dimensions`, so invokeAppExport's inner check requires only "some
    // app-level scope" — both tokens below carry `exp_route_test:read` so the
    // inner check is satisfied and the OUTER route admin gate is what's under test.
    exportRegistry.set([ORG, EXPORT_APP], {
      formats: ["json"],
      handler: async () => [{ id: "row-1", value: "exported" }],
    })

    // Admin: holds the admin gate scope AND the app scope.
    adminToken = await signAccessToken(
      {
        userId: ADMIN,
        orgId: ORG,
        name: "Export Admin",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:users:admin", `${EXPORT_APP}:read`],
      },
      env.JWT_SECRET,
    )
    // Member: holds ONLY the app scope — enough to satisfy invokeAppExport's
    // inner "some app scope" check, but NOT the route's admin gate.
    memberToken = await signAccessToken(
      {
        userId: MEMBER,
        orgId: ORG,
        name: "Export Member",
        authVersion: 1,
        permissionVersion: 1,
        scopes: [`${EXPORT_APP}:read`],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    exportRegistry.delete([ORG, EXPORT_APP])
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("returns 403 for a member holding only an app scope (bypass closed)", async () => {
    const res = await app.request(`/api/apps/export/${EXPORT_APP}?format=json`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    })
    expect(res.status).toBe(403)
  })

  it("returns 200 for an admin holding kernel:users:admin", async () => {
    const res = await app.request(`/api/apps/export/${EXPORT_APP}?format=json`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toEqual([{ id: "row-1", value: "exported" }])
  })
})
