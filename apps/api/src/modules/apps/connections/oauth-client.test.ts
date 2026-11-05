// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One resolver decides where every app connection's OAuth client comes from: the
// workspace's own client first, then a client the instance provides for every
// workspace, else none. For each provider (the Google workspace client, Google
// Drive, Shopify) the three cases, and the secret only for the flows that need it.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { sql } from "~/db/connection"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import {
  connectionClientSecretForConfigKey,
  INSTANCE_CLIENT_CONNECTIONS,
  instanceOAuthClient,
  resolveOAuthClient,
  resolveOAuthClientCredentials,
} from "~/modules/apps/connections/oauth-client"
import { upsertConnectionOAuthClient } from "~/modules/apps/connections/oauth-client-provisioning"
import { connectionRoutes } from "~/modules/apps/connections/routes"
import { createScope } from "~/modules/permissions/types"
import { saveGoogleIntegrationConfig } from "~/modules/settings/google-integration"

type InstanceVars = Partial<
  Record<
    | "GMAIL_OAUTH_CLIENT_ID"
    | "GMAIL_OAUTH_CLIENT_SECRET"
    | "GOOGLE_DRIVE_OAUTH_CLIENT_ID"
    | "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET"
    | "SHOPIFY_APP_CLIENT_ID"
    | "SHOPIFY_APP_CLIENT_SECRET",
    string
  >
>
const mutableEnv = env as InstanceVars
const KEYS: Array<keyof InstanceVars> = [
  "GMAIL_OAUTH_CLIENT_ID",
  "GMAIL_OAUTH_CLIENT_SECRET",
  "GOOGLE_DRIVE_OAUTH_CLIENT_ID",
  "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET",
  "SHOPIFY_APP_CLIENT_ID",
  "SHOPIFY_APP_CLIENT_SECRET",
]
const saved = Object.fromEntries(KEYS.map((k) => [k, mutableEnv[k]])) as InstanceVars

const INSTANCE: InstanceVars = {
  GMAIL_OAUTH_CLIENT_ID: "instance-google.apps.googleusercontent.com",
  GMAIL_OAUTH_CLIENT_SECRET: "instance-google-secret",
  GOOGLE_DRIVE_OAUTH_CLIENT_ID: "instance-drive.apps.googleusercontent.com",
  GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: "instance-drive-secret",
  SHOPIFY_APP_CLIENT_ID: "instance-shopify-id",
  SHOPIFY_APP_CLIENT_SECRET: "instance-shopify-secret",
}

function setInstance(vars: InstanceVars): void {
  for (const k of KEYS) mutableEnv[k] = vars[k]
}

let orgId: string

beforeEach(async () => {
  orgId = randomUUID()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${orgId}, 'OAuth client resolver org', ${`oauth-client-${orgId}`})`
  setInstance({})
})

afterEach(async () => {
  setInstance(saved)
  await sql`DELETE FROM kernel.oauth_providers WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
})

/** The org's own client for a provider, the way an administrator saves it. */
async function saveOrgClient(connectionKey: string, clientId: string, secret: string) {
  if (connectionKey === "mail:gmail" || connectionKey === "calendar:google-calendar") {
    await saveGoogleIntegrationConfig(orgId, { clientId, clientSecret: secret })
    return
  }
  const [appName, connectionName] = connectionKey.split(":") as [string, string]
  await upsertConnectionOAuthClient({
    orgId,
    appName,
    connectionName,
    clientId,
    clientSecret: secret,
  })
}

const PROVIDERS: Array<{ name: string; key: string; instanceId: string; instanceSecret: string }> =
  [
    {
      name: "Google (Gmail)",
      key: "mail:gmail",
      instanceId: "instance-google.apps.googleusercontent.com",
      instanceSecret: "instance-google-secret",
    },
    {
      name: "Google Calendar (the same workspace client)",
      key: "calendar:google-calendar",
      instanceId: "instance-google.apps.googleusercontent.com",
      instanceSecret: "instance-google-secret",
    },
    {
      name: "Google Drive",
      key: "google-drive:drive",
      instanceId: "instance-drive.apps.googleusercontent.com",
      instanceSecret: "instance-drive-secret",
    },
    {
      name: "Shopify",
      key: "shopify:shop",
      instanceId: "instance-shopify-id",
      instanceSecret: "instance-shopify-secret",
    },
  ]

for (const p of PROVIDERS) {
  describe(`resolveOAuthClient: ${p.name}`, () => {
    it("none: no org client, no instance client", async () => {
      expect(await resolveOAuthClient(orgId, p.key)).toEqual({ source: "none" })
      expect(await resolveOAuthClientCredentials(orgId, p.key)).toBeNull()
    })

    it("instance: the instance's client when the org has none, never its secret", async () => {
      setInstance(INSTANCE)
      const r = await resolveOAuthClient(orgId, p.key)
      expect(r).toEqual({ source: "instance", clientId: p.instanceId })
      expect(JSON.stringify(r)).not.toContain(p.instanceSecret)
      expect(await resolveOAuthClientCredentials(orgId, p.key)).toEqual({
        source: "instance",
        clientId: p.instanceId,
        clientSecret: p.instanceSecret,
      })
    })

    it("org: the org's own client overrides the instance's", async () => {
      setInstance(INSTANCE)
      await saveOrgClient(p.key, "org-own-client-id", "org-own-secret")
      expect(await resolveOAuthClient(orgId, p.key)).toEqual({
        source: "org",
        clientId: "org-own-client-id",
      })
      expect(await resolveOAuthClientCredentials(orgId, p.key)).toEqual({
        source: "org",
        clientId: "org-own-client-id",
        clientSecret: "org-own-secret",
      })
    })
  })
}

// The cell's shared Meta app (managed edition): every workspace's Facebook
// connection (and Instagram through Facebook login) uses it, unless the
// workspace brought its own Meta app.
describe("the cell's Meta app (managed edition)", () => {
  const metaEnv = env as { META_APP_ID?: string; META_APP_SECRET?: string }
  const prior = { id: metaEnv.META_APP_ID, secret: metaEnv.META_APP_SECRET }
  beforeEach(() => {
    metaEnv.META_APP_ID = "cell-meta-app-id"
    metaEnv.META_APP_SECRET = "cell-meta-app-secret"
  })
  afterEach(() => {
    metaEnv.META_APP_ID = prior.id
    metaEnv.META_APP_SECRET = prior.secret
    _setEdition(null)
  })

  for (const key of ["social:facebook", "social:instagram_unified"]) {
    it(`${key}: the cell's Meta app when the org has none; the org's own wins`, async () => {
      _setEdition("managed")
      expect(await resolveOAuthClient(orgId, key)).toEqual({
        source: "instance",
        clientId: "cell-meta-app-id",
      })
      expect(await resolveOAuthClientCredentials(orgId, key)).toEqual({
        source: "instance",
        clientId: "cell-meta-app-id",
        clientSecret: "cell-meta-app-secret",
      })
      await saveOrgClient(key, "org-meta-id", "org-meta-secret")
      expect(await resolveOAuthClient(orgId, key)).toEqual({
        source: "org",
        clientId: "org-meta-id",
      })
    })
  }

  it("self-hosted: the variables are no instance client", async () => {
    _setEdition("self_hosted")
    expect(await resolveOAuthClient(orgId, "social:facebook")).toEqual({ source: "none" })
    expect(instanceOAuthClient("social:facebook")).toBeNull()
  })
})

describe("instance clients", () => {
  it("a half-set pair is no client", () => {
    expect(instanceOAuthClient("shopify:shop", { SHOPIFY_APP_CLIENT_ID: "id-only" })).toBeNull()
  })

  it("a connection the instance cannot provide has no instance client", async () => {
    setInstance(INSTANCE)
    expect(INSTANCE_CLIENT_CONNECTIONS).not.toContain("gitlab:gitlab")
    expect(await resolveOAuthClient(orgId, "gitlab:gitlab")).toEqual({ source: "none" })
  })
})

describe("connectionClientSecretForConfigKey (webhook signing secret)", () => {
  const shopifyConnections = { shop: { clientSecretConfigKey: "shopifyWebhookSecret" } }

  it("is the instance's secret when the org has no client of its own", async () => {
    setInstance(INSTANCE)
    expect(
      await connectionClientSecretForConfigKey(
        orgId,
        "shopify",
        "shopifyWebhookSecret",
        shopifyConnections,
      ),
    ).toBe("instance-shopify-secret")
  })

  it("is the org's secret when it has its own client", async () => {
    setInstance(INSTANCE)
    await saveOrgClient("shopify:shop", "org-shopify-id", "org-shopify-secret")
    expect(
      await connectionClientSecretForConfigKey(
        orgId,
        "shopify",
        "shopifyWebhookSecret",
        shopifyConnections,
      ),
    ).toBe("org-shopify-secret")
  })

  it("is null for a key no connection declares, or with no client at all", async () => {
    setInstance(INSTANCE)
    expect(
      await connectionClientSecretForConfigKey(orgId, "shopify", "other", shopifyConnections),
    ).toBeNull()
    setInstance({})
    expect(
      await connectionClientSecretForConfigKey(
        orgId,
        "shopify",
        "shopifyWebhookSecret",
        shopifyConnections,
      ),
    ).toBeNull()
  })
})

// Gmail (Mail, Tickets) and Google Calendar: the workspace Google client first,
// then a client stored for the connection itself (the PUT route and
// `config apply` write it), then the instance's.
describe("Gmail and Calendar: a client stored for the connection is the org's own", () => {
  function routeApp() {
    const app = new Hono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("orgId", orgId)
      c.set("userId", "00000000-0000-0000-0000-000000000000")
      c.set("scopes", ["kernel:apps:admin"].map(createScope))
      c.set("dimensionGrants", {})
      await next()
    })
    app.route("/api/connections", connectionRoutes)
    return app
  }

  for (const key of ["mail:gmail", "tickets:gmail", "calendar:google-calendar"]) {
    it(`${key}: the PUT route's client is used, before the instance's`, async () => {
      setInstance(INSTANCE)
      const [appName, connectionName] = key.split(":") as [string, string]
      connectionConfigRegistry.set([orgId, appName, connectionName], {
        type: "oauth2",
        allowedDomains: [],
      })
      const res = await routeApp().request(
        `/api/connections/${appName}/${connectionName}/oauth-client`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "row-client-id", clientSecret: "row-secret" }),
        },
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { reconnectToMove: number } }
      expect(body.data.reconnectToMove).toBe(0)
      expect(await resolveOAuthClient(orgId, key)).toEqual({
        source: "org",
        clientId: "row-client-id",
      })
      expect(await resolveOAuthClientCredentials(orgId, key)).toEqual({
        source: "org",
        clientId: "row-client-id",
        clientSecret: "row-secret",
      })
      connectionConfigRegistry.deleteByPrefix([orgId, appName])
    })
  }

  it("the workspace Google client wins over the connection's stored client", async () => {
    await upsertConnectionOAuthClient({
      orgId,
      appName: "tickets",
      connectionName: "gmail",
      clientId: "row-client-id",
      clientSecret: "row-secret",
    })
    await saveGoogleIntegrationConfig(orgId, {
      clientId: "workspace-id",
      clientSecret: "ws-secret",
    })
    expect(await resolveOAuthClient(orgId, "tickets:gmail")).toEqual({
      source: "org",
      clientId: "workspace-id",
    })
  })
})
