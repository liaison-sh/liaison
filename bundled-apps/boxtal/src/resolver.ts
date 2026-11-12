// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Package resolver. Turns a set of invoice lines (each carrying a
// `(product_source, external_id)` catalog join key) into a parcel set + a
// per-line customs-article skeleton, flagging lines that cannot be resolved.
//
// Join key: `line.(product_source, external_id)` === catalog
// `(product_source, product_id)`. A line with a null `external_id` has no ref
// (hand-typed, non-catalog) and is immediately unresolved.
//
// Order of the rules: MASTER CARTONS first (the org policy's sealed cartons, matched by product short
// code), then the greedy pack cover (packs sorted by name, each consuming its component multiset), then
// the leftover STACK: L = max length, W = max width, P = summed thickness, weight = summed gross
// weight, at TRUE dimensions with no margin ever added. Items flagged `accessory` on their profile
// are laid beside the stack and add the tallest of their heights once. What happens to the stack
// next is the org's packaging policy (packaging-policy.ts, settings_packaging_policy_get/_set): its
// carton ladder picks a carton by P and adds the carton's tare once; a stack deeper than the last
// tier fills that carton thickest item first and the remainder starts over; the remainder may merge
// INTO a pack parcel when the combined thickness still fits. With no policy (the neutral default)
// packs are their own parcels and all leftovers ship as ONE raw stacked parcel. Leftover with no
// profile (or no ref, or a zero/null weight, or missing dims) become `unresolved`; conditions the
// operator must decide (no carton fits, an assumed tare) come back as `warnings`.
//
// Pure function over injected catalog rows — the DB read lives in the caller.

import { NEUTRAL_PACKAGING_POLICY, type PackagingPolicy } from "./packaging-policy"

export interface ResolverLine {
  id: string
  product_source: string | null
  external_id: string | null
  quantity: number
}

export interface CatalogProfile {
  product_source: string
  product_id: string
  unit_weight: number
  solo_length: number | null
  solo_width: number | null
  solo_height: number | null
  content_category: string | null
  /** Operator-set short product code (e.g. "ET2") for the prep-grid products summary. */
  short_code?: string | null
  /** A small item (power supply, cable) laid BESIDE the stack rather than on it: the stack grows by
   *  the height of the tallest such item once, however many there are. Alone, they stack. */
  accessory?: boolean | null
  /** The shared profile this variant uses (profiles.ts). Variants on the SAME profile are the same
   *  physical item, so a pack's component matches any of them. Absent/null (an unmigrated row, or a
   *  caller that does not know profiles) keeps matching by variant ref exactly as before. */
  profile_id?: string | null
}

export interface CatalogPack {
  id: string
  name: string
  length: number
  width: number
  height: number
  gross_weight: number
  content_category: string | null
  /** The shipping carton's own tare (kg) already folded into gross_weight from this
   *  pack's original boxing — e.g. a pack whose gross_weight was itself derived from
   *  a stacking calculation that added a ladder carton tare. Null on rows saved before
   *  this field existed, or on a pack whose gross_weight is items-only with no separate
   *  carton tare recorded; either way the merge below treats a null as zero tare, its
   *  prior (correct) behavior. */
  carton_tare: number | null
}

export interface CatalogPackComponent {
  pack_id: string
  product_source: string
  product_id: string
  quantity: number
}

export interface Parcel {
  length: number
  width: number
  height: number
  weight: number
}

export interface CustomsArticleSkeleton {
  line_id: string
  product_source: string | null
  external_id: string | null
  quantity: number
  unit_weight: number | null
}

export type UnresolvedReason = "no_profile" | "missing_weight" | "missing_dims"

export interface Unresolved {
  line: ResolverLine
  reason: UnresolvedReason
}

export interface ResolveInput {
  lines: ResolverLine[]
  profiles: CatalogProfile[]
  packs: CatalogPack[]
  components: CatalogPackComponent[]
  /** Replace the computed parcel set with a single ad-hoc carton. */
  override?: Parcel
  /** The org's packaging policy (packaging-policy.ts). Absent = the neutral default: packs are
   *  their own parcels and every leftover item stacks into one raw parcel. */
  policy?: PackagingPolicy
}

export interface ResolveResult {
  parcels: Parcel[]
  customsArticles: CustomsArticleSkeleton[]
  unresolved: Unresolved[]
  /** Conditions the operator must see instead of a silent parcel: a footprint no carton takes, an
   *  item deeper than every carton, a carton tare that is only assumed, nothing to pack. */
  warnings: string[]
  requote?: boolean
}

function refKey(source: string | null, id: string | null): string | null {
  if (source == null || id == null) return null
  return `${source}:${id}`
}

// ── Stacking calculation ──

/** One physical unit to stack: its retail-box footprint + thickness + weight. */
interface StackItem {
  /** The product short code when the profile has one, else the catalog ref: every ordering decision
   *  sorts on it, so the result never depends on line order and every variant of a product sorts
   *  as that product. */
  key: string
  length: number
  width: number
  height: number
  weight: number
  /** Laid BESIDE the stack (the profile's `accessory` flag), never on top of it. */
  beside: boolean
}

/** Grams-precision sum so repeated float adds never drift the declared weight. */
function gramsRound(v: number): number {
  return Math.round(v * 1000) / 1000
}

interface Tier {
  stackMax: number
  mergeMax: number
  length: number
  width: number
  height: number
  weight: number
  tareAssumed: boolean
}

/** The policy's thresholds, resolved once per call. Two parallel scales, because the two paths
 *  feed genuinely different P into the lookup:
 *   - the STACK path compares the TRUE stacked thickness of loose items against the policy's own
 *     figures;
 *   - the MERGE path (mergeStackIntoPackParcel) compares a pack's measured box height plus loose
 *     items' heights, so every threshold carries the policy's pack_merge_height_allowance on top. */
interface Ladder {
  /** Up to here a loose stack ships raw (no carton, no added weight). Infinity = always raw. */
  stackRawMax: number
  mergeEnabled: boolean
  mergeRawMax: number
  mergeMax: number
  tiers: ReadonlyArray<Tier>
}

function ladderFor(policy: PackagingPolicy): Ladder {
  const allowance = policy.pack_merge_height_allowance
  const stackRawMax = policy.raw_stack_max_height ?? Number.POSITIVE_INFINITY
  const last = policy.cartons[policy.cartons.length - 1]
  const stackSplitMax = last ? last.max_stack_height : stackRawMax
  return {
    stackRawMax,
    mergeEnabled: policy.merge_leftovers_into_packs,
    mergeRawMax: stackRawMax + allowance,
    mergeMax: stackSplitMax + allowance,
    tiers: policy.cartons.map((c) => ({
      stackMax: c.max_stack_height,
      mergeMax: c.max_stack_height + allowance,
      length: c.length,
      width: c.width,
      height: c.height,
      weight: c.tare_weight,
      tareAssumed: c.tare_assumed === true,
    })),
  }
}

/** Footprint and thickness of a group of loose items. L and W are the largest footprint; H is the
 *  summed thickness of the stacked items plus, ONCE, the tallest item laid beside them. With
 *  nothing to sit beside, beside items are the parcel and stack normally. */
function stackGeometry(items: StackItem[]): { length: number; width: number; height: number } {
  const length = Math.max(...items.map((i) => i.length))
  const width = Math.max(...items.map((i) => i.width))
  const base = items.filter((i) => !i.beside)
  const beside = items.filter((i) => i.beside)
  if (base.length === 0) return { length, width, height: beside.reduce((s, i) => s + i.height, 0) }
  const tallestBeside = beside.reduce((m, i) => Math.max(m, i.height), 0)
  return { length, width, height: base.reduce((s, i) => s + i.height, 0) + tallestBeside }
}

function fitsBase(geometry: { length: number; width: number }, tier: Tier): boolean {
  return geometry.length <= tier.length && geometry.width <= tier.width
}

function footprintWarning(geometry: { length: number; width: number }, tier: Tier): string {
  return (
    `Footprint ${geometry.length}x${geometry.width} cm exceeds the ${tier.length}x${tier.width} carton base: ` +
    "no carton fits, choose the packaging for this order."
  )
}

function tareWarning(tier: Tier): string {
  return (
    `The ${tier.length}x${tier.width}x${tier.height} carton was used with an assumed tare of ` +
    `${tier.weight} kg: weigh the empty carton and set its tare in the packaging policy.`
  )
}

/** One group of loose items bound for one parcel. `split` marks a piece filled out of a stack
 *  deeper than every carton: it always ships in a carton (the smallest whose max stack takes it),
 *  never raw, and it never merges into a pack. */
interface StackGroup {
  items: StackItem[]
  split?: boolean
}

/** Turn the loose items into parcel groups. Short stacks ship raw, the rest takes the first carton
 *  whose max stack fits; a stack deeper than every carton FILLS the biggest carton (thickest items
 *  first, beside items riding along when there is room) and the remainder starts over. A footprint
 *  wider than the biggest carton's base, or a single item deeper than it, is never forced into a
 *  carton: it is proposed as its raw stack and the caller is warned. */
function planStackGroups(items: StackItem[], ladder: Ladder, warnings: string[]): StackGroup[] {
  const groups: StackGroup[] = []
  let remaining = items
  while (remaining.length > 0) {
    const geometry = stackGeometry(remaining)
    if (
      geometry.height <= ladder.stackRawMax ||
      ladder.tiers.some((t) => geometry.height <= t.stackMax)
    ) {
      groups.push({ items: remaining })
      break
    }
    const biggest = ladder.tiers[ladder.tiers.length - 1]
    if (!biggest) {
      groups.push({ items: remaining })
      break
    }
    if (!fitsBase(geometry, biggest)) {
      warnings.push(footprintWarning(geometry, biggest))
      groups.push({ items: remaining })
      break
    }
    const { taken, left } = fillCarton(remaining, biggest.stackMax)
    if (taken.length === 0) {
      warnings.push(
        `A single item stacks deeper than the ${biggest.length}x${biggest.width}x${biggest.height} carton: ` +
          "no carton fits, choose the packaging for this order.",
      )
      groups.push({ items: remaining })
      break
    }
    groups.push({ items: taken, split: true })
    remaining = left
  }
  return groups
}

/** Fill one carton up to `maxHeight` of stacked thickness, thickest item first (ties by catalog
 *  ref), then let each beside product ride along, all its units at once, when the carton still has
 *  room for its height. */
function fillCarton(
  items: StackItem[],
  maxHeight: number,
): { taken: StackItem[]; left: StackItem[] } {
  // With nothing to sit beside, beside items are the stack itself and fill like any other item.
  const hasBase = items.some((i) => !i.beside)
  const base = items
    .filter((i) => !hasBase || !i.beside)
    .sort((a, b) => b.height - a.height || a.key.localeCompare(b.key))
  const taken: StackItem[] = []
  const left: StackItem[] = []
  let used = 0
  for (const item of base) {
    if (used + item.height <= maxHeight) {
      taken.push(item)
      used += item.height
    } else {
      left.push(item)
    }
  }
  const besideByKey = new Map<string, StackItem[]>()
  for (const item of items.filter((i) => hasBase && i.beside)) {
    besideByKey.set(item.key, [...(besideByKey.get(item.key) ?? []), item])
  }
  for (const key of [...besideByKey.keys()].sort()) {
    const units = besideByKey.get(key)!
    if (taken.length > 0 && used + units[0]!.height <= maxHeight) taken.push(...units)
    else left.push(...units)
  }
  return { taken, left }
}

/** One group into a parcel: a raw stack at its true dims (no margin, ever), or the first carton
 *  whose max stack takes it (always one for a split piece), plus that carton's tare once. A stack too wide for its carton's base is proposed raw, with a warning. */
function stackToParcel(group: StackGroup, ladder: Ladder, warnings: string[]): Parcel {
  const geometry = stackGeometry(group.items)
  const weight = gramsRound(group.items.reduce((s, i) => s + i.weight, 0))
  const raw = { length: geometry.length, width: geometry.width, height: geometry.height, weight }
  const carton =
    !group.split && geometry.height <= ladder.stackRawMax
      ? undefined
      : ladder.tiers.find((c) => geometry.height <= c.stackMax)
  if (!carton) return raw
  if (!fitsBase(geometry, carton)) {
    warnings.push(footprintWarning(geometry, carton))
    return raw
  }
  if (carton.tareAssumed) warnings.push(tareWarning(carton))
  return {
    length: carton.length,
    width: carton.width,
    height: carton.height,
    weight: gramsRound(weight + carton.weight),
  }
}

/** A merge's parcel plus the tare NOW baked into its weight, so the caller can
 *  keep its tare bookkeeping in sync with the parcel it just replaced. */
interface MergedParcel {
  parcel: Parcel
  /** The tare (kg) folded into `parcel.weight`, for a later merge over this same
   *  slot: null for a raw (no-carton) merge (no standard carton, no tracked
   *  tare), or the chosen ladder tier's own tare for a carton merge. */
  tare: number | null
}

/** Try to absorb a leftover stack INTO an existing pack parcel: the pack parcel
 *  acts as one item and the ladder re-runs over the combined thickness, against the
 *  merge-scale thresholds (see Ladder). Returns the merged parcel + its tare, or null
 *  when the combination cannot fit one carton. `packCartonTare` is the pack's OWN
 *  carton tare (kg), already folded into `pack.weight` from its original boxing,
 *  carried on the CatalogPack row and never inferred from dims. */
function mergeStackIntoPackParcel(
  pack: Parcel,
  packCartonTare: number | null,
  items: StackItem[],
  ladder: Ladder,
  warnings: string[],
): MergedParcel | null {
  // The pack is a stacked item itself, so beside items next to it add their tallest height once.
  const stackedP = items.filter((i) => !i.beside).reduce((s, i) => s + i.height, 0)
  const besideP = items.filter((i) => i.beside).reduce((m, i) => Math.max(m, i.height), 0)
  const combinedP = pack.height + stackedP + besideP
  if (combinedP > ladder.mergeMax) return null
  const weight = gramsRound(pack.weight + items.reduce((s, i) => s + i.weight, 0))
  if (combinedP <= ladder.mergeRawMax) {
    return {
      parcel: {
        length: Math.max(pack.length, ...items.map((i) => i.length)),
        width: Math.max(pack.width, ...items.map((i) => i.width)),
        height: combinedP,
        weight,
      },
      tare: null,
    }
  }
  const carton = ladder.tiers.find((c) => combinedP <= c.mergeMax)
  if (!carton) return null
  // A pack too wide for the standard carton base cannot be re-boxed.
  if (pack.length > carton.length || pack.width > carton.width) return null
  if (carton.tareAssumed) warnings.push(tareWarning(carton))
  // Exactly-once taring: back out the tare the pack's own weight already carries
  // from its original boxing, then apply the NEW outer carton's tare — this
  // stays correct even when the combined stack crosses into a different ladder
  // tier than the pack's own (its old tare and the new tier's tare can differ).
  return {
    parcel: {
      length: carton.length,
      width: carton.width,
      height: carton.height,
      weight: gramsRound(weight - (packCartonTare ?? 0) + carton.weight),
    },
    tare: carton.weight,
  }
}

/** Resolve invoice lines into parcels + per-line customs skeletons. */
export function resolvePackages(input: ResolveInput): ResolveResult {
  const profilesByRef = new Map<string, CatalogProfile>()
  for (const p of input.profiles) {
    profilesByRef.set(`${p.product_source}:${p.product_id}`, p)
  }

  // Per-line customs articles are ALWAYS one per input line, independent of how
  // the lines get packed.
  const customsArticles: CustomsArticleSkeleton[] = input.lines.map((l) => {
    const prof = profilesByRef.get(refKey(l.product_source, l.external_id) ?? "")
    return {
      line_id: l.id,
      product_source: l.product_source,
      external_id: l.external_id,
      quantity: l.quantity,
      unit_weight: prof?.unit_weight ?? null,
    }
  })

  // Ad-hoc carton override → one parcel, requote.
  if (input.override) {
    return {
      parcels: [input.override],
      customsArticles,
      unresolved: [],
      warnings: [],
      requote: true,
    }
  }

  // Expand each line into `quantity` unit-refs so packs consume the right count.
  // A line with no ref is unresolved up front.
  const unresolved: Unresolved[] = []
  const remaining: Array<{ line: ResolverLine; ref: string }> = []
  for (const l of input.lines) {
    const ref = refKey(l.product_source, l.external_id)
    if (ref == null) {
      unresolved.push({ line: l, reason: "no_profile" })
      continue
    }
    for (let i = 0; i < Math.max(1, l.quantity); i++) {
      remaining.push({ line: l, ref })
    }
  }

  const policy = input.policy ?? NEUTRAL_PACKAGING_POLICY
  const warnings: string[] = []

  // Step 1, MASTER CARTONS: a product whose units reach its master carton's count ships in sealed
  // master cartons at their confirmed gross weight. Units are matched by the profile's short code, so
  // every variant of one product counts together; they leave `remaining` before any pack is tried.
  const masterParcels: Parcel[] = []
  for (const master of policy.master_cartons) {
    const code = master.short_code.trim().toUpperCase()
    const matching = remaining
      .map((r, index) => ({ ref: r.ref, index }))
      .filter((r) => normalizedShortCode(profilesByRef.get(r.ref)) === code)
      .sort((a, b) => a.ref.localeCompare(b.ref) || a.index - b.index)
    const count = Math.floor(matching.length / master.units)
    if (count === 0) continue
    const consumed = new Set(matching.slice(0, count * master.units).map((r) => r.index))
    const kept = remaining.filter((_, index) => !consumed.has(index))
    remaining.length = 0
    remaining.push(...kept)
    for (let i = 0; i < count; i++) {
      masterParcels.push({
        length: master.length,
        width: master.width,
        height: master.height,
        weight: master.weight,
      })
    }
  }

  const parcels: Parcel[] = []
  // Parallel to `parcels`: each named-pack-matched parcel's own carton_tare, so a
  // later merge can back it out exactly once. Index-aligned only for the entries
  // pushed by the pack-match loop below (the only ones a merge ever targets).
  const parcelCartonTares: Array<number | null> = []

  // Greedy pack cover, deterministic by pack name.
  const componentsByPack = new Map<string, CatalogPackComponent[]>()
  for (const c of input.components) {
    const list = componentsByPack.get(c.pack_id) ?? []
    list.push(c)
    componentsByPack.set(c.pack_id, list)
  }
  const sortedPacks = [...input.packs].sort((a, b) => a.name.localeCompare(b.name))
  const packKeyOf = (ref: string): string => {
    const pid = profilesByRef.get(ref)?.profile_id
    return pid ? `profile:${pid}` : ref
  }

  let madeProgress = true
  while (madeProgress) {
    madeProgress = false
    for (const pack of sortedPacks) {
      const comps = componentsByPack.get(pack.id) ?? []
      if (comps.length === 0) continue
      // Does the remaining ref multiset contain this pack's component multiset?
      // Matched by PACK KEY: a variant's shared profile when it has one, else its own ref.
      const need = new Map<string, number>()
      for (const c of comps) {
        const key = packKeyOf(`${c.product_source}:${c.product_id}`)
        need.set(key, (need.get(key) ?? 0) + c.quantity)
      }
      const have = new Map<string, number>()
      for (const r of remaining) {
        const key = packKeyOf(r.ref)
        have.set(key, (have.get(key) ?? 0) + 1)
      }
      let covered = true
      for (const [ref, qty] of need) {
        if ((have.get(ref) ?? 0) < qty) {
          covered = false
          break
        }
      }
      if (!covered) continue
      // Consume the component refs from `remaining`.
      for (const [ref, qty] of need) {
        let toRemove = qty
        for (let i = remaining.length - 1; i >= 0 && toRemove > 0; i--) {
          if (packKeyOf(remaining[i]!.ref) === ref) {
            remaining.splice(i, 1)
            toRemove--
          }
        }
      }
      parcels.push({
        length: pack.length,
        width: pack.width,
        height: pack.height,
        weight: pack.gross_weight,
      })
      parcelCartonTares.push(pack.carton_tare ?? null)
      madeProgress = true
      break // re-scan from the start so packing stays deterministic
    }
  }

  // Leftover unit-refs → ONE STACK (or as few as the ladder allows), never a
  // parcel per item. Validation first: a unit with no profile / no weight /
  // no dims is reported once per affected line and excluded from the stack —
  // a 0x0x0 box is rejected by Boxtal's quote/create, so the operator supplies
  // the missing figure rather than silently shipping a zero box.
  const seenUnresolvedLines = new Set<string>()
  const stackItems: StackItem[] = []
  for (const { line, ref } of remaining) {
    const prof = profilesByRef.get(ref)
    if (!prof) {
      if (!seenUnresolvedLines.has(line.id)) {
        unresolved.push({ line, reason: "no_profile" })
        seenUnresolvedLines.add(line.id)
      }
      continue
    }
    if (!prof.unit_weight || prof.unit_weight <= 0) {
      if (!seenUnresolvedLines.has(line.id)) {
        unresolved.push({ line, reason: "missing_weight" })
        seenUnresolvedLines.add(line.id)
      }
      continue
    }
    if (
      !(prof.solo_length && prof.solo_length > 0) ||
      !(prof.solo_width && prof.solo_width > 0) ||
      !(prof.solo_height && prof.solo_height > 0)
    ) {
      if (!seenUnresolvedLines.has(line.id)) {
        unresolved.push({ line, reason: "missing_dims" })
        seenUnresolvedLines.add(line.id)
      }
      continue
    }
    stackItems.push({
      key: normalizedShortCode(prof) ?? ref,
      length: prof.solo_length,
      width: prof.solo_width,
      height: prof.solo_height,
      weight: prof.unit_weight,
      beside: prof.accessory === true,
    })
  }

  if (stackItems.length > 0) {
    const ladder = ladderFor(policy)
    const groups = planStackGroups(stackItems, ladder, warnings)
    // "One carton whenever the stack fits": before the leftover remainder becomes its own parcel,
    // try to ride in an existing pack parcel (instrument+skin pack + plate + cable = one carton).
    // Only the remainder may merge; a piece filled out of a split is a closed carton.
    const last = groups[groups.length - 1]
    if (last && !last.split && parcels.length > 0 && ladder.mergeEnabled) {
      for (let i = 0; i < parcels.length; i++) {
        const merged = mergeStackIntoPackParcel(
          parcels[i]!,
          parcelCartonTares[i] ?? null,
          last.items,
          ladder,
          warnings,
        )
        if (merged) {
          parcels[i] = merged.parcel
          parcelCartonTares[i] = merged.tare
          groups.pop()
          break
        }
      }
    }
    for (const group of groups) {
      parcels.push(stackToParcel(group, ladder, warnings))
    }
  }

  const allParcels = [...masterParcels, ...parcels]
  if (allParcels.length === 0 && unresolved.length === 0) {
    warnings.push("Nothing to pack: no shippable line in this order.")
  }
  return { parcels: allParcels, customsArticles, unresolved, warnings: [...new Set(warnings)] }
}

function normalizedShortCode(profile: CatalogProfile | undefined): string | null {
  const code = profile?.short_code?.trim().toUpperCase()
  return code ? code : null
}
