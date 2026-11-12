// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared shipping profiles (profiles.ts): one profile serves several variants through a link.
//
// The ZERO-DIFFERENCE proof is the first block: a catalog shaped like a real one (30 per-variant
// profiles that are really 10 products, several variants each, all duplicates identical) resolves
// every order the same way before the migration, after it, and after merging the duplicates. The
// only intended change after a merge is pack sharing: a pack whose bill names one variant now also
// takes a sibling variant of the same profile, which is asserted precisely, not tolerated.
import { describe, expect, it } from "bun:test"
import { packagesList, productProfileUpsert } from "./catalog"
import { importShippingProfiles } from "./import-kind"
import {
  deleteProfile,
  LEGACY_TABLE,
  LINK_TABLE,
  linkVariant,
  loadVariantProfiles,
  mergeProfiles,
  migrateLegacyProfiles,
  migrateShippingProfilesJobHandler,
  PROFILE_TABLE,
  unlinkVariant,
  type VariantProfile,
} from "./profiles"
import {
  type CatalogPack,
  type CatalogPackComponent,
  type ResolverLine,
  resolvePackages,
} from "./resolver"
import { createMockDb, type MockDb } from "./test-db"

// — a production-shaped catalog: 10 products, 30 variants —

interface Product {
  code: string
  variants: number
  weight: number
  dims: [number, number, number]
  category: string
  accessory?: boolean
}

const PRODUCTS: Product[] = [
  { code: "DV2", variants: 9, weight: 2.4, dims: [48, 30, 8], category: "content:v1:10120" },
  { code: "SKA", variants: 3, weight: 0.3, dims: [40, 25, 1], category: "content:v1:10120" },
  { code: "SKB", variants: 3, weight: 0.3, dims: [40, 25, 1], category: "content:v1:10120" },
  { code: "CV", variants: 3, weight: 0.9, dims: [50, 32, 4], category: "content:v1:10150" },
  { code: "MT", variants: 3, weight: 0.6, dims: [30, 20, 3], category: "content:v1:10150" },
  {
    code: "PS",
    variants: 3,
    weight: 0.4,
    dims: [15, 10, 6],
    category: "content:v1:10130",
    accessory: true,
  },
  {
    code: "UC",
    variants: 2,
    weight: 0.1,
    dims: [12, 8, 3],
    category: "content:v1:10130",
    accessory: true,
  },
  { code: "SKC", variants: 2, weight: 0.3, dims: [40, 25, 1], category: "content:v1:10120" },
  { code: "ST", variants: 1, weight: 1.1, dims: [60, 15, 15], category: "content:v1:10150" },
  { code: "CB", variants: 1, weight: 0.2, dims: [20, 15, 5], category: "content:v1:10130" },
]

const variantId = (code: string, i: number) => `gid://shopify/ProductVariant/${code}-${i}`

function legacyRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  let n = 0
  for (const p of PRODUCTS) {
    for (let i = 0; i < p.variants; i++) {
      rows.push({
        id: `legacy-${++n}`,
        product_source: "shopify",
        product_id: variantId(p.code, i),
        unit_weight: p.weight,
        solo_length: p.dims[0],
        solo_width: p.dims[1],
        solo_height: p.dims[2],
        content_category: p.category,
        short_code: p.code,
        accessory: p.accessory ?? null,
      })
    }
  }
  return rows
}

// Packs name ONE variant of each component product (the first), as a real catalog does.
const PACKS: CatalogPack[] = [
  {
    id: "pk-bundle",
    name: "Bundle",
    length: 55,
    width: 38,
    height: 14,
    gross_weight: 3.9,
    content_category: null,
    carton_tare: 0.5,
  },
  {
    id: "pk-skins",
    name: "Skin pair",
    length: 42,
    width: 27,
    height: 3,
    gross_weight: 0.7,
    content_category: null,
    carton_tare: null,
  },
]
const COMPONENTS: CatalogPackComponent[] = [
  { pack_id: "pk-bundle", product_source: "shopify", product_id: variantId("DV2", 0), quantity: 1 },
  { pack_id: "pk-bundle", product_source: "shopify", product_id: variantId("CV", 0), quantity: 1 },
  { pack_id: "pk-skins", product_source: "shopify", product_id: variantId("SKA", 0), quantity: 2 },
]

const ALL_VARIANTS = PRODUCTS.flatMap((p) =>
  Array.from({ length: p.variants }, (_, i) => variantId(p.code, i)),
)
const UNPROFILED = "gid://shopify/ProductVariant/UNPROFILED-1"

/** Deterministic orders: every variant alone at 1-3 units, every pair, and 300 seeded mixes (some
 *  with an unprofiled variant or a line with no ref). */
function orders(): ResolverLine[][] {
  const out: ResolverLine[][] = []
  const line = (
    i: number,
    id: string | null,
    q: number,
    source: string | null = "shopify",
  ): ResolverLine => ({
    id: `l${i}`,
    product_source: source,
    external_id: id,
    quantity: q,
  })
  for (const v of ALL_VARIANTS) for (const q of [1, 2, 3]) out.push([line(0, v, q)])
  for (let a = 0; a < ALL_VARIANTS.length; a++)
    for (let b = a + 1; b < ALL_VARIANTS.length; b++)
      out.push([line(0, ALL_VARIANTS[a]!, 1), line(1, ALL_VARIANTS[b]!, 1)])
  let seed = 20261103
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed / 2 ** 32
  }
  for (let k = 0; k < 300; k++) {
    const n = 3 + Math.floor(rnd() * 4)
    const lines: ResolverLine[] = []
    for (let i = 0; i < n; i++) {
      const r = rnd()
      const id =
        r < 0.04
          ? UNPROFILED
          : r < 0.06
            ? null
            : ALL_VARIANTS[Math.floor(rnd() * ALL_VARIANTS.length)]!
      lines.push(line(i, id, 1 + Math.floor(rnd() * 3), id === null ? null : "shopify"))
    }
    out.push(lines)
  }
  return out
}

function resolveWith(profiles: VariantProfile[], lines: ResolverLine[]) {
  return resolvePackages({ lines, profiles, packs: PACKS, components: COMPONENTS })
}

/** What a variant reads as, minus the row identities (link id / profile id) that are new. */
function variantView(profiles: VariantProfile[]) {
  return Object.fromEntries(
    profiles.map(({ id: _id, profile_id: _pid, ...rest }) => [
      `${rest.product_source}:${rest.product_id}`,
      rest,
    ]),
  )
}

function ctxOf(db: MockDb) {
  return { db }
}

/** Merge every product's duplicate profiles into its first variant's profile, previewing first. */
async function mergeDuplicates(db: MockDb) {
  const profiles = await loadVariantProfiles(db)
  const byCode = new Map<string, string[]>()
  for (const p of profiles) {
    const list = byCode.get(String(p.short_code)) ?? []
    if (p.profile_id && !list.includes(p.profile_id)) list.push(p.profile_id)
    byCode.set(String(p.short_code), list)
  }
  for (const ids of byCode.values()) {
    if (ids.length < 2) continue
    const [target, ...sources] = ids as [string, ...string[]]
    const preview = await mergeProfiles(ctxOf(db), {
      target_profile_id: target,
      source_profile_ids: sources,
    })
    expect(preview.preview).toBe(true)
    expect(preview.differences).toEqual([])
    await mergeProfiles(ctxOf(db), {
      target_profile_id: target,
      source_profile_ids: sources,
      confirm: true,
    })
  }
}

describe("zero-difference proof: migration and merge keep every resolution", () => {
  it("30 per-variant profiles migrate to 30 profiles + 30 links, then merge to 10 profiles", async () => {
    const db = createMockDb({ seed: { [LEGACY_TABLE]: legacyRows() } })
    const before = await loadVariantProfiles(db)
    expect(before).toHaveLength(30)

    const { migrated } = await migrateLegacyProfiles(ctxOf(db))
    expect(migrated).toBe(30)
    expect(db.__all(PROFILE_TABLE)).toHaveLength(30)
    expect(db.__all(LINK_TABLE)).toHaveLength(30)
    expect(db.__all(LEGACY_TABLE).every((r) => typeof r.migrated_profile_id === "string")).toBe(
      true,
    )
    // Idempotent: a second run migrates nothing.
    expect((await migrateLegacyProfiles(ctxOf(db))).migrated).toBe(0)

    await mergeDuplicates(db)
    expect(db.__all(PROFILE_TABLE)).toHaveLength(10)
    expect(db.__all(LINK_TABLE)).toHaveLength(30)
  })

  it("every variant reads the same profile, and every order resolves identically, before and after migration", async () => {
    const db = createMockDb({ seed: { [LEGACY_TABLE]: legacyRows() } })
    const before = await loadVariantProfiles(db)
    await migrateLegacyProfiles(ctxOf(db))
    const after = await loadVariantProfiles(db)

    expect(variantView(after)).toEqual(variantView(before))
    expect(after.map((p) => p.product_id)).toEqual(before.map((p) => p.product_id))
    const all = orders()
    expect(all.length).toBeGreaterThan(700)
    for (const lines of all) {
      expect(JSON.stringify(resolveWith(after, lines))).toBe(
        JSON.stringify(resolveWith(before, lines)),
      )
    }
  })

  it("after merging duplicates: identical resolution, except a pack now also takes a sibling variant", async () => {
    const db = createMockDb({ seed: { [LEGACY_TABLE]: legacyRows() } })
    const before = await loadVariantProfiles(db)
    await migrateLegacyProfiles(ctxOf(db))
    await mergeDuplicates(db)
    const after = await loadVariantProfiles(db)

    expect(variantView(after)).toEqual(variantView(before))

    // canon(): each line's variant replaced by the variant the pack bills name for that product.
    const packVariants = new Map(
      COMPONENTS.map((c) => [c.product_id.replace(/-\d+$/, ""), c.product_id]),
    )
    const canonId = (id: string | null) =>
      id ? (packVariants.get(id.replace(/-\d+$/, "")) ?? id) : id
    const touchesSibling = (lines: ResolverLine[]) =>
      lines.some((l) => canonId(l.external_id) !== l.external_id)

    let identical = 0
    let shared = 0
    let sharedChanged = 0
    for (const lines of orders()) {
      const a = resolveWith(after, lines)
      const b = resolveWith(before, lines)
      if (!touchesSibling(lines)) {
        expect(JSON.stringify(a)).toBe(JSON.stringify(b))
        identical++
        continue
      }
      shared++
      // Per-line customs articles and unresolved lines never change...
      expect(JSON.stringify(a.customsArticles)).toBe(JSON.stringify(b.customsArticles))
      expect(JSON.stringify(a.unresolved)).toBe(JSON.stringify(b.unresolved))
      // ...and the parcels are exactly what the old catalog gave the same items under the
      // variants the packs name.
      const canon = lines.map((l) => ({ ...l, external_id: canonId(l.external_id) }))
      expect(JSON.stringify(a.parcels)).toBe(JSON.stringify(resolveWith(before, canon).parcels))
      if (JSON.stringify(a.parcels) !== JSON.stringify(b.parcels)) sharedChanged++
    }
    expect(identical).toBeGreaterThan(200)
    expect(shared).toBeGreaterThan(50)
    // The sharing is real: some orders a pack could not take before, it takes now.
    expect(sharedChanged).toBeGreaterThan(0)
  })

  it("an order holding sibling variants of a pack's bill packs into that pack after the merge", async () => {
    const db = createMockDb({ seed: { [LEGACY_TABLE]: legacyRows() } })
    await migrateLegacyProfiles(ctxOf(db))
    const lines: ResolverLine[] = [
      { id: "a", product_source: "shopify", external_id: variantId("DV2", 5), quantity: 1 },
      { id: "b", product_source: "shopify", external_id: variantId("CV", 2), quantity: 1 },
    ]
    const pre = resolveWith(await loadVariantProfiles(db), lines)
    expect(pre.parcels.some((p) => p.weight === 3.9)).toBe(false)
    await mergeDuplicates(db)
    const post = resolveWith(await loadVariantProfiles(db), lines)
    expect(post.parcels).toEqual([{ length: 55, width: 38, height: 14, weight: 3.9 }])
  })
})

// — tools —

async function seeded() {
  const db = createMockDb({
    seed: {
      [LEGACY_TABLE]: [
        {
          id: "l1",
          product_source: "shopify",
          product_id: "V1",
          unit_weight: 1,
          solo_length: 10,
          solo_width: 10,
          solo_height: 10,
          content_category: "c",
          short_code: "AA",
        },
        {
          id: "l2",
          product_source: "shopify",
          product_id: "V2",
          unit_weight: 1,
          solo_length: 10,
          solo_width: 10,
          solo_height: 10,
          content_category: "c",
          short_code: "AA",
        },
        {
          id: "l3",
          product_source: "shopify",
          product_id: "V3",
          unit_weight: 2,
          solo_length: 10,
          solo_width: 10,
          solo_height: 10,
          content_category: "c",
          short_code: "BB",
        },
      ],
    },
  })
  await migrateLegacyProfiles(ctxOf(db))
  const byVariant = Object.fromEntries(
    (await loadVariantProfiles(db)).map((p) => [p.product_id, p.profile_id!]),
  )
  return { db, ctx: ctxOf(db), p1: byVariant.V1!, p2: byVariant.V2!, p3: byVariant.V3! }
}

describe("product_profile_link / unlink", () => {
  it("links an unprofiled variant to an existing profile; it then resolves with that profile", async () => {
    const { db, ctx, p1 } = await seeded()
    const res = await linkVariant(ctx, {
      product_source: "shopify",
      product_id: "V9",
      profile_id: p1,
    })
    expect(res).toEqual({
      ok: true,
      preview: false,
      profile_id: p1,
      previous_profile_id: null,
      differences: [],
    })
    const v9 = (await loadVariantProfiles(db)).find((p) => p.product_id === "V9")
    expect(v9).toMatchObject({ profile_id: p1, unit_weight: 1, short_code: "AA" })
  })

  it("moves a linked variant to another profile and reports where it came from", async () => {
    const { ctx, p1, p3 } = await seeded()
    const res = await linkVariant(ctx, {
      product_source: "shopify",
      product_id: "V1",
      profile_id: p3,
      confirm: true,
    })
    expect(res.previous_profile_id).toBe(p1)
  })

  it("refuses a link to a profile that does not exist", async () => {
    const { ctx } = await seeded()
    await expect(
      linkVariant(ctx, { product_source: "shopify", product_id: "V9", profile_id: "nope" }),
    ).rejects.toThrow(/No shipping profile/)
  })

  it("migrates old per-variant rows before linking (no legacy row is left unmigrated)", async () => {
    const db = createMockDb({
      seed: {
        [LEGACY_TABLE]: [{ id: "l1", product_source: "shopify", product_id: "V1", unit_weight: 1 }],
      },
    })
    const target = await db.insert(PROFILE_TABLE, { unit_weight: 3 })
    await linkVariant(ctxOf(db), {
      product_source: "shopify",
      product_id: "V9",
      profile_id: target.id,
    })
    expect(db.__all(LEGACY_TABLE)[0]!.migrated_profile_id).toBeTruthy()
    expect(db.__all(LINK_TABLE)).toHaveLength(2)
  })

  it("unlinks a variant: it has no profile any more, its profile stays for the others", async () => {
    const { db, ctx, p1 } = await seeded()
    await linkVariant(ctx, {
      product_source: "shopify",
      product_id: "V2",
      profile_id: p1,
      confirm: true,
    })
    const res = await unlinkVariant(ctx, { product_source: "shopify", product_id: "V1" })
    expect(res).toEqual({ ok: true, profile_id: p1, remaining_variants: 1 })
    const profiles = await loadVariantProfiles(db)
    expect(profiles.find((p) => p.product_id === "V1")).toBeUndefined()
    // The old per-variant row does not come back once its variant is unlinked.
    const r = resolvePackages({
      lines: [{ id: "x", product_source: "shopify", external_id: "V1", quantity: 1 }],
      profiles,
      packs: [],
      components: [],
    })
    expect(r.unresolved.map((u) => u.reason)).toEqual(["no_profile"])
  })

  it("refuses to unlink a variant that has no link", async () => {
    const { ctx } = await seeded()
    await expect(
      unlinkVariant(ctx, { product_source: "shopify", product_id: "V9" }),
    ).rejects.toThrow(/not linked/)
  })
})

describe("product_profile_merge", () => {
  it("previews without writing: lists the variants that move and the profiles to delete", async () => {
    const { db, ctx, p1, p2 } = await seeded()
    const preview = await mergeProfiles(ctx, { target_profile_id: p1, source_profile_ids: [p2] })
    expect(preview).toEqual({
      preview: true,
      target_profile_id: p1,
      moves: [{ product_source: "shopify", product_id: "V2", from_profile_id: p2 }],
      differences: [],
      deleted_profile_ids: [p2],
    })
    expect(db.__all(PROFILE_TABLE)).toHaveLength(3)
  })

  it("applies an identical merge on confirm: the variants move, the source is deleted", async () => {
    const { db, ctx, p1, p2 } = await seeded()
    await mergeProfiles(ctx, { target_profile_id: p1, source_profile_ids: [p2], confirm: true })
    expect(db.__all(PROFILE_TABLE).map((p) => p.id)).not.toContain(p2)
    expect(
      (await loadVariantProfiles(db)).filter((p) => p.profile_id === p1).map((p) => p.product_id),
    ).toEqual(["V1", "V2"])
  })

  it("refuses to merge differing profiles unless told whose fields win", async () => {
    const { db, ctx, p1, p3 } = await seeded()
    const preview = await mergeProfiles(ctx, { target_profile_id: p1, source_profile_ids: [p3] })
    expect(preview.differences).toEqual([
      { field: "unit_weight", values: { [p1]: 1, [p3]: 2 } },
      { field: "short_code", values: { [p1]: "AA", [p3]: "BB" } },
    ])
    await expect(
      mergeProfiles(ctx, { target_profile_id: p1, source_profile_ids: [p3], confirm: true }),
    ).rejects.toThrow(/differ on unit_weight, short_code/)
    expect(db.__all(PROFILE_TABLE)).toHaveLength(3)

    await mergeProfiles(ctx, {
      target_profile_id: p1,
      source_profile_ids: [p3],
      confirm: true,
      fields_from: p3,
    })
    const v1 = (await loadVariantProfiles(db)).find((p) => p.product_id === "V1")
    expect(v1).toMatchObject({ profile_id: p1, unit_weight: 2, short_code: "BB" })
  })

  it("refuses a target that is also a source, an unknown profile, an empty source list, a foreign fields_from", async () => {
    const { ctx, p1, p2 } = await seeded()
    await expect(
      mergeProfiles(ctx, { target_profile_id: p1, source_profile_ids: [p1] }),
    ).rejects.toThrow(/cannot also be a source/)
    await expect(
      mergeProfiles(ctx, { target_profile_id: p1, source_profile_ids: ["nope"] }),
    ).rejects.toThrow(/No shipping profile/)
    await expect(
      mergeProfiles(ctx, { target_profile_id: p1, source_profile_ids: [] }),
    ).rejects.toThrow(/at least one/)
    await expect(
      mergeProfiles(ctx, {
        target_profile_id: p1,
        source_profile_ids: [p2],
        confirm: true,
        fields_from: "other",
      }),
    ).rejects.toThrow(/fields_from/)
  })
})

describe("product_profile_delete", () => {
  it("is refused while a variant links to the profile, and deletes it once none does", async () => {
    const { db, ctx, p1 } = await seeded()
    await expect(deleteProfile(ctx, { profile_id: p1 })).rejects.toThrow(
      /still used by 1 variant\(s\): shopify:V1/,
    )
    await unlinkVariant(ctx, { product_source: "shopify", product_id: "V1" })
    expect(await deleteProfile(ctx, { profile_id: p1 })).toEqual({ ok: true })
    expect(db.__all(PROFILE_TABLE).map((p) => p.id)).not.toContain(p1)
  })

  it("refuses an unknown profile", async () => {
    const { ctx } = await seeded()
    await expect(deleteProfile(ctx, { profile_id: "nope" })).rejects.toThrow(/No shipping profile/)
  })
})

describe("product_profile_upsert on shared profiles", () => {
  it("editing one variant of a shared profile changes it for every variant on it", async () => {
    const { db, ctx, p1 } = await seeded()
    await linkVariant(ctx, {
      product_source: "shopify",
      product_id: "V2",
      profile_id: p1,
      confirm: true,
    })
    const res = await productProfileUpsert(ctx, {
      product_source: "shopify",
      product_id: "V1",
      unit_weight: 1.7,
      apply_to_shared: true,
    })
    expect(res).toEqual({ id: p1, shared_with: [{ product_source: "shopify", product_id: "V2" }] })
    const weights = (await loadVariantProfiles(db))
      .filter((p) => p.profile_id === p1)
      .map((p) => p.unit_weight)
    expect(weights).toEqual([1.7, 1.7])
  })

  it("an unlinked variant gets a new profile of its own", async () => {
    const { db, ctx } = await seeded()
    const res = await productProfileUpsert(ctx, {
      product_source: "shopify",
      product_id: "V7",
      unit_weight: 0.5,
      short_code: "CC",
    })
    expect(res.shared_with).toEqual([])
    expect((await loadVariantProfiles(db)).find((p) => p.product_id === "V7")).toMatchObject({
      profile_id: res.id,
      short_code: "CC",
    })
  })
})

describe("packages_list", () => {
  it("returns shared profiles with their variants, and unprofiled variants from resolved rows", async () => {
    const { db, ctx, p1 } = await seeded()
    db.__seed("prep_draft_cache", [
      {
        id: "c1",
        document_ref: "d1",
        unresolved_refs: [
          { product_source: "shopify", product_id: "V9", description: "Cable, retail" },
        ],
      },
      {
        id: "c2",
        document_ref: "d2",
        unresolved_refs: [
          { product_source: "shopify", product_id: "V9", description: "Cable, retail" },
        ],
      },
      { id: "c3", document_ref: "d3" },
    ])
    let list = await packagesList(ctx, {})
    expect(list.shared_profiles).toHaveLength(3)
    expect(list.shared_profiles.find((p) => p.id === p1)?.variants).toEqual([
      { product_source: "shopify", product_id: "V1" },
    ])
    expect(list.profiles).toHaveLength(3)
    expect(list.unprofiled_variants).toEqual([
      { product_source: "shopify", product_id: "V9", description: "Cable, retail", rows: 2 },
    ])
    // Linked: no longer offered, though the cached rows were not re-resolved.
    await linkVariant(ctx, { product_source: "shopify", product_id: "V9", profile_id: p1 })
    list = await packagesList(ctx, {})
    expect(list.unprofiled_variants).toEqual([])
    expect(db.__all("prep_draft_cache").find((r) => r.id === "c1")!.unresolved_refs).toHaveLength(1)
  })
})

describe("shipping-profile import kind on shared profiles", () => {
  it("creates a profile + link, and skips a variant that already has a profile (linked or legacy)", async () => {
    const db = createMockDb({
      seed: {
        [LEGACY_TABLE]: [{ id: "l1", product_source: "shopify", product_id: "V1", unit_weight: 1 }],
      },
    })
    const res = await importShippingProfiles(
      {
        runId: "r",
        kind: "shipping-profile",
        sourceLabel: "t",
        records: [
          {
            record: { productSource: "shopify", productId: "V1", unitWeight: 2 },
            dedupValue: "V1",
          },
          {
            record: { productSource: "shopify", productId: "V2", unitWeight: 2 },
            dedupValue: "V2",
          },
          {
            record: { productSource: "shopify", productId: "V2", unitWeight: 3 },
            dedupValue: "V2",
          },
        ],
      },
      { db },
    )
    expect(res.map((r) => r.status)).toEqual(["skipped", "created", "skipped"])
    expect(db.__all(PROFILE_TABLE)).toHaveLength(1)
    expect(db.__all(LINK_TABLE)).toHaveLength(1)
  })
})

// — rolling deploy: the previous release reads and writes the old per-variant table —
//
// During a deploy the previous release runs beside this one and still reads `shipping_profile`
// (one row per variant) and upserts it. So every profile write here is MIRRORED onto the linked
// variants' old rows, an unlinked variant's old row is removed (no row = no profile to the previous
// release), and an old row the previous release rewrote after its migration is picked up again.

/** What the previous release reads: one old-table row per variant, keyed by variant id. */
function oldReader(db: MockDb): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const r of db.__all(LEGACY_TABLE)) {
    out[String(r.product_id)] = {
      unit_weight: r.unit_weight,
      solo_length: r.solo_length ?? null,
      solo_width: r.solo_width ?? null,
      solo_height: r.solo_height ?? null,
      content_category: r.content_category ?? null,
      short_code: r.short_code ?? null,
    }
  }
  return out
}

/** The previous release's product_profile_upsert, verbatim in effect: update the variant's old row
 *  in place (dims and category replaced, short code only when sent) or insert one. */
async function oldReleaseUpsert(
  db: MockDb,
  input: { product_id: string; unit_weight: number; solo_length?: number },
) {
  const data = {
    product_source: "shopify",
    product_id: input.product_id,
    unit_weight: input.unit_weight,
    solo_length: input.solo_length ?? null,
    solo_width: null,
    solo_height: null,
    content_category: null,
  }
  const row = (await db.findMany(LEGACY_TABLE, {
    where: { product_source: "shopify", product_id: input.product_id },
    limit: 1,
  })) as Array<{ id: string }>
  if (row[0]) await db.update(LEGACY_TABLE, row[0].id, data)
  else await db.insert(LEGACY_TABLE, data)
}

/** A db that enforces the per-variant unique constraint of the link and old tables, as postgres
 *  does (the mock alone would accept a duplicate). */
function uniqueDb(db: MockDb): MockDb {
  const insert = db.insert.bind(db)
  db.insert = async (entity, data) => {
    if (entity === LINK_TABLE || entity === LEGACY_TABLE) {
      const clash = db
        .__all(entity)
        .some((r) => r.product_source === data.product_source && r.product_id === data.product_id)
      if (clash) {
        throw new Error(
          `db_insert: duplicate key value violates unique constraint "${entity}_org_id_product_source_product_id_key" (23505)`,
        )
      }
    }
    return insert(entity, data)
  }
  return db
}

describe("rolling deploy: writes are mirrored onto the old per-variant table", () => {
  it("a new profile, its link and its old-table mirror commit together: a failing mirror leaves nothing", async () => {
    const db = createMockDb()
    const insert = db.insert.bind(db)
    db.insert = async (entity, data) => {
      if (entity === LEGACY_TABLE) throw new Error("mirror refused")
      return insert(entity, data)
    }
    await expect(
      productProfileUpsert(ctxOf(db), {
        product_source: "shopify",
        product_id: "V5",
        unit_weight: 1,
      }),
    ).rejects.toThrow("mirror refused")
    expect(db.__all(PROFILE_TABLE)).toEqual([])
    expect(db.__all(LINK_TABLE)).toEqual([])
  })

  it("an old row the previous release inserted meanwhile is adopted: the write retries once on the unique clash", async () => {
    const db = uniqueDb(createMockDb())
    const findMany = db.findMany.bind(db)
    let raced = false
    db.findMany = async (entity, opts) => {
      const rows = await findMany(entity, opts)
      // Right after this call read the variant's (missing) old row, the previous release writes it.
      if (
        entity === LEGACY_TABLE &&
        !raced &&
        (opts?.where as { product_id?: string } | undefined)?.product_id === "V6"
      ) {
        raced = true
        await db.insert(LEGACY_TABLE, {
          product_source: "shopify",
          product_id: "V6",
          unit_weight: 9,
        })
      }
      return rows
    }
    const res = await productProfileUpsert(ctxOf(db), {
      product_source: "shopify",
      product_id: "V6",
      unit_weight: 1.5,
    })
    expect(raced).toBe(true)
    expect(db.__all(PROFILE_TABLE).map((p) => p.id)).toEqual([res.id])
    expect(db.__all(LINK_TABLE)).toHaveLength(1)
    expect(db.__all(LEGACY_TABLE)).toHaveLength(1)
    expect(oldReader(db).V6).toMatchObject({ unit_weight: 1.5 })
    expect(db.__all(LEGACY_TABLE)[0]!.migrated_profile_id).toBe(res.id)
  })

  it("an edit to a shared profile is visible to an old-shape reader for every linked variant", async () => {
    const { db, ctx, p1, p2 } = await seeded()
    await mergeProfiles(ctx, { target_profile_id: p1, source_profile_ids: [p2], confirm: true })
    await productProfileUpsert(ctx, {
      product_source: "shopify",
      product_id: "V1",
      unit_weight: 1.7,
      apply_to_shared: true,
    })
    const old = oldReader(db)
    expect(old.V1).toMatchObject({
      unit_weight: 1.7,
      solo_length: 10,
      content_category: "c",
      short_code: "AA",
    })
    expect(old.V2).toMatchObject({
      unit_weight: 1.7,
      solo_length: 10,
      content_category: "c",
      short_code: "AA",
    })
    expect(old.V3!.unit_weight).toBe(2)
  })

  it("a link, a move, a merge with fields_from, an import and a new profile all reach the old table", async () => {
    const { db, ctx, p1, p3 } = await seeded()
    await linkVariant(ctx, { product_source: "shopify", product_id: "V9", profile_id: p1 })
    expect(oldReader(db).V9).toMatchObject({ unit_weight: 1, short_code: "AA" })

    await linkVariant(ctx, {
      product_source: "shopify",
      product_id: "V9",
      profile_id: p3,
      confirm: true,
    })
    expect(oldReader(db).V9).toMatchObject({ unit_weight: 2, short_code: "BB" })

    await mergeProfiles(ctx, {
      target_profile_id: p1,
      source_profile_ids: [p3],
      confirm: true,
      fields_from: p3,
    })
    expect(oldReader(db).V1).toMatchObject({ unit_weight: 2, short_code: "BB" })
    expect(oldReader(db).V9).toMatchObject({ unit_weight: 2, short_code: "BB" })

    await productProfileUpsert(ctx, {
      product_source: "shopify",
      product_id: "V7",
      unit_weight: 0.5,
      short_code: "CC",
    })
    expect(oldReader(db).V7).toMatchObject({
      unit_weight: 0.5,
      short_code: "CC",
      solo_length: null,
    })

    await importShippingProfiles(
      {
        runId: "r",
        kind: "shipping-profile",
        sourceLabel: "t",
        records: [
          {
            record: { productSource: "shopify", productId: "V8", unitWeight: 4 },
            dedupValue: "V8",
          },
        ],
      },
      { db },
    )
    expect(oldReader(db).V8).toMatchObject({ unit_weight: 4 })
    // Every old row now carries the profile it mirrors, so none of them is migrated again.
    expect(db.__all(LEGACY_TABLE).every((r) => typeof r.migrated_profile_id === "string")).toBe(
      true,
    )
    expect((await migrateLegacyProfiles(ctx)).migrated).toBe(0)
  })

  it("an unlinked variant has no old row either: the previous release reads it as having no profile", async () => {
    const { db, ctx } = await seeded()
    await unlinkVariant(ctx, { product_source: "shopify", product_id: "V1" })
    expect(oldReader(db).V1).toBeUndefined()
    expect(Object.keys(oldReader(db)).sort()).toEqual(["V2", "V3"])
  })
})

describe("rolling deploy: the previous release's writes after the migration are picked up", () => {
  it("an old-release edit of one variant of a shared profile reads at once and splits it off on roll-forward", async () => {
    const { db, ctx, p1 } = await seeded()
    await linkVariant(ctx, {
      product_source: "shopify",
      product_id: "V2",
      profile_id: p1,
      confirm: true,
    })
    await oldReleaseUpsert(db, { product_id: "V2", unit_weight: 5, solo_length: 12 })

    // Read before any migration runs: the old release's write is what V2 reads; V1 is untouched.
    let profiles = await loadVariantProfiles(db)
    expect(profiles.find((p) => p.product_id === "V2")).toMatchObject({
      unit_weight: 5,
      solo_length: 12,
    })
    expect(profiles.find((p) => p.product_id === "V1")).toMatchObject({
      profile_id: p1,
      unit_weight: 1,
      solo_length: 10,
    })

    const res = await migrateLegacyProfiles(ctx)
    expect(res.remigrated).toBe(1)
    profiles = await loadVariantProfiles(db)
    const v2 = profiles.find((p) => p.product_id === "V2")!
    expect(v2.profile_id).not.toBe(p1)
    expect(v2).toMatchObject({ unit_weight: 5, solo_length: 12, solo_width: null })
    expect(profiles.find((p) => p.product_id === "V1")).toMatchObject({
      profile_id: p1,
      unit_weight: 1,
    })
    // Idempotent: nothing diverges any more.
    expect((await migrateLegacyProfiles(ctx)).remigrated).toBe(0)
  })

  it("an old-release edit of a variant alone on its profile updates that profile in place", async () => {
    const { db, ctx, p3 } = await seeded()
    await oldReleaseUpsert(db, { product_id: "V3", unit_weight: 7 })
    await migrateShippingProfilesJobHandler({}, ctx)
    const v3 = (await loadVariantProfiles(db)).find((p) => p.product_id === "V3")
    expect(v3).toMatchObject({
      profile_id: p3,
      unit_weight: 7,
      solo_length: null,
      short_code: "BB",
    })
  })

  it("an old-release insert of a new variant after the migration is migrated by the next write", async () => {
    const { db, ctx } = await seeded()
    await oldReleaseUpsert(db, { product_id: "V5", unit_weight: 3 })
    await productProfileUpsert(ctx, { product_source: "shopify", product_id: "V6", unit_weight: 1 })
    const v5 = (await loadVariantProfiles(db)).find((p) => p.product_id === "V5")
    expect(v5?.profile_id).toBeTruthy()
    expect(v5).toMatchObject({ unit_weight: 3 })
  })
})

describe("product_profile_upsert: shared edits are explicit, partial updates keep what was not sent", () => {
  it("refuses to change a shared profile from one variant unless apply_to_shared is passed, naming the siblings", async () => {
    const { db, ctx, p1 } = await seeded()
    await linkVariant(ctx, {
      product_source: "shopify",
      product_id: "V2",
      profile_id: p1,
      confirm: true,
    })
    await linkVariant(ctx, { product_source: "shopify", product_id: "V9", profile_id: p1 })
    await expect(
      productProfileUpsert(ctx, { product_source: "shopify", product_id: "V1", unit_weight: 9 }),
    ).rejects.toThrow(/shared with 2 other variant\(s\): shopify:V2, shopify:V9.*apply_to_shared/)
    expect(db.__all(PROFILE_TABLE).find((p) => p.id === p1)!.unit_weight).toBe(1)
  })

  it("a variant alone on its profile needs no flag", async () => {
    const { ctx, p3 } = await seeded()
    const res = await productProfileUpsert(ctx, {
      product_source: "shopify",
      product_id: "V3",
      unit_weight: 2.5,
    })
    expect(res).toEqual({ id: p3, shared_with: [] })
  })

  it("keeps solo dims, category and code that were not sent; null clears one", async () => {
    const { db, ctx } = await seeded()
    await productProfileUpsert(ctx, {
      product_source: "shopify",
      product_id: "V3",
      unit_weight: 2.5,
    })
    let v3 = (await loadVariantProfiles(db)).find((p) => p.product_id === "V3")
    expect(v3).toMatchObject({
      unit_weight: 2.5,
      solo_length: 10,
      solo_width: 10,
      solo_height: 10,
      content_category: "c",
      short_code: "BB",
    })
    await productProfileUpsert(ctx, {
      product_source: "shopify",
      product_id: "V3",
      unit_weight: 2.5,
      solo_length: null,
    })
    v3 = (await loadVariantProfiles(db)).find((p) => p.product_id === "V3")
    expect(v3).toMatchObject({ solo_length: null, solo_width: 10 })
    expect(oldReader(db).V3).toMatchObject({ solo_length: null, solo_width: 10 })
  })
})

describe("product_profile_link: moving a profiled variant is previewed", () => {
  it("previews the field differences and writes nothing without confirm; moves it with confirm", async () => {
    const { db, ctx, p1, p3 } = await seeded()
    const preview = await linkVariant(ctx, {
      product_source: "shopify",
      product_id: "V1",
      profile_id: p3,
    })
    expect(preview).toMatchObject({
      ok: false,
      preview: true,
      profile_id: p3,
      previous_profile_id: p1,
      differences: [
        { field: "unit_weight", current: 1, next: 2 },
        { field: "short_code", current: "AA", next: "BB" },
      ],
    })
    expect(preview.note).toMatch(/packs/)
    expect((await loadVariantProfiles(db)).find((p) => p.product_id === "V1")!.profile_id).toBe(p1)
    const done = await linkVariant(ctx, {
      product_source: "shopify",
      product_id: "V1",
      profile_id: p3,
      confirm: true,
    })
    expect(done).toMatchObject({
      ok: true,
      preview: false,
      profile_id: p3,
      previous_profile_id: p1,
    })
    expect((await loadVariantProfiles(db)).find((p) => p.product_id === "V1")!.profile_id).toBe(p3)
  })
})

describe("migration edge cases", () => {
  it("an unmigrated old row whose variant already has a link reads as the link, and is stamped with its values", async () => {
    const db = createMockDb()
    const p = await db.insert(PROFILE_TABLE, { unit_weight: 3, short_code: "NEW" })
    await db.insert(LINK_TABLE, { product_source: "shopify", product_id: "V1", profile_id: p.id })
    db.__seed(LEGACY_TABLE, [
      {
        id: "old-1",
        product_source: "shopify",
        product_id: "V1",
        unit_weight: 1,
        short_code: "OLD",
      },
    ])

    const before = await loadVariantProfiles(db)
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ profile_id: p.id, unit_weight: 3, short_code: "NEW" })

    expect((await migrateLegacyProfiles(ctxOf(db))).migrated).toBe(0)
    expect(db.__all(PROFILE_TABLE)).toHaveLength(1)
    expect(db.__all(LEGACY_TABLE)[0]).toMatchObject({
      migrated_profile_id: p.id,
      unit_weight: 3,
      short_code: "NEW",
    })
    expect(await loadVariantProfiles(db)).toEqual(before)
  })

  it("a mix of stamped and unstamped rows migrates only the unstamped ones", async () => {
    const { db, ctx } = await seeded()
    db.__seed(LEGACY_TABLE, [
      { id: "n1", product_source: "shopify", product_id: "N1", unit_weight: 4 },
      { id: "n2", product_source: "shopify", product_id: "N2", unit_weight: 5 },
    ])
    expect((await migrateLegacyProfiles(ctx)).migrated).toBe(2)
    expect(db.__all(PROFILE_TABLE)).toHaveLength(5)
    expect(db.__all(LINK_TABLE)).toHaveLength(5)
    expect(
      (await loadVariantProfiles(db)).map((p) => [p.product_id, Number(p.unit_weight)]),
    ).toEqual([
      ["V1", 1],
      ["V2", 1],
      ["V3", 2],
      ["N1", 4],
      ["N2", 5],
    ])
  })

  it("a concurrent migrator that links the variant first wins: the loser drops its profile and adopts the winner's", async () => {
    const db = uniqueDb(
      createMockDb({
        seed: {
          [LEGACY_TABLE]: [
            { id: "l1", product_source: "shopify", product_id: "V1", unit_weight: 1 },
          ],
        },
      }),
    )
    const winner = await db.insert(PROFILE_TABLE, { unit_weight: 1 })
    const insert = db.insert
    let raced = false
    db.insert = async (entity, data) => {
      const row = await insert(entity, data)
      // Right after this run made its profile, another run links the variant first.
      if (entity === PROFILE_TABLE && !raced) {
        raced = true
        await insert(LINK_TABLE, {
          product_source: "shopify",
          product_id: "V1",
          profile_id: winner.id,
        })
      }
      return row
    }
    const res = await migrateLegacyProfiles(ctxOf(db))
    expect(res.migrated).toBe(0)
    expect(raced).toBe(true)
    expect(db.__all(PROFILE_TABLE).map((p) => p.id)).toEqual([winner.id])
    expect(db.__all(LINK_TABLE)).toHaveLength(1)
    expect(db.__all(LEGACY_TABLE)[0]!.migrated_profile_id).toBe(winner.id)
  })

  it("the hourly job never recreates a link the user removed while it ran", async () => {
    const db = createMockDb({
      seed: {
        [LEGACY_TABLE]: [{ id: "l1", product_source: "shopify", product_id: "V1", unit_weight: 1 }],
      },
    })
    const ctx = ctxOf(db)
    const findMany = db.findMany.bind(db)
    let interleaved = false
    db.findMany = async (entity, opts) => {
      const rows = await findMany(entity, opts)
      // The job has just listed the old table; before it acts, the user's tool call migrates the
      // row (its own write path) and unlinks the variant.
      if (entity === LEGACY_TABLE && !interleaved) {
        interleaved = true
        await migrateLegacyProfiles(ctx)
        await unlinkVariant(ctx, { product_source: "shopify", product_id: "V1" })
      }
      return rows
    }
    await migrateShippingProfilesJobHandler({}, ctx)
    expect(interleaved).toBe(true)
    expect(db.__all(LINK_TABLE)).toEqual([])
    expect(await loadVariantProfiles(db)).toEqual([])
  })
})
