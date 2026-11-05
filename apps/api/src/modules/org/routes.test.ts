// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { ticketsSettingsDefaults } from "@liaison/shared"
import { app } from "~/app"
import { sql } from "~/db"
import { generateToken, hashToken } from "~/lib/crypto"
import { checkTaintEscalation, untrustedTurnNeedsApproval } from "~/modules/agent/scopes/taint"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("org settings", () => {
  let token: string
  let memberToken: string
  let orgAdminOnlyToken: string

  beforeAll(async () => {
    await acquireTestLock()
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpass123", name: "Admin" }),
    })
    token = ((await res.json()) as any).data.accessToken

    // Create a non-admin role with a narrow scope via SQL
    const orgRows = await sql`SELECT id FROM kernel.organizations LIMIT 1`
    const orgId = orgRows[0].id
    const adminRows = await sql`SELECT id FROM kernel.users WHERE email = 'admin@test.com' LIMIT 1`
    const adminId = adminRows[0].id

    const [role] = await sql`
      INSERT INTO kernel.roles (org_id, name, description)
      VALUES (${orgId}, 'org-routes-test-member', 'Regular member')
      RETURNING id
    `
    const roleId = role.id

    // Grant kernel:threads scope — does NOT cover kernel:org:admin
    await sql`
      INSERT INTO kernel.role_scope_grants (role_id, scope)
      VALUES (${roleId}, 'kernel:threads')
    `

    // Create invitation directly in DB
    const inviteTokenRaw = generateToken()
    const tokenHash = hashToken(inviteTokenRaw)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    await sql`
      INSERT INTO kernel.invitations (org_id, email, role_id, token_hash, invited_by, expires_at)
      VALUES (${orgId}, 'member@test.com', ${roleId}, ${tokenHash}, ${adminId}, ${expiresAt}::timestamptz)
    `

    const regRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteToken: inviteTokenRaw,
        password: "testpass123",
        name: "Member",
      }),
    })
    memberToken = ((await regRes.json()) as any).data.accessToken

    const [orgAdminRole] = await sql`
      INSERT INTO kernel.roles (org_id, name, description)
      VALUES (${orgId}, 'org-admin-only', 'Org settings admin without Tickets settings')
      RETURNING id
    `
    await sql`
      INSERT INTO kernel.role_scope_grants (role_id, scope)
      VALUES (${orgAdminRole.id}, 'kernel:org:admin')
    `
    const orgAdminInviteTokenRaw = generateToken()
    const orgAdminTokenHash = hashToken(orgAdminInviteTokenRaw)
    await sql`
      INSERT INTO kernel.invitations (org_id, email, role_id, token_hash, invited_by, expires_at)
      VALUES (${orgId}, 'org-admin-only@test.com', ${orgAdminRole.id}, ${orgAdminTokenHash}, ${adminId}, ${expiresAt}::timestamptz)
    `
    const orgAdminRegRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteToken: orgAdminInviteTokenRaw,
        password: "testpass123",
        name: "Org Admin Only",
      }),
    })
    orgAdminOnlyToken = ((await orgAdminRegRes.json()) as any).data.accessToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("GET /api/org returns org settings", async () => {
    const res = await app.request("/api/org", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(body.data.name).toBe("Default Organization")
    expect(body.data.timezone).toBe("UTC")
    expect(body.data.settings).toBeDefined()
    // A real org: the web shows it none of the demo's surfaces, even on a demo box.
    expect(body.data.demo).toBe(false)
  })

  it("PATCH /api/org updates settings (admin)", async () => {
    const res = await app.request("/api/org", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "My Company", timezone: "Europe/Paris" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(body.data.name).toBe("My Company")
    expect(body.data.timezone).toBe("Europe/Paris")
  })

  it("settings strict validation rejects unknown keys", async () => {
    const res = await app.request("/api/org", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ settings: { customKey: "value", rateLimitPerMinute: 200 } }),
    })
    expect(res.status).toBe(400)
  })

  it("settings accepts known keys", async () => {
    const res = await app.request("/api/org", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ settings: { rateLimitPerMinute: 200 } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(body.data.settings.rateLimitPerMinute).toBe(200)
  })

  it("PATCH /api/org accepts webContentProtection 'hardened' and taint escalation reads it", async () => {
    const res = await app.request("/api/org", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ settings: { webContentProtection: "hardened" } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.settings.webContentProtection).toBe("hardened")

    // Escalation must read the persisted "hardened" value: a tainted thread
    // calling a trust-boundary tool is blocked.
    const orgRows = await sql`SELECT id FROM kernel.organizations LIMIT 1`
    const orgId = orgRows[0].id
    const userRows = await sql`SELECT id FROM kernel.users WHERE email = 'admin@test.com' LIMIT 1`
    const [thread] = await sql`
      INSERT INTO kernel.threads (org_id, handle, type, created_by, tainted)
      VALUES (${orgId}, 'taint-hardened-thread', 'agent_chat', ${userRows[0].id}, true)
      RETURNING id
    `
    try {
      const result = await checkTaintEscalation({
        threadId: thread.id,
        orgId,
        toolHasTrustBoundary: true,
      })
      expect(result.blocked).toBe(true)
      expect(result.reason).toBe("taint_escalation")
    } finally {
      await sql`DELETE FROM kernel.threads WHERE id = ${thread.id}`
    }
  })

  it("PATCH /api/org rejects invalid webContentProtection value", async () => {
    const res = await app.request("/api/org", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ settings: { webContentProtection: "disabled" } }),
    })
    expect(res.status).toBe(400)
  })

  it("PATCH /api/org switches the untrusted-content approvals off, and escalation honours it", async () => {
    const patch = (value: string) =>
      app.request("/api/org", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ settings: { webContentProtection: value } }),
      })
    const orgRows = await sql`SELECT id FROM kernel.organizations LIMIT 1`
    const orgId = orgRows[0].id
    const userRows = await sql`SELECT id FROM kernel.users WHERE email = 'admin@test.com' LIMIT 1`
    const [thread] = await sql`
      INSERT INTO kernel.threads (org_id, handle, type, created_by, tainted)
      VALUES (${orgId}, 'taint-off-thread', 'agent_chat', ${userRows[0].id}, true)
      RETURNING id
    `
    try {
      // Default posture: an outward tool after outside text waits for a person.
      expect((await patch("standard")).status).toBe(200)
      expect(
        (
          await checkTaintEscalation({
            threadId: thread.id,
            orgId,
            toolHasTrustBoundary: true,
            toolHasExternalEffect: true,
          })
        ).blocked,
      ).toBe(true)
      expect(await untrustedTurnNeedsApproval(thread.id, orgId)).toBe(true)

      const res = await patch("off")
      expect(res.status).toBe(200)
      expect(((await res.json()) as any).data.settings.webContentProtection).toBe("off")
      expect(
        (
          await checkTaintEscalation({
            threadId: thread.id,
            orgId,
            toolHasTrustBoundary: true,
            toolHasExternalEffect: true,
          })
        ).blocked,
      ).toBe(false)
      expect(await untrustedTurnNeedsApproval(thread.id, orgId)).toBe(false)
    } finally {
      await patch("standard")
      await sql`DELETE FROM kernel.threads WHERE id = ${thread.id}`
    }
  })

  it("PATCH /api/org no longer takes Tickets settings: 400 (they moved to the app settings route)", async () => {
    const res = await app.request("/api/org", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${orgAdminOnlyToken}`,
      },
      body: JSON.stringify({ settings: { tickets: ticketsSettingsDefaults } }),
    })
    expect(res.status).toBe(400)
  })

  it("non-admin user PATCH /api/org returns 403", async () => {
    const res = await app.request("/api/org", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${memberToken}`,
      },
      body: JSON.stringify({ name: "Hacked Org" }),
    })
    expect(res.status).toBe(403)
  })

  it("GET /api/org strips secret settings for non-admins, keeps them for admins", async () => {
    // Seed sensitive + non-sensitive settings directly into the default org.
    const orgRows = await sql`SELECT id FROM kernel.organizations LIMIT 1`
    const orgId = orgRows[0].id
    const sensitive = {
      providerKeys: { anthropic: { encrypted: "ciphertext-byok", preview: "sk-...xyz" } },
      integrations: {
        google: { oauthClient: { clientId: "gid", clientSecretEncrypted: "ciphertext-google" } },
      },
      taintSources: { "https://evil.example": { reason: "x" } },
      rateLimitPerMinute: 321,
      webContentProtection: "hardened",
    }
    await sql`UPDATE kernel.organizations SET settings = ${JSON.stringify(sensitive)}::jsonb WHERE id = ${orgId}`

    // Non-admin (kernel:threads only): secret keys stripped, safe keys kept.
    const memberRes = await app.request("/api/org", {
      headers: { Authorization: `Bearer ${memberToken}` },
    })
    expect(memberRes.status).toBe(200)
    const memberBody = (await memberRes.json()) as any
    expect(memberBody.data.settings.providerKeys).toBeUndefined()
    expect(memberBody.data.settings.integrations).toBeUndefined()
    expect(memberBody.data.settings.taintSources).toBeUndefined()
    // Non-sensitive config stays visible to all members.
    expect(memberBody.data.settings.rateLimitPerMinute).toBe(321)
    expect(memberBody.data.settings.webContentProtection).toBe("hardened")

    // Admin (kernel:org:admin via the bootstrap '*' token): full settings.
    const adminRes = await app.request("/api/org", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(adminRes.status).toBe(200)
    const adminBody = (await adminRes.json()) as any
    expect(adminBody.data.settings.providerKeys).toEqual(sensitive.providerKeys)
    expect(adminBody.data.settings.integrations).toEqual(sensitive.integrations)
    expect(adminBody.data.settings.taintSources).toEqual(sensitive.taintSources)
  })

  it("GET /api/org withholds the AI models block (own servers' addresses) from non-admins", async () => {
    const orgRows = await sql`SELECT id FROM kernel.organizations LIMIT 1`
    const orgId = orgRows[0].id
    const serverURL = "https://gpu.internal.example/v1"
    const settings = {
      rateLimitPerMinute: 99,
      ai: {
        models: {
          disabled: ["some-model"],
          servers: [
            { id: "ab12cd34", name: "Lab", baseURL: serverURL, addedAt: "2026-10-22T00:00:00Z" },
          ],
          added: [
            {
              key: "custom/ab12cd34/llama",
              provider: "custom",
              upstreamId: "llama",
              serverId: "ab12cd34",
              displayName: "Llama",
              contextWindow: 32768,
              inputCostPerM: null,
              outputCostPerM: null,
              tools: true,
              reasoningEfforts: [],
              canDisableReasoning: false,
              enabled: true,
              addedAt: "2026-10-22T00:00:00Z",
            },
          ],
        },
      },
    }
    await sql`UPDATE kernel.organizations SET settings = ${JSON.stringify(settings)}::jsonb WHERE id = ${orgId}`

    const memberRes = await app.request("/api/org", {
      headers: { Authorization: `Bearer ${memberToken}` },
    })
    expect(memberRes.status).toBe(200)
    const memberText = await memberRes.text()
    expect(memberText).not.toContain("gpu.internal.example")
    expect(memberText).not.toContain("ab12cd34")
    const memberBody = JSON.parse(memberText)
    expect(memberBody.data.settings.ai?.models).toBeUndefined()
    expect(memberBody.data.settings.rateLimitPerMinute).toBe(99)

    const adminRes = await app.request("/api/org", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const adminBody = (await adminRes.json()) as any
    expect(adminBody.data.settings.ai.models.servers[0].baseURL).toBe(serverURL)
  })
})

// The Tickets settings page writes one field at a time through the kernel's app
// settings route, under each section's own scope (S17); PATCH /api/org keeps
// only the organization's own settings.
describe("Tickets settings through /api/apps/tickets/settings (S17)", () => {
  let kernelAdminToken: string
  let ticketsAdminToken: string
  let bothScopesToken: string
  let memberOnlyToken: string

  beforeAll(async () => {
    await acquireTestLock()

    const adminRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "org-scope-admin@test.com",
        password: "testpass123",
        name: "Admin",
      }),
    })
    const bootstrapAdminToken = ((await adminRes.json()) as any).data.accessToken

    const orgRows = await sql`SELECT id FROM kernel.organizations LIMIT 1`
    const orgId = orgRows[0].id
    const adminRows =
      await sql`SELECT id FROM kernel.users WHERE email = 'org-scope-admin@test.com' LIMIT 1`
    const adminId = adminRows[0].id

    async function bootstrapUserWithScopes(email: string, scopes: string[]): Promise<string> {
      const roleName = `phase9-role-${email}`
      const [r] = await sql`
        INSERT INTO kernel.roles (org_id, name) VALUES (${orgId}, ${roleName}) RETURNING id`
      const roleId = r.id
      for (const s of scopes) {
        await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${roleId}, ${s})`
      }
      const inviteRaw = generateToken()
      const inviteHash = hashToken(inviteRaw)
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      await sql`
        INSERT INTO kernel.invitations (org_id, email, role_id, token_hash, invited_by, expires_at)
        VALUES (${orgId}, ${email}, ${roleId}, ${inviteHash}, ${adminId}, ${expiresAt}::timestamptz)
      `
      const reg = await app.request("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteToken: inviteRaw, password: "testpass123", name: email }),
      })
      return ((await reg.json()) as any).data.accessToken
    }

    kernelAdminToken = await bootstrapUserWithScopes("kernel-admin-only@test.com", [
      "kernel:org:admin",
    ])
    ticketsAdminToken = await bootstrapUserWithScopes("tickets-admin-only@test.com", [
      "tickets:settings:admin",
    ])
    bothScopesToken = await bootstrapUserWithScopes("both-admin@test.com", [
      "kernel:org:admin",
      "tickets:settings:admin",
    ])
    memberOnlyToken = await bootstrapUserWithScopes("tickets-member-only@test.com", [
      "tickets:tickets:read",
    ])
    // Silence unused warning
    void bootstrapAdminToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  const call = (method: "GET" | "PATCH", scope: "org" | "user", token: string, body?: unknown) =>
    app.request(`/api/apps/tickets/settings/${scope}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  it("400 for a tickets key on PATCH /api/org, whatever the caller holds", async () => {
    const res = await app.request("/api/org", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bothScopesToken}` },
      body: JSON.stringify({ settings: { tickets: { sla: { targets: { urgent: 3600 } } } } }),
    })
    expect(res.status).toBe(400)
  })

  it("403 for a response-time target without tickets:settings:admin (member, org admin)", async () => {
    for (const t of [memberOnlyToken, kernelAdminToken]) {
      const res = await call("PATCH", "org", t, { path: "sla.targets.urgent", value: 1800 })
      expect(res.status).toBe(403)
    }
  })

  it("200 with tickets:settings:admin, the sibling targets kept, read back", async () => {
    const high = await call("PATCH", "org", ticketsAdminToken, {
      path: "sla.targets.high",
      value: 14400,
    })
    expect(high.status).toBe(200)
    const urgent = await call("PATCH", "org", ticketsAdminToken, {
      path: "sla.targets.urgent",
      value: 1800,
    })
    expect(urgent.status).toBe(200)
    const read = (await (await call("GET", "org", ticketsAdminToken)).json()) as any
    expect(read.data.values["sla.targets.urgent"]).toBe(1800)
    expect(read.data.values["sla.targets.high"]).toBe(14400)
    const org = (await (
      await app.request("/api/org", { headers: { Authorization: `Bearer ${ticketsAdminToken}` } })
    ).json()) as any
    expect(org.data.settings.tickets.sla.targets).toMatchObject({ urgent: 1800, high: 14400 })
    expect(org.data.settings.tickets.sla.businessHours.timezone).toBeTruthy()
  })

  it("422 for overlapping hours, a window ending before it starts, and a bad holiday date", async () => {
    const week = (mon: Array<[string, string]>) => ({
      mon,
      tue: [],
      wed: [],
      thu: [],
      fri: [["09:00", "17:00"]],
      sat: [],
      sun: [],
    })
    const overlap = await call("PATCH", "org", ticketsAdminToken, {
      path: "sla.businessHours.weekly",
      value: week([
        ["09:00", "12:00"],
        ["11:00", "13:00"],
      ]),
    })
    expect(overlap.status).toBe(422)
    const backwards = await call("PATCH", "org", ticketsAdminToken, {
      path: "sla.businessHours.weekly",
      value: week([["18:00", "09:00"]]),
    })
    expect(backwards.status).toBe(422)
    const badDate = await call("PATCH", "org", ticketsAdminToken, {
      path: "sla.businessHours.holidays",
      value: [{ date: "2026-02-30", label: "Nope" }],
    })
    expect(badDate.status).toBe(422)
    const zero = await call("PATCH", "org", ticketsAdminToken, {
      path: "sla.targets.low",
      value: 0,
    })
    expect(zero.status).toBe(422)
    const color = await call("PATCH", "org", ticketsAdminToken, {
      path: "emailTemplate.accentColor",
      value: "blue",
    })
    expect(color.status).toBe(422)
    const ok = await call("PATCH", "org", ticketsAdminToken, {
      path: "sla.businessHours.holidays",
      value: [{ date: "2026-12-25", label: "Christmas" }],
    })
    expect(ok.status).toBe(200)
  })

  it("approve replies from Home is written by its tool as the person (no approval for a person)", async () => {
    const read = (await (await call("GET", "org", ticketsAdminToken)).json()) as any
    expect(read.data.values.enabled).toBe(false)
    const res = await call("PATCH", "org", ticketsAdminToken, { path: "enabled", value: true })
    expect(res.status).toBe(200)
    const org = (await (
      await app.request("/api/org", { headers: { Authorization: `Bearer ${ticketsAdminToken}` } })
    ).json()) as any
    expect(org.data.settings.tickets.approveRepliesFromHome).toBe(true)
    const again = (await (await call("GET", "org", ticketsAdminToken)).json()) as any
    expect(again.data.values.enabled).toBe(true)
    expect(
      (await call("PATCH", "org", kernelAdminToken, { path: "enabled", value: false })).status,
    ).toBe(403)
  })

  it("a member saves their own reply signature; the html sibling is kept", async () => {
    const before = (await (await call("GET", "user", memberOnlyToken)).json()) as any
    expect(before.data.values["signature.text"]).toBeNull()
    await sql`
      UPDATE kernel.users
      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{tickets}',
                               '{"signature":{"html":"<p>Kept</p>"}}'::jsonb, true)
      WHERE email = 'tickets-member-only@test.com'`
    const res = await call("PATCH", "user", memberOnlyToken, {
      path: "signature.text",
      value: "Best,\nAlex",
    })
    expect(res.status).toBe(200)
    const [row] = await sql`
      SELECT settings->'tickets'->'signature' AS sig FROM kernel.users
      WHERE email = 'tickets-member-only@test.com'`
    expect(row.sig).toEqual({ html: "<p>Kept</p>", text: "Best,\nAlex" })
    expect(
      (
        await call("PATCH", "org", memberOnlyToken, {
          path: "emailTemplate.footerText",
          value: "x",
        })
      ).status,
    ).toBe(403)
  })
})

describe("PUT /api/org/settings/media-analysis (strict)", () => {
  let adminToken: string
  let memberToken2: string
  let orgId: string

  beforeAll(async () => {
    await acquireTestLock()
    const adminRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "media-admin@test.com", password: "testpass123", name: "MA" }),
    })
    adminToken = ((await adminRes.json()) as any).data.accessToken

    const orgRows = await sql`SELECT id FROM kernel.organizations LIMIT 1`
    orgId = orgRows[0].id
    const adminRows =
      await sql`SELECT id FROM kernel.users WHERE email = 'media-admin@test.com' LIMIT 1`
    const adminId = adminRows[0].id

    const [role] = await sql`
      INSERT INTO kernel.roles (org_id, name, description)
      VALUES (${orgId}, 'media-member', 'Non-admin') RETURNING id`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${role.id}, 'kernel:threads')`
    const inviteRaw = generateToken()
    const inviteHash = hashToken(inviteRaw)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    await sql`INSERT INTO kernel.invitations (org_id, email, role_id, token_hash, invited_by, expires_at)
      VALUES (${orgId}, 'media-member@test.com', ${role.id}, ${inviteHash}, ${adminId}, ${expiresAt}::timestamptz)`
    const reg = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteToken: inviteRaw, password: "testpass123", name: "MM" }),
    })
    memberToken2 = ((await reg.json()) as any).data.accessToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  function put(body: unknown, tok: string) {
    return app.request("/api/org/settings/media-analysis", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
      body: JSON.stringify(body),
    })
  }

  it("providerKeys SURVIVE a valid media-analysis PUT (jsonb_set keyed write)", async () => {
    // Seed a pre-existing providerKeys block.
    await sql`UPDATE kernel.organizations
      SET settings = '{"providerKeys":{"google":{"encrypted":"x"}}}'::jsonb WHERE id = ${orgId}`
    const res = await put(
      { tickets: { image: true, video: false }, mail: { image: false, video: false } },
      adminToken,
    )
    expect(res.status).toBe(200)
    // GET returns the four values.
    const getRes = await app.request("/api/org/settings/media-analysis", {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(getRes.status).toBe(200)
    const got = (await getRes.json()) as any
    expect(got.data).toEqual({
      tickets: { image: true, video: false },
      mail: { image: false, video: false },
    })
    // The DB holds both mediaAnalysis AND the untouched providerKeys.
    const [row] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${orgId}`
    expect(row.settings.mediaAnalysis).toEqual({
      tickets: { image: true, video: false },
      mail: { image: false, video: false },
    })
    expect(row.settings.providerKeys).toEqual({ google: { encrypted: "x" } })
  })

  it("rejects a body that smuggles providerKeys (strict validation 400)", async () => {
    await sql`UPDATE kernel.organizations
      SET settings = '{"providerKeys":{"google":{"encrypted":"keep"}}}'::jsonb WHERE id = ${orgId}`
    const res = await put(
      {
        tickets: { image: true, video: true },
        mail: { image: false, video: false },
        providerKeys: { google: { encrypted: "evil" } },
      },
      adminToken,
    )
    expect(res.status).toBe(400)
    const [row] = await sql`SELECT settings FROM kernel.organizations WHERE id = ${orgId}`
    expect(row.settings.providerKeys).toEqual({ google: { encrypted: "keep" } })
  })

  it("rejects a generic-extra key the generic settings schema would accept (rateLimitPerMinute)", async () => {
    const res = await put(
      {
        tickets: { image: true, video: true },
        mail: { image: false, video: false },
        rateLimitPerMinute: 321,
      },
      adminToken,
    )
    expect(res.status).toBe(400)
  })

  it("non-admin PUT → 403", async () => {
    const res = await put(
      { tickets: { image: true, video: true }, mail: { image: false, video: false } },
      memberToken2,
    )
    expect(res.status).toBe(403)
  })
})
