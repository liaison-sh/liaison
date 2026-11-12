// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The database app over a fake ctx (test-ctx.ts): Report access (who may run
// each domain's reads), the db_* tools' answers, the provisioning handler and
// the knowledge source's paging.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { callerMayRun, parseStoredAccess, resolveRule } from "./access"
import * as handlers from "./handlers"
import { PAGE_SIZE, syncCatalogArticles } from "./knowledge"
import { provisionDatabase, reportAccessGet, reportAccessSet } from "./report-access"
import { asCtx, fakeCtx } from "./test-ctx"
import {
  compactListing,
  dbDescribe,
  dbListReads,
  dbQuery,
  dbRead,
  explain,
  onDatabaseConnected,
  parseConnection,
} from "./tools"

const MANIFEST = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))
const ROLE_FIN = "00000000-0000-4000-8000-0000000000f1"
const ROLE_OPS = "00000000-0000-4000-8000-0000000000f2"
const ANN = "00000000-0000-4000-8000-0000000000a1"
const BOB = "00000000-0000-4000-8000-0000000000b1"
const ROLES = [
  { id: ROLE_FIN, name: "finance" },
  { id: ROLE_OPS, name: "operations" },
]
const PEOPLE = [
  { id: ANN, name: "Ann", email: "ann@example.com" },
  { id: BOB, name: "Bob", email: "bob@example.com" },
]
const READS = {
  revenue_by_month: { domain: "revenue", description: "Revenue" },
  open_tickets: { domain: "support", description: "Tickets" },
}

describe("manifest", () => {
  it("every handler the manifest names is exported", () => {
    const names = [
      ...Object.values(MANIFEST.tools as Record<string, { handler: string }>).map((t) => t.handler),
      ...Object.values(MANIFEST.events.subscribes as Record<string, string>),
      ...Object.values(MANIFEST.knowledgeSources as Record<string, { handler: string }>).map(
        (k) => k.handler,
      ),
      MANIFEST.provisioning.handler,
    ]
    for (const name of names) {
      expect({ name, type: typeof (handlers as Record<string, unknown>)[name] }).toEqual({
        name,
        type: "function",
      })
    }
  })
})

describe("Report access rules", () => {
  it("an org rule wins over the catalog tier; neither means internal", () => {
    const tiers = { revenue: { tier: "confidential" as const } }
    expect(resolveRule("revenue", tiers, {}).source).toBe("catalog")
    expect(resolveRule("support", tiers, {})).toMatchObject({ tier: "internal", source: "default" })
    expect(resolveRule("revenue", tiers, { revenue: { tier: "internal" } })).toMatchObject({
      tier: "internal",
      source: "org",
    })
  })

  it("a stored rule that does not parse restricts its domain to nobody (fails closed)", () => {
    expect(parseStoredAccess({ revenue: { tier: "everyone" } })).toEqual({
      revenue: { tier: "restricted", users: [] },
    })
    expect(parseStoredAccess("nonsense")).toEqual({})
  })

  it("confidential runs for the named roles, restricted for the named people; admins pass", () => {
    const person = (roleIds: string[], holds: Record<string, boolean> = {}) =>
      ({ kind: "person", userId: ANN, roleIds, holds }) as const
    const conf = { tier: "confidential" as const, roles: [ROLE_FIN], users: [] }
    const restr = { tier: "restricted" as const, roles: [], users: [BOB] }
    expect(callerMayRun(person([ROLE_FIN]), conf)).toBe(true)
    expect(callerMayRun(person([ROLE_OPS]), conf)).toBe(false)
    expect(callerMayRun(person([ROLE_FIN]), restr)).toBe(false)
    expect(callerMayRun(person([], { "kernel:org:admin": true }), restr)).toBe(true)
    expect(callerMayRun(person([], { "database:query:read": true }), restr)).toBe(true)
    expect(callerMayRun({ kind: "system", holds: {} }, restr)).toBe(true)
  })
})

describe("db_list_reads and db_read", () => {
  const member = { kind: "person" as const, userId: ANN, roleIds: [ROLE_OPS], holds: {} }

  it("with no gated domain, nobody is looked up and every read is listed", async () => {
    const ctx = fakeCtx({ reads: READS })
    const out = await dbListReads({}, asCtx(ctx))
    expect(Object.keys(out.reads as object).sort()).toEqual(["open_tickets", "revenue_by_month"])
    expect(ctx.lookups.caller).toBe(0)
  })

  it("a read of a domain the caller may not run is left out, and refused by name", async () => {
    const ctx = fakeCtx({
      reads: READS,
      caller: member,
      stored: { revenue: { tier: "confidential", roles: [ROLE_FIN] } },
    })
    const listed = await dbListReads({}, asCtx(ctx))
    expect(Object.keys(listed.reads as object)).toEqual(["open_tickets"])
    const refused = await dbRead({ name: "revenue_by_month" }, asCtx(ctx))
    expect((refused.error as { code: string }).code).toBe("domain_restricted")
    expect(ctx.calls.filter((c) => c.method === "query")).toHaveLength(0)
  })

  it("the catalog's own tier gates a domain the org set no rule for", async () => {
    const ctx = fakeCtx({
      reads: READS,
      caller: member,
      domains: { revenue: { tier: "confidential" } },
    })
    const refused = await dbRead({ name: "revenue_by_month" }, asCtx(ctx))
    expect((refused.error as { code: string }).code).toBe("domain_restricted")
  })

  it("an allowed read runs with the statement timeout and row cap and returns its rows", async () => {
    const ctx = fakeCtx({
      reads: READS,
      query: () => ({ rows: [{ n: 1 }], truncated: false, durationMs: 2 }),
    })
    const out = await dbRead({ name: "open_tickets", params: { status: "open" } }, asCtx(ctx))
    expect(out).toEqual({ rows: [{ n: 1 }], truncated: false })
    expect(ctx.calls.at(-1)).toEqual({
      method: "query",
      connection: "database",
      request: {
        read: "open_tickets",
        params: { status: "open" },
        timeoutMs: 55_000,
        maxRows: 2_000,
      },
    })
  })

  it("an unknown read lists the valid names", async () => {
    const out = await dbRead({ name: "nope" }, asCtx(fakeCtx({ reads: READS })))
    expect(out.error).toMatchObject({
      code: "unknown_read",
      validNames: ["revenue_by_month", "open_tickets"],
    })
  })
})

describe("db_query, db_describe and the warehouse", () => {
  it("the warehouse needs database:query:read on every tool", async () => {
    const ctx = fakeCtx({ scopes: [] })
    const out = await dbDescribe({ connection: "warehouse" }, asCtx(ctx))
    expect((out.error as { code: string }).code).toBe("forbidden")
    expect(ctx.calls).toHaveLength(0)
    const ok = fakeCtx({ scopes: ["database:query:read"] })
    await dbQuery({ sql: "SELECT 1", connection: "warehouse" }, asCtx(ok))
    expect(ok.calls[0]).toMatchObject({ method: "query", connection: "warehouse" })
  })

  it("an empty sql is refused before any call; an unknown connection names the valid ones", async () => {
    const ctx = fakeCtx()
    expect(
      ((await dbQuery({ sql: " " }, asCtx(ctx))) as { error: { code: string } }).error.code,
    ).toBe("invalid_params")
    expect(parseConnection("other")).toMatchObject({ error: { code: "unknown_connection" } })
    expect(parseConnection(undefined)).toBe("default")
    expect(ctx.calls).toHaveLength(0)
  })

  it("a timeout tells the agent to narrow the query instead of retrying it", () => {
    const out = explain({ error: { code: "statement_timeout", message: "timed out" } }, "query")
    expect(out.error).toMatchObject({ code: "statement_timeout", retryable: false })
    expect(String((out.error as { message: string }).message)).toContain("Narrow it")
  })

  it("a malformed value is invalid_params, by its SQLSTATE", () => {
    const out = explain(
      { error: { code: "execution", message: "bad uuid", sqlstate: "22P02" } },
      "read",
    )
    expect((out.error as { code: string }).code).toBe("invalid_params")
  })

  it("db_describe with no table lists tables only, filtered by schema or search", () => {
    const tables = [
      { table: "public.orders", columns: [1, 2] },
      { table: "sales.dealers", columns: [1] },
    ]
    expect(compactListing(tables, "sales", undefined).tables).toEqual([
      { table: "sales.dealers", columnCount: 1 },
    ])
    expect(compactListing(tables, undefined, "ORD").tables).toEqual([
      { table: "public.orders", columnCount: 2 },
    ])
  })

  it("a table that is not readable lists what is", async () => {
    const ctx = fakeCtx({
      schema: (_c, req) =>
        req.table ? { tables: [] } : { tables: [{ table: "public.orders", columns: [] }] },
    })
    const out = await dbDescribe({ table: "public.secrets" }, asCtx(ctx))
    expect(out.error).toMatchObject({
      code: "table_not_readable",
      readableTables: ["public.orders"],
    })
  })

  it("the connect-time probe runs on the connection that was saved and never throws", async () => {
    const ctx = fakeCtx({ probe: () => ({ ok: false, warnings: ["write grant"] }) })
    await onDatabaseConnected(
      { data: { appName: "database", connectionName: "warehouse" } },
      asCtx(ctx),
    )
    expect(ctx.calls[0]).toMatchObject({ method: "probe", connection: "warehouse" })
    expect(ctx.logs[0]?.level).toBe("warn")
    await onDatabaseConnected({ data: { appName: "other" } }, asCtx(ctx))
    expect(ctx.calls).toHaveLength(1)
  })
})

describe("Report access settings and provisioning", () => {
  it("the view lists each catalog domain with its reads, default and effective tier", async () => {
    const ctx = fakeCtx({
      reads: READS,
      domains: { revenue: { tier: "confidential" } },
      roles: ROLES,
      people: PEOPLE,
      stored: { support: { tier: "restricted", users: [BOB] } },
    })
    const view = await reportAccessGet({}, asCtx(ctx))
    expect(view.domains.map((d) => [d.domain, d.catalogTier, d.effectiveTier])).toEqual([
      ["revenue", "confidential", "confidential"],
      ["support", null, "restricted"],
    ])
    expect(view.members).toEqual([{ id: BOB, name: "Bob", email: "bob@example.com" }])
  })

  it("a save naming a role of another org is refused and writes nothing", async () => {
    const ctx = fakeCtx({ roles: ROLES, people: PEOPLE })
    const out = await reportAccessSet(
      { domainAccess: { revenue: { tier: "confidential", roles: [BOB] } } },
      asCtx(ctx),
    )
    expect((out as { error: { code: string } }).error.code).toBe("invalid_params")
    expect(ctx.docs.size).toBe(0)
  })

  it("provisioning resolves role names and emails, and a re-apply changes nothing", async () => {
    const ctx = fakeCtx({ roles: ROLES, people: PEOPLE })
    const config = {
      domainAccess: {
        revenue: { tier: "confidential" as const, roles: ["finance"] },
        dealers: { tier: "restricted" as const, users: ["ANN@example.com"] },
      },
    }
    const dry = await provisionDatabase({ config, dryRun: true }, asCtx(ctx))
    expect(dry.changed).toEqual(["domainAccess: dealers, revenue"])
    expect(ctx.docs.size).toBe(0)
    await provisionDatabase({ config, dryRun: false }, asCtx(ctx))
    expect(ctx.docs.get("settings/domain_access")?.data).toEqual({
      value: {
        revenue: { tier: "confidential", roles: [ROLE_FIN] },
        dealers: { tier: "restricted", users: [ANN] },
      },
    })
    expect((await provisionDatabase({ config, dryRun: false }, asCtx(ctx))).changed).toEqual([])
  })

  it("provisioning an unknown role fails the apply", async () => {
    const ctx = fakeCtx({ roles: ROLES })
    await expect(
      provisionDatabase(
        {
          config: { domainAccess: { x: { tier: "confidential", roles: ["ghosts"] } } },
          dryRun: false,
        },
        asCtx(ctx),
      ),
    ).rejects.toThrow("unknown role 'ghosts'")
  })
})

describe("knowledge source `catalog`", () => {
  const READS_KB = { knowledge_sync_list: {}, knowledge_sync_get: {} }

  it("pages by (updated_at, id) and hands the next cursor back", async () => {
    const list = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: `a${i}`,
      title: `T${i}`,
      updated_at: "2026-01-01T00:00:00.000Z",
    }))
    const ctx = fakeCtx({
      reads: READS_KB,
      query: (_c, req) =>
        req.read === "knowledge_sync_list"
          ? { rows: list, truncated: false, durationMs: 1 }
          : {
              rows: [
                {
                  id: (req.params as { id: string }).id,
                  title: "T",
                  body: "B",
                  updated_at: "2026-01-01",
                },
              ],
              truncated: false,
              durationMs: 1,
            },
    })
    const page = await syncCatalogArticles({ cursor: null } as never, asCtx(ctx))
    expect(page.done).toBe(false)
    expect(page.nextCursor).toEqual({
      updated_at: "2026-01-01T00:00:00.000Z",
      id: `a${PAGE_SIZE - 1}`,
    })
    expect(page.documents?.upsert?.[0]).toMatchObject({
      externalId: "a0",
      body: "B",
      mimeType: "text/markdown",
    })
    const first = ctx.calls.find((c) => c.method === "query")?.request as { params: unknown }
    expect(first.params).toEqual({ after_updated_at: null, after_id: null, limit: PAGE_SIZE })
  })

  it("a catalog without the knowledge reads syncs nothing and is done", async () => {
    const page = await syncCatalogArticles({ cursor: null } as never, asCtx(fakeCtx({ reads: {} })))
    expect(page).toEqual({ done: true, nextCursor: null })
  })
})
