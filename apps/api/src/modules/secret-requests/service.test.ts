// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A secret request is saved only when the store holds a secret it did not
// hold when the agent asked. Every kind is completed here after a REAL write
// through the route that stores that secret (the person's own route, called
// with the person's token), and refused with 409 when nothing was written.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { secretRequests } from "~/db/schema/kernel"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import {
  announceConnectFailure,
  completeSecretRequest,
  createSecretRequest,
  expireSecretRequests,
  getSecretRequest,
} from "~/modules/secret-requests/service"
import type { SecretTarget } from "~/modules/secret-requests/targets"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Json = Record<string, any>

const realFetch = globalThis.fetch

/** The provider boundary: the key route checks a key against the provider. */
function providerAnswers(status: number): typeof fetch {
  return Object.assign(async () => new Response("{}", { status }), {
    preconnect: realFetch.preconnect,
  })
}

let orgId: string
let adminId: string
let adminToken: string
let threadId: string
let adminScopes: string[]

async function req(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await app.request(path, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json }
}

async function asAdmin<T>(fn: Parameters<typeof withRlsContext<T>>[1]): Promise<T> {
  const perms = await withPrivilegedDb(orgId, "test-secret-perms", (tx) =>
    loadEffectivePermissions(tx, adminId, orgId),
  )
  return withRlsContext(
    {
      actorType: "user",
      userId: adminId,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    fn,
  )
}

function ask(target: SecretTarget) {
  return asAdmin((tx) =>
    createSecretRequest(tx, { orgId, threadId, requestedBy: adminId, agentId: null, target }),
  )
}

function complete(id: string) {
  return completeSecretRequest({ orgId, id, userId: adminId, scopes: adminScopes })
}

async function expectNothingStored(id: string) {
  await expect(complete(id)).rejects.toMatchObject({ status: 409 })
  const row = await asAdmin((tx) => getSecretRequest(tx, id))
  expect(row?.status).toBe("pending")
}

describe("secret requests: completion is derived from the store", () => {
  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    orgId = org.id
    const admin = await minimal.person(orgId, { role: "admin" })
    adminId = admin.id
    adminToken = await minimal.token(adminId)
    threadId = await minimal.thread(orgId, adminId)
    await ensureAppsForOrg(orgId)
    const perms = await withPrivilegedDb(orgId, "test-secret-perms", (tx) =>
      loadEffectivePermissions(tx, adminId, orgId),
    )
    adminScopes = perms.scopes
  }, 180_000)

  afterAll(releaseTestLock)

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("byok: the key route itself settles the pending request, with the key's last 4", async () => {
    const row = await ask({ kind: "byok", provider: "openrouter" })
    await expectNothingStored(row.id)

    globalThis.fetch = providerAnswers(200)
    const saved = await req("/api/settings/ai/keys", {
      method: "POST",
      body: { provider: "openrouter", apiKey: "sk-or-test-key-abcd1234" },
    })
    expect(saved.status).toBe(200)

    // A model key saved anywhere (the card posts to this same route, and so
    // does Settings) completes the pending request through the store check.
    const done = await asAdmin((tx) => getSecretRequest(tx, row.id))
    expect(done?.status).toBe("saved")
    expect(done?.hint).toBe("…1234")
    expect(done?.completedBy).toBe(adminId)
  })

  it("byok: a second request for the same provider waits for a NEW key", async () => {
    const row = await ask({ kind: "byok", provider: "openrouter" })
    // The key stored by the previous test is in the baseline: no completion yet.
    await expectNothingStored(row.id)
    globalThis.fetch = providerAnswers(200)
    // The same key typed again is a new ciphertext, hence a new stored secret.
    await req("/api/settings/ai/keys", {
      method: "POST",
      body: { provider: "openrouter", apiKey: "sk-or-test-key-abcd1234" },
    })
    expect((await asAdmin((tx) => getSecretRequest(tx, row.id)))?.status).toBe("saved")
  })

  it("byok: a key the provider refused stores nothing and completes nothing", async () => {
    const row = await ask({ kind: "byok", provider: "anthropic" })
    globalThis.fetch = providerAnswers(401)
    const refused = await req("/api/settings/ai/keys", {
      method: "POST",
      body: { provider: "anthropic", apiKey: "sk-ant-wrong" },
    })
    expect(refused.status).toBe(400)
    await expectNothingStored(row.id)
  })

  it("connection_credentials: saved, with no hint, after an org-owned account is stored", async () => {
    const row = await ask({ kind: "connection_credentials", app: "gitlab", connection: "gitlab" })
    await expectNothingStored(row.id)

    // A PERSONAL account (someone's own login) is not what was asked for.
    const member = await minimal.person(orgId)
    const personal = await app.request("/api/connections/gitlab/gitlab/credentials", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await minimal.token(member.id)}`,
      },
      body: JSON.stringify({
        mode: "personal",
        credentials: { token: "glpat-personal", group: "acme" },
      }),
    })
    expect(personal.status).toBe(201)
    await expectNothingStored(row.id)

    const org = await req("/api/connections/gitlab/gitlab/credentials", {
      method: "POST",
      body: { mode: "org", credentials: { token: "glpat-org-secret", group: "acme" } },
    })
    expect(org.status).toBe(201)
    const done = await complete(row.id)
    expect(done.status).toBe("saved")
    expect(done.hint).toBeNull()
  })

  it("connection_credentials, mode personal: saved after the requester's OWN account is stored", async () => {
    const row = await ask({
      kind: "connection_credentials",
      app: "gitlab",
      connection: "gitlab",
      mode: "personal",
    })
    // The organization's shared account is not the person's own mailbox or login.
    const org = await req("/api/connections/gitlab/gitlab/credentials", {
      method: "POST",
      body: { mode: "org", credentials: { token: "glpat-org-2", group: "acme" } },
    })
    expect(org.status).toBe(201)
    await expectNothingStored(row.id)

    const own = await req("/api/connections/gitlab/gitlab/credentials", {
      method: "POST",
      body: { mode: "personal", credentials: { token: "glpat-own", group: "acme" } },
    })
    expect(own.status).toBe(201)
    // A personal card needs no admin scope: the person saves their own account.
    const done = await completeSecretRequest({
      orgId,
      id: row.id,
      userId: adminId,
      scopes: ["kernel:threads:read"],
    })
    expect(done.status).toBe("saved")
  })

  it("oauth_client: saved with the client id's tail after the client route stored it", async () => {
    const row = await ask({ kind: "oauth_client", app: "mail", connection: "gmail" })
    await expectNothingStored(row.id)
    const put = await req("/api/connections/mail/gmail/oauth-client", {
      method: "PUT",
      body: { clientId: "client-1234567.example", clientSecret: "oauth-secret-value" },
    })
    expect(put.status).toBe(200)
    const done = await complete(row.id)
    expect(done.status).toBe("saved")
    expect(done.hint).toBe("...1234567")
  })

  it("google_integration_client: saved after the Google integration stored a client", async () => {
    const row = await ask({ kind: "google_integration_client" })
    await expectNothingStored(row.id)
    const patch = await req("/api/settings/integrations/google", {
      method: "PATCH",
      body: {
        clientId: "998877-abcdefg.apps.googleusercontent.com",
        clientSecret: "google-secret-value",
      },
    })
    expect(patch.status).toBe(200)
    const done = await complete(row.id)
    expect(done.status).toBe("saved")
    expect(done.hint).toBe("...abcdefg")
  })

  it("api_connector_credentials: saved after the adapter's credentials were stored", async () => {
    const adapter = {
      id: "crm",
      name: "Example CRM",
      version: "1.0.0",
      baseUrl: "https://crm.example.com/api",
      auth: { type: "bearer" },
      operations: [
        {
          name: "find_customer",
          description: "Find companies by contact email.",
          kind: "read",
          method: "GET",
          path: "/companies",
          params: { type: "object", properties: { email: { type: "string" } } },
          query: { email: "{email}" },
          items: "/data",
          fields: ["id", "name"],
          role: "customer.lookup",
        },
      ],
    }
    const put = await req("/api/api-connector/adapters/crm", { method: "PUT", body: adapter })
    expect(put.status).toBeLessThan(300)
    const row = await ask({ kind: "api_connector_credentials", identifier: "crm" })
    await expectNothingStored(row.id)
    const creds = await req("/api/connections/api-connector/api/credentials", {
      method: "POST",
      body: { mode: "org", credentials: { identifier: "crm", token: "crm-bearer-secret" } },
    })
    expect(creds.status).toBe(201)
    const done = await complete(row.id)
    expect(done.status).toBe("saved")
    expect(done.hint).toBeNull()
  })

  it("api_key: saved with the key's public prefix after the person minted it", async () => {
    const row = await ask({ kind: "api_key", label: "Website form" })
    await expectNothingStored(row.id)
    const minted = await req("/api/apps/run-tool", {
      method: "POST",
      body: { toolName: "tickets:apiKeys.create", params: { label: "Website form" } },
    })
    expect(minted.status).toBe(200)
    const key = minted.body.data.key as string
    const done = await complete(row.id)
    expect(done.status).toBe("saved")
    expect(done.hint).toBe(key.slice(0, 8))
  })

  it("an org credential already stored when asked is not a completion: 409 until a new write", async () => {
    const first = await req("/api/connections/gitlab/gitlab/credentials", {
      method: "POST",
      body: { mode: "org", credentials: { token: "glpat-stored-before", group: "acme" } },
    })
    expect(first.status).toBe(201)
    const row = await ask({ kind: "connection_credentials", app: "gitlab", connection: "gitlab" })
    await expectNothingStored(row.id)
    await req("/api/connections/gitlab/gitlab/credentials", {
      method: "POST",
      body: { mode: "org", credentials: { token: "glpat-stored-after", group: "acme" } },
    })
    expect((await complete(row.id)).status).toBe("saved")
  })

  it("API connector credentials already stored when asked are not a completion", async () => {
    // The connector "crm" got its credentials in an earlier test.
    const row = await ask({ kind: "api_connector_credentials", identifier: "crm" })
    await expectNothingStored(row.id)
    await req("/api/connections/api-connector/api/credentials", {
      method: "POST",
      body: { mode: "org", credentials: { identifier: "crm", token: "crm-bearer-rotated" } },
    })
    expect((await complete(row.id)).status).toBe("saved")
  })

  it("an OAuth client already stored when asked is not a completion", async () => {
    // mail/gmail's client was stored in an earlier test.
    const row = await ask({ kind: "oauth_client", app: "mail", connection: "gmail" })
    await expectNothingStored(row.id)
    await req("/api/connections/mail/gmail/oauth-client", {
      method: "PUT",
      body: { clientId: "client-1234567.example", clientSecret: "oauth-secret-rotated" },
    })
    expect((await complete(row.id)).status).toBe("saved")
  })

  it("a second save is refused with 'already saved'", async () => {
    const row = await ask({ kind: "google_integration_client" })
    await req("/api/settings/integrations/google", {
      method: "PATCH",
      body: { clientId: "112233-xyz.apps.googleusercontent.com", clientSecret: "another" },
    })
    expect((await complete(row.id)).status).toBe("saved")
    await expect(complete(row.id)).rejects.toMatchObject({ status: 409 })
  })

  it("a caller without the target route's scope cannot complete", async () => {
    const row = await ask({ kind: "google_integration_client" })
    await expect(
      completeSecretRequest({
        orgId,
        id: row.id,
        userId: adminId,
        scopes: ["kernel:threads:read"],
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it("walk N42: a connect refused at the callback tells its card the reason code, and nothing else", async () => {
    const row = await ask({
      kind: "oauth_connect",
      app: "mail",
      connection: "gmail",
      mode: "personal",
    })
    await announceConnectFailure(orgId, row.id, "connection_held_by_other_owner")
    // Free text from a callback is never carried: it becomes the generic code.
    await announceConnectFailure(orgId, row.id, "<script>provider said</script>")
    const frames = await sql<{ data: Json }[]>`
      SELECT payload->'data' AS data FROM kernel.pending_events
       WHERE org_id = ${orgId} AND payload->>'entity' = 'secret_request'
         AND payload->>'entityId' = ${row.id} AND payload->'data' ? 'failure'
       ORDER BY seq`
    expect(frames.map((f) => f.data)).toEqual([
      { id: row.id, status: "pending", failure: "connection_held_by_other_owner" },
      { id: row.id, status: "pending", failure: "failed" },
    ])
    expect((await asAdmin((tx) => getSecretRequest(tx, row.id)))?.status).toBe("pending")
  })

  it("dedupes a pending request for the same target in the same conversation", async () => {
    const a = await ask({ kind: "byok", provider: "mistral" })
    const b = await ask({ kind: "byok", provider: "mistral" })
    expect(b.id).toBe(a.id)
    const c = await ask({ kind: "byok", provider: "openai" })
    expect(c.id).not.toBe(a.id)
  })

  it("expires a pending request after its deadline, and a new ask files a new row", async () => {
    const row = await ask({ kind: "byok", provider: "google" })
    await withPrivilegedDb(orgId, "test-age-secret-request", (tx) =>
      tx
        .update(secretRequests)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(secretRequests.id, row.id)),
    )
    const swept = await expireSecretRequests()
    expect(swept.expired).toBeGreaterThanOrEqual(1)
    expect((await asAdmin((tx) => getSecretRequest(tx, row.id)))?.status).toBe("expired")
    await expect(complete(row.id)).rejects.toMatchObject({ status: 409 })
    const again = await ask({ kind: "byok", provider: "google" })
    expect(again.id).not.toBe(row.id)
  })
})
