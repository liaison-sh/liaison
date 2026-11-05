// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-domain read access: the resolver (who passes which tier, catalog default
// vs org rule) and its enforcement in the bridge (db_list_reads omits, db_read
// refuses), against a mock transport. The no-config case must be exactly
// today's output: nobody loses access on a deployment that configured nothing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ReadCatalog } from "@liaison/db-core"
import { validateCatalog } from "@liaison/db-core"
import type { DatabaseDomainAccess } from "@liaison/shared"
import {
  buildDatabaseBridgeMethods,
  type DatabaseBridgeDeps,
  DatabaseBridgeTestAccess,
} from "./bridge"
import {
  callerMayRunDomain,
  type DomainAccessCaller,
  parseStoredDomainAccess,
  resolveDomainRule,
} from "./domain-access"
import type { DbTransport, ProbeReport } from "./transport"

const FINANCE = "11111111-1111-4111-8111-111111111111"
const SUPPORT = "22222222-2222-4222-8222-222222222222"
const ALICE = "33333333-3333-4333-8333-333333333333"
const BOB = "44444444-4444-4444-8444-444444444444"

function read(domain: string) {
  return {
    description: `${domain} read`,
    domain,
    sql: "SELECT id FROM s.t",
    params: {},
    columns: ["id"],
    tables: ["s.t"],
  }
}

const plainCatalog: ReadCatalog = {
  adapter: "plain",
  reads: {
    revenue_by_month: read("revenue"),
    open_returns: read("returns"),
    top_customers: read("customers"),
  },
}

const tieredCatalog: ReadCatalog = {
  ...plainCatalog,
  adapter: "tiered",
  domains: { revenue: { tier: "confidential" }, customers: { tier: "restricted" } },
}

function person(
  over: Partial<Extract<DomainAccessCaller, { kind: "person" }>> = {},
): DomainAccessCaller {
  return {
    kind: "person",
    userId: BOB,
    roleIds: [SUPPORT],
    scopes: ["database:reads:read"],
    ...over,
  }
}

describe("resolveDomainRule", () => {
  test("no org rule and no catalog tier: internal", () => {
    expect(resolveDomainRule("revenue", plainCatalog, {})).toEqual({
      tier: "internal",
      roles: [],
      users: [],
      source: "default",
    })
  })

  test("an unknown domain is internal", () => {
    expect(resolveDomainRule("never-declared", tieredCatalog, {}).tier).toBe("internal")
  })

  test("the catalog default applies without an org rule", () => {
    expect(resolveDomainRule("revenue", tieredCatalog, {})).toMatchObject({
      tier: "confidential",
      roles: [],
      source: "catalog",
    })
  })

  test("an org rule overrides the catalog default, both ways", () => {
    const org: DatabaseDomainAccess = {
      revenue: { tier: "internal" },
      returns: { tier: "confidential", roles: [FINANCE] },
    }
    expect(resolveDomainRule("revenue", tieredCatalog, org).tier).toBe("internal")
    expect(resolveDomainRule("returns", tieredCatalog, org)).toMatchObject({
      tier: "confidential",
      roles: [FINANCE],
      source: "org",
    })
  })

  test("a key on Object.prototype is not a rule", () => {
    expect(resolveDomainRule("constructor", plainCatalog, {}).tier).toBe("internal")
  })
})

describe("callerMayRunDomain", () => {
  const confidential = { tier: "confidential" as const, roles: [FINANCE], users: [] }
  const restricted = { tier: "restricted" as const, roles: [], users: [ALICE] }

  test("internal: every caller", () => {
    expect(callerMayRunDomain(person(), { tier: "internal", roles: [], users: [] })).toBe(true)
  })

  test("confidential: only a holder of a listed role", () => {
    expect(callerMayRunDomain(person(), confidential)).toBe(false)
    expect(callerMayRunDomain(person({ roleIds: [SUPPORT, FINANCE] }), confidential)).toBe(true)
  })

  test("restricted: only a listed person, whatever their roles", () => {
    expect(callerMayRunDomain(person({ roleIds: [FINANCE] }), restricted)).toBe(false)
    expect(callerMayRunDomain(person({ userId: ALICE, roleIds: [] }), restricted)).toBe(true)
  })

  test("org admins pass every tier", () => {
    const admin = person({ scopes: ["*"], roleIds: [] })
    expect(callerMayRunDomain(admin, confidential)).toBe(true)
    expect(callerMayRunDomain(admin, restricted)).toBe(true)
    expect(callerMayRunDomain(person({ scopes: ["kernel:org:admin"] }), restricted)).toBe(true)
  })

  test("holders of database:query:read pass every tier", () => {
    const dbAdmin = person({ scopes: ["database:reads:read", "database:query:read"] })
    expect(callerMayRunDomain(dbAdmin, confidential)).toBe(true)
    expect(callerMayRunDomain(dbAdmin, restricted)).toBe(true)
    expect(callerMayRunDomain(person({ scopes: ["database:*"] }), restricted)).toBe(true)
  })

  test("the system actor passes every tier", () => {
    expect(callerMayRunDomain({ kind: "system" }, restricted)).toBe(true)
  })
})

describe("parseStoredDomainAccess", () => {
  test("absent: no rules", () => {
    expect(parseStoredDomainAccess(undefined)).toEqual({})
    expect(parseStoredDomainAccess(null)).toEqual({})
  })

  test("a malformed entry fails closed to restricted with nobody listed", () => {
    const parsed = parseStoredDomainAccess({
      revenue: { tier: "secret" },
      returns: { tier: "confidential", roles: [FINANCE] },
    })
    expect(parsed.revenue).toEqual({ tier: "restricted", users: [] })
    expect(parsed.returns).toEqual({ tier: "confidential", roles: [FINANCE] })
  })
})

describe("catalog schema", () => {
  test("a catalog without domains parses as before; one with domains keeps them", () => {
    expect(validateCatalog(plainCatalog).domains).toBeUndefined()
    expect(validateCatalog(tieredCatalog).domains).toEqual(tieredCatalog.domains)
  })
})

// ---------------------------------------------------------------- the bridge

class MockTransport implements DbTransport {
  runReadCalls: string[] = []
  async probe(): Promise<ProbeReport> {
    return { ok: true, mode: "direct", warnings: [] }
  }
  async runRead(_read: unknown, name: string) {
    this.runReadCalls.push(name)
    return { rows: [{ id: 1 }], truncated: false, durationMs: 1 }
  }
  async runQuery() {
    return { rows: [], truncated: false, durationMs: 1 }
  }
  async describe() {
    return { tables: [] }
  }
  async close() {}
}

function makeDeps(opts: {
  catalog: ReadCatalog
  orgRules?: DatabaseDomainAccess
  caller?: DomainAccessCaller
  noDomainAccess?: boolean
}) {
  const transport = new MockTransport()
  const audit: { action: string; outcome: string; metadata: Record<string, unknown> }[] = []
  const lookups = { orgRules: 0, caller: 0 }
  const deps: DatabaseBridgeDeps = {
    // Its own org: transports are pooled per org, and each bridge keeps its own.
    orgId: `org-${crypto.randomUUID()}`,
    callerScopes: ["database:reads:read"],
    resolveCredentials: async () => ({ connectionString: "postgres://x:y@localhost/db" }),
    transportFactory: () => transport,
    resolveCatalog: () => opts.catalog,
    writeAudit: async (entry) => {
      audit.push(entry)
    },
    ...(opts.noDomainAccess
      ? {}
      : {
          domainAccess: {
            loadOrgRules: async () => {
              lookups.orgRules++
              return opts.orgRules ?? {}
            },
            loadCaller: async () => {
              lookups.caller++
              return opts.caller ?? person()
            },
          },
        }),
  }
  return { methods: buildDatabaseBridgeMethods(deps), transport, audit, lookups }
}

beforeEach(() => DatabaseBridgeTestAccess.resetTransportPool())
afterEach(() => DatabaseBridgeTestAccess.resetTransportPool())

describe("no tier configured anywhere: exactly today's behaviour", () => {
  test("db_list_reads and db_read answer byte for byte what a bridge without domain access answers", async () => {
    const before = makeDeps({ catalog: plainCatalog, noDomainAccess: true })
    const after = makeDeps({ catalog: plainCatalog })
    expect(await after.methods.db_list_reads?.("{}")).toBe(
      (await before.methods.db_list_reads?.("{}")) as string,
    )
    for (const name of Object.keys(plainCatalog.reads)) {
      const p = JSON.stringify({ name, params: {} })
      expect(await after.methods.db_read?.(p)).toBe((await before.methods.db_read?.(p)) as string)
    }
    const unknown = JSON.stringify({ name: "nope" })
    expect(await after.methods.db_read?.(unknown)).toBe(
      (await before.methods.db_read?.(unknown)) as string,
    )
    expect(after.transport.runReadCalls).toEqual(before.transport.runReadCalls)
    expect(after.audit).toEqual(before.audit)
    // Nothing about the caller was looked up: no tier means no cost.
    expect(after.lookups.caller).toBe(0)
  })

  test("an org rule that sets every domain internal changes nothing either", async () => {
    const before = makeDeps({ catalog: plainCatalog, noDomainAccess: true })
    const after = makeDeps({ catalog: plainCatalog, orgRules: { revenue: { tier: "internal" } } })
    expect(await after.methods.db_list_reads?.("{}")).toBe(
      (await before.methods.db_list_reads?.("{}")) as string,
    )
  })
})

describe("db_list_reads omits reads the caller may not run", () => {
  test("catalog defaults hide confidential and restricted domains from a plain member", async () => {
    const { methods } = makeDeps({ catalog: tieredCatalog })
    const listed = JSON.parse((await methods.db_list_reads?.("{}")) as string)
    expect(Object.keys(listed.reads)).toEqual(["open_returns"])
  })

  test("a holder of a granted role sees the confidential domain", async () => {
    const { methods } = makeDeps({
      catalog: tieredCatalog,
      orgRules: { revenue: { tier: "confidential", roles: [FINANCE] } },
      caller: person({ roleIds: [FINANCE] }),
    })
    const listed = JSON.parse((await methods.db_list_reads?.("{}")) as string)
    expect(Object.keys(listed.reads).sort()).toEqual(["open_returns", "revenue_by_month"])
  })

  test("an admin sees everything", async () => {
    const { methods } = makeDeps({ catalog: tieredCatalog, caller: person({ scopes: ["*"] }) })
    const listed = JSON.parse((await methods.db_list_reads?.("{}")) as string)
    expect(Object.keys(listed.reads).sort()).toEqual(Object.keys(plainCatalog.reads).sort())
  })
})

describe("db_read refuses a hidden read", () => {
  test("typed domain_restricted error, nothing run, audit blocked", async () => {
    const { methods, transport, audit } = makeDeps({ catalog: tieredCatalog })
    const out = JSON.parse(
      (await methods.db_read?.(JSON.stringify({ name: "revenue_by_month" }))) as string,
    )
    expect(out.error.code).toBe("domain_restricted")
    expect(out.error.domain).toBe("revenue")
    expect(out.error.message).toContain("restricted")
    expect(out.error.message).toContain("Report access")
    expect(transport.runReadCalls).toEqual([])
    expect(audit.at(-1)).toMatchObject({
      action: "database.read",
      outcome: "blocked",
      metadata: { read: "revenue_by_month", redactedReason: "domain_restricted" },
    })
  })

  test("an unknown read never names hidden reads among the valid ones", async () => {
    const { methods } = makeDeps({ catalog: tieredCatalog })
    const out = JSON.parse((await methods.db_read?.(JSON.stringify({ name: "nope" }))) as string)
    expect(out.error.validNames).toEqual(["open_returns"])
  })

  test("a listed person runs a restricted read; the lookups happen once per call", async () => {
    const { methods, transport, lookups } = makeDeps({
      catalog: tieredCatalog,
      orgRules: { customers: { tier: "restricted", users: [ALICE] } },
      caller: person({ userId: ALICE, roleIds: [] }),
    })
    const out = JSON.parse(
      (await methods.db_read?.(JSON.stringify({ name: "top_customers" }))) as string,
    )
    expect(out.rows).toEqual([{ id: 1 }])
    expect(transport.runReadCalls).toEqual(["top_customers"])
    expect(lookups).toEqual({ orgRules: 1, caller: 1 })
  })

  test("the system actor runs any read", async () => {
    const { methods } = makeDeps({ catalog: tieredCatalog, caller: { kind: "system" } })
    const out = JSON.parse(
      (await methods.db_read?.(JSON.stringify({ name: "top_customers" }))) as string,
    )
    expect(out.rows).toBeDefined()
  })

  test("a failed access lookup fails closed with a config error", async () => {
    const transport = new MockTransport()
    const methods = buildDatabaseBridgeMethods({
      orgId: "org-1",
      callerScopes: ["database:reads:read"],
      resolveCredentials: async () => ({ connectionString: "postgres://x:y@localhost/db" }),
      transportFactory: () => transport,
      resolveCatalog: () => tieredCatalog,
      writeAudit: async () => {},
      domainAccess: {
        loadOrgRules: async () => {
          throw new Error("db down")
        },
        loadCaller: async () => person(),
      },
    })
    const out = JSON.parse(
      (await methods.db_read?.(JSON.stringify({ name: "open_returns" }))) as string,
    )
    expect(out.error.code).toBe("config_error")
    expect(transport.runReadCalls).toEqual([])
  })
})
