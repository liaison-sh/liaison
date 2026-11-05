// SPDX-License-Identifier: FSL-1.1-ALv2
//
// config_<section> tools: an agent's call parks for a person; the approved
// call acts as the APPROVER (their own scopes, checked per section before any
// provisioner runs); a direct call by a person holding the scopes runs at once;
// the approval binds the plan; one change per section at a time; every handler
// goes through the section runner only.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildRefToken, orgKernelSettingsSchema } from "@liaison/shared"
import { asSchema } from "ai"
import { and, eq } from "drizzle-orm"
import * as parse from "~/cli/config/parse"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { agents, organizations, roleScopeGrants, roles, userRoles } from "~/db/schema/kernel"
import * as eventBusModule from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { getOrgKernelSettings } from "~/lib/settings"
import { noChangeSentence, registerConfigTools } from "~/modules/agent/tools/config-tools"
import { decideApproval } from "~/modules/approvals/decide"
import { approvalSummarizerRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { enableApp } from "~/modules/apps/enabled-apps"
import { executeTool } from "~/modules/apps/execute-tool"
import { setOrgAppStatus } from "~/modules/apps/org-app-service"
import { getOrgAppState } from "~/modules/apps/org-apps"
import { setMailProviderEnabled } from "~/modules/mail/provider-settings"
import { checkRoleChangeKeepsAdmins } from "~/modules/provisioning/config-admin-guard"
import { withConfigLease } from "~/modules/provisioning/config-lease"
import { SECTION_BASE_SCOPE } from "~/modules/provisioning/config-section-scopes"
import {
  CONFIG_TOOL_SECTIONS,
  type ConfigToolSection,
  isConfigToolSection,
  parseSectionInput,
  SECTION_EXAMPLES,
  sectionJsonSchema,
} from "~/modules/provisioning/config-tool-input"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

// The Google client cards are asked only when no client exists, org or
// instance: these tests start without the instance's Workspace client, whatever
// the checkout's .env.test provides (connect.test.ts covers the instance one).
const instance = env as { GMAIL_OAUTH_CLIENT_ID?: string; GMAIL_OAUTH_CLIENT_SECRET?: string }
const savedInstance = [instance.GMAIL_OAUTH_CLIENT_ID, instance.GMAIL_OAUTH_CLIENT_SECRET] as const

let orgId: string
let adminId: string
let admin: UserContext
let threadId: string

beforeAll(async () => {
  await acquireTestLock()
  instance.GMAIL_OAUTH_CLIENT_ID = undefined
  instance.GMAIL_OAUTH_CLIENT_SECRET = undefined
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  adminId = a.userId
  admin = a.actor
  threadId = await minimal.thread(orgId, adminId)
  // The addresses these tests connect, as the person gave them (an address an
  // agent connects comes from the conversation: legal-identity-grounding.ts).
  await sql`INSERT INTO kernel.messages
    (thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${threadId}, ${orgId}, ${adminId}, 'user',
      'Our mailboxes: team@acme.example, shape@acme.example, m@acme.example, team@northwind.test', '{}')`
  registerConfigTools(orgId)
})
afterAll(async () => {
  instance.GMAIL_OAUTH_CLIENT_ID = savedInstance[0]
  instance.GMAIL_OAUTH_CLIENT_SECRET = savedInstance[1]
  broadcastSpy.mockRestore()
  await releaseTestLock()
})

type Handler = (params: unknown, ctx: unknown) => Promise<unknown>

function tool(section: string): { handler: Handler; preflight: Handler } {
  const def = toolRegistry.get([orgId, "kernel", `config_${section}`])
  if (!def || typeof def.handler !== "function" || typeof def.preflight !== "function") {
    throw new Error(`config_${section} not registered`)
  }
  return { handler: def.handler, preflight: def.preflight }
}

/** A member of the org holding exactly `scopes` (no role scopes). */
async function personWith(scopes: string[]): Promise<string> {
  const u = await minimal.person(orgId)
  await withSystemDb("test-strip-member", (db) =>
    db.delete(userRoles).where(eq(userRoles.userId, u.id)),
  )
  for (const s of scopes) await minimal.grantScope(u.id, s)
  return u.id
}

async function roleScopes(name: string): Promise<string[] | null> {
  return withSystemDb("test-role-scopes", async (db) => {
    const [r] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.name, name)))
      .limit(1)
    if (!r) return null
    const g = await db
      .select({ scope: roleScopeGrants.scope })
      .from(roleScopeGrants)
      .where(eq(roleScopeGrants.roleId, r.id))
    return g.map((x) => x.scope).sort()
  })
}

const propose = (section: ConfigToolSection, data: unknown) =>
  executeTool({
    toolName: `kernel:config_${section}`,
    orgId,
    actor: admin,
    params: { [section]: data },
    threadId,
    origin: "in-app-agent",
    stepBundleId: null,
  })

describe("config tools: the approval flow", () => {
  it("an agent's call parks as a pending approval and writes nothing", async () => {
    const res = await propose("roles", [{ name: "Parked", scopes: ["kernel:threads:read"] }])
    expect(res.blocked?.approvalRequestId).toMatch(/^[0-9a-f-]{36}$/)
    const lines = (res.blocked?.summary as { lines?: string[] } | undefined)?.lines ?? []
    expect(lines.join("\n")).toContain("create role 'Parked'")
    expect(await roleScopes("Parked")).toBeNull()
  })

  it("approved by a full admin, the rows are written", async () => {
    const res = await propose("roles", [{ name: "Approved", scopes: ["kernel:threads:read"] }])
    const approvalId = res.blocked?.approvalRequestId as string
    await decideApproval({
      orgId,
      requestId: approvalId,
      actor: { ...admin, scopes: ["*", "kernel:approve"] },
      decision: "approve",
    })
    expect(await roleScopes("Approved")).toEqual(["kernel:threads:read"])
  })

  it("approved by a person lacking the section scope: missing scope, nothing written", async () => {
    const approver = await personWith(["kernel:approve", "kernel:threads:read"])
    const res = await propose("roles", [{ name: "ByScopedApprover", scopes: [] }])
    const approvalId = res.blocked?.approvalRequestId as string
    // A refused execution is a failure the card shows, never "executed successfully".
    await expect(
      decideApproval({
        orgId,
        requestId: approvalId,
        actor: {
          actorType: "user",
          userId: approver,
          orgId,
          scopes: ["kernel:approve", "kernel:threads:read"],
          dimensionGrants: {},
        },
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "handler_failed", status: 422 })
    expect(await roleScopes("ByScopedApprover")).toBeNull()
  })

  it("a direct call by a person holding the scopes runs without an approval", async () => {
    const res = await executeTool({
      toolName: "kernel:config_roles",
      orgId,
      actor: admin,
      params: { roles: [{ name: "Direct", scopes: [] }] },
      origin: "human-ui",
      stepBundleId: null,
    })
    expect(res.blocked).toBeUndefined()
    expect(typeof res.data === "object" && res.data !== null && "error" in res.data).toBe(false)
    expect(await roleScopes("Direct")).toEqual([])
  })
})

describe("config tools: a pending secret names the request_secret call that fills it", () => {
  it("an API connection saved without credentials hands back the card's exact call", async () => {
    const res = await executeTool({
      toolName: "kernel:config_apiConnectors",
      orgId,
      actor: admin,
      params: {
        apiConnectors: [
          {
            identifier: "pending-crm",
            adapter: {
              id: "pending-crm",
              name: "Pending CRM",
              version: "1",
              baseUrl: "https://crm.example.com",
              auth: { type: "bearer" },
              operations: [
                {
                  name: "list_companies",
                  description: "Companies.",
                  kind: "read",
                  method: "GET",
                  path: "/companies",
                  params: { type: "object", properties: {} },
                  fields: ["id", "name"],
                },
              ],
            },
          },
        ],
      },
      origin: "human-ui",
      stepBundleId: null,
    })
    const data = res.data as { pending?: Array<Record<string, unknown>>; next?: string }
    const item = data.pending?.find((p) => p.identifier === "pending-crm")
    expect(item?.askWith).toEqual({
      tool: "kernel__request_secret",
      params: { kind: "api_connector_credentials", target: { identifier: "pending-crm" } },
    })
    expect(data.next).toContain("askWith")
  })

  it("a Gmail mailbox asks for the Google client, then for the consent: two cards, no CLI", async () => {
    const res = await executeTool({
      toolName: "kernel:config_mail",
      orgId,
      actor: admin,
      params: { mail: { mailboxes: [{ address: "team@northwind.test", provider: "gmail" }] } },
      origin: "human-ui",
      stepBundleId: null,
    })
    const data = res.data as { pending?: Array<Record<string, unknown>>; next?: string }
    const cards = (data.pending ?? []).filter((p) => "askWith" in p).map((p) => p.askWith)
    expect(cards).toEqual([
      {
        tool: "kernel__request_secret",
        params: { kind: "google_integration_client", target: {} },
      },
      {
        tool: "kernel__request_secret",
        params: {
          kind: "oauth_connect",
          target: { app: "mail", connection: "gmail", mode: "org" },
        },
      },
    ])
    expect(JSON.stringify(data)).not.toContain("liaison connect")
    expect(JSON.stringify(data)).not.toMatch(/from Settings/i)
    expect(data.next).toContain("signs in at the provider")
  })
})

describe("config tools: pending OAuth items become cards", () => {
  it("the client card comes first only when the connection has no client, asked once", async () => {
    const { pendingWithCards } = await import("~/modules/secret-requests/pending-cards")
    const { saveGoogleIntegrationConfig } = await import("~/modules/settings/google-integration")
    const items = [
      {
        kind: "oauth" as const,
        app: "tickets",
        connection: "gmail",
        action: "liaison connect tickets/gmail",
      },
      { kind: "oauth" as const, app: "calendar", connection: "google-calendar", action: "connect" },
      { kind: "source" as const, app: "knowledge", action: "register the source" },
    ]
    const before = await pendingWithCards(orgId, items)
    expect(before.map((p) => ("askWith" in p ? p.askWith.params.kind : p.kind))).toEqual([
      "google_integration_client",
      "oauth_connect",
      "oauth_connect",
      "source",
    ])
    expect(JSON.stringify(before)).not.toContain("liaison connect")
    await saveGoogleIntegrationConfig(orgId, {
      clientId: "5555-config.apps.googleusercontent.com",
      clientSecret: `GOCSPX-${crypto.randomUUID()}`,
    })
    const after = await pendingWithCards(orgId, items)
    expect(after.map((p) => ("askWith" in p ? p.askWith.params.kind : p.kind))).toEqual([
      "oauth_connect",
      "oauth_connect",
      "source",
    ])
  })
})

describe("config tools: a mailbox is never reported live on saved credentials", () => {
  it("a mailbox whose password is saved reads: credentials saved; first sync pending", async () => {
    const address = `synced-later-${Date.now()}@northwind.test`
    await withSystemDb("test-mail-imap-connection", (tx) =>
      createCredentialConnection(tx as never, orgId, adminId, "mail", "imap", {
        identifier: address,
        credentials: {
          email: address,
          imapHost: "imap.northwind.test",
          imapPort: "993",
          smtpHost: "smtp.northwind.test",
          smtpPort: "465",
          username: address,
          password: "not-a-real-password",
        },
        ownerType: "org",
      }),
    )
    const res = await executeTool({
      toolName: "kernel:config_mail",
      orgId,
      actor: admin,
      params: {
        mail: {
          mailboxes: [
            {
              address,
              provider: "imap",
              imap: {
                email: address,
                imapHost: "imap.northwind.test",
                imapPort: 993,
                smtpHost: "smtp.northwind.test",
                smtpPort: 465,
                username: address,
              },
            },
          ],
        },
      },
      origin: "human-ui",
      stepBundleId: null,
    })
    const data = res.data as { state?: string }
    expect(data.state).toContain("credentials saved; first sync pending")
    expect(data.state).toContain("never call a mailbox connected or live")
  })
})

describe("config tools: the approver's scopes, per section", () => {
  const rows: Array<{ section: ConfigToolSection; data: unknown; scope: string }> = [
    { section: "roles", data: [{ name: "M", scopes: [] }], scope: "kernel:roles:admin" },
    { section: "email", data: { from: "m@acme.example" }, scope: "kernel:org:admin" },
    {
      section: "users",
      data: [{ email: "m@acme.example", name: "M", role: "member" }],
      scope: "kernel:users:admin",
    },
    {
      section: "mail",
      data: {
        mailboxes: [
          {
            address: "m@acme.example",
            provider: "imap",
            imap: {
              email: "m@acme.example",
              imapHost: "imap.acme.example",
              imapPort: 993,
              smtpHost: "smtp.acme.example",
              smtpPort: 587,
              username: "m@acme.example",
            },
          },
        ],
      },
      scope: "mail:accounts:admin",
    },
    { section: "tickets", data: { approveRepliesFromHome: true }, scope: "tickets:settings:admin" },
    { section: "apps", data: [{ name: "projects", enable: true }], scope: "kernel:apps:admin" },
    {
      section: "apiConnectors",
      data: [{ identifier: "crm", adapter: {} }],
      scope: "api-connector:admin",
    },
    {
      section: "knowledge",
      data: { collections: [{ name: "M" }] },
      scope: "knowledge:collections:manage",
    },
    { section: "agents", data: [{ handle: "@m", displayName: "M" }], scope: "kernel:agents:admin" },
    {
      section: "invoicing",
      data: { hsCodes: [{ code: "9207" }] },
      scope: "invoicing:settings:write",
    },
  ]
  for (const row of rows) {
    it(`${row.section}: refused without ${row.scope}`, async () => {
      const approver = await personWith(["kernel:approve"])
      const before = await getEmailFrom()
      const out = (await tool(row.section).handler(
        { [row.section]: row.data, planHash: "approved-hash" },
        { orgId, userId: adminId, approverUserId: approver, scopes: ["*"] },
      )) as { error?: string }
      expect(out.error).toContain("missing scope")
      expect(out.error).toContain(row.scope)
      expect(await getEmailFrom()).toBe(before)
      expect(await roleScopes("M")).toBeNull()
    })
  }

  it("roles: a scope the change would revoke and the approver lacks is refused before any write", async () => {
    const seeded = [{ name: "Revocable", scopes: ["kernel:contacts:read", "shopify:orders:admin"] }]
    await tool("roles").handler(
      { roles: seeded, ...(await pinned("roles", seeded)) },
      { orgId, userId: adminId, approverUserId: adminId },
    )
    const approver = await personWith([
      "kernel:roles:admin",
      "kernel:approve",
      "kernel:contacts:read",
    ])
    const data = [
      { name: "Early", scopes: [] },
      { name: "Revocable", scopes: ["kernel:contacts:read"] },
    ]
    const out = (await tool("roles").handler(
      { roles: data, ...(await pinned("roles", data)) },
      { orgId, userId: adminId, approverUserId: approver },
    )) as { error?: string }
    expect(out.error).toMatch(/missing scope: shopify:orders:admin/)
    expect(await roleScopes("Revocable")).toEqual(["kernel:contacts:read", "shopify:orders:admin"])
    expect(await roleScopes("Early")).toBeNull()
  })

  it("agents: an approver without invoicing scopes cannot give an agent invoicing scopes", async () => {
    const approver = await personWith(["kernel:agents:admin", "kernel:approve"])
    const data = [
      { handle: "@billing", displayName: "Billing", scopes: ["invoicing:documents:read"] },
    ]
    const out = (await tool("agents").handler(
      { agents: data, planHash: "approved-hash" },
      { orgId, userId: adminId, approverUserId: approver, scopes: ["*"] },
    )) as { error?: string }
    expect(out.error).toMatch(
      /cannot give an agent scopes you do not hold.*invoicing:documents:read/,
    )
    const [row] = await withSystemDb("test-agent", (db) =>
      db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.orgId, orgId), eq(agents.handle, "@billing"))),
    )
    expect(row).toBeUndefined()
  })
})

async function getEmailFrom(): Promise<string | undefined> {
  const s = await withSystemDb("test-email", (db) =>
    getOrgKernelSettings(db, orgId, orgKernelSettingsSchema),
  )
  return s.email?.from
}

describe("config tools: a reference to an earlier step never stages", () => {
  it("a call carrying an @ref with a spoofed plan is refused, and member never gets *", async () => {
    const before = await roleScopes("member")
    const spoof = await pinned("roles", [{ name: "member", scopes: before ?? [] }])
    const res = await executeTool({
      toolName: "kernel:config_roles",
      orgId,
      actor: admin,
      params: {
        roles: [
          {
            name: "member",
            description: buildRefToken(crypto.randomUUID(), "role_id"),
            scopes: ["*"],
          },
        ],
        planHash: spoof.planHash,
      },
      threadId,
      origin: "in-app-agent",
      stepBundleId: null,
    })
    expect(res.blocked).toBeUndefined()
    const refusal = JSON.stringify(res.data)
    expect(refusal).toMatch(/reference to an earlier step/)
    expect(await roleScopes("member")).toEqual(before)
    expect(await roleScopes("member")).not.toContain("*")
  })

  it("a spoofed planLines param is refused; the card's lines come from the data", async () => {
    await expect(
      executeTool({
        toolName: "kernel:config_roles",
        orgId,
        actor: admin,
        params: {
          roles: [{ name: "CardFromData", scopes: ["kernel:threads:read"] }],
          planLines: ["role 'CardFromData' unchanged"],
        },
        threadId,
        origin: "in-app-agent",
        stepBundleId: null,
      }),
    ).rejects.toThrow(/planLines/)
    const res = await propose("roles", [{ name: "CardFromData", scopes: ["kernel:threads:read"] }])
    const lines = (res.blocked?.summary as { lines?: string[] } | undefined)?.lines ?? []
    expect(lines.join("\n")).toContain("create role 'CardFromData'")
  })
})

describe("config tools: the approval binds the plan", () => {
  it("a call without an approved plan is refused", async () => {
    const out = (await tool("roles").handler(
      { roles: [{ name: "NoHash", scopes: [] }] },
      { orgId, userId: adminId, approverUserId: adminId },
    )) as { error?: { code?: string; message?: string; final?: boolean } }
    expect(out.error?.message).toMatch(/no approved plan/)
    // Re-approving the same call can never pass: final, so the card closes.
    expect(out.error?.final).toBe(true)
    expect(await roleScopes("NoHash")).toBeNull()
  })

  it("a concurrent edit after approval refuses with the new plan", async () => {
    const data = [{ name: "Drift", scopes: ["kernel:threads:read"] }]
    await tool("roles").handler(
      {
        roles: [{ name: "Drift", scopes: [] }],
        ...(await pinned("roles", [{ name: "Drift", scopes: [] }])),
      },
      { orgId, userId: adminId, approverUserId: adminId },
    )
    const approved = await pinned("roles", data)
    // Someone grants the scope in Settings between the approval and the run.
    await withSystemDb("test-drift", async (db) => {
      const [r] = await db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), eq(roles.name, "Drift")))
      if (!r) throw new Error("no role")
      await db.insert(roleScopeGrants).values({ roleId: r.id, scope: "kernel:threads:read" })
    })
    const out = (await tool("roles").handler(
      { roles: data, ...approved },
      { orgId, userId: adminId, approverUserId: adminId },
    )) as {
      error?: { code?: string; message?: string; final?: boolean; body?: { plan?: string[] } }
    }
    expect(out.error?.code).toBe("plan_changed")
    expect(out.error?.message).toMatch(/the plan changed since approval; propose again/)
    expect(out.error?.final).toBe(true)
    expect(out.error?.body?.plan).toEqual(["role 'Drift' unchanged"])
  })

  it("a second change to the same section while one runs is refused", async () => {
    const data = [{ name: "Leased", scopes: [] }]
    const approved = await pinned("roles", data)
    const out = await withConfigLease(orgId, "roles", () =>
      tool("roles").handler(
        { roles: data, ...approved },
        { orgId, userId: adminId, approverUserId: adminId },
      ),
    )
    expect((out as { error?: string }).error).toMatch(/another change to roles is running/)
    expect(await roleScopes("Leased")).toBeNull()
  })
})

async function pinned(section: ConfigToolSection, data: unknown) {
  const r = (await tool(section).preflight(
    { [section]: data },
    { orgId, userId: adminId, scopes: admin.scopes, dimensionGrants: admin.dimensionGrants },
  )) as { ok?: boolean; pinnedParams?: { planHash: string } }
  if (!r.pinnedParams) throw new Error(`preflight refused: ${JSON.stringify(r)}`)
  return r.pinnedParams
}

describe("config tools: the org stays administrable", () => {
  // Runs first in this block: here the bootstrap admin (the "admin" role, "*")
  // is the only holder of kernel:org:admin.
  it("stripping the admin role is refused before any write: the approver must hold what it revokes", async () => {
    const approver = await personWith(["kernel:roles:admin", "kernel:approve"])
    const data = [{ name: "admin", scopes: ["kernel:roles:admin"] }]
    const out = (await tool("roles").handler(
      { roles: data, ...(await pinned("roles", data)) },
      { orgId, userId: adminId, approverUserId: approver },
    )) as { error?: string }
    expect(out.error).toMatch(/missing scope: \*/)
    expect(await roleScopes("admin")).toContain("*")
  })

  it("the lock-out guard refuses a change that leaves nobody holding kernel:org:admin", async () => {
    // Unreachable through the tool now that revoked scopes are required of the
    // approver (they keep what they hold directly); the guard stays as defence
    // in depth and is checked on its own here.
    const approver = await personWith(["kernel:roles:admin"])
    expect(
      await checkRoleChangeKeepsAdmins(orgId, approver, [
        { name: "admin", scopes: ["kernel:roles:admin"] },
      ]),
    ).toMatch(/leaves the organization with nobody holding kernel:org:admin/)
  })

  it("the lock-out guard runs inside the section's lease", async () => {
    const approver = await personWith(["kernel:roles:admin", "kernel:approve"])
    const data = [{ name: "LeaseProbe", scopes: [] }]
    const approved = await pinned("roles", data)
    const out = await withConfigLease(orgId, "roles", () =>
      tool("roles").handler(
        { roles: data, ...approved },
        { orgId, userId: adminId, approverUserId: approver },
      ),
    )
    expect((out as { error?: string }).error).toMatch(/another change to roles is running/)
    expect(await roleScopes("LeaseProbe")).toBeNull()
  })

  it("the approver cannot remove kernel:org:admin from themself", async () => {
    const approver = await personWith([])
    await withSystemDb("test-self-role", async (db) => {
      const [r] = await db
        .insert(roles)
        .values({ orgId, name: "SelfAdmins" })
        .returning({ id: roles.id })
      if (!r) throw new Error("no role")
      for (const scope of ["kernel:roles:admin", "kernel:org:admin", "kernel:approve"]) {
        await db.insert(roleScopeGrants).values({ roleId: r.id, scope })
      }
      await db.insert(userRoles).values({ userId: approver, roleId: r.id, orgId })
    })
    const data = [{ name: "SelfAdmins", scopes: ["kernel:roles:admin", "kernel:approve"] }]
    const out = (await tool("roles").handler(
      { roles: data, ...(await pinned("roles", data)) },
      { orgId, userId: adminId, approverUserId: approver },
    )) as { error?: string }
    expect(out.error).toMatch(/removes kernel:org:admin from you/)
    expect(await roleScopes("SelfAdmins")).toContain("kernel:org:admin")
  })
})

describe("config tools: a weak model learns the shape", () => {
  const imap = {
    email: "shape@acme.example",
    imapHost: "imap.acme.example",
    imapPort: 993,
    smtpHost: "smtp.acme.example",
    smtpPort: 465,
    username: "shape@acme.example",
  }

  it("the model-facing schema carries each section's keys and entry shapes", () => {
    const def = toolRegistry.get([orgId, "kernel", "config_mail"])
    const json = asSchema(def?.params as never).jsonSchema as {
      properties: { mail: { properties?: Record<string, { items?: { properties?: object } }> } }
    }
    const mailboxes = json.properties.mail.properties?.mailboxes
    expect(Object.keys(mailboxes?.items?.properties ?? {})).toEqual(
      expect.arrayContaining(["address", "provider", "imap"]),
    )
    for (const section of CONFIG_TOOL_SECTIONS) {
      expect(JSON.stringify(sectionJsonSchema(section))).not.toContain("$ref")
    }
  })

  it("every section's example is valid input", () => {
    for (const section of CONFIG_TOOL_SECTIONS) {
      const parsed = parseSectionInput(section, SECTION_EXAMPLES[section], {
        slug: "acme",
        name: "Acme",
      })
      expect({ section, ok: parsed.ok }).toEqual({ section, ok: true })
    }
  })

  it("mail.accounts is refused as a retryable 400 naming mailboxes; mail.mailboxes then parks", async () => {
    const wrong = { accounts: [{ address: "shape@acme.example", provider: "imap", imap }] }
    let refused: { status?: number; code?: string; message?: string; details?: unknown } = {}
    try {
      await propose("mail", wrong)
    } catch (err) {
      refused = err as typeof refused
    }
    expect(refused.status).toBe(400)
    expect(refused.code).toBe("invalid_config")
    expect(refused.details).toEqual({ retryable: true })
    expect(refused.message).toContain("accounts")
    expect(refused.message).toContain("mailboxes?: [{ address: string")
    expect(refused.message).toContain('Example: {"mail":{"mailboxes":[')

    const res = await propose("mail", {
      mailboxes: [{ address: "shape@acme.example", provider: "imap", imap }],
    })
    expect(res.blocked?.approvalRequestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("config_apps refuses an app that is neither installed nor in the catalog (no false success)", async () => {
    let refused: { status?: number; code?: string; message?: string } = {}
    try {
      await propose("apps", [{ name: "no-such-app", enable: true }])
    } catch (err) {
      refused = err as typeof refused
    }
    expect(refused.status).toBe(400)
    expect(refused.code).toBe("invalid_config")
    expect(refused.message).toContain("no app 'no-such-app' is installed or in the catalog")
  })

  it("a client id that is not a Google one (another app's) is refused before any card, with its own code", async () => {
    for (const section of ["mail", "tickets"] as const) {
      const entry = {
        address: "team@acme.example",
        provider: "gmail",
        google: { clientId: "0f3c5e1d2b4a69788a7d6c5b4a392817" },
      }
      let refused: { status?: number; code?: string; message?: string; details?: unknown } = {}
      try {
        await propose(section, section === "mail" ? { mailboxes: [entry] } : { inboxes: [entry] })
      } catch (err) {
        refused = err as typeof refused
      }
      expect(refused.status).toBe(400)
      expect(refused.code).toBe("invalid_google_client_id")
      expect(refused.details).toEqual({ retryable: false })
      expect(refused.message).toContain(".apps.googleusercontent.com")
      expect(refused.message).toContain("Nothing was saved")
      expect(refused.message).toContain("google_integration_client")
    }
  })

  it("the approval card shows the Google client ID being set, never a secret", async () => {
    const clientId = "1234-shown.apps.googleusercontent.com"
    const summarize = approvalSummarizerRegistry.get([orgId, "kernel", "config_mail"])
    if (!summarize) throw new Error("config_mail summarizer not registered")
    const card = await withRlsContext(admin, (tx) =>
      summarize(
        {
          mail: {
            mailboxes: [{ address: "team@acme.example", provider: "gmail", google: { clientId } }],
          },
        },
        { tx, orgId, userId: adminId },
      ),
    )
    if (!card || !("lines" in card)) throw new Error("config_mail card has no lines")
    expect(card.lines.join("\n")).toContain(`Google client ID ${clientId}`)
    expect(card.lines.join("\n")).not.toMatch(/secret/i)
  })

  it("a secret field keeps its own refusal, as a retryable 400", async () => {
    let refused: { status?: number; message?: string } = {}
    try {
      await propose("mail", {
        mailboxes: [
          { address: "shape@acme.example", provider: "imap", imap: { ...imap, password: "x" } },
        ],
      })
    } catch (err) {
      refused = err as typeof refused
    }
    expect(refused.status).toBe(400)
    expect(refused.message).toContain("mail.mailboxes[0].imap.password is a secret")
  })
})

// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} config reference, never a JS template.
const ENV_REF = "${HOME}"

describe("config tools: a change that changes nothing (walk N35)", () => {
  const enabledApps = async () =>
    withSystemDb("test-enabled-apps", async (db) => {
      const [row] = await db
        .select({ settings: organizations.settings })
        .from(organizations)
        .where(eq(organizations.id, orgId))
      const list = (row?.settings as { enabledApps?: unknown } | undefined)?.enabledApps
      return Array.isArray(list) ? list : []
    })

  it("enabling an app already on answers at once: no card, changed false, a plain note", async () => {
    // On for everyone, but missing from the curation list (an org set up elsewhere).
    await sql`UPDATE kernel.organizations
      SET settings = jsonb_set(settings, '{enabledApps}',
        coalesce(settings -> 'enabledApps', '[]'::jsonb) - 'tickets')
      WHERE id = ${orgId}`
    const res = await propose("apps", [{ name: "tickets", enable: true }])
    expect(res.blocked).toBeUndefined()
    const data = res.data as {
      changed?: boolean
      note?: string
      plan?: string[]
      tellThePerson?: string
      next?: string
    }
    expect(data.changed).toBe(false)
    expect(data.note).toContain("Nothing changes")
    expect(data.note).toContain("never tell the person it is now enabled")
    expect(data.plan).toEqual(["app 'tickets' unchanged"])
    // Walk N44: the result leads with the sentence for the person, and its only
    // next step is that reply: no card, no other tool, no export to go digging in.
    expect(Object.keys(res.data as object)[0]).toBe("tellThePerson")
    expect(data.tellThePerson).toBe("Tickets is already on. Nothing to change.")
    expect(data.next).toBe(
      "Reply to the person with tellThePerson. Nothing else is needed for this request.",
    )
    expect(data.note).toContain("post no card")
    expect(data.note).toContain("as a question")
    expect(data.note).not.toContain("config_export")
    // Recorded in the curation list, which nobody sees.
    expect(await enabledApps()).toContain("tickets")
  })

  it("an app already on with a connection not made yet: the no-op names no card, only the reply", async () => {
    // Mail is on and its Gmail is not connected in this org: still no Connect card.
    const res = await propose("apps", [{ name: "mail", enable: true }])
    expect(res.blocked).toBeUndefined()
    const data = res.data as { changed?: boolean; tellThePerson?: string; next?: string }
    expect(data.changed).toBe(false)
    expect(data.tellThePerson).toBe("Mail is already on. Nothing to change.")
    expect(data.next).not.toMatch(/request_secret|oauth_connect|card|config_export/)
  })

  it("an identical config_users call answers at once with no card", async () => {
    const member = await minimal.person(orgId)
    const res = await propose("users", [
      { email: member.email, name: "Member", role: "member", mode: "invite" },
    ])
    expect(res.blocked).toBeUndefined()
    const data = res.data as { changed?: boolean; plan?: string[]; tellThePerson?: string }
    expect(data.changed).toBe(false)
    expect(data.plan).toEqual([`user '${member.email}' role member unchanged`])
    expect(data.tellThePerson).toBe(
      "People invited to the org already are as asked. Nothing to change.",
    )
  })

  it("the no-op sentence says which way an app already is, or that a section is as asked", () => {
    expect(
      noChangeSentence("apps", {
        org: { slug: "x", name: "X" },
        apps: [
          { name: "projects", enable: false },
          { name: "google-drive", enable: true },
        ],
      }),
    ).toBe("Projects is already off; Google drive is already on. Nothing to change.")
    expect(noChangeSentence("roles", { org: { slug: "x", name: "X" } })).toBe(
      "Roles and their scopes already are as asked. Nothing to change.",
    )
  })

  it("a mixed call's card shows only the real change; the result says per app what changed", async () => {
    await setMailProviderEnabled(orgId, "gmail", true)
    const data = [
      { name: "tickets", enable: true },
      { name: "mail", enable: true, providers: { gmail: { enabled: false } } },
    ]
    const res = await propose("apps", data)
    const lines = (res.blocked?.summary as { lines?: string[] } | undefined)?.lines ?? []
    expect(lines).toEqual(["disable mail provider 'gmail'"])

    const out = (await tool("apps").handler(
      { apps: data, ...(await pinned("apps", data)) },
      { orgId, userId: adminId, approverUserId: adminId },
    )) as {
      changed: string[]
      result: { apps: Array<{ name: string; changed: string[] }> }
      note?: string
    }
    expect(out.changed).toEqual(["apps.mail.providers.gmail.enabled"])
    expect(out.result.apps.map((a) => [a.name, a.changed])).toEqual([
      ["tickets", []],
      ["mail", ["providers.gmail.enabled"]],
    ])
    expect(out.note).toBeUndefined()

    // Executed again (the state already reached): nothing changed, said in words.
    const again = (await tool("apps").handler(
      { apps: data, ...(await pinned("apps", data)) },
      { orgId, userId: adminId, approverUserId: adminId },
    )) as { changed: string[]; note?: string }
    expect(again.changed).toEqual([])
    expect(again.note).toContain("Nothing changed")
  })
})

describe("config tools: an app turned Off is a real change (walk N35 review)", () => {
  const status = async () => (await getOrgAppState(orgId, "projects"))?.status

  it("Off and still listed: the card says turn on, and approving really turns it on", async () => {
    await enableApp(orgId, "projects")
    await setOrgAppStatus(orgId, "projects", "disabled")
    try {
      const data = [{ name: "projects", enable: true }]
      const res = await propose("apps", data)
      expect(res.blocked).toBeDefined()
      const lines = (res.blocked?.summary as { lines?: string[] } | undefined)?.lines ?? []
      expect(lines).toEqual(["turn on app 'projects' (now off)"])
      const out = (await tool("apps").handler(
        { apps: data, ...(await pinned("apps", data)) },
        { orgId, userId: adminId, approverUserId: adminId },
      )) as { changed: string[]; result: { apps: Array<{ name: string; enabled: boolean }> } }
      expect(await status()).toBe("active")
      expect(out.changed).toContain("apps.projects.enabled")
      expect(out.result.apps).toMatchObject([{ name: "projects", enabled: true }])
    } finally {
      await setOrgAppStatus(orgId, "projects", "active")
    }
  })

  it("Off and not listed: the same, never an append that leaves it Off", async () => {
    await setOrgAppStatus(orgId, "projects", "disabled")
    await sql`UPDATE kernel.organizations
      SET settings = jsonb_set(settings, '{enabledApps}',
        coalesce(settings -> 'enabledApps', '[]'::jsonb) - 'projects')
      WHERE id = ${orgId}`
    try {
      const data = [{ name: "projects", enable: true }]
      const res = await propose("apps", data)
      const lines = (res.blocked?.summary as { lines?: string[] } | undefined)?.lines ?? []
      expect(lines).toEqual(["turn on app 'projects' (now off)"])
      await tool("apps").handler(
        { apps: data, ...(await pinned("apps", data)) },
        { orgId, userId: adminId, approverUserId: adminId },
      )
      expect(await status()).toBe("active")
    } finally {
      await setOrgAppStatus(orgId, "projects", "active")
    }
  })
})

describe("config tools: liaisonTeam", () => {
  // Discriminator: a tool that applies at once, or is scoped wider than the
  // Settings route (kernel:org:admin), fails.
  it("config_liaisonTeam is gated and scoped kernel:org:admin", async () => {
    const def = toolRegistry.get([orgId, "kernel", "config_liaisonTeam"])
    expect(def?.gated).toBe(true)
    expect(def?.noAutoApprove).toBe(true)
    expect(def?.deferLoading).toBe(true)
    expect(def?.requiredScopes).toEqual(["kernel:org:admin"])
    expect(SECTION_BASE_SCOPE.liaisonTeam).toBe("kernel:org:admin")
    const res = await propose("liaisonTeam", { register: false, forwardBugReports: false })
    expect(res.blocked?.approvalRequestId).toMatch(/^[0-9a-f-]{36}$/)
    const lines = (res.blocked?.summary as { lines?: string[] } | undefined)?.lines ?? []
    expect(lines.join("\n")).toContain("share with the Liaison team")
  })

  it("forwarding without registration is refused before an approval is staged", async () => {
    let refused: { status?: number; code?: string; message?: string } = {}
    try {
      await propose("liaisonTeam", { forwardBugReports: true })
    } catch (err) {
      refused = err as typeof refused
    }
    expect(refused.status).toBe(400)
    expect(refused.code).toBe("invalid_config")
    expect(refused.message).toContain("turn on registration with the Liaison team")
  })
})

describe("config tools: one code path", () => {
  it("every config tool is deferred and described in at most 240 characters", () => {
    for (const [[o, app, name], def] of toolRegistry.entries()) {
      if (o !== orgId || app !== "kernel" || !name.startsWith("config_")) continue
      expect(def.deferLoading).toBe(true)
      expect(def.description.length).toBeLessThanOrEqual(240)
      const section = name.slice("config_".length)
      if (isConfigToolSection(section)) {
        expect(def.requiredScopes).toEqual([SECTION_BASE_SCOPE[section]])
      }
      if (def.gated) expect(def.noAutoApprove).toBe(true)
    }
  })

  it("every config_<section> handler is the same runner-only body", () => {
    const sources = new Set<string>()
    for (const section of [
      "roles",
      "email",
      "users",
      "mail",
      "tickets",
      "apps",
      "apiConnectors",
      "knowledge",
      "agents",
      "invoicing",
      "liaisonTeam",
    ]) {
      sources.add(tool(section).handler.toString())
    }
    expect(sources.size).toBe(1)
    const body = [...sources][0] ?? ""
    expect(body).toContain("applySections(")
    expect(body).toContain("planSections(")
    expect(body).not.toMatch(/Provisioner|\.apply\(pctx/)
  })

  it("config-tools.ts imports no provisioner directly", () => {
    const src = readFileSync(join(import.meta.dir, "config-tools.ts"), "utf8")
    expect(src).not.toMatch(/from "~\/cli\/provisioners\//)
  })

  it("the tool path never parses a config file nor interpolates the environment", async () => {
    const parseSpy = spyOn(parse, "parseConfigFile")
    const interpolateSpy = spyOn(parse, "interpolateEnv")
    try {
      const data = [{ name: `NoEnv ${ENV_REF}`, scopes: [] }]
      const approved = await pinned("roles", data)
      await tool("roles").handler(
        { roles: data, ...approved },
        { orgId, userId: adminId, approverUserId: adminId },
      )
      expect(await roleScopes(`NoEnv ${ENV_REF}`)).toEqual([])
      expect(parseSpy).not.toHaveBeenCalled()
      expect(interpolateSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
      interpolateSpy.mockRestore()
    }
  })
})
