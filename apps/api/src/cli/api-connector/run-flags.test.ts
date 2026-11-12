// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison api-connector test` flags against the real database, with the
// outbound fetch seam as the API: `--pages N` / `--all-pages` walk a cursor,
// `--dry-run` prints a write's rendered request (auth redacted, `{$now}`
// filled) and sends nothing.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { type Adapter, validateAdapter } from "@liaison/api-connector-core"
import { sql as drizzleSql } from "drizzle-orm"
import { invalidateConnectionCaches } from "~/modules/apps/connections/api/cache"
import { upsertAdapterRow } from "~/modules/apps/connections/api/store"
import { describeRequest } from "~/modules/apps/connections/api/transport"
import { parseTestFlags, runApiConnectorTest } from "~/cli/api-connector/run"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const TOKEN = "tok_flags_SECRET_91"
const ID = "paged"

const API: Adapter = (() => {
  const r = validateAdapter({
    id: "paged",
    name: "Paged API",
    version: "1",
    baseUrl: "https://api.paged.example",
    auth: { type: "bearer" },
    operations: [
      {
        name: "list_companies",
        description: "All companies.",
        kind: "read",
        method: "GET",
        path: "/companies",
        params: { type: "object", properties: {} },
        query: { limit: "2" },
        pagination: {
          type: "cursor",
          param: "after",
          cursorPointer: "/paging/next/after",
          maxPages: 3,
        },
        items: "/results",
        fields: { id: "id", name: "properties.name" },
      },
      {
        name: "add_note",
        description: "A note on a company.",
        kind: "write",
        method: "POST",
        path: "/notes",
        params: {
          type: "object",
          properties: { customerId: { type: "string" }, text: { type: "string" } },
          required: ["customerId", "text"],
        },
        body: {
          properties: { body: "{text}", timestamp: "{$now}" },
          associations: [{ to: { id: "{customerId}" } }],
        },
        items: "",
        fields: ["id"],
      },
    ],
  })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.adapter
})()

let ORG = ""
let SLUG = ""
let USER = ""
let seen: string[] = []
let lookupSpy: ReturnType<typeof spyOn>

function page(url: URL): Response {
  const after = Number(url.searchParams.get("after") ?? "0")
  const results = [after + 1, after + 2].map((n) => ({
    id: String(n),
    properties: { name: `Co ${n}` },
  }))
  return new Response(
    JSON.stringify({
      results,
      ...(after < 10 ? { paging: { next: { after: String(after + 2) } } } : {}),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

beforeAll(async () => {
  await acquireTestLock()
  SLUG = `cli-flags-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'cli-flags', ${SLUG}) RETURNING id`,
    ),
  )
  ORG = org?.id ?? ""
  const [u] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${ORG}::uuid, ${`flags-${Date.now()}@api-connector.test`},
                'Admin', 'active', 'h', 1, 1)
        RETURNING id`,
    ),
  )
  USER = u?.id ?? ""
  await ensureAppsForOrg(ORG)
  await upsertAdapterRow(ORG, ID, API, USER)
  await withPrivilegedDb(ORG, "cli-flags-test", (tx) =>
    createCredentialConnection(tx, ORG, USER, "api-connector", "api", {
      identifier: ID,
      credentials: { token: TOKEN },
      ownerType: "org",
    }),
  )
}, 180_000)

afterAll(async () => {
  await invalidateConnectionCaches(ORG, ID)
  resetAppRegistries()
  await releaseTestLock()
})

beforeEach(() => {
  seen = []
  lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation((async () => [
    { address: "93.184.216.34", family: 4 },
  ]) as never)
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request) => {
    const url = new URL(String(input))
    seen.push(`${url.pathname}${url.search}`)
    return page(url)
  }) as typeof fetch)
})

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
  lookupSpy.mockRestore()
})

const run = (operation: string, argv: string[]) =>
  runApiConnectorTest({ identifier: ID, operation, argv, orgSlug: SLUG })

describe("parseTestFlags", () => {
  it("reads --pages, --all-pages and --dry-run, and refuses a bad page count", () => {
    expect(parseTestFlags([])).toEqual({ ok: true, flags: { pages: 1, dryRun: false } })
    expect(parseTestFlags(["--pages", "3"])).toEqual({
      ok: true,
      flags: { pages: 3, dryRun: false },
    })
    expect(parseTestFlags(["--all-pages", "--dry-run"])).toEqual({
      ok: true,
      flags: { pages: "all", dryRun: true },
    })
    expect(parseTestFlags(["--pages", "9"]).ok).toBe(false)
    expect(parseTestFlags(["--pages"]).ok).toBe(false)
    expect(parseTestFlags(["--pages", "2", "--all-pages"]).ok).toBe(false)
  })
})

describe("api-connector test: pages", () => {
  it("fetches one page by default", async () => {
    const r = await run("list_companies", [])
    expect(r.exitCode).toBe(0)
    expect(r.report).toMatchObject({ ok: true, pages: 1 })
    expect(seen).toEqual(["/companies?limit=2"])
  })

  it("follows the cursor for --pages N", async () => {
    const r = await run("list_companies", ["--pages", "2"])
    expect(r.report).toMatchObject({ ok: true, pages: 2 })
    expect((r.report as { items: unknown[] }).items).toHaveLength(4)
    expect(seen).toEqual(["/companies?limit=2", "/companies?limit=2&after=2"])
  })

  it("stops at the operation's maxPages for --all-pages", async () => {
    const r = await run("list_companies", ["--all-pages"])
    expect(r.report).toMatchObject({ ok: true, pages: 3 })
    expect((r.report as { items: { name: string }[] }).items.map((i) => i.name)).toEqual([
      "Co 1",
      "Co 2",
      "Co 3",
      "Co 4",
      "Co 5",
      "Co 6",
    ])
  })
})

describe("api-connector test: --dry-run", () => {
  it("prints a write's rendered request, auth redacted, and sends nothing", async () => {
    const r = await run("add_note", [
      "--dry-run",
      "--param",
      "customerId=9001",
      "--param",
      "text=Called about the order",
    ])
    expect(r.exitCode).toBe(0)
    const report = r.report as {
      ok: boolean
      dryRun: boolean
      kind: string
      request: { method: string; url: string; headers: Record<string, string>; body: unknown }
    }
    expect(report).toMatchObject({ ok: true, dryRun: true, kind: "write" })
    expect(report.request.method).toBe("POST")
    expect(report.request.url).toBe("https://api.paged.example/notes")
    expect(report.request.headers.authorization).toBe("Bearer REDACTED")
    const body = report.request.body as {
      properties: { body: string; timestamp: string }
      associations: unknown
    }
    expect(body.properties.body).toBe("Called about the order")
    expect(Number.isNaN(Date.parse(body.properties.timestamp))).toBe(false)
    expect(body.associations).toEqual([{ to: { id: "9001" } }])
    expect(JSON.stringify(r.report)).not.toContain(TOKEN)
    expect(seen).toEqual([])
  })

  it("refuses a write without --dry-run, and bad params with it, before any request", async () => {
    const write = await run("add_note", ["--param", "customerId=1", "--param", "text=x"])
    expect(write.report).toMatchObject({ ok: false, code: "write_not_testable" })
    const bad = await run("add_note", ["--dry-run", "--param", "customerId=1"])
    expect(bad.report).toMatchObject({ ok: false, code: "invalid_params" })
    expect(seen).toEqual([])
  })

  it("redacts an apiKey sent in the query or a header", () => {
    const op = API.operations[0]
    if (!op) throw new Error("no op")
    const inQuery = describeRequest(
      { ...API, auth: { type: "apiKey", in: "query", name: "hapikey" } },
      op,
      {},
    )
    expect(inQuery.url).toBe("https://api.paged.example/companies?limit=2&hapikey=REDACTED")
    const inHeader = describeRequest(
      { ...API, auth: { type: "apiKey", in: "header", name: "X-Api-Key" } },
      op,
      {},
    )
    expect(inHeader.headers["x-api-key"]).toBe("REDACTED")
  })
})
