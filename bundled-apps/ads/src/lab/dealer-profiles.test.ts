// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T3 — dealer_profile_upsert (gated) + dealer_profiles_list (ungated).

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AppCtx } from "../lib/ctx-types"
import { createMockDb } from "../test-db"
import { dealer_profile_upsert, dealer_profiles_list } from "./dealer-profiles"

function makeCtx(db = createMockDb()): AppCtx {
  return { fetch: async () => ({}), connections: {}, db, actorId: "user_1" } as unknown as AppCtx
}

describe("dealer_profile_upsert", () => {
  it("inserts a new dealer profile when no dealer_id is provided", async () => {
    const ctx = makeCtx()
    const result = (await dealer_profile_upsert(
      { dealer_name: "Acme Music", dealer_type: "boutique", coverage_area: "EU-West" },
      ctx,
    )) as Record<string, unknown>
    const row = result.row as Record<string, unknown>
    expect(row.dealer_name).toBe("Acme Music")
    expect(row.dealer_type).toBe("boutique")
    expect(row.coverage_area).toBe("EU-West")
  })

  it("updates an existing profile when dealer_id is provided", async () => {
    const ctx = makeCtx()
    const created = (await dealer_profile_upsert(
      { dealer_name: "Acme Music", dealer_type: "boutique" },
      ctx,
    )) as Record<string, unknown>
    const id = created.id as string
    const updated = (await dealer_profile_upsert(
      {
        dealer_id: id,
        dealer_name: "Acme Music",
        dealer_type: "broadline",
        notes: "upgraded tier",
      },
      ctx,
    )) as Record<string, unknown>
    expect(updated.id).toBe(id)
    const row = updated.row as Record<string, unknown>
    expect(row.dealer_type).toBe("broadline")
    expect(row.notes).toBe("upgraded tier")

    const db = (ctx as unknown as { db: ReturnType<typeof createMockDb> }).db
    expect(db.__all("dealer_profiles").length).toBe(1)
  })

  it("throws when required fields are missing", async () => {
    const ctx = makeCtx()
    await expect(dealer_profile_upsert({ dealer_name: "x" }, ctx)).rejects.toThrow()
  })

  it("is gated in the manifest with summarizeDealerProfileUpsert", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "app.manifest.json"), "utf8"),
    ) as { tools: Record<string, { gated?: boolean; summarizer?: string }> }
    expect(manifest.tools.dealer_profile_upsert?.gated).toBe(true)
    expect(manifest.tools.dealer_profile_upsert?.summarizer).toBe("summarizeDealerProfileUpsert")
  })
})

describe("dealer_profiles_list", () => {
  it("returns previously upserted profiles", async () => {
    const ctx = makeCtx()
    await dealer_profile_upsert({ dealer_name: "Acme Music", dealer_type: "boutique" }, ctx)
    await dealer_profile_upsert({ dealer_name: "Broad Distro", dealer_type: "broadline" }, ctx)
    const result = (await dealer_profiles_list({}, ctx)) as Record<string, unknown>
    expect((result.dealers as unknown[]).length).toBe(2)
  })

  it("filters by dealer_name", async () => {
    const ctx = makeCtx()
    await dealer_profile_upsert({ dealer_name: "Acme Music", dealer_type: "boutique" }, ctx)
    await dealer_profile_upsert({ dealer_name: "Broad Distro", dealer_type: "broadline" }, ctx)
    const result = (await dealer_profiles_list({ dealer_name: "Acme Music" }, ctx)) as Record<
      string,
      unknown
    >
    const dealers = result.dealers as Array<Record<string, unknown>>
    expect(dealers.length).toBe(1)
    expect(dealers[0]?.dealer_name).toBe("Acme Music")
  })
})
