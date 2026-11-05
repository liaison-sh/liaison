// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B14 — staff_overrides_upsert / staff_overrides_delete handlers.
//
// Scope-gating is enforced kernel-side (the manifest declares
// `scope: "shopify:admin:identity_map"`) so these unit tests assume the
// handler has already been allowed past the gate — they exercise the in-app
// behaviour: insert vs update, delete-by-id, reason field.
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { validateFields } from "../lib/validate-fields.testutil"
import {
  staff_overrides_delete,
  staff_overrides_upsert,
  staff_overrides_upsert_preflight,
} from "./staff-overrides"

interface DbRow extends Record<string, unknown> {
  id: string
}

function makeCtx(): { ctx: AppContext; tables: Map<string, DbRow[]> } {
  const tables = new Map<string, DbRow[]>()
  let counter = 1
  const ctx = {
    userId: "admin-user",
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
      findOne: async (entity: string, id: string) =>
        (tables.get(entity) ?? []).find((r) => r.id === id) ?? null,
      insert: async (entity: string, data: Record<string, unknown>) => {
        // Enforce the kernel's write-path field allowlist (rpc-bridge.ts):
        // undeclared columns throw at runtime, so they must throw here too.
        validateFields(entity, data)
        const id = `${entity}-${counter++}`
        const row = { id, ...data } as DbRow
        tables.set(entity, [...(tables.get(entity) ?? []), row])
        return { id }
      },
      update: async (entity: string, id: string, data: Record<string, unknown>) => {
        validateFields(entity, data)
        const rows = tables.get(entity) ?? []
        const idx = rows.findIndex((r) => r.id === id)
        if (idx >= 0) rows[idx] = { ...rows[idx], ...data } as DbRow
      },
      updateMany: async () => ({ count: 0 }),
      delete: async (entity: string, id: string) => {
        const rows = tables.get(entity) ?? []
        tables.set(entity, rows.filter((r) => r.id !== id))
      },
      count: async () => 0,
    },
    emit: async () => undefined,
    enqueueJob: async () => undefined,
    resolveContact: async () => ({}),
    connections: {},
    fetch: async () => ({ status: 200, headers: {}, body: "{}" }),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agent_run: async () => "{}",
    realtime_publish: async () => "{}",
    grants_setUserScopes: async () => "{}",
    bulk: {
      fetchToBlob: async () => ({ blobId: "x", sizeBytes: 0 }),
      iterateJsonl: async function* () {},
      deleteBlob: async () => undefined,
    },
  } as unknown as AppContext
  return { ctx, tables }
}

const MARIE_ID = "11111111-1111-1111-1111-111111111111"
const BOB_ID = "22222222-2222-2222-2222-222222222222"

describe("staff_overrides_upsert", () => {
  it("creates a new row when one doesn't exist", async () => {
    const { ctx, tables } = makeCtx()
    const out = await staff_overrides_upsert(
      { liaisonUserId: MARIE_ID, shopifyStaffId: "s1", reason: "Marie wears two hats" },
      ctx,
    )
    expect(out.id).toMatch(/staff_overrides-/)
    const rows = tables.get("staff_overrides") ?? []
    expect(rows.length).toBe(1)
    expect(rows[0]!.liaisonUserId).toBe(MARIE_ID)
    expect(rows[0]!.shopifyStaffId).toBe("s1")
    expect(rows[0]!.reason).toBe("Marie wears two hats")
    expect(rows[0]!.createdBy).toBe("admin-user")
    // created_at is kernel-managed and must not be written by the handler — the
    // enforcing mock would have thrown on insert if it were present.
    expect(rows[0]).not.toHaveProperty("createdAt")
  })

  it("updates an existing row keyed by liaisonUserId (idempotent re-map)", async () => {
    const { ctx, tables } = makeCtx()
    await staff_overrides_upsert(
      { liaisonUserId: MARIE_ID, shopifyStaffId: "s1" },
      ctx,
    )
    await staff_overrides_upsert(
      { liaisonUserId: MARIE_ID, shopifyStaffId: "s2", reason: "moved teams" },
      ctx,
    )
    const rows = tables.get("staff_overrides") ?? []
    expect(rows.length).toBe(1)
    expect(rows[0]!.shopifyStaffId).toBe("s2")
    expect(rows[0]!.reason).toBe("moved teams")
  })

  it("throws on missing liaisonUserId or shopifyStaffId", async () => {
    const { ctx } = makeCtx()
    await expect(staff_overrides_upsert({ shopifyStaffId: "s1" }, ctx)).rejects.toThrow(/liaisonUserId/)
    await expect(staff_overrides_upsert({ liaisonUserId: MARIE_ID }, ctx)).rejects.toThrow(/shopifyStaffId/)
  })

  it("two distinct users get two distinct rows", async () => {
    const { ctx, tables } = makeCtx()
    await staff_overrides_upsert({ liaisonUserId: MARIE_ID, shopifyStaffId: "s1" }, ctx)
    await staff_overrides_upsert({ liaisonUserId: BOB_ID, shopifyStaffId: "s2" }, ctx)
    expect((tables.get("staff_overrides") ?? []).length).toBe(2)
  })
})

describe("staff_overrides_delete", () => {
  it("removes the row by id", async () => {
    const { ctx, tables } = makeCtx()
    const ins = await staff_overrides_upsert(
      { liaisonUserId: MARIE_ID, shopifyStaffId: "s1" },
      ctx,
    )
    await staff_overrides_delete({ id: ins.id }, ctx)
    expect((tables.get("staff_overrides") ?? []).length).toBe(0)
  })

  it("throws on missing id", async () => {
    const { ctx } = makeCtx()
    await expect(staff_overrides_delete({}, ctx)).rejects.toThrow(/id/)
  })

  it("no-op when row already absent (silent)", async () => {
    const { ctx } = makeCtx()
    await expect(staff_overrides_delete({ id: "nonexistent" }, ctx)).resolves.toBeUndefined()
  })
})

// A gated call parks a pending approval for a human. The staff-id conflict used to be detected only
// inside the post-approval handler, so an admin approved a mapping that then failed on a conflict
// only the agent could resolve. The manifest now names staff_overrides_upsert_preflight, which runs
// BEFORE the approval is created: it refuses here, and no row is written.
describe("staff_overrides_upsert_preflight - stage-time refusal", () => {
  it("refuses a Shopify staff id already mapped to a different Liaison user, and writes nothing", async () => {
    const { ctx, tables } = makeCtx()
    await staff_overrides_upsert({ liaisonUserId: "u1", shopifyStaffId: "s1" }, ctx)
    const before = [...(tables.get("staff_overrides") ?? [])]
    const out = await staff_overrides_upsert_preflight({ liaisonUserId: "u2", shopifyStaffId: "s1" }, ctx)
    expect("error" in out).toBe(true)
    const err = (out as { error: { code: string; message: string } }).error
    expect(err.code).toBe("STAFF_ID_CONFLICT")
    expect(err.message).toContain("already mapped to a different Liaison user")
    expect(tables.get("staff_overrides")).toEqual(before)
  })

  it("refuses a missing liaisonUserId without touching the table", async () => {
    const { ctx, tables } = makeCtx()
    const out = await staff_overrides_upsert_preflight({ shopifyStaffId: "s1" }, ctx)
    expect((out as { error: { code: string } }).error.code).toBe("INVALID_ARG")
    expect(tables.get("staff_overrides")).toBeUndefined()
  })

  it("passes a genuine new mapping and a re-upsert of the same user", async () => {
    const { ctx } = makeCtx()
    expect(await staff_overrides_upsert_preflight({ liaisonUserId: "u1", shopifyStaffId: "s1" }, ctx)).toEqual({ ok: true })
    await staff_overrides_upsert({ liaisonUserId: "u1", shopifyStaffId: "s1" }, ctx)
    expect(await staff_overrides_upsert_preflight({ liaisonUserId: "u1", shopifyStaffId: "s1" }, ctx)).toEqual({ ok: true })
  })
})
