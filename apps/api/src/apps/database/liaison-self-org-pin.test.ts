// SPDX-License-Identifier: FSL-1.1-ALv2
// The liaison-self catalog reads a Liaison database through a login that bypasses
// row-level security. Its reads are therefore pinned to the caller's org, held to
// the app read scopes of the tables they touch, and keep to rows everyone in the
// org may see (org-wide knowledge documents, shared mailboxes).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ReadCatalog } from "@liaison/db-core"
import { env } from "~/lib/env"
import { SqlPoolTestAccess } from "~/modules/apps/connections/sql/pool"
import type { DbTransport, ProbeReport } from "~/modules/apps/connections/sql/transport"
import { resetOperatorOrgCache } from "~/modules/apps/operator-org"
import { liaisonSelfCatalog } from "./adapters/liaison-self"
import { buildDatabaseBridgeMethods, type DatabaseBridgeDeps } from "./bridge"

const CALLER_ORG = "00000000-0000-4000-8000-0000000d8001"
const OTHER_ORG = "00000000-0000-4000-8000-0000000d8002"

class RecordingTransport implements DbTransport {
  public reads: Array<{ name: string; params: Record<string, unknown> }> = []
  async probe(): Promise<ProbeReport> {
    return { ok: true, mode: "direct", warnings: [] }
  }
  async runRead(_read: unknown, name: string, params: Record<string, unknown>) {
    this.reads.push({ name, params })
    return { rows: [], truncated: false, durationMs: 1 }
  }
  async runQuery() {
    return { rows: [], truncated: false, durationMs: 1 }
  }
  async describe() {
    return { tables: [] }
  }
  async close() {}
}

function bridge(callerScopes: string[], catalog: ReadCatalog = liaisonSelfCatalog) {
  const transport = new RecordingTransport()
  const deps: DatabaseBridgeDeps = {
    orgId: CALLER_ORG,
    callerScopes,
    resolveCredentials: async () => ({ connectionString: "postgres://x:y@localhost/db" }),
    transportFactory: () => transport,
    resolveCatalog: () => catalog,
    writeAudit: async () => {},
  }
  return { methods: buildDatabaseBridgeMethods(deps), transport }
}

beforeEach(() => SqlPoolTestAccess.reset())
afterEach(() => SqlPoolTestAccess.reset())

describe("liaison-self reads", () => {
  test("run against the caller's org whatever orgId the caller passes", async () => {
    const { methods, transport } = bridge(["database:reads:read", "tickets:tickets:read"])
    await methods.db_read(
      JSON.stringify({
        name: "recent_tickets_by_status",
        params: { orgId: OTHER_ORG, status: "open" },
      }),
    )
    await methods.db_read(
      JSON.stringify({ name: "org_tier_and_slug", params: { orgId: OTHER_ORG } }),
    )
    expect(transport.reads.map((r) => r.params.orgId)).toEqual([CALLER_ORG, CALLER_ORG])
  })

  test("need the read scope of the app whose rows they return", async () => {
    const { methods, transport } = bridge(["database:reads:read"])
    const out = JSON.parse(
      await methods.db_read(
        JSON.stringify({ name: "knowledge_document_lookup", params: { titleQuery: "%a%" } }),
      ),
    )
    expect(out.error.code).toBe("forbidden")
    expect(out.error.message).toContain("knowledge:documents:read")
    expect(transport.reads).toHaveLength(0)
  })

  test("keep to org-wide documents, shared mailboxes and the caller's own org row", () => {
    expect(liaisonSelfCatalog.reads.knowledge_document_lookup.sql).toContain("AND org_wide")
    expect(liaisonSelfCatalog.reads.mail_thread_lookup_by_address.sql).toContain(
      "owner_type = 'org'",
    )
    expect(liaisonSelfCatalog.reads.org_tier_and_slug.sql).toContain("WHERE id = :orgId")
  })

  test("other catalogs keep their own params untouched", async () => {
    const custom: ReadCatalog = {
      adapter: "customer-shop",
      reads: {
        orders: {
          description: "orders",
          domain: "orders",
          sql: "SELECT id FROM shop.orders WHERE org = :orgId",
          params: { orgId: { type: "string" } },
          columns: ["id"],
          tables: ["shop.orders"],
        },
      },
    }
    const { methods, transport } = bridge(["database:reads:read"], custom)
    await methods.db_read(JSON.stringify({ name: "orders", params: { orgId: "acme" } }))
    expect(transport.reads[0].params.orgId).toBe("acme")
  })

  test("raw query over it is the instance operator org's only", async () => {
    const saved = env.LIAISON_OPERATOR_ORG_ID
    const set = (v: string | undefined) => {
      ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = v
      resetOperatorOrgCache()
    }
    try {
      set(OTHER_ORG)
      const refused = bridge(["database:query:read"])
      const out = JSON.parse(await refused.methods.db_query(JSON.stringify({ sql: "SELECT 1" })))
      expect(out.error).toBeDefined()
      set(CALLER_ORG)
      const allowed = bridge(["database:query:read"])
      const ok = JSON.parse(await allowed.methods.db_query(JSON.stringify({ sql: "SELECT 1" })))
      expect(ok.error).toBeUndefined()
    } finally {
      set(saved)
    }
  })
})
