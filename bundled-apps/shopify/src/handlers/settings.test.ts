// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B14 — settings_load + connection_disconnect handler tests.
//
// The mock ctx is table-backed (mirrors connection.test.ts / scope-seed.test.ts)
// so we exercise the REAL data-shaping logic against app-owned tables. The
// returned bundle must match the `SettingsBundle` contract the Settings UI
// (src/ui/settings.tsx) consumes.
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { connectionDisconnect, settingsLoad } from "./settings"
import manifest from "../../app.manifest.json"

type StoredRow = { id: string } & Record<string, unknown>

interface MockCtx {
  ctx: AppContext
  tables: Map<string, StoredRow[]>
  updates: Array<{ entity: string; id: string; data: Record<string, unknown> }>
  fetchBodies: Array<{ status?: number; body: unknown }>
}

function makeCtx(preload: Record<string, StoredRow[]> = {}, fetchBodies: Array<{ status?: number; body: unknown }> = []): MockCtx {
  const tables = new Map<string, StoredRow[]>()
  const updates: Array<{ entity: string; id: string; data: Record<string, unknown> }> = []
  const responses = [...fetchBodies]
  for (const [k, v] of Object.entries(preload)) tables.set(k, [...v])
  let counter = 1
  const ctx = {
    userId: "u",
    orgId: "o",
    db: {
      findMany: async (
        entity: string,
        opts?: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number },
      ): Promise<unknown[]> => {
        let rows = [...(tables.get(entity) ?? [])]
        if (opts?.where) {
          rows = rows.filter((r) =>
            Object.entries(opts.where!).every(([k, v]) => r[k] === v),
          )
        }
        if (opts?.orderBy) {
          const entry = Object.entries(opts.orderBy)[0]
          if (entry) {
            const [k, dir] = entry
            rows.sort((a, b) => {
              const av = String(a[k] ?? "")
              const bv = String(b[k] ?? "")
              return dir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv)
            })
          }
        }
        if (opts?.limit !== undefined) rows = rows.slice(0, opts.limit)
        return rows
      },
      findOne: async (entity: string, id: string) =>
        (tables.get(entity) ?? []).find((r) => r.id === id) ?? null,
      insert: async (entity: string, data: Record<string, unknown>) => {
        const id = `${entity}-${counter++}`
        const row = { id, ...data } as StoredRow
        tables.set(entity, [...(tables.get(entity) ?? []), row])
        return { id }
      },
      update: async (entity: string, id: string, data: Record<string, unknown>) => {
        updates.push({ entity, id, data })
        const arr = tables.get(entity) ?? []
        const idx = arr.findIndex((r) => r.id === id)
        if (idx >= 0) arr[idx] = { ...arr[idx], ...data, id } as StoredRow
      },
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async (entity: string) => (tables.get(entity) ?? []).length,
    },
    emit: async () => {},
    enqueueJob: async () => undefined,
    resolveContact: async () => ({}),
    connections: {
      shop: {
        getAccounts: async () => [
          { id: "ca1", ownerType: "org" as const, ownerId: null, identifier: "demo.myshopify.com", displayName: null },
        ],
        getToken: async () => "test-token",
      },
    },
    fetch: async () => {
      const next = responses.shift() ?? { body: {} }
      return { status: next.status ?? 200, headers: {}, body: JSON.stringify(next.body) }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agent_run: async () => "{}",
    realtime_publish: async () => "{}",
    grants_setUserScopes: async () => JSON.stringify({ ok: true }),
    bulk: {
      fetchToBlob: async () => ({ blobId: "x", sizeBytes: 0 }),
      iterateJsonl: async function* () {},
      deleteBlob: async () => undefined,
    },
  } as unknown as AppContext
  return { ctx, tables, updates, fetchBodies: responses }
}

const NOW = Date.now()
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

describe("settingsLoad", () => {
  // X3d: the mock ctx's `connections.shop` (see makeCtx above) always carries
  // an active Shopify account, mirroring a connected shop whose install_metadata
  // row is missing because the connect event was lost. settings_load is
  // readOnly, so it must resolve that the same way home_load does
  // (resolveInstallMetadata, in-memory only) rather than report "disconnected"
  // while home_load reports connected. No install_metadata row is ever written.
  it("resolves a missing row from the active connection and reports connected, without inserting", async () => {
    const { ctx, tables } = makeCtx({})
    const bundle = await settingsLoad({}, ctx)
    expect(bundle.connection.status).toBe("connected")
    expect(bundle.connection.shopDomain).toBe("demo.myshopify.com")
    expect(bundle.connection.connectedAt).toBeNull()
    expect(bundle.connection.scopesKnown).toBe(false)
    expect(bundle.connection.missingScopes).toEqual([])
    expect(bundle.mappings).toEqual([])
    expect(bundle.inventoryAllowlist).toEqual([])
    expect(bundle.seedAvailable).toBe(false)
    expect(bundle.diagnostics.backfillStatus).toBe("idle")
    expect(bundle.diagnostics.staffMirrorLastSyncedAt).toBeNull()
    // Read-only: settings_load must never persist the self-heal.
    expect(tables.get("install_metadata") ?? []).toHaveLength(0)
  })

  it("returns disconnected with empty blocks when neither a row nor an active connection exists", async () => {
    const { ctx, tables } = makeCtx({})
    ;(ctx as { connections: Record<string, unknown> }).connections = {}
    const bundle = await settingsLoad({}, ctx)
    expect(bundle.connection).toEqual({
      status: "disconnected",
      shopDomain: null,
      connectedAt: null,
      scopesKnown: false,
      missingScopes: [],
    })
    expect(bundle.mappings).toEqual([])
    expect(bundle.inventoryAllowlist).toEqual([])
    expect(bundle.seedAvailable).toBe(false)
    expect(bundle.seedSuggestions).toEqual([])
    expect(bundle.diagnostics.backfillStatus).toBe("idle")
    expect(bundle.diagnostics.staffMirrorLastSyncedAt).toBeNull()
    expect(tables.get("install_metadata") ?? []).toHaveLength(0)
  })

  it("reports connected with shop domain + connectedAt", async () => {
    const { ctx } = makeCtx({
      install_metadata: [
        {
          id: "i1",
          shopDomain: "demo.myshopify.com",
          connectionStatus: "connected",
          installedAt: iso(-86_400_000),
          inventoryLocationAllowlist: null,
          consecutiveScopeMirrorFailures: 0,
        },
      ],
    }, [{ body: { errors: [{ message: "Access denied" }] } }])
    const bundle = await settingsLoad({}, ctx)
    expect(bundle.connection.status).toBe("connected")
    expect(bundle.connection.shopDomain).toBe("demo.myshopify.com")
    expect(bundle.connection.connectedAt).toBe(iso(-86_400_000))
  })

  it("derives needs_reconnect from a scope-mirror failure run even when status is connected", async () => {
    const { ctx } = makeCtx({
      install_metadata: [
        {
          id: "i1",
          shopDomain: "demo.myshopify.com",
          connectionStatus: "connected",
          installedAt: iso(-1000),
          consecutiveScopeMirrorFailures: 5,
        },
      ],
    })
    const bundle = await settingsLoad({}, ctx)
    expect(bundle.connection.status).toBe("needs_reconnect")
    // needs_reconnect is a declared enum value in install_metadata.connectionStatus
    const enumVals = manifest.schema.install_metadata.fields.connectionStatus.enum as string[]
    expect(enumVals).toContain("needs_reconnect")
  })

  it("treats Shopify's normalized grant (write_X implies read_X) as satisfying read scopes", async () => {
    // Shopify's token response OMITS read scopes implied by a granted write
    // scope. This grant is exactly what a real store returns for the full
    // manifest request minus the two Shopify-gated scopes, from a store connected
    // before read_locations was requested: only those may be reported missing
    // (read_locations is not implied by read_inventory or write_inventory).
    const { ctx } = makeCtx({
      install_metadata: [
        {
          id: "i1",
          shopDomain: "demo.myshopify.com",
          connectionStatus: "connected",
          installedAt: iso(-1000),
          consecutiveScopeMirrorFailures: 0,
          grantedOAuthScopes: [
            "read_markets",
            "write_customers",
            "write_discounts",
            "write_draft_orders",
            "write_fulfillments",
            "write_inventory",
            "write_orders",
            "write_products",
            "write_publications",
            "write_returns",
          ],
        },
      ],
    }, [{ body: { errors: [{ message: "Access denied" }] } }])
    const bundle = await settingsLoad({}, ctx)
    expect(bundle.connection.scopesKnown).toBe(true)
    expect(bundle.connection.missingScopes).toEqual([
      "read_locations",
      "read_merchant_managed_fulfillment_orders",
      "write_merchant_managed_fulfillment_orders",
      "read_companies",
      "read_reports",
      // Requested since 0.4.23 (products_merge's redirect): a grant from before it lacks it.
      "write_online_store_navigation",
    ])
  })

  it("honours an explicit disconnected status", async () => {
    const { ctx } = makeCtx({
      install_metadata: [
        { id: "i1", shopDomain: "demo.myshopify.com", connectionStatus: "disconnected" },
      ],
    })
    const bundle = await settingsLoad({}, ctx)
    expect(bundle.connection.status).toBe("disconnected")
  })

  it("builds identity-mapping rows: override > auto > unmapped", async () => {
    const { ctx } = makeCtx({
      install_metadata: [{ id: "i1", shopDomain: "demo.myshopify.com", connectionStatus: "disconnected" }],
      staff_mirror: [
        { id: "m1", shopifyStaffId: "s1", email: "auto@x", mappedLiaisonUserId: "u-auto", lastSyncedAt: iso(-2000) },
        { id: "m2", shopifyStaffId: "s2", email: "override@x", mappedLiaisonUserId: "u-stale", lastSyncedAt: iso(-1000) },
        { id: "m3", shopifyStaffId: "s3", email: "unmapped@x", mappedLiaisonUserId: null, lastSyncedAt: iso(-3000) },
      ],
      staff_overrides: [{ id: "o1", shopifyStaffId: "s2", liaisonUserId: "u-override" }],
    })
    const bundle = await settingsLoad({}, ctx)
    const byStaff = new Map(bundle.mappings.map((m) => [m.shopifyStaffId, m]))
    expect(byStaff.get("s1")).toMatchObject({ source: "auto", liaisonUserId: "u-auto" })
    // Override wins over the stale auto mapping.
    expect(byStaff.get("s2")).toMatchObject({ source: "override", liaisonUserId: "u-override" })
    expect(byStaff.get("s3")).toMatchObject({ source: "unmapped", liaisonUserId: "" })
    // staffMirrorLastSyncedAt is the most recent of the mirror rows.
    expect(bundle.diagnostics.staffMirrorLastSyncedAt).toBe(iso(-1000))
  })

  it("counts only processed/failed webhook deliveries inside the trailing 24h window", async () => {
    const { ctx } = makeCtx({
      install_metadata: [{ id: "i1", shopDomain: "demo.myshopify.com", connectionStatus: "disconnected" }],
      webhook_deliveries: [
        { id: "w1", status: "processed", receivedAt: iso(-3_600_000) }, // 1h ago — in window
        { id: "w2", status: "failed", receivedAt: iso(-7_200_000) }, // 2h ago — in window
        { id: "w3", status: "processed", receivedAt: iso(-25 * 3_600_000) }, // 25h — out
        { id: "w4", status: "processing", receivedAt: iso(-1000) }, // in window but not counted
      ],
    })
    const bundle = await settingsLoad({}, ctx)
    expect(bundle.diagnostics.webhookDeliveriesProcessed24h).toBe(1)
    expect(bundle.diagnostics.webhookDeliveriesFailed24h).toBe(1)
  })

  it("surfaces customer backfill status + cursor", async () => {
    const { ctx } = makeCtx({
      install_metadata: [{ id: "i1", shopDomain: "demo.myshopify.com", connectionStatus: "disconnected" }],
      // entityType must match the value written by the backfill-customers handler ("customers", plural).
      backfill_progress: [{ id: "b1", entityType: "customers", status: "running", cursorExternalId: "cur-42" }],
    })
    const bundle = await settingsLoad({}, ctx)
    expect(bundle.diagnostics.backfillStatus).toBe("running")
    expect(bundle.diagnostics.backfillCursor).toBe("cur-42")
  })

  it("parses a JSON-string inventory allowlist", async () => {
    const { ctx } = makeCtx({
      install_metadata: [
        {
          id: "i1",
          shopDomain: "demo.myshopify.com",
          connectionStatus: "disconnected",
          inventoryLocationAllowlist: JSON.stringify(["gid://loc/1", "gid://loc/2"]),
        },
      ],
    })
    const bundle = await settingsLoad({}, ctx)
    expect(bundle.inventoryAllowlist).toEqual(["gid://loc/1", "gid://loc/2"])
  })

  it("populates seed suggestions from the Plus-only probe when connected", async () => {
    const { ctx } = makeCtx(
      {
        install_metadata: [{ id: "i1", shopDomain: "demo.myshopify.com", connectionStatus: "connected", connectionId: "ca1", apiVersion: "2026-04" }],
        staff_overrides: [{ id: "o1", shopifyStaffId: "s1", liaisonUserId: "u-marie" }],
      },
      [
        // capabilityDetectSeed probe
        { body: { data: { staffMembers: { edges: [{ node: { id: "s1", email: "marie@x" } }] } } } },
        // full staff fetch
        {
          body: {
            data: {
              staffMembers: {
                edges: [{ node: { id: "s1", email: "marie@x", permissions: ["refund_orders"] } }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      ],
    )
    const bundle = await settingsLoad({}, ctx)
    expect(bundle.seedAvailable).toBe(true)
    expect(bundle.seedSuggestions).toContainEqual({
      liaisonUserId: "u-marie",
      shopifyStaffEmail: "marie@x",
      scopes: ["shopify:refunds:create"],
    })
  })
})

describe("connectionDisconnect", () => {
  it("flips install_metadata.connectionStatus to disconnected", async () => {
    const { ctx, updates } = makeCtx({
      install_metadata: [{ id: "i1", shopDomain: "demo.myshopify.com", connectionStatus: "connected" }],
    })
    const result = await connectionDisconnect({}, ctx)
    expect(result).toEqual({ ok: true, status: "disconnected" })
    expect(updates).toContainEqual({
      entity: "install_metadata",
      id: "i1",
      data: { connectionStatus: "disconnected" },
    })
    // settingsLoad now reports disconnected.
    const bundle = await settingsLoad({}, ctx)
    expect(bundle.connection.status).toBe("disconnected")
  })

  it("is a no-op (still ok) when there is no install_metadata row", async () => {
    const { ctx, updates } = makeCtx({})
    const result = await connectionDisconnect({}, ctx)
    expect(result).toEqual({ ok: true, status: "disconnected" })
    expect(updates).toEqual([])
  })
})

describe("manifest tool declarations", () => {
  it("declares settings_load as a read-only (ungated) tool wired to settingsLoad", () => {
    const t = (manifest.tools as Record<string, { handler: string; gated?: boolean } | undefined>)
      .settings_load
    expect(t).toBeDefined()
    expect(t?.handler).toBe("settingsLoad")
    expect(t?.gated ?? false).toBe(false)
  })

  it("declares connection_disconnect as a gated user-trust-boundary tool wired to connectionDisconnect", () => {
    const t = (
      manifest.tools as Record<
        string,
        { handler: string; gated?: boolean; trustBoundary?: string } | undefined
      >
    ).connection_disconnect
    expect(t).toBeDefined()
    expect(t?.handler).toBe("connectionDisconnect")
    expect(t?.gated).toBe(true)
    expect(t?.trustBoundary).toBe("user")
  })
})

describe("read_users connection split (Gap #2 — non-Plus stores must not fail closed)", () => {
  const shop = (
    manifest.connections as Record<string, { scopes: string[]; optionalScopes?: string[] } | undefined>
  ).shop

  it("the base OAuth connection does NOT hard-require the Plus-only read_users scope", () => {
    // Real (non-Plus) stores reject an OAuth grant that asks for read_users.
    // The base connection scope set must therefore exclude it so install
    // succeeds on every store.
    expect(shop?.scopes).not.toContain("read_users")
  })

  it("preserves the scope-seed capability by declaring read_users as an optional scope", () => {
    // The Plus-only re-seed path still needs read_users; it is requested only
    // through this optional path, never as part of the base grant.
    expect(shop?.optionalScopes ?? []).toContain("read_users")
  })

  it("still requests the core read/write scopes on the base connection", () => {
    for (const s of ["read_orders", "write_orders", "read_customers", "read_products"]) {
      expect(shop?.scopes).toContain(s)
    }
  })
})
