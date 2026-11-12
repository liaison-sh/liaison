// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SHARED SHIPPING PROFILES. A shipping profile (unit weight, solo carton dims, short code, content
// category, accessory flag) has its own identity in `product_profile`, and a product variant uses it
// through one row of `product_profile_link` (variant -> profile, at most one profile per variant).
// The same physical object sold as several variants (retail, wholesale, a colour, a bundle channel)
// is then described ONCE: a weight or a code changes in one place for every variant.
//
// Every reader still sees the per-variant shape it always had (`VariantProfile`: one row per
// variant, keyed by `(product_source, product_id)`), flattened through the link. For data that did
// not change, resolution output is byte-identical to the per-variant table it replaces.
//
// MIGRATION (forward only, inside this app's schema). The old table `shipping_profile` held one
// profile per variant. Each of its rows becomes one profile plus one link, never merged
// automatically (merging is `mergeProfiles`, explicit and previewed). A migrated row is stamped
// with `migrated_profile_id`; until it is migrated, a row is read as it is, so a read never depends
// on the migration having run. Every catalog write migrates first, and the
// `migrate-shipping-profiles` job finishes it for an org that never writes its catalog.
//
// ROLLING DEPLOY (expand/contract). The previous release runs beside this one during a deploy and
// still reads `shipping_profile` (one row per variant; no row = no profile) and upserts it. So for
// this release the old table stays a faithful per-variant copy:
//   - every write of a profile or a link is MIRRORED onto the old row of each variant linked to it
//     (inserted for a newly linked variant), stamped with the profile it mirrors;
//   - unlinking a variant deletes its old row, which is how the previous release reads "no profile"
//     (a kept row would keep it packing the variant with the profile it just left);
//   - the previous release never touches the stamp, so a stamped old row whose fields no longer
//     match its variant's profile is one it rewrote after the migration: a read uses that row for
//     the variant at once, and the next migration pass re-migrates it (in place when the variant is
//     alone on its profile, else onto a profile of its own, since the previous release only ever
//     meant that one variant).
// The mirror and the old table go when no running release reads them any more.

// What linking does NOT do: it never re-resolves a draft that was already resolved. A cached draft
// keeps what it said until the row is synced again (prep_sync or the row-scoped read).

import type { DbBatchOp, DbBatchResult, DbBatchSpec } from "@liaison/app-sdk"
import { isUniqueViolation } from "./db-errors"
import type { CatalogProfile } from "./resolver"

export interface ProfileDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      orderBy?: Record<string, "asc" | "desc">
      limit?: number
    },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  delete(entity: string, id: string): Promise<void>
  /** `ctx.db.batch`: the writes of one tool call, committed together or not at all. */
  batch(spec: DbBatchSpec): Promise<DbBatchResult>
}

export type ProfileReader = Pick<ProfileDb, "findMany">

export interface ProfileCtx {
  db: ProfileDb
}

export const PROFILE_TABLE = "product_profile"
export const LINK_TABLE = "product_profile_link"
export const LEGACY_TABLE = "shipping_profile"

const MAX = 1000

/** The fields a profile owns, shared by every variant linked to it. */
export const PROFILE_FIELDS = [
  "unit_weight",
  "solo_length",
  "solo_width",
  "solo_height",
  "content_category",
  "short_code",
  "accessory",
] as const
type ProfileField = (typeof PROFILE_FIELDS)[number]

export interface ProfileRow {
  id: string
  label?: string | null
  unit_weight: number
  solo_length?: number | null
  solo_width?: number | null
  solo_height?: number | null
  content_category?: string | null
  short_code?: string | null
  accessory?: boolean | null
}

export interface LinkRow {
  id: string
  product_source: string
  product_id: string
  profile_id: string
}

interface LegacyRow extends Record<string, unknown> {
  id: string
  product_source: string
  product_id: string
  migrated_profile_id?: string | null
}

/** One variant's view of its profile: the per-variant shape every reader has always used. `id` is
 *  the link's id (the legacy row's id for a row not migrated yet); `profile_id` is the shared
 *  profile's, null for a legacy row. */
export interface VariantProfile extends CatalogProfile {
  id: string
  profile_id: string | null
}

export interface VariantRef {
  product_source: string
  product_id: string
}

function refOf(r: VariantRef): string {
  return `${r.product_source}:${r.product_id}`
}

function profileFields(src: object): Record<ProfileField, unknown> {
  const values = new Map<string, unknown>(Object.entries(src))
  const out = {} as Record<ProfileField, unknown>
  for (const f of PROFILE_FIELDS) out[f] = values.get(f) ?? null
  return out
}

async function all<T>(
  db: ProfileReader,
  entity: string,
  where?: Record<string, unknown>,
): Promise<T[]> {
  return (await db.findMany(entity, { ...(where ? { where } : {}), limit: MAX })) as T[]
}

/**
 * Every variant's profile, one row per variant. Links come first in their own order (which is the
 * old table's order for migrated rows), then any old-table row not migrated yet whose variant has no
 * link. Pure read: safe under a read-only scope.
 */
export async function loadVariantProfiles(db: ProfileReader): Promise<VariantProfile[]> {
  const [links, profiles, legacy] = await Promise.all([
    all<LinkRow>(db, LINK_TABLE),
    all<ProfileRow>(db, PROFILE_TABLE),
    all<LegacyRow>(db, LEGACY_TABLE),
  ])
  const byId = new Map(profiles.map((p) => [String(p.id), p]))
  const legacyByRef = new Map(legacy.map((r) => [refOf(r), r]))
  const out: VariantProfile[] = []
  const linked = new Set<string>()
  for (const l of links) {
    const p = byId.get(String(l.profile_id))
    if (!p) continue
    linked.add(refOf(l))
    const old = legacyByRef.get(refOf(l))
    if (old && rewrittenByPreviousRelease(old, p)) {
      // The previous release edited this variant after the migration: its row is the truth until
      // the next migration pass re-migrates it.
      out.push({ ...legacyView(old), id: String(l.id) })
      continue
    }
    out.push({
      id: String(l.id),
      profile_id: String(p.id),
      product_source: l.product_source,
      product_id: l.product_id,
      unit_weight: p.unit_weight,
      solo_length: p.solo_length ?? null,
      solo_width: p.solo_width ?? null,
      solo_height: p.solo_height ?? null,
      content_category: p.content_category ?? null,
      short_code: p.short_code ?? null,
      accessory: p.accessory ?? null,
    })
  }
  for (const r of legacy) {
    if (r.migrated_profile_id) continue
    if (linked.has(refOf(r))) continue
    out.push(legacyView(r))
  }
  return out
}

/** An old-table row read as a variant profile (no shared profile behind it). */
function legacyView(r: LegacyRow): VariantProfile {
  const f = profileFields(r)
  return {
    id: String(r.id),
    profile_id: null,
    product_source: r.product_source,
    product_id: r.product_id,
    unit_weight: Number(f.unit_weight),
    solo_length: (f.solo_length as number | null) ?? null,
    solo_width: (f.solo_width as number | null) ?? null,
    solo_height: (f.solo_height as number | null) ?? null,
    content_category: (f.content_category as string | null) ?? null,
    short_code: (f.short_code as string | null) ?? null,
    accessory: (f.accessory as boolean | null) ?? null,
  }
}

const NUMERIC_FIELDS = new Set<string>(["unit_weight", "solo_length", "solo_width", "solo_height"])

/** A field's value compared across tables: numbers as numbers (a numeric column may read back as
 *  text), absent as null. */
function norm(field: string, v: unknown): unknown {
  if (v === undefined || v === null) return null
  return NUMERIC_FIELDS.has(field) ? Number(v) : v
}

function sameFields(a: object, b: object): boolean {
  const fa = profileFields(a)
  const fb = profileFields(b)
  return PROFILE_FIELDS.every((f) => norm(f, fa[f]) === norm(f, fb[f]))
}

/** A STAMPED old row that no longer mirrors its variant's profile: the previous release, which
 *  never writes the stamp, rewrote it after the migration. */
function rewrittenByPreviousRelease(old: LegacyRow, profile: ProfileRow): boolean {
  return Boolean(old.migrated_profile_id) && !sameFields(old, profile)
}

async function findLink(db: ProfileReader, ref: VariantRef): Promise<LinkRow | null> {
  const rows = await db.findMany(LINK_TABLE, {
    where: { product_source: ref.product_source, product_id: ref.product_id },
    limit: 1,
  })
  return (rows[0] as LinkRow | undefined) ?? null
}

async function findProfile(db: ProfileReader, id: string): Promise<ProfileRow | null> {
  const rows = await db.findMany(PROFILE_TABLE, { where: { id }, limit: 1 })
  return (rows[0] as ProfileRow | undefined) ?? null
}

async function findLegacy(db: ProfileReader, ref: VariantRef): Promise<LegacyRow | null> {
  const rows = await db.findMany(LEGACY_TABLE, {
    where: { product_source: ref.product_source, product_id: ref.product_id },
    limit: 1,
  })
  return (rows[0] as LegacyRow | undefined) ?? null
}

async function rereadLegacy(db: ProfileReader, id: string): Promise<LegacyRow | null> {
  const rows = await db.findMany(LEGACY_TABLE, { where: { id }, limit: 1 })
  return (rows[0] as LegacyRow | undefined) ?? null
}

/** Mirror `profile` onto one variant's old row (inserted when it has none), stamped with it. */
async function writeLegacy(db: ProfileDb, ref: VariantRef, profile: ProfileRow): Promise<void> {
  const data = { ...profileFields(profile), migrated_profile_id: String(profile.id) }
  const row = await findLegacy(db, ref)
  if (row) {
    await db.update(LEGACY_TABLE, row.id, data)
    return
  }
  try {
    await db.insert(LEGACY_TABLE, {
      product_source: ref.product_source,
      product_id: ref.product_id,
      ...data,
    })
  } catch (err) {
    // The previous release inserted the variant's row meanwhile: overwrite it with the link's truth.
    if (!isUniqueViolation(err)) throw err
    const winner = await findLegacy(db, ref)
    if (!winner) throw err
    await db.update(LEGACY_TABLE, winner.id, data)
  }
}

/** The writes that mirror `profile` (its fields, stamped with `profileId`) onto each variant's old
 *  row: an update of the row it has, an insert for one it lacks. Run in the tool's batch. */
async function legacyMirrorOps(
  db: ProfileReader,
  refs: VariantRef[],
  profile: object,
  profileId: string | { $ref: string },
): Promise<DbBatchOp[]> {
  const data = { ...profileFields(profile), migrated_profile_id: profileId }
  const ops: DbBatchOp[] = []
  for (const ref of refs) {
    const row = await findLegacy(db, ref)
    ops.push(
      row
        ? { update: LEGACY_TABLE, id: row.id, data }
        : {
            insert: LEGACY_TABLE,
            data: { product_source: ref.product_source, product_id: ref.product_id, ...data },
          },
    )
  }
  return ops
}

/**
 * Commit one tool call's writes (`build` reads, then lists them) in ONE batch: the profile, its
 * links and their old-table mirror land together or not at all, with no transaction held across
 * the run. When the previous release inserted a variant's old row between the read and the batch
 * (a unique violation), the batch wrote nothing: `build` re-reads and it is tried once more.
 */
async function commitProfileWrites(
  db: ProfileDb,
  build: () => Promise<DbBatchOp[]>,
): Promise<DbBatchResult> {
  try {
    return await db.batch({ ops: await build() })
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    return db.batch({ ops: await build() })
  }
}

/**
 * Migrate every old-table row not migrated yet (one profile + one link each), and re-migrate every
 * stamped row the previous release rewrote since (see ROLLING DEPLOY above). Idempotent and safe to
 * race. Each row is re-read right before it is acted on, and an unmigrated row is CLAIMED by
 * stamping it before its link is written, so a pass working from a stale listing never recreates a
 * link the user removed meanwhile (unlinking deletes the row). The link is unique per variant, so a
 * concurrent run that loses the race drops the profile it just made and adopts the winner's. A row
 * whose variant already has a link (written by the new model) is stamped with that link's profile
 * and takes its values, so the previous release reads what this one does.
 */
export async function migrateLegacyProfiles(
  ctx: ProfileCtx,
): Promise<{ migrated: number; remigrated: number }> {
  const [legacy, links, profiles] = await Promise.all([
    all<LegacyRow>(ctx.db, LEGACY_TABLE),
    all<LinkRow>(ctx.db, LINK_TABLE),
    all<ProfileRow>(ctx.db, PROFILE_TABLE),
  ])
  const linkByRef = new Map(links.map((l) => [refOf(l), l]))
  const profileById = new Map(profiles.map((p) => [String(p.id), p]))
  let migrated = 0
  let remigrated = 0
  for (const row of legacy) {
    if (!row.migrated_profile_id) {
      migrated += await migrateRow(ctx.db, row.id)
      continue
    }
    const link = linkByRef.get(refOf(row))
    const profile = link ? profileById.get(String(link.profile_id)) : undefined
    if (profile && rewrittenByPreviousRelease(row, profile))
      remigrated += await remigrateRow(ctx.db, row.id)
  }
  return { migrated, remigrated }
}

async function migrateRow(db: ProfileDb, rowId: string): Promise<number> {
  const row = await rereadLegacy(db, rowId)
  if (!row || row.migrated_profile_id) return 0
  const existing = await findLink(db, row)
  if (existing) {
    const profile = await findProfile(db, existing.profile_id)
    if (profile) await writeLegacy(db, row, profile)
    return 0
  }
  const { id } = await db.insert(PROFILE_TABLE, profileFields(row))
  // Claim the row: stamp it, then check the stamp is ours and the row still exists.
  try {
    await db.update(LEGACY_TABLE, row.id, { migrated_profile_id: id })
  } catch (err) {
    if (await rereadLegacy(db, row.id)) throw err
  }
  const claimed = await rereadLegacy(db, row.id)
  if (!claimed || claimed.migrated_profile_id !== id) {
    await db.delete(PROFILE_TABLE, id)
    return 0
  }
  try {
    await db.insert(LINK_TABLE, {
      product_source: row.product_source,
      product_id: row.product_id,
      profile_id: id,
    })
    return 1
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    await db.delete(PROFILE_TABLE, id)
    const winner = await findLink(db, row)
    if (!winner) throw err
    const profile = await findProfile(db, winner.profile_id)
    if (!profile) throw err
    await writeLegacy(db, row, profile)
    return 0
  }
}

async function remigrateRow(db: ProfileDb, rowId: string): Promise<number> {
  const row = await rereadLegacy(db, rowId)
  if (!row || !row.migrated_profile_id) return 0
  const link = await findLink(db, row)
  const profile = link ? await findProfile(db, link.profile_id) : null
  if (!link || !profile || !rewrittenByPreviousRelease(row, profile)) return 0
  const fields = profileFields(row)
  const siblings = await all<LinkRow>(db, LINK_TABLE, { profile_id: link.profile_id })
  if (siblings.length <= 1) {
    await db.update(PROFILE_TABLE, link.profile_id, fields)
    await db.update(LEGACY_TABLE, row.id, { migrated_profile_id: link.profile_id })
    return 1
  }
  // The previous release meant this variant only: give it a profile of its own.
  const { id } = await db.insert(PROFILE_TABLE, { ...fields, label: profile.label ?? null })
  await db.update(LINK_TABLE, link.id, { profile_id: id })
  await db.update(LEGACY_TABLE, row.id, { migrated_profile_id: id })
  return 1
}

/** The `migrate-shipping-profiles` job. */
export const migrateShippingProfilesJobHandler = (_payload: unknown, ctx: ProfileCtx) =>
  migrateLegacyProfiles(ctx)

// — upsert (product_profile_upsert) —

export interface ProfileUpsertInput {
  product_source: string
  product_id: string
  unit_weight: number
  /** Absent: kept as it is. null: cleared. */
  solo_length?: number | null
  solo_width?: number | null
  solo_height?: number | null
  content_category?: string | null
  short_code?: string
  accessory?: boolean
  label?: string
  /** Required to edit a profile other variants share: the edit changes it for all of them. */
  apply_to_shared?: boolean
}

/**
 * Write the profile a variant uses. A linked variant's profile is updated IN PLACE; when other
 * variants share it, that is refused unless `apply_to_shared` is true (the error names them), since
 * the edit moves every one of them. An unlinked variant gets a new profile and its link. Only the
 * fields sent are written (null clears a solo dim or the category; an empty string clears the code
 * or the label), so a weight update never wipes the dims or the code. Mirrored onto the old table.
 */
export async function upsertVariantProfile(
  ctx: ProfileCtx,
  input: ProfileUpsertInput,
): Promise<{ id: string; shared_with: VariantRef[] }> {
  if (!(input.unit_weight > 0)) {
    throw new Error("unit_weight must be greater than 0")
  }
  await migrateLegacyProfiles(ctx)
  const data: Record<string, unknown> = { unit_weight: input.unit_weight }
  for (const f of ["solo_length", "solo_width", "solo_height", "content_category"] as const) {
    if (input[f] !== undefined) data[f] = input[f] === "" ? null : input[f]
  }
  if (input.short_code !== undefined) data.short_code = input.short_code || null
  if (input.accessory !== undefined) data.accessory = input.accessory === true
  if (input.label !== undefined) data.label = input.label || null

  const link = await findLink(ctx.db, input)
  if (link) {
    const shared = (await all<LinkRow>(ctx.db, LINK_TABLE, { profile_id: link.profile_id }))
      .filter((s) => refOf(s) !== refOf(input))
      .map((s) => ({ product_source: s.product_source, product_id: s.product_id }))
    if (shared.length > 0 && input.apply_to_shared !== true) {
      throw new Error(
        `Variant ${refOf(input)} uses shipping profile ${link.profile_id}, shared with ${shared.length} other variant(s): ${shared.map(refOf).join(", ")}. This edit would change it for all of them: pass apply_to_shared: true to do that, or unlink this variant (product_profile_unlink) and give it a profile of its own.`,
      )
    }
    const profileId = link.profile_id
    await commitProfileWrites(ctx.db, async () => {
      const current = await findProfile(ctx.db, profileId)
      const linked = await all<LinkRow>(ctx.db, LINK_TABLE, { profile_id: profileId })
      return [
        { update: PROFILE_TABLE, id: profileId, data },
        ...(await legacyMirrorOps(ctx.db, linked, { ...(current ?? {}), ...data }, profileId)),
      ]
    })
    return { id: profileId, shared_with: shared }
  }
  const committed = await commitProfileWrites(ctx.db, async () => [
    { insert: PROFILE_TABLE, as: "profile", data },
    {
      insert: LINK_TABLE,
      data: {
        product_source: input.product_source,
        product_id: input.product_id,
        profile_id: { $ref: "profile" },
      },
    },
    ...(await legacyMirrorOps(ctx.db, [input], data, { $ref: "profile" })),
  ])
  return { id: String(committed.rows.profile?.id), shared_with: [] }
}

// — link / unlink —

export interface LinkInput extends VariantRef {
  profile_id: string
  /** Required to MOVE a variant that already has another profile: without it the move is only
   *  previewed. */
  confirm?: boolean
}

export interface LinkDifference {
  field: ProfileField
  current: unknown
  next: unknown
}

export interface LinkResult {
  /** false: a preview, nothing was written. */
  ok: boolean
  preview: boolean
  profile_id: string
  previous_profile_id: string | null
  /** Moving off another profile: every field the variant would change. */
  differences: LinkDifference[]
  note?: string
}

/** Point a variant at an existing profile. Moving it off the profile it already uses is previewed
 *  first (the field differences) and applied only with `confirm: true`. Drafts already resolved are
 *  NOT re-resolved: they pick the profile up at their next sync. Mirrored onto the old table. */
export async function linkVariant(ctx: ProfileCtx, input: LinkInput): Promise<LinkResult> {
  if (!input.product_source || !input.product_id)
    throw new Error("product_source and product_id are required")
  await migrateLegacyProfiles(ctx)
  const profile = await findProfile(ctx.db, input.profile_id)
  if (!profile) throw new Error(`No shipping profile with id ${input.profile_id}.`)
  const link = await findLink(ctx.db, input)
  const base = { profile_id: input.profile_id, previous_profile_id: link?.profile_id ?? null }
  if (link?.profile_id === input.profile_id) {
    return { ok: true, preview: false, ...base, differences: [] }
  }
  if (link) {
    const current = await findProfile(ctx.db, link.profile_id)
    const differences: LinkDifference[] = []
    for (const field of PROFILE_FIELDS) {
      const a = current?.[field] ?? null
      const b = profile[field] ?? null
      if (norm(field, a) !== norm(field, b)) differences.push({ field, current: a, next: b })
    }
    const note = `Moving ${refOf(input)} from profile ${link.profile_id} to ${input.profile_id}: it takes that profile's values${differences.length > 0 ? ` (${differences.map((d) => d.field).join(", ")} change)` : ""} and enters that profile's packs (a pack whose bill names any variant of it can take this variant), and leaves the packs of its current profile.`
    if (input.confirm !== true) {
      return {
        ok: false,
        preview: true,
        ...base,
        differences,
        note: `${note} Call again with confirm: true to apply.`,
      }
    }
    await commitProfileWrites(ctx.db, async () => [
      { update: LINK_TABLE, id: link.id, data: { profile_id: input.profile_id } },
      ...(await legacyMirrorOps(ctx.db, [input], profile, input.profile_id)),
    ])
    return { ok: true, preview: false, ...base, differences, note }
  }
  await commitProfileWrites(ctx.db, async () => [
    {
      insert: LINK_TABLE,
      data: {
        product_source: input.product_source,
        product_id: input.product_id,
        profile_id: input.profile_id,
      },
    },
    ...(await legacyMirrorOps(ctx.db, [input], profile, input.profile_id)),
  ])
  return { ok: true, preview: false, ...base, differences: [] }
}

/** Detach a variant from its profile. The profile stays (other variants may use it); the variant
 *  resolves as having no profile until it is linked again, in the previous release too (its old
 *  row is deleted). */
export async function unlinkVariant(
  ctx: ProfileCtx,
  input: VariantRef,
): Promise<{ ok: true; profile_id: string; remaining_variants: number }> {
  await migrateLegacyProfiles(ctx)
  const link = await findLink(ctx.db, input)
  if (!link) throw new Error(`Variant ${refOf(input)} is not linked to any shipping profile.`)
  const legacy = await findLegacy(ctx.db, input)
  await ctx.db.batch({
    ops: [
      { delete: LINK_TABLE, id: link.id },
      ...(legacy ? [{ delete: LEGACY_TABLE, id: legacy.id }] : []),
    ],
  })
  const rest = await all<LinkRow>(ctx.db, LINK_TABLE, { profile_id: link.profile_id })
  return { ok: true, profile_id: link.profile_id, remaining_variants: rest.length }
}

// — delete —

/** Delete a profile no variant uses. Refused while any variant links to it. */
export async function deleteProfile(
  ctx: ProfileCtx,
  input: { profile_id: string },
): Promise<{ ok: true }> {
  await migrateLegacyProfiles(ctx)
  const profile = await findProfile(ctx.db, input.profile_id)
  if (!profile) throw new Error(`No shipping profile with id ${input.profile_id}.`)
  const links = await all<LinkRow>(ctx.db, LINK_TABLE, { profile_id: input.profile_id })
  if (links.length > 0) {
    throw new Error(
      `Shipping profile ${input.profile_id} is still used by ${links.length} variant(s): ${links.map(refOf).join(", ")}. Unlink them (or merge this profile into another) first.`,
    )
  }
  await ctx.db.delete(PROFILE_TABLE, input.profile_id)
  return { ok: true }
}

// — merge —

export interface MergeInput {
  /** The profile that remains. */
  target_profile_id: string
  /** Profiles folded into the target: their variants move to it, then they are deleted. */
  source_profile_ids: string[]
  /** When the profiles' fields differ: whose fields the target keeps (the target or one source). */
  fields_from?: string
  /** False or absent: preview only, nothing is written. */
  confirm?: boolean
}

export interface MergeDifference {
  field: ProfileField
  values: Record<string, unknown>
}

export interface MergeResult {
  preview: boolean
  target_profile_id: string
  moves: Array<VariantRef & { from_profile_id: string }>
  differences: MergeDifference[]
  deleted_profile_ids: string[]
}

function same(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null)
}

/**
 * Fold several profiles into one. Without `confirm` it only previews: which variants move, which
 * profiles would be deleted, and every field where the profiles disagree. Applying is refused while
 * any field differs unless `fields_from` names whose fields win.
 */
export async function mergeProfiles(ctx: ProfileCtx, input: MergeInput): Promise<MergeResult> {
  const sources = [...new Set(input.source_profile_ids ?? [])]
  if (sources.length === 0)
    throw new Error("source_profile_ids must name at least one profile to merge.")
  if (sources.includes(input.target_profile_id)) {
    throw new Error("The target profile cannot also be a source.")
  }
  await migrateLegacyProfiles(ctx)
  const ids = [input.target_profile_id, ...sources]
  const rows: ProfileRow[] = []
  for (const id of ids) {
    const p = await findProfile(ctx.db, id)
    if (!p) throw new Error(`No shipping profile with id ${id}.`)
    rows.push(p)
  }
  const target = rows[0]!
  const differences: MergeDifference[] = []
  for (const field of PROFILE_FIELDS) {
    if (rows.every((r) => same(r[field], target[field]))) continue
    differences.push({
      field,
      values: Object.fromEntries(rows.map((r) => [String(r.id), r[field] ?? null])),
    })
  }
  const moves: MergeResult["moves"] = []
  const movingLinks: LinkRow[] = []
  for (const id of sources) {
    for (const l of await all<LinkRow>(ctx.db, LINK_TABLE, { profile_id: id })) {
      movingLinks.push(l)
      moves.push({
        product_source: l.product_source,
        product_id: l.product_id,
        from_profile_id: id,
      })
    }
  }
  const result: MergeResult = {
    preview: input.confirm !== true,
    target_profile_id: input.target_profile_id,
    moves,
    differences,
    deleted_profile_ids: sources,
  }
  if (input.confirm !== true) return result

  if (input.fields_from !== undefined && !ids.includes(input.fields_from)) {
    throw new Error("fields_from must be the target or one of the source profiles.")
  }
  if (differences.length > 0 && input.fields_from === undefined) {
    throw new Error(
      `The profiles differ on ${differences.map((d) => d.field).join(", ")}. Pass fields_from (the profile whose fields the merged profile keeps) to merge them anyway.`,
    )
  }
  const winner =
    input.fields_from !== undefined && input.fields_from !== input.target_profile_id
      ? rows.find((r) => String(r.id) === input.fields_from)!
      : null
  const targetData = winner
    ? { ...profileFields(winner), ...(winner.label != null ? { label: winner.label } : {}) }
    : null
  // The target's new fields, the moved links, the deleted sources and every mirrored old row of
  // the merged profile commit together: a merge never leaves variants half moved.
  await commitProfileWrites(ctx.db, async () => {
    const targetLinks = await all<LinkRow>(ctx.db, LINK_TABLE, {
      profile_id: input.target_profile_id,
    })
    return [
      ...(targetData
        ? [{ update: PROFILE_TABLE, id: input.target_profile_id, data: targetData }]
        : []),
      ...movingLinks.map((l) => ({
        update: LINK_TABLE,
        id: l.id,
        data: { profile_id: input.target_profile_id },
      })),
      ...sources.map((id) => ({ delete: PROFILE_TABLE, id })),
      ...(await legacyMirrorOps(
        ctx.db,
        [...targetLinks, ...movingLinks],
        { ...target, ...(targetData ?? {}) },
        input.target_profile_id,
      )),
    ]
  })
  return result
}

// — listing —

export interface SharedProfileView extends ProfileRow {
  variants: VariantRef[]
}

/** Every profile with the variants that use it (a profile no variant uses lists none). */
export async function listSharedProfiles(db: ProfileReader): Promise<SharedProfileView[]> {
  const [profiles, links] = await Promise.all([
    all<ProfileRow>(db, PROFILE_TABLE),
    all<LinkRow>(db, LINK_TABLE),
  ])
  return profiles.map((p) => ({
    ...p,
    variants: links
      .filter((l) => String(l.profile_id) === String(p.id))
      .map((l) => ({ product_source: l.product_source, product_id: l.product_id })),
  }))
}
