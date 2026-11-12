// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S2 parity: the same section data applied through `liaison config apply` on
// one org and through the agent's config tool (approved by a full admin) on
// another yields the same rows. A tool that re-implemented a provisioner, or
// skipped it, diverges here. The fixtures carry no secrets (the tool path
// never takes one) and no server files.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { orgKernelSettingsSchema } from "@liaison/shared"
import { and, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import { runConfigApply } from "~/cli/config/apply"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { agents, organizations, roleScopeGrants, roles } from "~/db/schema/kernel"
import { getOrgKernelSettings } from "~/lib/settings"
import { registerConfigTools } from "~/modules/agent/tools/config-tools"
import { canonicalJson, readAppConfig } from "~/modules/apps/app-config"
import { toolRegistry } from "~/modules/apps/app-registries"
import { getAdapterRow } from "~/modules/apps/connections/api/store"
import { getEnabledApps } from "~/modules/apps/enabled-apps"
import { CANONICAL_ORDER } from "~/modules/provisioning/config-sections"
import { CONFIG_TOOL_SECTIONS } from "~/modules/provisioning/config-tool-input"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const INLINE_ADAPTER = {
  id: "crm",
  name: "Fixture CRM",
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
}

/** One fixture per section the tool path can take as-is. */
const FIXTURES: Omit<ProvisioningConfig, "org" | "admin"> = {
  roles: [
    {
      name: "Support",
      description: "Desk",
      scopes: ["kernel:threads:read", "kernel:contacts:read"],
    },
  ],
  email: { from: "Acme <hello@acme.example>", replyTo: "help@acme.example" },
  users: [
    { email: "parity-invitee@acme.example", name: "Invitee", role: "member", mode: "invite" },
  ],
  tickets: { approveRepliesFromHome: true },
  apps: [{ name: "projects", enable: true }],
  apiConnectors: [{ identifier: "crm", adapter: INLINE_ADAPTER }],
  knowledge: {
    collections: [{ name: "Policies" }],
    documents: [
      { title: "Returns", collection: "Policies", content: "# Returns\nWithin 30 days." },
    ],
  },
  agents: [
    {
      handle: "@support",
      displayName: "Support",
      purpose: "Answers tickets",
      systemPrompt: "Be brief.",
      scopes: ["kernel:contacts:read"],
    },
  ],
}

let cliOrg: string
let toolOrg: string
let toolAdmin: string

beforeAll(async () => {
  await acquireTestLock()
  // CLI path: one config file with every fixture section, on a new org.
  const slug = `parity-cli-${crypto.randomUUID().slice(0, 8)}`
  const config: ProvisioningConfig = {
    org: { slug, name: "Parity CLI" },
    admin: { email: `owner-${crypto.randomUUID().slice(0, 8)}@acme.example`, name: "Owner" },
    ...FIXTURES,
  }
  const { exitCode } = await runConfigApply({
    config,
    format: "json",
    dryRun: false,
    validateByok: false,
    echoSupplied: false,
    log: () => {},
  })
  expect(exitCode).toBe(0)
  const [org] = await withSystemDb("t", (db) =>
    db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)),
  )
  if (!org) throw new Error("cli org missing")
  cliOrg = org.id

  // Tool path: each section through its config tool, approved by a full admin.
  const b = await minimal.secondOrg()
  toolOrg = b.orgId
  toolAdmin = b.adminUserId
  registerConfigTools(toolOrg)
  for (const section of CONFIG_TOOL_SECTIONS) {
    const data = FIXTURES[section]
    if (data === undefined) continue
    const def = toolRegistry.get([toolOrg, "kernel", `config_${section}`])
    if (!def || typeof def.handler !== "function" || typeof def.preflight !== "function") {
      throw new Error(`config_${section} not registered`)
    }
    const ctx = { orgId: toolOrg, userId: toolAdmin }
    const pre = (await def.preflight({ [section]: data }, ctx)) as {
      pinnedParams?: Record<string, unknown>
      error?: string
    }
    if (!pre.pinnedParams) throw new Error(`config_${section} preflight: ${pre.error}`)
    const out = (await def.handler(
      { [section]: data, ...pre.pinnedParams },
      { ...ctx, approverUserId: toolAdmin },
    )) as { error?: string }
    if (out.error) throw new Error(`config_${section}: ${out.error}`)
  }
}, 600_000)

afterAll(releaseTestLock)

async function roleScopesNamed(orgId: string, names: string[]) {
  return withSystemDb("t", async (db) => {
    const rows = await db
      .select({ name: roles.name, description: roles.description, scope: roleScopeGrants.scope })
      .from(roles)
      .leftJoin(roleScopeGrants, eq(roleScopeGrants.roleId, roles.id))
      .where(and(eq(roles.orgId, orgId), inArray(roles.name, names)))
    const out: Record<string, { description: string | null; scopes: string[] }> = {}
    for (const r of rows) {
      out[r.name] ??= { description: r.description ?? null, scopes: [] }
      if (r.scope) out[r.name]?.scopes.push(r.scope)
    }
    for (const v of Object.values(out)) v.scopes.sort()
    return out
  })
}

async function settings(orgId: string) {
  return withSystemDb("t", (db) => getOrgKernelSettings(db, orgId, orgKernelSettingsSchema))
}

async function invitations(orgId: string) {
  const rows = await withSystemDb("t", (db) =>
    db.execute(drizzleSql`
      SELECT i.email, r.name AS role FROM kernel.invitations i
      JOIN kernel.roles r ON r.id = i.role_id
      WHERE i.org_id = ${orgId}::uuid ORDER BY i.email`),
  )
  return extractRows<{ email: string; role: string }>(rows)
}

async function knowledgeRows(orgId: string) {
  const rows = await withSystemDb("t", (db) =>
    db.execute(drizzleSql`
      SELECT c.name AS collection, d.title, d.body
      FROM app_knowledge.collections c
      LEFT JOIN app_knowledge.collection_memberships m
        ON m.collection_id = c.id AND m.target_type = 'document'
      LEFT JOIN app_knowledge.documents d ON d.id = m.target_id
      WHERE c.org_id = ${orgId}::uuid AND c.name = 'Policies'
      ORDER BY d.title`),
  )
  return extractRows<{ collection: string; title: string | null; body: string | null }>(rows)
}

async function agentRow(orgId: string) {
  const [a] = await withSystemDb("t", (db) =>
    db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.handle, "@support"))),
  )
  if (!a) return null
  return {
    displayName: a.displayName,
    purpose: a.purpose,
    systemPrompt: a.systemPrompt,
    scopeCeiling: [...(a.scopeCeiling ?? [])].sort(),
    modelPreference: a.modelPreference,
  }
}

describe("config tools write the same rows as config apply", () => {
  it("roles", async () => {
    const cli = await roleScopesNamed(cliOrg, ["Support"])
    expect(cli.Support?.scopes).toEqual(["kernel:contacts:read", "kernel:threads:read"])
    expect(await roleScopesNamed(toolOrg, ["Support"])).toEqual(cli)
  })

  it("email", async () => {
    const cli = (await settings(cliOrg)).email
    expect(cli?.from).toBe("Acme <hello@acme.example>")
    expect((await settings(toolOrg)).email).toEqual(cli)
  })

  it("users (invitations)", async () => {
    const cli = (await invitations(cliOrg)).filter((i) => i.email.startsWith("parity-"))
    expect(cli).toEqual([{ email: "parity-invitee@acme.example", role: "member" }])
    expect((await invitations(toolOrg)).filter((i) => i.email.startsWith("parity-"))).toEqual(cli)
  })

  it("tickets settings", async () => {
    const read = async (orgId: string) =>
      JSON.stringify((await settings(orgId)) as Record<string, unknown>).includes(
        '"approveRepliesFromHome":true',
      )
    expect(await read(cliOrg)).toBe(true)
    expect(await read(toolOrg)).toBe(true)
  })

  it("apps", async () => {
    expect(await getEnabledApps(cliOrg)).toContain("projects")
    expect(await getEnabledApps(toolOrg)).toContain("projects")
    const cfg = async (orgId: string) =>
      canonicalJson(await withSystemDb("t", (db) => readAppConfig(db, orgId, "projects")))
    expect(await cfg(toolOrg)).toBe(await cfg(cliOrg))
  })

  it("apiConnectors", async () => {
    const cli = await getAdapterRow(cliOrg, "crm")
    expect(cli?.adapter.name).toBe("Fixture CRM")
    expect(canonicalJson((await getAdapterRow(toolOrg, "crm"))?.adapter)).toBe(
      canonicalJson(cli?.adapter),
    )
  })

  it("knowledge", async () => {
    const cli = await knowledgeRows(cliOrg)
    expect(cli).toEqual([
      { collection: "Policies", title: "Returns", body: "# Returns\nWithin 30 days." },
    ])
    expect(await knowledgeRows(toolOrg)).toEqual(cli)
  })

  it("agents", async () => {
    const cli = await agentRow(cliOrg)
    expect(cli?.displayName).toBe("Support")
    expect(await agentRow(toolOrg)).toEqual(cli)
  })
})

// The sections with no agent tool, each for a reason. Every other section of
// `liaison config apply` must have one (parity above). `limits` is the
// operator's caps (modules/org/caps.ts): an org admin acting through their
// agent must never raise their own caps (spec A16).
const CLI_ONLY_SECTIONS: Record<string, string> = {
  org: "creates the tenant",
  admin: "creates the tenant's first admin",
  byok: "secrets go through the secret card",
  apiKeys: "secrets go through the secret card",
  limits: "operator caps: an org admin must not set their own",
}

describe("config sections without an agent tool", () => {
  it("are exactly the listed exceptions, limits included", () => {
    const tool = new Set<string>(CONFIG_TOOL_SECTIONS)
    const without = CANONICAL_ORDER.filter((k) => !tool.has(k))
    expect(without.map(String).sort()).toEqual(Object.keys(CLI_ONLY_SECTIONS).sort())
    expect(tool.has("limits")).toBe(false)
  })
})
