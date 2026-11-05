// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PACKAGING POLICY: how an org boxes leftover items, and what a no-sale proforma declares.
//
// The package resolver stacks the items no confirmed pack covers (L = max length, W = max width,
// P = summed thickness, weight = summed gross weight). What happens to that stack next is one
// company's packing rule, not this app's: which cartons exist, at what stack thickness each one
// takes over, what each carton weighs, whether a leftover stack rides inside a pack's parcel, and
// the nominal value printed on a return-after-repair or sample proforma. It is held per org in
// `app_config` under `packaging_policy` (`settings_packaging_policy_get` / `_set`).
//
// The rules run in a fixed order: MASTER CARTONS first (a product whose quantity reaches its master
// carton's unit count ships in sealed master cartons at their confirmed gross weight), then the
// confirmed packs, then the leftover stack goes through the carton ladder. A stack deeper than the
// last tier fills the last carton (thickest items first) and the remainder starts over. Small items
// flagged `accessory` on their shipping profile are laid BESIDE the stack: they add the height of the
// tallest of them once, however many there are (alone, with nothing to sit beside, they stack).
//
// NEUTRAL DEFAULT (no policy stored): no carton ladder. Every confirmed pack is its own parcel and
// all leftover items stack into ONE parcel at their true stacked dimensions and summed weight, with
// no carton added and no split. That is what the resolver does for a stack no carton rule applies
// to. No nominal value is declared either, so a repair or sample proforma is refused, naming this
// setting, until the org sets one.

/** One carton of the ladder. A loose stack whose true thickness is at most `max_stack_height`
 *  (and above the previous tier's) ships in this carton. */
export interface CartonTier {
  max_stack_height: number
  length: number
  width: number
  height: number
  /** The empty carton's own weight (kg), added to the stack's weight. */
  tare_weight: number
  /** True while `tare_weight` is an estimate, not a weighed figure: every parcel that uses this
   *  carton then carries a warning so the assumption never travels silently. */
  tare_assumed?: boolean
}

/** A sealed master carton: `units` of ONE product (matched by the shipping profiles' short code, so
 *  every variant carrying that code counts together) ship as this carton at its confirmed total
 *  gross weight, contents and carton included, nothing added on top. */
export interface MasterCarton {
  short_code: string
  units: number
  length: number
  width: number
  height: number
  weight: number
}

export interface PackagingPolicy {
  /** A loose stack up to this true thickness (cm) ships in its own retail boxes, no carton. Null
   *  means no limit: every stack ships raw (only valid with no cartons and no pack merge). */
  raw_stack_max_height: number | null
  /** The carton ladder, ascending by `max_stack_height`. A stack deeper than the last tier is split
   *  into balanced stacks that each fit. Empty = no cartons. */
  cartons: CartonTier[]
  /** Whether a leftover stack rides INSIDE a confirmed pack's parcel when the combined thickness
   *  still fits the ladder, instead of shipping as a parcel of its own. */
  merge_leftovers_into_packs: boolean
  /** How much deeper (cm) a pack plus leftovers may be than a loose stack at the same tier. A pack's
   *  height is measured on its own box, so a merge compares against every threshold plus this. */
  pack_merge_height_allowance: number
  /** Declared value of a nominal (return after repair, sample) proforma, in EUR minor units. Null =
   *  not set: such a proforma is refused until the org sets one. */
  nominal_proforma_value_minor: number | null
  /** Master cartons, applied before anything else. Empty = none. */
  master_cartons: MasterCarton[]
}

export const NEUTRAL_PACKAGING_POLICY: PackagingPolicy = Object.freeze({
  raw_stack_max_height: null,
  cartons: Object.freeze([]) as unknown as CartonTier[],
  merge_leftovers_into_packs: false,
  pack_merge_height_allowance: 0,
  nominal_proforma_value_minor: null,
  master_cartons: Object.freeze([]) as unknown as MasterCarton[],
}) as PackagingPolicy

export const PACKAGING_POLICY_KEY = "packaging_policy"

function positive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0
}

function nonNegative(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
}

/** Every problem with a candidate policy, named, or an empty list when it is valid. */
export function packagingPolicyProblems(p: PackagingPolicy): string[] {
  const problems: string[] = []
  if (p.raw_stack_max_height !== null && !positive(p.raw_stack_max_height)) {
    problems.push("raw_stack_max_height must be a positive number of cm, or null for no limit")
  }
  if (!Array.isArray(p.cartons)) {
    problems.push("cartons must be a list")
  } else {
    let previous = p.raw_stack_max_height ?? 0
    p.cartons.forEach((c, i) => {
      const at = `cartons[${i}]`
      if (!c || typeof c !== "object") {
        problems.push(`${at} must be an object`)
        return
      }
      for (const f of ["max_stack_height", "length", "width", "height"] as const) {
        if (!positive(c[f])) problems.push(`${at}.${f} must be a positive number`)
      }
      if (!nonNegative(c.tare_weight)) problems.push(`${at}.tare_weight must be a number of kg, 0 or more`)
      if (c.tare_assumed !== undefined && typeof c.tare_assumed !== "boolean") {
        problems.push(`${at}.tare_assumed must be true or false`)
      }
      if (positive(c.max_stack_height)) {
        if (c.max_stack_height <= previous) {
          problems.push(`${at}.max_stack_height must be above the previous threshold (${previous})`)
        }
        previous = c.max_stack_height
      }
    })
    if (p.cartons.length > 0 && p.raw_stack_max_height === null) {
      problems.push("raw_stack_max_height must be set when cartons are defined")
    }
  }
  if (typeof p.merge_leftovers_into_packs !== "boolean") {
    problems.push("merge_leftovers_into_packs must be true or false")
  } else if (p.merge_leftovers_into_packs && p.raw_stack_max_height === null) {
    problems.push("raw_stack_max_height must be set when merge_leftovers_into_packs is on")
  }
  if (!nonNegative(p.pack_merge_height_allowance)) {
    problems.push("pack_merge_height_allowance must be a number of cm, 0 or more")
  }
  if (!Array.isArray(p.master_cartons)) {
    problems.push("master_cartons must be a list")
  } else {
    const seen = new Set<string>()
    p.master_cartons.forEach((m, i) => {
      const at = `master_cartons[${i}]`
      if (!m || typeof m !== "object") {
        problems.push(`${at} must be an object`)
        return
      }
      if (typeof m.short_code !== "string" || m.short_code.trim() === "") {
        problems.push(`${at}.short_code must name a product short code`)
      } else if (seen.has(m.short_code.trim().toUpperCase())) {
        problems.push(`${at}.short_code ${m.short_code} already has a master carton`)
      } else {
        seen.add(m.short_code.trim().toUpperCase())
      }
      if (!(Number.isInteger(m.units) && m.units >= 1)) problems.push(`${at}.units must be a whole number, 1 or more`)
      for (const f of ["length", "width", "height", "weight"] as const) {
        if (!positive(m[f])) problems.push(`${at}.${f} must be a positive number`)
      }
    })
  }
  if (
    p.nominal_proforma_value_minor !== null &&
    !(Number.isInteger(p.nominal_proforma_value_minor) && p.nominal_proforma_value_minor > 0)
  ) {
    problems.push("nominal_proforma_value_minor must be a positive whole number of minor units, or null")
  }
  return problems
}

/** Read a stored value. Unset or invalid degrades to the neutral default, never a crash and never a
 *  half-applied ladder. */
export function packagingPolicyFromValue(value: unknown): PackagingPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return NEUTRAL_PACKAGING_POLICY
  const v = value as Record<string, unknown>
  const candidate: PackagingPolicy = {
    raw_stack_max_height: (v.raw_stack_max_height ?? null) as number | null,
    cartons: (Array.isArray(v.cartons) ? v.cartons : []) as CartonTier[],
    merge_leftovers_into_packs: (v.merge_leftovers_into_packs ?? false) as boolean,
    pack_merge_height_allowance: (v.pack_merge_height_allowance ?? 0) as number,
    nominal_proforma_value_minor: (v.nominal_proforma_value_minor ?? null) as number | null,
    master_cartons: (Array.isArray(v.master_cartons) ? v.master_cartons : []) as MasterCarton[],
  }
  if (packagingPolicyProblems(candidate).length > 0) return NEUTRAL_PACKAGING_POLICY
  return normalizePackagingPolicy(candidate)
}

/** The stored shape of a valid policy: known fields only, short codes trimmed and upper-cased. */
export function normalizePackagingPolicy(p: PackagingPolicy): PackagingPolicy {
  return {
    raw_stack_max_height: p.raw_stack_max_height,
    cartons: p.cartons.map((c) => ({
      max_stack_height: c.max_stack_height,
      length: c.length,
      width: c.width,
      height: c.height,
      tare_weight: c.tare_weight,
      ...(c.tare_assumed === true ? { tare_assumed: true } : {}),
    })),
    merge_leftovers_into_packs: p.merge_leftovers_into_packs,
    pack_merge_height_allowance: p.pack_merge_height_allowance,
    nominal_proforma_value_minor: p.nominal_proforma_value_minor,
    master_cartons: p.master_cartons.map((m) => ({
      short_code: m.short_code.trim().toUpperCase(),
      units: m.units,
      length: m.length,
      width: m.width,
      height: m.height,
      weight: m.weight,
    })),
  }
}
