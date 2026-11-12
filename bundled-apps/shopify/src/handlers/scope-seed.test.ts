// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B10 — Plus-conditional one-shot scope-seed handler tests.
//
// We exercise:
//   - mapStaffPermissionsToScopes (pure mapper)
//   - capabilityDetectSeed (probe; access-denied / non-empty edges)
//   - scopeSeedJob (suggestions; never writes; conflicts; 401)
//   - applySeedSuggestion (admin apply; idempotent)
//
// The mock `ctx.db` is intentionally permissive ("entity" is just a string)
// so we can stage rows in tables that, in production, are kernel-owned (the
// mock simulates the kernel-side user-by-email lookup that scope-seed needs).
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import manifest from "../../app.manifest.json"
import { mapStaffPermissionsToScopes } from "../lib/staff-permissions-map"
import { applySeedSuggestion, capabilityDetectSeed, scopeSeedJob } from "./scope-seed"

interface FetchResponse {
  status?: number
  body: unknown
}

interface GrantCall {
  userId: string
  scopes: string[]
}

interface DbRow extends Record<string, unknown> {
  id: string
}

function makeCtx(opts: {
  shopifyFetch?: FetchResponse | FetchResponse[]
  preload?: Record<string, DbRow[]>
}): {
  ctx: AppContext
  grants: { calls: GrantCall[] }
  db: Map<string, DbRow[]>
  events: Array<{ entity: string; action: string }>
} {
  const responses = Array.isArray(opts.shopifyFetch)
    ? [...opts.shopifyFetch]
    : opts.shopifyFetch !== undefined
      ? [opts.shopifyFetch]
      : []
  const grantCalls: GrantCall[] = []
  const events: Array<{ entity: string; action: string }> = []
  const tables = new Map<string, DbRow[]>()
  // Always pre-seed install_metadata so getClient() resolves.
  tables.set("install_metadata", [
    {
      id: "i1",
      shopDomain: "demo.myshopify.com",
      connectionId: "ca1",
      apiVersion: "2026-04",
    } as DbRow,
  ])
  if (opts.preload) {
    for (const [k, v] of Object.entries(opts.preload)) tables.set(k, [...v])
  }

  let counter = 1
  const ctx = {
    userId: "u",
    orgId: "o",
    db: {
      findMany: async (entity: string, query?: { where?: Record<string, unknown> }) => {
        const rows = tables.get(entity) ?? []
        if (!query?.where) return rows
        return rows.filter((row) => {
          for (const [k, v] of Object.entries(query.where!)) {
            if (row[k] !== v) return false
          }
          return true
        })
      },
      findOne: async (entity: string, id: string) => {
        return (tables.get(entity) ?? []).find((r) => r.id === id) ?? null
      },
      insert: async (entity: string, data: Record<string, unknown>) => {
        const id = `${entity}-${counter++}`
        const row = { id, ...data } as DbRow
        tables.set(entity, [...(tables.get(entity) ?? []), row])
        return { id }
      },
      update: async (entity: string, id: string, data: Record<string, unknown>) => {
        const rows = tables.get(entity) ?? []
        const idx = rows.findIndex((r) => r.id === id)
        if (idx >= 0) rows[idx] = { ...rows[idx], ...data } as DbRow
      },
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async (entity: string) => (tables.get(entity) ?? []).length,
    },
    emit: (async (ev: { entity: string; action: string }) => {
      events.push({ entity: ev.entity, action: ev.action })
    }) as AppContext["emit"],
    enqueueJob: async () => undefined,
    resolveContact: async () => ({}),
    connections: {
      shop: {
        getAccounts: async () => [
          {
            id: "ca1",
            ownerType: "org" as const,
            ownerId: null,
            identifier: "demo.myshopify.com",
            displayName: null,
          },
        ],
        getToken: async () => "test-token",
      },
    },
    fetch: async (_url: string) => {
      const next = responses.shift() ?? { body: {} }
      return { status: next.status ?? 200, headers: {}, body: JSON.stringify(next.body) }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agent_run: async () => "{}",
    realtime_publish: async () => "{}",
    grants_setUserScopes: (async (userId: string, scopesJson: string) => {
      grantCalls.push({ userId, scopes: JSON.parse(scopesJson) as string[] })
      return JSON.stringify({ ok: true })
    }) as AppContext["grants_setUserScopes"],
    bulk: {
      fetchToBlob: async () => ({ blobId: "x", sizeBytes: 0 }),
      iterateJsonl: async function* () {},
      deleteBlob: async () => undefined,
    },
  } as unknown as AppContext
  return { ctx, grants: { calls: grantCalls }, db: tables, events }
}

const MARIE_ID = "11111111-1111-1111-1111-111111111111"
const BOB_ID = "22222222-2222-2222-2222-222222222222"

describe("mapStaffPermissionsToScopes", () => {
  it("'full' grants the union of shopify:* scopes", () => {
    const scopes = mapStaffPermissionsToScopes({ permissions: ["full"] })
    expect(scopes).toEqual(
      expect.arrayContaining([
        "shopify:orders:read",
        "shopify:orders:write",
        "shopify:refunds:create",
        "shopify:products:read",
        "shopify:products:write",
        "shopify:customers:read",
        "shopify:customers:write",
      ]),
    )
  })

  it("granular permissions → specific shopify:* scopes", () => {
    const scopes = mapStaffPermissionsToScopes({
      permissions: ["refund_orders", "write_products"],
    })
    expect(scopes).toContain("shopify:refunds:create")
    expect(scopes).toContain("shopify:products:write")
    expect(scopes).not.toContain("shopify:customers:write")
  })

  it("empty permissions → empty set", () => {
    expect(mapStaffPermissionsToScopes({ permissions: [] })).toEqual([])
  })

  it("unknown permissions are ignored (no throw)", () => {
    const scopes = mapStaffPermissionsToScopes({ permissions: ["unknown_perm", "read_orders"] })
    expect(scopes).toContain("shopify:orders:read")
    expect(scopes.length).toBe(1)
  })

  // Property test (C4, M5 follow-up): every scope returned by the mapper for
  // any permission must appear in app.manifest.json#scopes. This catches
  // snake/kebab drift between the mapper and the manifest declaration.
  it("every scope emitted is declared in manifest.scopes (no snake/kebab drift)", () => {
    const declared = new Set<string>(manifest.scopes as readonly string[])
    const fullScopes = mapStaffPermissionsToScopes({ permissions: ["full"] })
    for (const scope of fullScopes) {
      expect(declared.has(scope), `scope "${scope}" not in manifest.scopes`).toBe(true)
    }
    // Walk every granular permission too — covers permissions whose scopes
    // might not appear under "full" because they're admin-only.
    for (const perm of [
      "read_orders",
      "write_orders",
      "refund_orders",
      "read_products",
      "write_products",
      "read_customers",
      "write_customers",
      "read_inventory",
      "write_inventory",
      "read_fulfillments",
      "write_fulfillments",
      "read_returns",
      "write_returns",
      "read_discounts",
      "write_discounts",
      "read_metafields",
      "write_metafields",
      "read_draft_orders",
      "write_draft_orders",
    ]) {
      const scopes = mapStaffPermissionsToScopes({ permissions: [perm] })
      for (const scope of scopes) {
        expect(
          declared.has(scope),
          `scope "${scope}" (from "${perm}") not in manifest.scopes`,
        ).toBe(true)
      }
    }
  })
})

describe("capabilityDetectSeed", () => {
  it("returns false (and never throws) when staffMembers is access-denied", async () => {
    const { ctx } = makeCtx({
      shopifyFetch: { body: { errors: [{ message: "Access denied for staffMembers field." }] } },
    })
    expect(await capabilityDetectSeed(ctx)).toBe(false)
  })

  it("returns true when staffMembers returns a non-empty edges array", async () => {
    const { ctx } = makeCtx({
      shopifyFetch: {
        body: {
          data: {
            staffMembers: {
              edges: [{ node: { id: "s1", email: "a@x", isShopOwner: true } }],
            },
          },
        },
      },
    })
    expect(await capabilityDetectSeed(ctx)).toBe(true)
  })

  it("returns false on 4xx (e.g. 403)", async () => {
    const { ctx } = makeCtx({
      shopifyFetch: { status: 403, body: { errors: [{ message: "Forbidden" }] } },
    })
    expect(await capabilityDetectSeed(ctx)).toBe(false)
  })
})

describe("scopeSeedJob", () => {
  it("when capability absent, returns { available: false, suggestions: [] } and writes nothing", async () => {
    const { ctx, grants } = makeCtx({
      shopifyFetch: { body: { errors: [{ message: "Access denied" }] } },
    })
    const result = await scopeSeedJob({}, ctx)
    expect(result).toEqual({ available: false, suggestions: [], conflicts: [] })
    expect(grants.calls.length).toBe(0)
  })

  it("when capability present, emits suggestions per mapped user; does NOT call grants_setUserScopes", async () => {
    const { ctx, grants } = makeCtx({
      preload: {
        "kernel.users": [{ id: MARIE_ID, email: "marie@x" } as DbRow],
      },
      shopifyFetch: [
        // capabilityDetectSeed probe
        {
          body: {
            data: {
              staffMembers: {
                edges: [{ node: { id: "s1", email: "marie@x", permissions: ["refund_orders"] } }],
              },
            },
          },
        },
        // full staffMembers fetch
        {
          body: {
            data: {
              staffMembers: {
                edges: [
                  {
                    node: { id: "s1", email: "marie@x", permissions: ["refund_orders"] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      ],
    })
    const result = await scopeSeedJob({}, ctx)
    expect(result.available).toBe(true)
    expect(result.suggestions).toContainEqual({
      liaisonUserId: MARIE_ID,
      shopifyStaffEmail: "marie@x",
      scopes: ["shopify:refunds:create"],
    })
    expect(grants.calls.length).toBe(0)
  })

  it("unmapped Shopify staff (no Liaison-user email match) are omitted", async () => {
    const { ctx } = makeCtx({
      shopifyFetch: [
        {
          body: {
            data: {
              staffMembers: {
                edges: [{ node: { id: "s1", email: "ghost@nowhere", permissions: ["full"] } }],
              },
            },
          },
        },
        {
          body: {
            data: {
              staffMembers: {
                edges: [{ node: { id: "s1", email: "ghost@nowhere", permissions: ["full"] } }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      ],
    })
    const result = await scopeSeedJob({}, ctx)
    expect(result.available).toBe(true)
    expect(result.suggestions).toEqual([])
  })

  it("admin override (staff_overrides) wins over email auto-match", async () => {
    const { ctx } = makeCtx({
      preload: {
        "kernel.users": [
          { id: MARIE_ID, email: "marie@x" } as DbRow,
          { id: BOB_ID, email: "bob@x" } as DbRow,
        ],
        staff_overrides: [{ id: "so1", liaisonUserId: BOB_ID, shopifyStaffId: "s_marie" } as DbRow],
      },
      shopifyFetch: [
        {
          body: {
            data: {
              staffMembers: {
                edges: [
                  { node: { id: "s_marie", email: "marie@x", permissions: ["refund_orders"] } },
                ],
              },
            },
          },
        },
        {
          body: {
            data: {
              staffMembers: {
                edges: [
                  { node: { id: "s_marie", email: "marie@x", permissions: ["refund_orders"] } },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      ],
    })
    const result = await scopeSeedJob({}, ctx)
    expect(result.suggestions).toContainEqual({
      liaisonUserId: BOB_ID,
      shopifyStaffEmail: "marie@x",
      scopes: ["shopify:refunds:create"],
    })
  })

  it("two Shopify staff with same email → fail-closed (excluded, flagged in conflicts)", async () => {
    const { ctx } = makeCtx({
      preload: {
        "kernel.users": [{ id: MARIE_ID, email: "dup@x" } as DbRow],
      },
      shopifyFetch: [
        {
          body: {
            data: {
              staffMembers: {
                edges: [
                  { node: { id: "s1", email: "dup@x", permissions: ["full"] } },
                  { node: { id: "s2", email: "dup@x", permissions: ["read_orders"] } },
                ],
              },
            },
          },
        },
        {
          body: {
            data: {
              staffMembers: {
                edges: [
                  { node: { id: "s1", email: "dup@x", permissions: ["full"] } },
                  { node: { id: "s2", email: "dup@x", permissions: ["read_orders"] } },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      ],
    })
    const result = await scopeSeedJob({}, ctx)
    expect(result.suggestions.filter((s) => s.shopifyStaffEmail === "dup@x")).toEqual([])
    expect(result.conflicts).toContainEqual(expect.objectContaining({ email: "dup@x" }))
  })

  it("401 from Shopify (invalid token) → { available: false }; never writes", async () => {
    const { ctx, grants } = makeCtx({
      shopifyFetch: { status: 401, body: "invalid" },
    })
    const result = await scopeSeedJob({}, ctx)
    expect(result.available).toBe(false)
    expect(grants.calls.length).toBe(0)
  })

  it("owner with empty permissions + one email-matched non-owner staff → owner gets full scopes", async () => {
    // Regression: the hardened guard checked overrideByStaffId for otherMapped,
    // not the fully-resolved set. In the common case (non-owner matched via email
    // only, no override row), otherMapped was always false and the owner was
    // silently dropped.
    const OWNER_ID = "33333333-3333-3333-3333-333333333333"
    const STAFF_ID = "44444444-4444-4444-4444-444444444444"
    const { ctx } = makeCtx({
      preload: {
        "kernel.users": [
          { id: OWNER_ID, email: "owner@x" } as DbRow,
          { id: STAFF_ID, email: "staff@x" } as DbRow,
        ],
      },
      shopifyFetch: [
        // capabilityDetectSeed probe
        {
          body: {
            data: {
              staffMembers: {
                edges: [
                  { node: { id: "s-owner", email: "owner@x", permissions: [], isShopOwner: true } },
                ],
              },
            },
          },
        },
        // full staffMembers fetch
        {
          body: {
            data: {
              staffMembers: {
                edges: [
                  { node: { id: "s-owner", email: "owner@x", permissions: [], isShopOwner: true } },
                  {
                    node: {
                      id: "s-staff",
                      email: "staff@x",
                      permissions: ["read_orders"],
                      isShopOwner: false,
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      ],
    })
    const result = await scopeSeedJob({}, ctx)
    expect(result.available).toBe(true)
    // The non-owner staff is matched by email, not override — must be in suggestions.
    const staffSuggestion = result.suggestions.find((s) => s.liaisonUserId === STAFF_ID)
    expect(staffSuggestion).toBeDefined()
    // The owner had empty permissions but there is an email-matched non-owner staff →
    // owner must receive the full scope set.
    const ownerSuggestion = result.suggestions.find((s) => s.liaisonUserId === OWNER_ID)
    expect(ownerSuggestion).toBeDefined()
    expect(ownerSuggestion!.scopes.length).toBeGreaterThan(0)
  })

  it("owner-only store (no other mapped staff) → owner is dropped (scopes not seeded)", async () => {
    const OWNER_ID = "55555555-5555-5555-5555-555555555555"
    const { ctx } = makeCtx({
      preload: {
        "kernel.users": [{ id: OWNER_ID, email: "owner@x" } as DbRow],
      },
      shopifyFetch: [
        // capabilityDetectSeed probe
        {
          body: {
            data: {
              staffMembers: {
                edges: [
                  { node: { id: "s-owner", email: "owner@x", permissions: [], isShopOwner: true } },
                ],
              },
            },
          },
        },
        // full staffMembers fetch — only the owner
        {
          body: {
            data: {
              staffMembers: {
                edges: [
                  { node: { id: "s-owner", email: "owner@x", permissions: [], isShopOwner: true } },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      ],
    })
    const result = await scopeSeedJob({}, ctx)
    expect(result.available).toBe(true)
    // No non-owner mapped staff → owner must be omitted from suggestions.
    expect(result.suggestions.find((s) => s.liaisonUserId === OWNER_ID)).toBeUndefined()
    expect(result.suggestions).toEqual([])
  })
})

describe("applySeedSuggestion", () => {
  it("calls grants_setUserScopes for the named user", async () => {
    const { ctx, grants } = makeCtx({})
    await applySeedSuggestion({ liaisonUserId: MARIE_ID, scopes: ["shopify:refunds:create"] }, ctx)
    const call = grants.calls.find((c) => c.userId === MARIE_ID)
    expect(call).toBeDefined()
    expect(call!.scopes).toContain("shopify:refunds:create")
  })

  it("is idempotent when called twice with the same scopes", async () => {
    const { ctx, grants } = makeCtx({})
    const args = { liaisonUserId: MARIE_ID, scopes: ["shopify:refunds:create"] }
    await applySeedSuggestion(args, ctx)
    await applySeedSuggestion(args, ctx)
    // Both calls fire (replace semantics), but the resulting set on the user
    // is identical — the call returns ok both times.
    expect(grants.calls.length).toBe(2)
    expect(grants.calls[0]!.scopes).toEqual(grants.calls[1]!.scopes)
  })

  it("throws on missing liaisonUserId", async () => {
    const { ctx } = makeCtx({})
    await expect(applySeedSuggestion({}, ctx)).rejects.toThrow(/liaisonUserId/)
  })

  it("does NOT grant a caller-supplied admin scope through the seed path (no self-escalation)", async () => {
    const { ctx, grants } = makeCtx({})
    // A scope-seed admin tries to self-grant arbitrary admin scopes by stuffing
    // them into args.scopes alongside one legitimate seed scope.
    await applySeedSuggestion(
      {
        liaisonUserId: MARIE_ID,
        scopes: [
          "shopify:refunds:create",
          "shopify:admin:scope-seed",
          "shopify:admin:identity-map",
        ],
      },
      ctx,
    )
    const call = grants.calls.find((c) => c.userId === MARIE_ID)
    expect(call).toBeDefined()
    // The legitimate seed scope is granted…
    expect(call!.scopes).toContain("shopify:refunds:create")
    // …but neither admin scope survives the server-side re-derivation.
    expect(call!.scopes).not.toContain("shopify:admin:scope-seed")
    expect(call!.scopes).not.toContain("shopify:admin:identity-map")
    expect(call!.scopes.some((s) => s.startsWith("shopify:admin:"))).toBe(false)
  })

  it("drops forged / unknown scopes, granting only the seed-grantable subset", async () => {
    const { ctx, grants } = makeCtx({})
    await applySeedSuggestion(
      {
        liaisonUserId: BOB_ID,
        scopes: ["shopify:products:read", "mail:admin:all", "not-a-real-scope"],
      },
      ctx,
    )
    const call = grants.calls.find((c) => c.userId === BOB_ID)
    expect(call).toBeDefined()
    expect(call!.scopes).toEqual(["shopify:products:read"])
  })
})
