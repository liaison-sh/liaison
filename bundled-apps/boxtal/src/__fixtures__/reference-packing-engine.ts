// Reference packing engine, the oracle the resolver is replayed against
// (resolver-reference-engine.test.ts). Its algorithm and reference data are kept verbatim; only the
// operator-facing rationale and trace strings were shortened. It was supplied by the operations team as the
// specification of the house packing rules; the resolver implements the same rules generically,
// with every figure below held as org data (packaging policy + shipping profiles). Do not edit the
// algorithm: if the rules change, change the org data and this oracle together.

/**
 * FABRIKAM — deterministic parcel engine (dimensions + weight)
 *
 * Single source of truth for "what carton, what size, what weight" for an
 * outbound Tessera order. Pure, dependency-free, no I/O: same input -> same
 * output, always. Intended to replace the connector's current auto-resolver.
 *
 * Rules implemented, in the order they are applied (Priya, 2026-08-12):
 *   1. MASTER CARTONS first: whenever the quantity of one product reaches a
 *      standard master-carton count, ship those units as master cartons.
 *   2. STANDARD CARTONS next: what is left goes into 60x40x20, else 60x40x30.
 *   3. RAW STACK last: the remainder travels as the bare stack of its items.
 *
 * ABSOLUTE RULE — NO MARGIN IS EVER ADDED TO A DIMENSION. Never +1 cm on L, W
 * or H, on a stack or on a carton, for any reason. A declared size is either a
 * carton's own dimensions or the raw stack of real package sizes. The +1 cm and
 * +3 cm below are NOT margins: they are the real heights of a USB-C cable box
 * and a PSU box laid BESIDE the stack, counted once (see SMALL_ACCESSORIES).
 */

/** Short product code used across the packing rules. */
export type ProductCode = "ET2" | "MP" | "DS" | "BS" | "FS" | "HC" | "PS" | "USBC"

export interface Product {
  code: ProductCode
  name: string
  /** Package length in cm — the item already boxed in its retail packaging. */
  length: number
  /** Package width in cm. */
  width: number
  /** Package thickness in cm — this is what stacks. */
  height: number
  /** Gross weight in kg, retail box included. Never a net weight. */
  grossWeight: number
  /** Shopify variant ids that resolve to this product. */
  variantIds: string[]
}

export interface OrderLine {
  code: ProductCode
  quantity: number
}

export type ParcelKind = "master_carton" | "standard_carton" | "raw_stack"

export interface Parcel {
  length: number
  width: number
  height: number
  /** Total gross weight in kg, carton included. */
  weight: number
  kind: ParcelKind
  /** What is inside, e.g. { ET2: 5 }. */
  contents: Partial<Record<ProductCode, number>>
  /** Human-readable justification, for the operator and for audit. */
  rationale: string
}

export interface PackingResult {
  parcels: Parcel[]
  /** Sum of the parcels' weights, kg, rounded to 3 decimals. */
  totalWeight: number
  /** Ordered log of every decision taken. */
  trace: string[]
  /**
   * Conditions the caller MUST surface to the operator instead of silently
   * shipping: an unpackable footprint, an unknown product, an assumption used.
   */
  warnings: string[]
}

export interface PackingOptions {
  /**
   * Tare of the 60x40x30 standard carton, kg. NOT a confirmed figure: the
   * reference doc only records 0.5 kg for the 60x40x20. Set this once the real
   * carton has been weighed.
   */
  standardCarton30Tare?: number
}

/**
 * Per-item package size + gross weight. Verified identical to the live Boxtal
 * product profiles on 2026-08-12.
 */
export const PRODUCTS: Record<ProductCode, Product> = {
  ET2: {
    code: "ET2",
    name: "Tessera 2",
    length: 59,
    width: 38,
    height: 8,
    grossWeight: 4.0,
    variantIds: ["47748313416011", "53394068734283", "55968599376203", "56257042448715", "57467563475275"],
  },
  MP: {
    code: "MP",
    name: "Tessera 2 Mounting Plate",
    length: 49,
    width: 34,
    height: 10,
    grossWeight: 3.1,
    variantIds: ["50464471744843", "56257269858635"],
  },
  DS: {
    code: "DS",
    name: "Tessera 2 Silicone Skin",
    length: 50,
    width: 34,
    height: 1,
    grossWeight: 0.85,
    variantIds: ["50468196057419", "56257098023243"],
  },
  BS: {
    code: "BS",
    name: "Tessera 2 Black Skin",
    length: 50,
    width: 34,
    height: 1,
    grossWeight: 0.85,
    variantIds: ["53337545703755", "56257227063627"],
  },
  FS: {
    code: "FS",
    name: "Tessera 2 Fabric Skin",
    length: 50,
    width: 34,
    height: 1,
    grossWeight: 0.65,
    variantIds: ["50468186128715", "56257083343179"],
  },
  HC: {
    code: "HC",
    name: "Tessera 2 Hard Cover",
    length: 45,
    width: 30,
    height: 3,
    grossWeight: 0.5,
    variantIds: ["50464416465227", "56257285423435"],
  },
  PS: {
    code: "PS",
    name: "Tessera Power Supply",
    length: 20,
    width: 15,
    height: 3,
    grossWeight: 0.2,
    variantIds: ["50778580189515"],
  },
  USBC: {
    code: "USBC",
    name: "Tessera USB Type-C Cable",
    length: 20,
    width: 15,
    height: 1,
    grossWeight: 0.052,
    variantIds: ["50778599915851"],
  },
}

export interface MasterCarton {
  code: ProductCode
  /** Number of units the master carton holds. */
  units: number
  length: number
  width: number
  height: number
  /** Confirmed total gross weight, kg. */
  weight: number
}

export const MASTER_CARTONS: MasterCarton[] = [
  { code: "ET2", units: 5, length: 60, width: 39, height: 38, weight: 21 },
  { code: "HC", units: 12, length: 51, width: 41, height: 35, weight: 13.4 },
  { code: "FS", units: 20, length: 50, width: 34, height: 37, weight: 16 },
  { code: "BS", units: 20, length: 50, width: 34, height: 37, weight: 18 },
  { code: "DS", units: 20, length: 50, width: 34, height: 37, weight: 18 },
  { code: "MP", units: 4, length: 50, width: 41, height: 35, weight: 13.2 },
]

export interface StandardCarton {
  length: number
  width: number
  height: number
  tare: number
  maxStack: number
}

export const CARTON_20_TARE = 0.5
export const CARTON_20_MAX_STACK = 23
export const CARTON_30_MAX_STACK = 30
export const CARTON_30_TARE_ASSUMED = 0.5
export const RAW_STACK_MAX_HEIGHT = 17
export const SMALL_ACCESSORIES: ProductCode[] = ["PS", "USBC"]

const round3 = (n: number) => Math.round(n * 1000) / 1000

function toQuantities(lines: OrderLine[], warnings: string[]): Map<ProductCode, number> {
  const quantities = new Map<ProductCode, number>()
  for (const line of lines) {
    if (!PRODUCTS[line.code]) {
      warnings.push(`Unknown product code "${line.code}": not packed, ask the operator.`)
      continue
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 0) {
      warnings.push(`Invalid quantity ${line.quantity} for ${line.code}: not packed.`)
      continue
    }
    if (line.quantity === 0) continue
    quantities.set(line.code, (quantities.get(line.code) ?? 0) + line.quantity)
  }
  return quantities
}

function contentsWeight(contents: Partial<Record<ProductCode, number>>): number {
  let weight = 0
  for (const [code, qty] of Object.entries(contents) as [ProductCode, number][]) {
    weight += PRODUCTS[code].grossWeight * qty
  }
  return weight
}

function stackGeometry(contents: Partial<Record<ProductCode, number>>): {
  length: number
  width: number
  height: number
} {
  let length = 0
  let width = 0
  let stacked = 0
  let tallestAccessory = 0
  let hasBaseItem = false

  for (const [code, qty] of Object.entries(contents) as [ProductCode, number][]) {
    if (qty <= 0) continue
    const product = PRODUCTS[code]
    length = Math.max(length, product.length)
    width = Math.max(width, product.width)

    if (SMALL_ACCESSORIES.includes(code)) {
      tallestAccessory = Math.max(tallestAccessory, product.height)
    } else {
      hasBaseItem = true
      stacked += product.height * qty
    }
  }

  if (!hasBaseItem) {
    let accessoriesOnly = 0
    for (const [code, qty] of Object.entries(contents) as [ProductCode, number][]) {
      if (qty > 0 && SMALL_ACCESSORIES.includes(code)) accessoriesOnly += PRODUCTS[code].height * qty
    }
    return { length, width, height: accessoriesOnly }
  }

  return { length, width, height: stacked + tallestAccessory }
}

function fitsStandardBase(length: number, width: number): boolean {
  return length <= 60 && width <= 40
}

export function computeParcels(lines: OrderLine[], options: PackingOptions = {}): PackingResult {
  const warnings: string[] = []
  const trace: string[] = []
  const parcels: Parcel[] = []
  const quantities = toQuantities(lines, warnings)

  const standardCartons: StandardCarton[] = [
    { length: 60, width: 40, height: 20, tare: CARTON_20_TARE, maxStack: CARTON_20_MAX_STACK },
    {
      length: 60,
      width: 40,
      height: 30,
      tare: options.standardCarton30Tare ?? CARTON_30_TARE_ASSUMED,
      maxStack: CARTON_30_MAX_STACK,
    },
  ]

  for (const master of MASTER_CARTONS) {
    const available = quantities.get(master.code) ?? 0
    if (available < master.units) continue

    const count = Math.floor(available / master.units)
    quantities.set(master.code, available - count * master.units)

    for (let i = 0; i < count; i++) {
      parcels.push({
        length: master.length,
        width: master.width,
        height: master.height,
        weight: master.weight,
        kind: "master_carton",
        contents: { [master.code]: master.units },
        rationale: `Master carton ${master.units}x ${master.code}`,
      })
    }
    trace.push(`Step 1: ${count} master carton(s) of ${master.units}x ${master.code}`)
  }

  const loose: Partial<Record<ProductCode, number>> = {}
  for (const [code, qty] of quantities) if (qty > 0) loose[code] = qty
  const looseCount = Object.values(loose).reduce((a, b) => a + (b ?? 0), 0)

  if (looseCount === 0) {
    if (parcels.length === 0) {
      warnings.push("Nothing to pack: no shippable line in this order.")
      trace.push("No shippable item: no parcel produced.")
    } else {
      trace.push("Every unit fitted a master carton; no loose remainder.")
    }
    return { parcels, totalWeight: round3(parcels.reduce((a, p) => a + p.weight, 0)), trace, warnings }
  }

  let remaining: Partial<Record<ProductCode, number>> = { ...loose }

  while (Object.values(remaining).some((q) => (q ?? 0) > 0)) {
    const geometry = stackGeometry(remaining)
    const weight = contentsWeight(remaining)

    if (geometry.height <= RAW_STACK_MAX_HEIGHT) {
      parcels.push({
        length: geometry.length,
        width: geometry.width,
        height: geometry.height,
        weight: round3(weight),
        kind: "raw_stack",
        contents: { ...remaining },
        rationale: "Raw stack",
      })
      remaining = {}
      break
    }

    if (!fitsStandardBase(geometry.length, geometry.width)) {
      warnings.push(
        `Footprint ${geometry.length}x${geometry.width} cm exceeds the 60x40 standard carton base: ` +
          `no standard packaging fits, ask the operator which carton to use.`,
      )
      parcels.push({
        length: geometry.length,
        width: geometry.width,
        height: geometry.height,
        weight: round3(weight),
        kind: "raw_stack",
        contents: { ...remaining },
        rationale: "PROPOSAL ONLY: oversized footprint, no standard carton fits.",
      })
      remaining = {}
      break
    }

    const carton = standardCartons.find((c) => geometry.height <= c.maxStack)

    if (carton) {
      if (carton.height === 30 && options.standardCarton30Tare === undefined) {
        warnings.push(
          `60x40x30 carton used with an ASSUMED tare of ${CARTON_30_TARE_ASSUMED} kg: ` +
            `weigh the empty carton and pass standardCarton30Tare.`,
        )
      }
      parcels.push({
        length: carton.length,
        width: carton.width,
        height: carton.height,
        weight: round3(weight + carton.tare),
        kind: "standard_carton",
        contents: { ...remaining },
        rationale: "Standard carton",
      })
      remaining = {}
      break
    }

    const biggest = standardCartons[standardCartons.length - 1]!
    const split = fillCarton(remaining, biggest.maxStack)

    if (Object.values(split.taken).every((q) => (q ?? 0) === 0)) {
      warnings.push(
        `A single item stacks to more than ${biggest.height} cm: no standard carton fits, ` +
          `ask the operator which packaging to use.`,
      )
      parcels.push({
        length: geometry.length,
        width: geometry.width,
        height: geometry.height,
        weight: round3(weight),
        kind: "raw_stack",
        contents: { ...remaining },
        rationale: "PROPOSAL ONLY: taller than every standard carton.",
      })
      remaining = {}
      break
    }

    const takenWeight = contentsWeight(split.taken)
    if (options.standardCarton30Tare === undefined) {
      warnings.push(
        `60x40x30 carton used with an ASSUMED tare of ${CARTON_30_TARE_ASSUMED} kg: ` +
          `weigh the empty carton and pass standardCarton30Tare.`,
      )
    }
    parcels.push({
      length: biggest.length,
      width: biggest.width,
      height: biggest.height,
      weight: round3(takenWeight + biggest.tare),
      kind: "standard_carton",
      contents: split.taken,
      rationale: "Split carton",
    })
    remaining = split.left
  }

  return {
    parcels,
    totalWeight: round3(parcels.reduce((a, p) => a + p.weight, 0)),
    trace,
    warnings,
  }
}

function fillCarton(
  remaining: Partial<Record<ProductCode, number>>,
  maxHeight: number,
): { taken: Partial<Record<ProductCode, number>>; left: Partial<Record<ProductCode, number>> } {
  const taken: Partial<Record<ProductCode, number>> = {}
  const left: Partial<Record<ProductCode, number>> = { ...remaining }

  const byThicknessDesc = (Object.keys(remaining) as ProductCode[])
    .filter((code) => (remaining[code] ?? 0) > 0 && !SMALL_ACCESSORIES.includes(code))
    .sort((a, b) => PRODUCTS[b].height - PRODUCTS[a].height || a.localeCompare(b))

  let used = 0
  for (const code of byThicknessDesc) {
    const product = PRODUCTS[code]
    let available = left[code] ?? 0
    while (available > 0 && used + product.height <= maxHeight) {
      taken[code] = (taken[code] ?? 0) + 1
      available -= 1
      used += product.height
    }
    left[code] = available
  }

  for (const code of SMALL_ACCESSORIES) {
    const available = left[code] ?? 0
    if (available > 0 && used + PRODUCTS[code].height <= maxHeight) {
      taken[code] = available
      left[code] = 0
    }
  }

  for (const key of Object.keys(left) as ProductCode[]) if ((left[key] ?? 0) === 0) delete left[key]
  return { taken, left }
}
