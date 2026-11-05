// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/api-connector routes against the real database (the app's adapters
// table comes from the runtime DDL of its manifest) and the generic
// credentials route. The outbound fetch seam and DNS are the only fakes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { createHash, createHmac } from "node:crypto"
import * as dnsPromises from "node:dns/promises"
import { beatOutcome, findTour, type Tour, type TourBeatState } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { resolveConnectionCredentials } from "~/apps/api-connector/store"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import type { AppEvent } from "~/infra/events/event-bus"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import { apiConnectorRoutes } from "~/modules/api-connector/routes"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { connectionRoutes } from "~/modules/apps/connections/routes"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { createScope } from "~/modules/permissions/types"
import { bindingMatches, handleTourProgressEvent } from "~/modules/tours/consumer"
import { loadTourOrgContext, startTour, tourBeats } from "~/modules/tours/service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const KEY = "sk_test_ROUTE_SECRET_42"
const ADMIN = [
  "api-connector:read",
  "api-connector:write",
  "api-connector:admin",
  "api-connector:accounts:admin",
]
const MEMBER = ["api-connector:read", "api-connector:write"]

const ADAPTER = {
  id: "fixture-crm",
  name: "Fixture CRM",
  version: "1.0.0",
  baseUrl: "https://crm.example.com/api",
  auth: { type: "apiKey", in: "header", name: "X-Api-Key" },
  operations: [
    {
      name: "find_customer",
      description: "Find companies by contact email or domain.",
      kind: "read",
      method: "GET",
      path: "/companies",
      params: {
        type: "object",
        properties: { email: { type: "string" }, domain: { type: "string" } },
      },
      query: { email: "{email}", domain: "{domain}" },
      items: "/data",
      fields: ["id", "name"],
      role: "customer.lookup",
    },
    {
      name: "create_note",
      description: "Add a note.",
      kind: "write",
      method: "POST",
      path: "/notes",
      params: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      body: { text: "{text}" },
      fields: ["id"],
    },
  ],
}

let ORG = ""
let USER = ""
let seen: string[] = []
let lookupSpy: ReturnType<typeof spyOn>

function makeApp(scopes: string[], orgId = ORG) {
  const app = new Hono<AppEnv>()
  app.onError(errorHandler)
  app.use("*", async (c, next) => {
    c.set("orgId", orgId)
    c.set("userId", USER)
    c.set("scopes", scopes.map(createScope))
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/api-connector", apiConnectorRoutes)
  app.route("/api/connections", connectionRoutes)
  return app
}

function put(
  scopes: string[],
  identifier: string,
  body: string,
  contentType = "application/json",
  orgId = ORG,
) {
  return makeApp(scopes, orgId).request(`/api/api-connector/adapters/${identifier}`, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  })
}

function postCredentials(scopes: string[], body: unknown, orgId = ORG) {
  return makeApp(scopes, orgId).request("/api/connections/api-connector/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function runTest(scopes: string[], identifier: string, body: unknown) {
  return makeApp(scopes).request(`/api/api-connector/adapters/${identifier}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function newOrg(label: string): Promise<string> {
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), ${label}, ${`${label}-${Date.now()}`}) RETURNING id`,
    ),
  )
  return org?.id ?? ""
}

beforeAll(async () => {
  await acquireTestLock()
  ORG = await newOrg("api-connector-routes")
  const [u] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${ORG}::uuid, ${`admin-${Date.now()}@api-connector.test`},
                'Admin', 'active', 'h', 1, 1)
        RETURNING id`,
    ),
  )
  USER = u?.id ?? ""
  await ensureAppsForOrg(ORG)
}, 120_000)

afterAll(async () => {
  resetAppRegistries()
  await releaseTestLock()
})

beforeEach(() => {
  seen = []
  lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation((async () => [
    { address: "93.184.216.34", family: 4 },
  ]) as never)
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request) => {
    seen.push(String(input))
    return new Response(
      JSON.stringify({ data: [{ id: "c1", name: "Acme Instruments", vat: "FR123" }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )
  }) as typeof fetch)
})

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
  lookupSpy.mockRestore()
})

describe("PUT/GET/DELETE /api/api-connector/adapters", () => {
  it("refuses a member (admin scope required) and an unauthenticated read", async () => {
    expect((await put(MEMBER, "crm", JSON.stringify(ADAPTER))).status).toBe(403)
    const res = await makeApp([]).request("/api/api-connector/adapters")
    expect(res.status).toBe(403)
  })

  it("answers 422 with path-precise issues for an invalid adapter", async () => {
    const bad = { ...ADAPTER, baseUrl: "http://crm.example.com" }
    const res = await put(ADMIN, "crm", JSON.stringify(bad))
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string; issues: { path: string }[] } }
    expect(body.error.code).toBe("invalid_adapter")
    expect(body.error.issues.map((i) => i.path)).toContain("baseUrl")
  })

  it("refuses a malformed identifier", async () => {
    expect((await put(ADMIN, "Not_A_Slug", JSON.stringify(ADAPTER))).status).toBe(400)
  })

  it("stores a JSON adapter and a YAML one, and lists both with their shape", async () => {
    expect((await put(ADMIN, "crm", JSON.stringify(ADAPTER))).status).toBe(200)
    const yaml = [
      "id: erp",
      "name: ERP",
      'version: "2"',
      "baseUrl: https://erp.example.com",
      "auth: { type: bearer }",
      "operations:",
      "  - name: list_stock",
      "    description: Stock.",
      "    kind: read",
      "    method: GET",
      "    path: /stock",
      "    params: { type: object, properties: { sku: { type: string } } }",
      '    query: { sku: "{sku}" }',
      "    fields: [sku, qty]",
      "    role: stock.check",
    ].join("\n")
    expect((await put(ADMIN, "erp", yaml, "text/yaml")).status).toBe(200)
    const res = await makeApp(MEMBER).request("/api/api-connector/adapters")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        readOnly: boolean
        connections: {
          identifier: string
          status: string
          roles: string[]
          auth: Record<string, string>
          operations: { name: string; kind: string; fields: string[] }[]
        }[]
      }
    }
    expect(body.data.readOnly).toBe(false)
    const data = body.data.connections
    expect(data.map((d) => d.identifier)).toEqual(["crm", "erp"])
    const crm = data[0]
    expect(crm?.status).toBe("needs_credentials")
    expect(crm?.roles).toEqual(["customer.lookup"])
    expect(crm?.auth).toEqual({ type: "apiKey", in: "header", name: "X-Api-Key" })
    expect(crm?.operations.map((o) => [o.name, o.kind])).toEqual([
      ["find_customer", "read"],
      ["create_note", "write"],
    ])
    expect(JSON.stringify(data)).not.toContain(KEY)
  })
})

describe("credentials for a connection (generic route, multiInstance)", () => {
  it("refuses credentials for an identifier with no adapter", async () => {
    const res = await postCredentials(ADMIN, {
      mode: "org",
      credentials: { identifier: "ghost", apiKey: KEY },
    })
    expect(res.status).toBe(404)
  })

  it("refuses fields the adapter's auth type does not take, and missing ones", async () => {
    expect(
      (
        await postCredentials(ADMIN, {
          mode: "org",
          credentials: { identifier: "crm", token: "t" },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await postCredentials(ADMIN, {
          mode: "org",
          credentials: { identifier: "crm", apiKey: KEY, token: "t" },
        })
      ).status,
    ).toBe(400)
  })

  it("refuses a member without accounts:admin", async () => {
    const res = await postCredentials(MEMBER, {
      mode: "org",
      credentials: { identifier: "crm", apiKey: KEY },
    })
    expect(res.status).toBe(403)
  })

  it("stores the settings form's shape and the connection becomes ok", async () => {
    const res = await postCredentials(ADMIN, {
      mode: "org",
      credentials: { identifier: "crm", apiKey: KEY },
    })
    expect(res.status).toBe(201)
    const list = await makeApp(MEMBER).request("/api/api-connector/adapters")
    const {
      data: { connections: data },
    } = (await list.json()) as { data: { connections: { identifier: string; status: string }[] } }
    expect(data.find((d) => d.identifier === "crm")?.status).toBe("ok")
    expect(data.find((d) => d.identifier === "erp")?.status).toBe("needs_credentials")
  })
})

describe("the customer-card tour feature", () => {
  it("is set up once a connection fills customer.lookup, not by the installed connector alone", async () => {
    // The installed connector alone offers adding a connection (connector-add),
    // never the customer card.
    const bare = await newOrg("api-connector-tour-feature")
    expect((await loadTourOrgContext(bare)).features).toEqual(["connector-add"])
    const withLookup = await newOrg("api-connector-tour-feature-lookup")
    expect(
      (await put(ADMIN, "crm", JSON.stringify(ADAPTER), "application/json", withLookup)).status,
    ).toBe(200)
    expect((await loadTourOrgContext(withLookup)).features).toEqual([
      "customer-card",
      "connector-add",
    ])
  })
})

describe("the api-connector tour's add beat (kernel/connected_account:create)", () => {
  it("saving a connection's credentials announces the event the beat binds, and it advances the owner's tour", async () => {
    const tour = findTour("api-connector.settings") as Tour
    const addBeat = tour.beats.find((b) => b.id === "add")
    expect(addBeat?.kind).toBe("do")
    const ctx = await loadTourOrgContext(ORG)
    const beats = tourBeats(tour, ctx)
    await withPrivilegedDb(ORG, "api-connector-tour-test", (tx) =>
      startTour(tx, {
        orgId: ORG,
        userId: USER,
        tour,
        beats,
        source: "cli",
        actor: { userId: USER, actorType: "user" },
        // The tour talks to the person's agent in their DM with it (talksToAgent).
        conversationId: crypto.randomUUID(),
      }),
    )
    const addIndex = beats.findIndex((b) => b.id === "add")
    await db.execute(drizzleSql`UPDATE kernel.tour_progress
      SET beat_id = 'add', beat_index = ${addIndex}
      WHERE org_id = ${ORG}::uuid AND user_id = ${USER}::uuid AND tour_id = ${tour.id}`)

    expect((await put(ADMIN, "tourcrm", JSON.stringify(ADAPTER))).status).toBe(200)
    const res = await postCredentials(ADMIN, {
      mode: "org",
      credentials: { identifier: "tourcrm", apiKey: KEY },
    })
    expect(res.status).toBe(201)

    const rows = extractRows<{ id: string; payload: AppEvent }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id, payload FROM kernel.pending_events
        WHERE org_id = ${ORG}::uuid AND payload->>'app' = 'kernel'
          AND payload->>'entity' = 'connected_account' AND payload->>'action' = 'create'
          AND payload->'data'->>'identifier' = 'tourcrm'`),
    )
    expect(rows).toHaveLength(1)
    const event = rows[0]!.payload
    expect(event.actorId).toBe(USER)
    expect(event.data).toMatchObject({ appName: "api-connector" })
    if (addBeat?.kind !== "do" || !addBeat.event) throw new Error("add beat has no binding")
    expect(bindingMatches(addBeat.event, event)).toBe(true)

    // One event for the whole add (the adapter save itself announces none): the beat completes.
    await handleTourProgressEvent({ eventId: rows[0]!.id, event })
    const [row] = extractRows<{
      beat_id: string | null
      beat_states: Record<string, TourBeatState>
    }>(
      await db.execute(drizzleSql`SELECT beat_id, beat_states FROM kernel.tour_progress
        WHERE org_id = ${ORG}::uuid AND user_id = ${USER}::uuid AND tour_id = ${tour.id}`),
    )
    // The tour moved on to the beat after "add" (today "ask").
    expect(beats[addIndex + 1]?.id).toBeDefined()
    expect(row?.beat_id).toBe(beats[addIndex + 1]?.id ?? "")
    const add = row?.beat_states.add
    expect(add && beatOutcome(add)).toBe("done")
  })
})

describe("POST /api/api-connector/adapters/:identifier/test", () => {
  it("runs a read operation and returns projected items", async () => {
    const res = await runTest(ADMIN, "crm", {
      operation: "find_customer",
      params: { email: "a@acme.test" },
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as {
      data: { ok: boolean; status: number; items: unknown[]; ms: number }
    }
    expect(data.ok).toBe(true)
    expect(data.status).toBe(200)
    expect(data.items).toEqual([{ id: "c1", name: "Acme Instruments" }])
    expect(seen).toEqual(["https://crm.example.com/api/companies?email=a%40acme.test"])
  })

  it("refuses a write operation with zero upstream requests", async () => {
    const res = await runTest(ADMIN, "crm", { operation: "create_note", params: { text: "hi" } })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("write_not_testable")
    expect(seen).toEqual([])
  })

  it("refuses a lookup with none of its filter params (an unfiltered page of every customer)", async () => {
    const res = await runTest(ADMIN, "crm", { operation: "find_customer", params: {} })
    expect(res.status).toBe(400)
    const { error } = (await res.json()) as { error: { code: string } }
    expect(error.code).toBe("invalid_params")
  })

  it("refuses a member", async () => {
    expect((await runTest(MEMBER, "crm", { operation: "find_customer", params: {} })).status).toBe(
      403,
    )
  })

  it("reports an upstream failure as a result with the status, never the body or key", async () => {
    OutboundFetchTestAccess.setFetch(
      (async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: `invalid key ${KEY}` }), {
          status: 401,
        })) as typeof fetch,
    )
    const res = await runTest(ADMIN, "crm", {
      operation: "find_customer",
      params: { email: "a@acme.test" },
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(KEY)
    const { data } = JSON.parse(text) as { data: { ok: boolean; status: number; code: string } }
    expect(data).toMatchObject({ ok: false, status: 401, code: "upstream_status" })
  })

  it("writes an audit row per call, from the operation name, with no secret", async () => {
    const rows = extractRows<{ action: string; metadata: Record<string, unknown> }>(
      await db.execute(
        drizzleSql`SELECT action, metadata FROM kernel.audit_log
          WHERE org_id = ${ORG}::uuid AND app = 'api-connector' ORDER BY "timestamp"`,
      ),
    )
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows[0]?.action).toBe("api-connector.test")
    expect(rows[0]?.metadata).toMatchObject({
      connection: "crm",
      operation: "find_customer",
      outcome: "success",
      status: 200,
    })
    expect(JSON.stringify(rows)).not.toContain(KEY)
    expect(JSON.stringify(rows)).not.toContain("crm.example.com")
  })
})

describe("cache invalidation", () => {
  it("drops a connection's cached entries on adapter PUT", async () => {
    const idx = `api-connector:keys:${ORG}:crm`
    await redis.sadd(idx, `api-connector:token:${ORG}:crm:x:y`)
    await redis.set(`api-connector:token:${ORG}:crm:x:y`, "stale", "EX", 60)
    expect((await put(ADMIN, "crm", JSON.stringify(ADAPTER))).status).toBe(200)
    expect(await redis.get(`api-connector:token:${ORG}:crm:x:y`)).toBeNull()
    expect(await redis.exists(idx)).toBe(0)
  })
})

describe("DELETE /api/api-connector/adapters/:identifier", () => {
  it("removes the adapter and its credentials", async () => {
    const res = await makeApp(ADMIN).request("/api/api-connector/adapters/crm", {
      method: "DELETE",
    })
    expect(res.status).toBe(200)
    const accounts = extractRows<{ n: number }>(
      await db.execute(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.connected_accounts
          WHERE org_id = ${ORG}::uuid AND app_name = 'api-connector' AND identifier = 'crm'`,
      ),
    )
    expect(accounts[0]?.n).toBe(0)
    const again = await makeApp(ADMIN).request("/api/api-connector/adapters/crm", {
      method: "DELETE",
    })
    expect(again.status).toBe(404)
  })
})

async function credentialCount(identifier: string): Promise<number> {
  const rows = extractRows<{ n: number }>(
    await db.execute(
      drizzleSql`SELECT count(*)::int AS n FROM kernel.connected_accounts
        WHERE org_id = ${ORG}::uuid AND app_name = 'api-connector' AND identifier = ${identifier}`,
    ),
  )
  return rows[0]?.n ?? 0
}

/** The PUT path segment that confirms the deletion of stored credentials. */
const CONFIRMED = (identifier: string) => `${identifier}?confirmCredentialWipe=true`

/** An admin of adapters who may NOT enter credentials. */
const ADAPTER_ADMIN = ["api-connector:read", "api-connector:admin"]

describe("adapter re-upload and the stored credential (P2-SK1)", () => {
  async function connectWith(identifier: string, adapter: unknown, credentials: unknown) {
    expect((await put(ADMIN, identifier, JSON.stringify(adapter))).status).toBe(200)
    const res = await postCredentials(ADMIN, {
      mode: "org",
      credentials: { identifier, ...(credentials as object) },
    })
    expect(res.status).toBe(201)
    expect(await credentialCount(identifier)).toBe(1)
  }

  it("a host change deletes the credential, and the old key never reaches the new host", async () => {
    await connectWith("mover", ADAPTER, { apiKey: KEY })
    const sent: { url: string; headers: string }[] = []
    OutboundFetchTestAccess.setFetch((async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), headers: JSON.stringify(init?.headers ?? {}) })
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch)
    const moved = { ...ADAPTER, baseUrl: "https://collector.example.net/api" }
    // Unconfirmed, the change is refused and the credential stays.
    expect((await put(ADAPTER_ADMIN, "mover", JSON.stringify(moved))).status).toBe(409)
    expect(await credentialCount("mover")).toBe(1)
    const res = await put(ADAPTER_ADMIN, CONFIRMED("mover"), JSON.stringify(moved))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { status: string } }
    expect(body.data.status).toBe("needs_credentials")
    expect(await credentialCount("mover")).toBe(0)
    const t = await runTest(ADMIN, "mover", {
      operation: "find_customer",
      params: { email: "a@acme.test" },
    })
    const { data } = (await t.json()) as { data: { ok: boolean; code?: string } }
    expect(data).toMatchObject({ ok: false, code: "not_configured" })
    expect(sent).toEqual([])
    expect(JSON.stringify(sent)).not.toContain(KEY)
  })

  it("clears it on every credential-target change, and keeps it on any other edit", async () => {
    const oauth = (auth: Record<string, unknown>) => ({
      ...ADAPTER,
      auth: { type: "oauth2ClientCredentials", ...auth },
    })
    const cases: [string, unknown, unknown, Record<string, string>][] = [
      [
        "port",
        ADAPTER,
        { ...ADAPTER, baseUrl: "https://crm.example.com:8443/api" },
        { apiKey: KEY },
      ],
      [
        "auth-in",
        ADAPTER,
        { ...ADAPTER, auth: { type: "apiKey", in: "query", name: "X-Api-Key" } },
        { apiKey: KEY },
      ],
      [
        "auth-name",
        ADAPTER,
        { ...ADAPTER, auth: { type: "apiKey", in: "header", name: "X-Other" } },
        { apiKey: KEY },
      ],
      [
        "token-url",
        oauth({ tokenUrl: "https://crm.example.com/oauth/token" }),
        oauth({ tokenUrl: "https://crm.example.com/other/token" }),
        { clientId: "cid", clientSecret: "csecret" },
      ],
      [
        "token-host",
        oauth({ tokenUrl: "https://crm.example.com/oauth/token" }),
        oauth({ tokenUrl: "https://login.example.net/token", tokenHost: "login.example.net" }),
        { clientId: "cid", clientSecret: "csecret" },
      ],
    ]
    for (const [id, before, after, creds] of cases) {
      await connectWith(id, before, creds)
      expect({ id, status: (await put(ADAPTER_ADMIN, id, JSON.stringify(after))).status }).toEqual({
        id,
        status: 409,
      })
      expect({ id, n: await credentialCount(id) }).toEqual({ id, n: 1 })
      expect((await put(ADAPTER_ADMIN, CONFIRMED(id), JSON.stringify(after))).status).toBe(200)
      expect({ id, n: await credentialCount(id) }).toEqual({ id, n: 0 })
    }
    await connectWith("keeper", ADAPTER, { apiKey: KEY })
    const edited = { ...ADAPTER, version: "1.1.0", description: "Renamed operations." }
    const res = await put(ADAPTER_ADMIN, "keeper", JSON.stringify(edited))
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe("ok")
    expect(await credentialCount("keeper")).toBe(1)
  })

  it("refuses a metadata or private token host at upload", async () => {
    for (const tokenHost of ["169.254.169.254", "10.0.0.5"]) {
      const res = await put(
        ADMIN,
        "tokhost",
        JSON.stringify({
          ...ADAPTER,
          auth: {
            type: "oauth2ClientCredentials",
            tokenUrl: `https://${tokenHost}/token`,
            tokenHost,
          },
        }),
      )
      expect(res.status).toBe(422)
      const body = (await res.json()) as { error: { issues: { path: string }[] } }
      expect(body.error.issues.map((i) => i.path)).toContain("auth.tokenHost")
    }
  })
})

describe("credential cache version (P2-SK11)", () => {
  it("is an HMAC of the account row id and update time under the server secret, never of the values", async () => {
    expect((await put(ADMIN, "ver", JSON.stringify(ADAPTER))).status).toBe(200)
    const post = () =>
      postCredentials(ADMIN, { mode: "org", credentials: { identifier: "ver", apiKey: KEY } })
    expect((await post()).status).toBe(201)
    const account = async () =>
      extractRows<{ id: string; updated_at: string | Date }>(
        await db.execute(
          drizzleSql`SELECT id, updated_at FROM kernel.connected_accounts
            WHERE org_id = ${ORG}::uuid AND app_name = 'api-connector' AND identifier = 'ver'`,
        ),
      )[0]
    const row = await account()
    const creds = await resolveConnectionCredentials(ORG, USER, "ver")
    expect(creds?.values).toEqual({ apiKey: KEY })
    const expected = createHmac("sha256", process.env.JWT_SECRET ?? "")
      .update(`api-connector-credential:${row?.id}:${new Date(row?.updated_at ?? 0).toISOString()}`)
      .digest("hex")
      .slice(0, 32)
    expect(creds?.version).toBe(expected)
    const unsalted = createHash("sha256")
      .update(JSON.stringify([["apiKey", KEY]]))
      .digest("hex")
      .slice(0, 16)
    expect(creds?.version).not.toContain(unsalted)
    await new Promise((r) => setTimeout(r, 5))
    expect((await post()).status).toBe(201)
    expect((await resolveConnectionCredentials(ORG, USER, "ver"))?.version).not.toBe(creds?.version)
  })
})

describe("demo orgs (C8)", () => {
  let demoOrg = ""
  beforeAll(async () => {
    demoOrg = await newOrg("api-connector-demo")
    await ensureAppsForOrg(demoOrg)
    await markOrgAsDemo(demoOrg, visitorMarker(24))
    DemoModeTestAccess.set(true)
    invalidateDemoMarker()
  }, 120_000)
  afterAll(() => {
    DemoModeTestAccess.set(null)
    invalidateDemoMarker()
  })

  const DEMO_REFUSAL =
    "This is a demo workspace: connections are pre-configured and cannot be changed."

  it("lists the connections as read-only, saying why (P2-V1)", async () => {
    const res = await makeApp(MEMBER, demoOrg).request("/api/api-connector/adapters")
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as {
      data: { readOnly: boolean; readOnlyReason?: string; connections: unknown[] }
    }
    expect(data.readOnly).toBe(true)
    expect(data.readOnlyReason).toBe("demo")
  })

  it("refuses adapter upload and removal, saying the connections cannot be changed", async () => {
    const up = await put(ADMIN, "crm", JSON.stringify(ADAPTER), "application/json", demoOrg)
    expect(up.status).toBe(403)
    expect(((await up.json()) as { error: { message: string } }).error.message).toBe(DEMO_REFUSAL)
    const del = await makeApp(ADMIN, demoOrg).request("/api/api-connector/adapters/crm", {
      method: "DELETE",
    })
    expect(del.status).toBe(403)
    expect(((await del.json()) as { error: { message: string } }).error.message).toBe(DEMO_REFUSAL)
  })

  it("refuses connection credentials", async () => {
    await db.execute(
      drizzleSql`INSERT INTO app_api_connector.adapters (org_id, identifier, adapter, adapter_version)
        VALUES (${demoOrg}::uuid, 'crm', ${JSON.stringify(ADAPTER)}::jsonb, '1.0.0')
        ON CONFLICT DO NOTHING`,
    )
    const res = await postCredentials(
      ADMIN,
      { mode: "org", credentials: { identifier: "crm", apiKey: KEY } },
      demoOrg,
    )
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(DEMO_REFUSAL)
  })
})

describe("adapter history routes", () => {
  const MOVED = { ...ADAPTER, version: "2.0.0", baseUrl: "https://other-crm.example.com/api" }

  async function versions(scopes: string[], identifier: string) {
    return makeApp(scopes).request(`/api/api-connector/adapters/${identifier}/versions`)
  }

  function restore(scopes: string[], identifier: string, body: unknown) {
    return makeApp(scopes).request(`/api/api-connector/adapters/${identifier}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  it("PUT refuses to delete credentials without the confirmation, and says when it deleted them", async () => {
    expect((await put(ADMIN, "wiped", JSON.stringify(ADAPTER))).status).toBe(200)
    await postCredentials(ADMIN, { mode: "org", credentials: { identifier: "wiped", apiKey: KEY } })
    const same = await put(ADMIN, "wiped", JSON.stringify({ ...ADAPTER, version: "1.0.1" }))
    expect(((await same.json()) as { data: { credentialsCleared: boolean } }).data).toMatchObject({
      credentialsCleared: false,
    })
    // A target change with credentials stored: refused until confirmed, both targets named.
    const refused = await put(ADMIN, "wiped", JSON.stringify(MOVED))
    expect(refused.status).toBe(409)
    const err = (await refused.json()) as {
      error: { code: string; priorTarget: string; newTarget: string }
    }
    expect(err.error.code).toBe("confirm_credential_wipe")
    expect(err.error.priorTarget).toContain("https://crm.example.com")
    expect(err.error.newTarget).toContain("https://other-crm.example.com")
    expect(await resolveConnectionCredentials(ORG, USER, "wiped")).not.toBeNull()
    const moved = await makeApp(ADMIN).request(
      "/api/api-connector/adapters/wiped?confirmCredentialWipe=true",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(MOVED),
      },
    )
    expect(moved.status).toBe(200)
    expect(((await moved.json()) as { data: { credentialsCleared: boolean } }).data).toMatchObject({
      credentialsCleared: true,
    })
    expect(await resolveConnectionCredentials(ORG, USER, "wiped")).toBeNull()
  })

  it("lists the kept versions to admins only, newest first, flagging a target change", async () => {
    expect((await put(ADMIN, "hist", JSON.stringify(ADAPTER))).status).toBe(200)
    expect((await put(ADMIN, "hist", JSON.stringify(MOVED))).status).toBe(200)
    expect((await versions(MEMBER, "hist")).status).toBe(403)
    const res = await versions(ADMIN, "hist")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        current: { adapterVersion: string }
        versions: { adapterVersion: string; targetDiffers: boolean; savedBy: string }[]
      }
    }
    expect(body.data.current.adapterVersion).toBe("2.0.0")
    expect(body.data.versions.map((v) => [v.adapterVersion, v.targetDiffers, v.savedBy])).toEqual([
      ["1.0.0", true, USER],
    ])
  })

  it("a restore that would delete credentials answers 409 naming both targets; confirmed, it restores and deletes them", async () => {
    expect((await put(ADMIN, "back", JSON.stringify(ADAPTER))).status).toBe(200)
    expect((await put(ADMIN, "back", JSON.stringify(MOVED))).status).toBe(200)
    await postCredentials(ADMIN, { mode: "org", credentials: { identifier: "back", apiKey: KEY } })
    expect(await resolveConnectionCredentials(ORG, USER, "back")).not.toBeNull()
    const list = (await (await versions(ADMIN, "back")).json()) as {
      data: { versions: { id: string }[] }
    }
    const versionId = list.data.versions[0]?.id ?? ""

    const refused = await restore(ADMIN, "back", { versionId })
    expect(refused.status).toBe(409)
    const err = (await refused.json()) as {
      error: { code: string; priorTarget: string; newTarget: string }
    }
    expect(err.error.code).toBe("confirm_credential_wipe")
    expect(err.error.priorTarget).toContain("https://other-crm.example.com")
    expect(err.error.newTarget).toContain("https://crm.example.com")
    expect(await resolveConnectionCredentials(ORG, USER, "back")).not.toBeNull()

    expect((await restore(MEMBER, "back", { versionId, confirmCredentialWipe: true })).status).toBe(
      403,
    )
    const ok = await restore(ADMIN, "back", { versionId, confirmCredentialWipe: true })
    expect(ok.status).toBe(200)
    const saved = (await ok.json()) as {
      data: { adapterVersion: string; credentialsCleared: boolean }
    }
    expect(saved.data).toMatchObject({ adapterVersion: "1.0.0", credentialsCleared: true })
    expect(await resolveConnectionCredentials(ORG, USER, "back")).toBeNull()
  })

  it("an unknown version is 404", async () => {
    expect((await put(ADMIN, "lost", JSON.stringify(ADAPTER))).status).toBe(200)
    const res = await restore(ADMIN, "lost", { versionId: crypto.randomUUID() })
    expect(res.status).toBe(404)
  })
})
