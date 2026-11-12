// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A workspace's setup checklist is read from its rows, never from a stored
// flag: each item turns done exactly when the row that proves it appears, and
// back when that row goes away. The result is counts and booleans only.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { validateAdapter } from "@liaison/api-connector-core"
import { knowledgeCreateDocumentSchema } from "@liaison/shared"
import { and, eq, sql } from "drizzle-orm"
import { API_CONNECTOR_CONNECTION, upsertAdapterRow } from "~/modules/apps/connections/api/store"
import { createKnowledgeDocument, knowledgeActorFromContext } from "~/apps/knowledge/service"
import { createByokProvisioner } from "~/cli/provisioners/byok"
import { buildProvisionContext } from "~/cli/provisioners/types"
import { sql as sql_ } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { connectedAccounts, importRuns, invitations, roles } from "~/db/schema/kernel"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { ENV_KEY_MAP } from "~/modules/agent/credits/platform-key-env"
import {
  connectionConfigRegistry,
  oauthClientResolverRegistry,
} from "~/modules/apps/app-registries"
import { ConnectionTurnedOffError } from "~/modules/apps/connections/oauth-client-config"
import { upsertConnectionOAuthClient } from "~/modules/apps/connections/oauth-client-provisioning"
import { enableApp } from "~/modules/apps/enabled-apps"
import { resetOperatorOrgCache } from "~/modules/apps/operator-org"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { setSharing } from "~/modules/liaison-team/settings"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import {
  computeSetupState,
  connectionNextStep,
  SETUP_ITEM_KEYS,
  type SetupConnection,
  type SetupState,
} from "~/modules/provisioning/setup-state"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let adminId: string
let actor: UserContext
const savedEnvKeys: Record<string, string | undefined> = {}

function item(state: SetupState, key: string) {
  const found = state.items.find((i) => i.key === key)
  if (!found) throw new Error(`no item ${key}`)
  return found
}

async function done(key: string): Promise<boolean> {
  return item(await computeSetupState(orgId), key).done
}

beforeAll(async () => {
  await acquireTestLock()
  // A deployment-wide model key would make every org's key item done: the
  // item must turn on the org's own key here.
  for (const name of Object.values(ENV_KEY_MAP)) {
    savedEnvKeys[name] = process.env[name]
    delete process.env[name]
  }
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  adminId = a.userId
  actor = a.actor
})

afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnvKeys)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await releaseTestLock()
})

describe("computeSetupState: the Liaison team item", () => {
  const savedEndpoint = env.LIAISON_TEAM_ENDPOINT
  const setEndpoint = (v: string) => {
    ;(env as { LIAISON_TEAM_ENDPOINT: string }).LIAISON_TEAM_ENDPOINT = v
  }
  const has = (state: SetupState) => state.items.some((i) => i.key === "liaisonTeam")
  const reset = async () => {
    await sql_`DELETE FROM kernel.control_plane_outbox`
    await sql_`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
  }
  afterEach(async () => {
    setEndpoint(savedEndpoint)
    _setEdition(null)
    DemoModeTestAccess.set(null)
    resetOperatorOrgCache()
    await reset()
  })

  // Discriminator: an item shown while sharing is unavailable asks a question
  // nothing can honour.
  test("absent when the endpoint is disabled", async () => {
    setEndpoint("")
    expect(has(await computeSetupState(orgId))).toBe(false)
  })

  // Discriminator: either answer counts; "not asked" is not done.
  test("shown optional and not done, then done after either answer", async () => {
    await reset()
    setEndpoint("http://127.0.0.1:9/hook")
    const before = item(await computeSetupState(orgId), "liaisonTeam")
    expect(before).toMatchObject({ done: false, optional: true })
    await setSharing({ register: false, forwardBugReports: false }, { userId: null })
    const no = await computeSetupState(orgId)
    expect(item(no, "liaisonTeam")).toMatchObject({ done: true, detail: "not registered" })
    await setSharing({ register: true }, { userId: null })
    const yes = await computeSetupState(orgId)
    expect(item(yes, "liaisonTeam").detail).toBe("registered, bug report forwarding off")
    // It is optional: it never becomes the checklist's next item.
    expect(no.next).toBe("aiKey")
  })

  test("a managed org has no model-key step: it runs on the server's key", async () => {
    _setEdition("managed")
    try {
      const state = await computeSetupState(orgId)
      expect(state.items.map((i) => i.key)).not.toContain("aiKey")
      expect(state.next).not.toBe("aiKey")
    } finally {
      _setEdition(null)
    }
  })

  // Discriminator: R17, a demo visitor's setup agent never asks.
  test("absent for an org that is not the operator's on a demo instance", async () => {
    const OTHER = "00000000-0000-4000-8000-0000000bad02"
    setEndpoint("http://127.0.0.1:9/hook")
    _setEdition("self_hosted")
    DemoModeTestAccess.set(true)
    await sql_`INSERT INTO kernel.organizations (id, name, slug) VALUES (${OTHER}, 'Visitor', 'setup-state-visitor')`
    try {
      ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = orgId
      resetOperatorOrgCache()
      expect(has(await computeSetupState(orgId))).toBe(true)
      expect(has(await computeSetupState(OTHER))).toBe(false)
    } finally {
      ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = undefined
      await sql_`DELETE FROM kernel.organizations WHERE id = ${OTHER}`
    }
  })
})

describe("computeSetupState", () => {
  test("a fresh org has nothing done and the key comes first", async () => {
    const state = await computeSetupState(orgId)
    expect(state.items.map((i) => i.key)).toEqual([...SETUP_ITEM_KEYS])
    for (const i of state.items) {
      expect({ key: i.key, done: i.done }).toEqual({ key: i.key, done: false })
    }
    expect(state.next).toBe("aiKey")
    expect(typeof state.asOf).toBe("string")
    expect(item(state, "import").optional).toBe(true)
    expect(item(state, "roles").optional).toBe(true)
    expect(item(state, "connector").optional).toBe(true)
    expect(item(state, "mail").optional).toBe(false)
  })

  test("aiKey turns done when the org saves its own model key", async () => {
    expect(await done("aiKey")).toBe(false)
    const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
    ctx.orgId = orgId
    await createByokProvisioner().apply(
      ctx,
      { actions: [] },
      {
        org: { slug: "setup-state", name: "Setup state" },
        byok: { openrouter: { apiKey: "sk-or-v1-setup-state-test-000000" } },
      },
    )
    expect(await done("aiKey")).toBe(true)
    expect((await computeSetupState(orgId)).next).not.toBe("aiKey")
  })

  test("apps turns done when an app is enabled", async () => {
    await enableApp(orgId, "projects")
    expect(await done("apps")).toBe(true)
  })

  test("mail turns done on an active mailbox and back when it disconnects", async () => {
    expect(await done("mail")).toBe(false)
    const [row] = await withSystemDb("test-mail-account", (db) =>
      db
        .insert(connectedAccounts)
        .values({
          orgId,
          appName: "mail",
          connectionName: "imap",
          ownerType: "org",
          providerType: "credentials",
          createdBy: adminId,
          identifier: `support-${crypto.randomUUID()}@acme.example`,
          status: "active",
        })
        .returning({ id: connectedAccounts.id }),
    )
    expect(await done("mail")).toBe(true)
    await withSystemDb("test-mail-disconnect", (db) =>
      db
        .update(connectedAccounts)
        .set({ status: "disconnected" })
        .where(eq(connectedAccounts.id, row!.id)),
    )
    expect(await done("mail")).toBe(false)
  })

  test("team: an import placeholder does not count, a second person does, an invitation does", async () => {
    await ensureUser({
      orgId,
      email: `slack-import+someone-${crypto.randomUUID()}@import.invalid`,
      name: "Imported",
      role: "member",
      allowPasswordless: true,
    })
    expect(await done("team")).toBe(false)

    const [memberRole] = await withSystemDb("test-member-role", (db) =>
      db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), eq(roles.name, "member"))),
    )
    const [invite] = await withSystemDb("test-invite", (db) =>
      db
        .insert(invitations)
        .values({
          orgId,
          email: `invitee-${crypto.randomUUID()}@acme.example`,
          roleId: memberRole!.id,
          tokenHash: crypto.randomUUID(),
          invitedBy: adminId,
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning({ id: invitations.id }),
    )
    expect(await done("team")).toBe(true)
    await withSystemDb("test-invite-drop", (db) =>
      db.delete(invitations).where(eq(invitations.id, invite!.id)),
    )
    expect(await done("team")).toBe(false)

    await ensureUser({
      orgId,
      email: `colleague-${crypto.randomUUID()}@acme.example`,
      name: "Colleague",
      role: "member",
      allowPasswordless: true,
    })
    expect(await done("team")).toBe(true)
  })

  test("knowledge turns done on a document", async () => {
    expect(await done("knowledge")).toBe(false)
    const input = knowledgeCreateDocumentSchema.parse({
      documentScope: "organization",
      title: "Returns policy",
      body: "Thirty days.",
    })
    await withRlsContext(actor, (tx) =>
      createKnowledgeDocument(tx, input, knowledgeActorFromContext(actor), []),
    )
    expect(await done("knowledge")).toBe(true)
  })

  test("import: a failed run does not count, a finished one does", async () => {
    await withSystemDb("test-import-failed", (db) =>
      db.insert(importRuns).values({ orgId, status: "failed", startedBy: adminId }),
    )
    expect(await done("import")).toBe(false)
    await withSystemDb("test-import-done", (db) =>
      db.insert(importRuns).values({ orgId, status: "done", startedBy: adminId }),
    )
    expect(await done("import")).toBe(true)
  })

  test("roles: the seeded presets do not count, a role the org made does", async () => {
    expect(await done("roles")).toBe(false)
    await withSystemDb("test-custom-role", (db) =>
      db.insert(roles).values({ orgId, name: `Support ${crypto.randomUUID().slice(0, 6)}` }),
    )
    expect(await done("roles")).toBe(true)
  })

  test("connector: an adapter alone does not count, with its credentials it does", async () => {
    const doc = validateAdapter({
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
          items: "/data",
          fields: ["id", "name"],
        },
      ],
    })
    if (!doc.ok) throw new Error(JSON.stringify(doc.issues))
    await upsertAdapterRow(orgId, "crm", doc.adapter, adminId)
    expect(await done("connector")).toBe(false)
    await withSystemDb("test-connector-creds", (db) =>
      db.insert(connectedAccounts).values({
        orgId,
        appName: "api-connector",
        connectionName: API_CONNECTOR_CONNECTION,
        ownerType: "org",
        providerType: "credentials",
        createdBy: adminId,
        identifier: "crm",
        status: "active",
      }),
    )
    expect(await done("connector")).toBe(true)
  })

  test("the result carries no name, address or secret", async () => {
    const state = await computeSetupState(orgId)
    const text = JSON.stringify(state)
    expect(text).not.toContain("@")
    expect(text).not.toContain("sk-or-")
    expect(text).not.toContain("Returns policy")
    for (const i of state.items) {
      expect(Object.keys(i).sort()).toEqual(["detail", "done", "key", "optional"])
    }
    expect(Object.keys(state).sort()).toEqual(["asOf", "connections", "features", "items", "next"])
  })
})

describe("connections: the next step of each OAuth connection", () => {
  type ShopifyInstanceVars = { SHOPIFY_APP_CLIENT_ID?: string; SHOPIFY_APP_CLIENT_SECRET?: string }
  const mutableEnv = env as ShopifyInstanceVars

  async function shopifyStep(): Promise<SetupConnection | undefined> {
    const state = await computeSetupState(orgId)
    return state.connections.find((c) => c.app === "shopify" && c.connection === "shop")
  }

  test("the rule: no client is a client card, a client is a consent card, an account is done", () => {
    expect(connectionNextStep("none", false)).toBe("client_card")
    expect(connectionNextStep("instance", false)).toBe("consent_card")
    expect(connectionNextStep("org", false)).toBe("consent_card")
    expect(connectionNextStep("none", true)).toBe("connected")
  })

  test("none, then instance, then org, then connected", async () => {
    await enableApp(orgId, "shopify")
    connectionConfigRegistry.set([orgId, "shopify", "shop"], {
      type: "oauth2",
      authorizationUrl: "https://{shop}/admin/oauth/authorize",
      tokenUrl: "https://{shop}/admin/oauth/access_token",
      scopes: ["read_orders"],
      allowedDomains: ["*.myshopify.com"],
    })
    const saved = { ...mutableEnv }
    try {
      mutableEnv.SHOPIFY_APP_CLIENT_ID = undefined
      mutableEnv.SHOPIFY_APP_CLIENT_SECRET = undefined
      expect(await shopifyStep()).toEqual({
        app: "shopify",
        connection: "shop",
        client: "none",
        connected: false,
        next: "client_card",
      })

      mutableEnv.SHOPIFY_APP_CLIENT_ID = "instance-shopify-id"
      mutableEnv.SHOPIFY_APP_CLIENT_SECRET = "instance-shopify-secret"
      expect(await shopifyStep()).toMatchObject({ client: "instance", next: "consent_card" })

      await upsertConnectionOAuthClient({
        orgId,
        appName: "shopify",
        connectionName: "shop",
        clientId: "org-shopify-id",
        clientSecret: "org-shopify-secret",
      })
      expect(await shopifyStep()).toMatchObject({ client: "org", next: "consent_card" })

      await withSystemDb("test-shopify-connected", (db) =>
        db.insert(connectedAccounts).values({
          orgId,
          appName: "shopify",
          connectionName: "shop",
          ownerType: "org",
          providerType: "oauth2",
          createdBy: adminId,
          identifier: "setup-state-store.myshopify.com",
          status: "active",
        }),
      )
      expect(await shopifyStep()).toMatchObject({ connected: true, next: "connected" })
      const text = JSON.stringify(await computeSetupState(orgId))
      expect(text).not.toContain("org-shopify-id")
      expect(text).not.toContain("instance-shopify")
    } finally {
      mutableEnv.SHOPIFY_APP_CLIENT_ID = saved.SHOPIFY_APP_CLIENT_ID
      mutableEnv.SHOPIFY_APP_CLIENT_SECRET = saved.SHOPIFY_APP_CLIENT_SECRET
      connectionConfigRegistry.deleteByPrefix([orgId, "shopify"])
    }
  })

  test("a connection the workspace switched off is turned on first: its Connect card would be refused", async () => {
    await enableApp(orgId, "shopify")
    connectionConfigRegistry.set([orgId, "shopify", "switched"], {
      type: "oauth2",
      authorizationUrl: "https://example.com/authorize",
      tokenUrl: "https://example.com/token",
      scopes: ["read"],
      allowedDomains: ["example.com"],
    })
    oauthClientResolverRegistry.set([orgId, "shopify", "switched"], async () => {
      throw new ConnectionTurnedOffError("Switched is not enabled for this org", "turn it on: X")
    })
    try {
      const state = await computeSetupState(orgId)
      expect(state.connections.find((c) => c.connection === "switched")).toMatchObject({
        connected: false,
        next: "turn_on",
        turnOn: "turn it on: X",
      })
    } finally {
      oauthClientResolverRegistry.deleteByPrefix([orgId, "shopify"])
      connectionConfigRegistry.deleteByPrefix([orgId, "shopify"])
    }
  })

  test("a connected store whose grant lacks a protected scope names it, and whether the setting is on", async () => {
    await enableApp(orgId, "shopify")
    connectionConfigRegistry.set([orgId, "shopify", "shop"], {
      type: "oauth2",
      authorizationUrl: "https://{shop}/admin/oauth/authorize",
      tokenUrl: "https://{shop}/admin/oauth/access_token",
      scopes: ["read_orders"],
      protectedScopes: [{ scope: "read_all_orders", setting: "fullOrderHistory" }],
      allowedDomains: ["*.myshopify.com"],
    })
    const identifier = "protected-scope-store.myshopify.com"
    const setGrant = (scopes: string[]) =>
      withSystemDb("test-shopify-grant", (db) =>
        db
          .update(connectedAccounts)
          .set({ metadata: { grantedOAuthScopes: scopes }, updatedAt: new Date() })
          .where(
            and(eq(connectedAccounts.orgId, orgId), eq(connectedAccounts.identifier, identifier)),
          ),
      )
    try {
      await withSystemDb("test-shopify-connected-protected", (db) =>
        db.insert(connectedAccounts).values({
          orgId,
          appName: "shopify",
          connectionName: "shop",
          ownerType: "org",
          providerType: "oauth2",
          createdBy: adminId,
          identifier,
          status: "active",
          metadata: { grantedOAuthScopes: ["read_orders"] },
        }),
      )
      expect((await shopifyStep())?.missingProtectedScopes).toEqual([
        { scope: "read_all_orders", setting: "fullOrderHistory", settingOn: false },
      ])

      await withSystemDb("test-shopify-opt-in", (db) =>
        db.execute(sql`UPDATE kernel.organizations
          SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{shopify}', '{"fullOrderHistory": true}'::jsonb)
          WHERE id = ${orgId}`),
      )
      expect((await shopifyStep())?.missingProtectedScopes).toEqual([
        { scope: "read_all_orders", setting: "fullOrderHistory", settingOn: true },
      ])

      // Shopify's grant on reconnect is the proof: once it holds the scope, nothing is left.
      await setGrant(["read_orders", "read_all_orders"])
      expect((await shopifyStep())?.missingProtectedScopes).toBeUndefined()
    } finally {
      await withSystemDb("test-shopify-cleanup", async (db) => {
        await db
          .delete(connectedAccounts)
          .where(
            and(eq(connectedAccounts.orgId, orgId), eq(connectedAccounts.identifier, identifier)),
          )
        await db.execute(
          sql`UPDATE kernel.organizations SET settings = settings - 'shopify' WHERE id = ${orgId}`,
        )
      })
      connectionConfigRegistry.deleteByPrefix([orgId, "shopify"])
    }
  })
})
