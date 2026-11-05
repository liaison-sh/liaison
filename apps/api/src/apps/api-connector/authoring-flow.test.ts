// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The authoring chain an agent runs to connect a CRM, offline, against the
// fixture CRM: read the guide, save the adapter (approved by an admin), see
// the test fail for want of credentials, store them through the credentials
// route, test again, then read through `connector_read` as a member. The
// fixture's request handler stands in for the network behind the outbound
// fetch seam; DNS is faked. Nothing leaves the process.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { validateAdapter } from "@liaison/api-connector-core"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { errorHandler } from "~/middleware/error-handler"
import { apiConnectorRoutes } from "~/modules/api-connector/routes"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { connectionRoutes } from "~/modules/apps/connections/routes"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool } from "~/modules/apps/sandbox/pool"
import { createScope } from "~/modules/permissions/types"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { loadFixtureCrmAdapter } from "./__fixtures__/fixture-crm/adapter"
import { createFixtureCrmHandler, type FixtureCrmHandler } from "./__fixtures__/fixture-crm/handler"
import { invalidateConnectionCaches } from "./cache"
import { upsertAdapterRow } from "./store"

const KEY = "fixture-flow-KEY-8812"
const BASE_URL = "https://crm.fixture.example/v1"
const ADMIN = [
  "api-connector:read",
  "api-connector:write",
  "api-connector:admin",
  "api-connector:accounts:admin",
]
const MEMBER = ["api-connector:read", "api-connector:write"]

let ORG = ""
let REQUESTER = ""
let APPROVER = ""
let crm: FixtureCrmHandler
let lookupSpy: ReturnType<typeof spyOn>

function actor(scopes: string[], userId = REQUESTER) {
  return { actorType: "user" as const, userId, orgId: ORG, scopes, dimensionGrants: {} }
}

async function call(tool: string, params: Record<string, unknown>, scopes = ADMIN) {
  return executeTool({
    toolName: `api-connector:${tool}`,
    orgId: ORG,
    actor: actor(scopes),
    params,
  })
}

function routes(scopes: string[]) {
  const app = new Hono<AppEnv>()
  app.onError(errorHandler)
  app.use("*", async (c, next) => {
    c.set("orgId", ORG)
    c.set("userId", REQUESTER)
    c.set("scopes", scopes.map(createScope))
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/api-connector", apiConnectorRoutes)
  app.route("/api/connections", connectionRoutes)
  return app
}

async function newAdmin(label: string): Promise<string> {
  const { userId } = await ensureUser({
    orgId: ORG,
    email: `${label}-${Date.now()}@authoring-flow.test`,
    name: label,
    password: "Passw0rd!",
    role: "admin",
  })
  return userId
}

beforeAll(async () => {
  await acquireTestLock()
  ORG = (await ensureOrg({ slug: `authoring-flow-${Date.now()}`, name: "Authoring Flow" })).orgId
  REQUESTER = await newAdmin("requester")
  APPROVER = await newAdmin("approver")
  await ensureAppsForOrg(ORG)
  await initSandboxPool()
}, 180_000)

afterAll(async () => {
  await invalidateConnectionCaches(ORG, "crm")
  resetAppRegistries()
  await releaseTestLock()
})

beforeEach(() => {
  crm = createFixtureCrmHandler({ apiKey: KEY })
  lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation((async () => [
    { address: "93.184.216.34", family: 4 },
  ]) as never)
  // The fixture CRM answers every request the transport sends to BASE_URL's host.
  OutboundFetchTestAccess.setFetch((async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input))
    if (url.host !== "crm.fixture.example") return new Response("unexpected host", { status: 599 })
    return crm.handle(new Request(url.toString(), init))
  }) as typeof fetch)
})

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
  lookupSpy.mockRestore()
})

describe("connecting the fixture CRM through the authoring tools", () => {
  it("guide, save (approved), credentials, test, read", async () => {
    // 1. The guide: the overview names the steps.
    const guide = (await call("connector_adapter_reference", {})) as { data: { text: string } }
    expect(guide.data.text).toContain("request_secret")

    // 2. The save parks for an admin's approval; approved, it is stored.
    const adapter = loadFixtureCrmAdapter({ baseUrl: BASE_URL })
    const staged = (await call("connector_adapter_save", { identifier: "crm", adapter })) as {
      blocked?: { approvalRequestId?: string }
    }
    const approvalId = staged.blocked?.approvalRequestId ?? ""
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/)
    await decideApproval({
      orgId: ORG,
      requestId: approvalId,
      actor: { ...actor(["*"], APPROVER) },
      decision: "approve",
    })
    const stored = (await call("connector_adapter_get", { identifier: "crm" })) as {
      data: { adapter: { baseUrl: string }; status: string }
    }
    expect(stored.data.adapter.baseUrl).toBe(BASE_URL)
    expect(stored.data.status).toBe("needs_credentials")

    // 3. Testing before the credentials says so, without any request.
    const early = (await call("connector_adapter_test", {
      identifier: "crm",
      operation: "find_customers",
      params: { email: "jane.doe@acme-instruments.example" },
    })) as { data: { ok: boolean; code?: string } }
    expect(early.data).toMatchObject({ ok: false, code: "not_configured" })
    expect(crm.requests).toEqual([])

    // 4. The credentials, through the generic credentials route (what the secret card posts to).
    const saved = await routes(ADMIN).request("/api/connections/api-connector/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "org", credentials: { identifier: "crm", apiKey: KEY } }),
    })
    expect(saved.status).toBeLessThan(300)

    // 5. The test answers with the allow-listed fields only.
    const tested = (await call("connector_adapter_test", {
      identifier: "crm",
      operation: "find_customers",
      params: { email: "jane.doe@acme-instruments.example" },
    })) as { data: { ok: boolean; count: number; items: string } }
    expect(tested.data.ok).toBe(true)
    expect(tested.data.count).toBeGreaterThan(0)
    expect(tested.data.items).toContain("Acme Instruments")
    expect(tested.data.items).not.toContain("internal_notes")
    expect(JSON.stringify(tested)).not.toContain(KEY)

    // 6. A member reads through the saved connection like any connector call.
    const read = (await call(
      "connector_read",
      {
        connection: "crm",
        operation: "find_customers",
        params: { email: "jane.doe@acme-instruments.example" },
      },
      MEMBER,
    )) as { data: { count: number; items: string } }
    expect(read.data.count).toBeGreaterThan(0)
    expect(read.data.items).toContain("Acme Instruments")
    expect(crm.requests.every((r) => r.includes("/v1/companies"))).toBe(true)
  })

  it("a test the API refuses says FAILED and carries the API's own error text", async () => {
    // Runs on the connection the first case saved, with its credentials.
    OutboundFetchTestAccess.setFetch(
      (async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            status: "error",
            message:
              "Invalid input JSON on line 1, column 1: No content to map due to end-of-input",
            echo: KEY,
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    )
    const tested = (await call("connector_adapter_test", {
      identifier: "crm",
      operation: "find_customers",
      params: { email: "jane.doe@acme-instruments.example" },
    })) as {
      data: {
        ok: boolean
        result: string
        status: number
        code: string
        vendorError: string
        next: string
      }
    }
    expect(tested.data).toMatchObject({
      ok: false,
      result: "FAILED",
      status: 400,
      code: "upstream_status",
    })
    expect(tested.data.vendorError).toContain("No content to map due to end-of-input")
    expect(tested.data.vendorError).toStartWith('<external-content source="untrusted">')
    expect(tested.data.next).toContain("FAILED")
    expect(tested.data.next).toContain("vendorError")
    expect(JSON.stringify(tested)).not.toContain(KEY)
  })

  it("a stored adapter saved before the read-POST body rule still lists and tests, with a warning", async () => {
    // Written as an older release stored it: a search POST whose param goes
    // nowhere (no body, no query), which a save now refuses.
    const legacy = {
      id: "legacy-crm",
      name: "Legacy CRM",
      version: "1.0.0",
      baseUrl: BASE_URL,
      auth: { type: "apiKey", in: "header", name: "X-Api-Key" },
      operations: [
        {
          name: "search_companies",
          description: "Search companies.",
          kind: "read",
          method: "POST",
          readOnlyPost: true,
          path: "/companies/search",
          params: { type: "object", properties: { q: { type: "string" } } },
          items: "/data",
          fields: ["id"],
        },
      ],
    }
    // A save refuses it; a stored read accepts it (with the rule as a warning).
    expect(validateAdapter(legacy).ok).toBe(false)
    const stored = validateAdapter(legacy, { stored: true })
    if (!stored.ok) throw new Error(JSON.stringify(stored.issues))
    await upsertAdapterRow(ORG, "legacy", stored.adapter, REQUESTER)
    const saved = await routes(ADMIN).request("/api/connections/api-connector/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "org", credentials: { identifier: "legacy", apiKey: KEY } }),
    })
    expect(saved.status).toBeLessThan(300)

    const listed = (await call("connector_list_operations", { connection: "legacy" })) as {
      data: {
        connections: Array<{ connection: string; operations: unknown[]; warnings?: string[] }>
      }
    }
    const row = listed.data.connections[0]
    expect(row?.operations).toHaveLength(1)
    expect(row?.warnings?.join(" ")).toContain("{q} would be sent nowhere")
    const got = (await call("connector_adapter_get", { identifier: "legacy" })) as {
      data: { warnings?: string[] }
    }
    expect(got.data.warnings?.join(" ")).toContain("operations.0.body")

    OutboundFetchTestAccess.setFetch(
      (async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [{ id: "c-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    )
    const tested = (await call("connector_adapter_test", {
      identifier: "legacy",
      operation: "search_companies",
      params: { q: "acme" },
    })) as { data: { ok: boolean; count: number } }
    expect(tested.data).toMatchObject({ ok: true, count: 1 })
  })
})
