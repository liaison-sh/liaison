// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PRODUCT CODES: the short operator-facing code a raw sku reads as, and the merged quantity list the
// prep grid's products cell shows.
//
// A row's `products` field is a quantity list. For a row with a cached draft it is built from the
// line summaries, which already resolve each line through its shipping profile's `short_code`. For
// a row with no document yet it is built from the Shopify order's line items, which carry the RAW
// sku. A store that sells the same product through two channels (a retail variant with a shipping
// profile, and a wholesale variant wrapped in a house prefix and a channel suffix without one) then
// shows the same product under two names, and a long wholesale sku wraps the cell over many lines.
//
// How a store's skus map onto its short codes is that store's data, not this app's: it is held per
// org in `app_config` under `product_code_aliases` (`settings_product_codes_get` / `_set`), and the
// DEFAULT is empty. With the empty default a sku is only trimmed, never renamed, and a product listed
// on several line items is still merged into one entry with the summed quantity.
//
// Deliberately NOT a heuristic. A wrong guess silently mislabels what is in a carton, so a code
// comes only from an alias the org declared. An sku that matches no alias is kept in its normalized
// (shorter) form and never dropped: an unnamable item in a carton is exactly what an operator must
// be able to read.

/** The org's sku to short-code mapping. Every field may be empty. */
export interface ProductCodeConfig {
  /** House prefixes stripped from the front of an sku (case-insensitive), e.g. "ACME-". */
  strip_prefixes: string[]
  /** Channel suffixes stripped from the end of an sku (case-insensitive), e.g. "-B2B". */
  strip_suffixes: string[]
  /**
   * Normalized sku (or its trailing product word) -> short code. Keys are matched upper-cased, so
   * "k1-hardcover" and "K1-HARDCOVER" are the same key. List both the full form and the product word
   * when a differently prefixed variant of the same item should land on the same code.
   */
  aliases: Record<string, string>
  /**
   * Upper-cased short code -> display rank in the products column: lower shows first. A code with
   * no rank counts as DEFAULT_PRODUCT_CODE_RANK; ties read alphabetically. Absent or empty keeps the
   * first-appearance order, so an org that never set a rank sees no change.
   */
  ranks?: Record<string, number>
}

/** The rank a short code with no declared rank sorts at: ranks below it show before, above after. */
export const DEFAULT_PRODUCT_CODE_RANK = 100

export const EMPTY_PRODUCT_CODE_CONFIG: ProductCodeConfig = Object.freeze({
  strip_prefixes: [],
  strip_suffixes: [],
  aliases: {},
}) as ProductCodeConfig

/** Longest short code an alias may map to: the grid chip renders up to this many characters. */
export const MAX_PRODUCT_CODE_LENGTH = 12

/** One merged entry of the products summary: a display code and its total quantity. */
export interface ProductCode {
  /** Short operator-facing code, e.g. "K1". Never empty. */
  code: string
  /** Total units across every entry that resolved to `code`. */
  qty: number
}

/**
 * Strip the org's wrapper off an sku: one channel suffix, then one house prefix, case-insensitively.
 * Everything else is left alone: a free-text token, a Shopify gid or an already-short code comes
 * back unchanged apart from surrounding whitespace.
 */
export function normalizeProductSku(
  raw: string,
  config: ProductCodeConfig = EMPTY_PRODUCT_CODE_CONFIG,
): string {
  let s = raw.trim()
  if (s === "") return s
  const upper = () => s.toUpperCase()
  const suffix = config.strip_suffixes.find((x) => x !== "" && upper().endsWith(x.toUpperCase()))
  if (suffix) s = s.slice(0, s.length - suffix.length)
  const prefix = config.strip_prefixes.find((x) => x !== "" && upper().startsWith(x.toUpperCase()))
  if (prefix) s = s.slice(prefix.length)
  return s.trim()
}

/**
 * The short display code for one sku: the alias when the normalized sku (or its trailing product
 * word) has one, else the normalized sku itself. Never returns an empty string for a non-empty
 * input: an unknown sku degrades to a shorter, readable form rather than disappearing.
 */
export function shortProductCode(
  raw: string,
  config: ProductCodeConfig = EMPTY_PRODUCT_CODE_CONFIG,
): string {
  const normalized = normalizeProductSku(raw, config)
  if (normalized === "") return raw.trim()
  const key = normalized.toUpperCase()
  const direct = config.aliases[key]
  if (direct) return direct
  // "<family>-<product>": try the product word alone, so a family prefix the org never listed
  // ("K2-HARDCOVER") still resolves to the accessory's code.
  const tail = key.split(/[-_]/).pop() ?? ""
  const byTail = tail && tail !== key ? config.aliases[tail] : undefined
  return byTail ?? normalized
}

const QTY_PREFIX = /^(\d+(?:[.,]\d+)?)\s*x(.+)$/i

/**
 * Parse a `products` summary ("2xACME-K1-BLACK-B2B, 1xK1") into merged, short-coded entries in
 * first-appearance order, or in the org's rank order when it declared ranks. Returns an EMPTY array when the string is not a quantity list at all
 * (the "-" placeholder, or the "2 parcels" fallback `summarizeProducts` emits for a draft with no
 * goods lines), which is the renderer's signal to show the string verbatim instead.
 */
export function resolveProductCodes(
  summary: string,
  config: ProductCodeConfig = EMPTY_PRODUCT_CODE_CONFIG,
): ProductCode[] {
  const out: ProductCode[] = []
  const byCode = new Map<string, ProductCode>()
  for (const part of summary.split(",")) {
    const m = QTY_PREFIX.exec(part.trim())
    if (!m) continue
    const qty = Number((m[1] ?? "1").replace(",", "."))
    const token = (m[2] ?? "").trim()
    if (token === "" || !Number.isFinite(qty)) continue
    const code = shortProductCode(token, config)
    if (code === "") continue
    const existing = byCode.get(code)
    if (existing) {
      existing.qty += qty
      continue
    }
    const entry: ProductCode = { code, qty }
    byCode.set(code, entry)
    out.push(entry)
  }
  return sortByProductRank(out, config)
}

function hasRanks(config: ProductCodeConfig): boolean {
  return config.ranks != null && Object.keys(config.ranks).length > 0
}

/**
 * Order entries by the org's display rank: ascending rank (a code without one counts as
 * DEFAULT_PRODUCT_CODE_RANK), then the code alphabetically. With no rank declared at all the input
 * order is returned untouched, so nothing changes for an org until it sets one.
 */
export function sortByProductRank<T extends { code: string }>(
  entries: T[],
  config: ProductCodeConfig,
): T[] {
  if (!hasRanks(config)) return entries
  const ranks = config.ranks ?? {}
  const rankOf = (code: string) => ranks[code.toUpperCase()] ?? DEFAULT_PRODUCT_CODE_RANK
  return [...entries].sort((a, b) => {
    const d = rankOf(a.code) - rankOf(b.code)
    if (d !== 0) return d
    const ua = a.code.toUpperCase()
    const ub = b.code.toUpperCase()
    return ua < ub ? -1 : ua > ub ? 1 : 0
  })
}

/**
 * Reorder a `products` summary string ("1xMP, 1xBSkin, 1xET2") by the org's display rank, keeping
 * each entry's text as it is. The products column of every queue goes through this at read time, so
 * a stored summary follows a rank set after it was written. A string that is not a quantity list
 * ("-", "2 parcels"), or an org with no rank, comes back unchanged.
 */
export function orderProductsSummary(
  summary: string,
  config: ProductCodeConfig = EMPTY_PRODUCT_CODE_CONFIG,
): string {
  if (!hasRanks(config)) return summary
  const parts = summary
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "")
  const entries: Array<{ code: string; text: string }> = []
  for (const text of parts) {
    const m = QTY_PREFIX.exec(text)
    if (!m) return summary
    entries.push({ code: shortProductCode((m[2] ?? "").trim(), config), text })
  }
  if (entries.length < 2) return summary
  return sortByProductRank(entries, config)
    .map((e) => e.text)
    .join(", ")
}

const stringList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
    : []

/**
 * Coerce a stored `app_config.value` into a config. Junk degrades to the empty default (skus shown
 * as they are), never to a crash: a corrupt setting must not take the worklist down.
 */
export function productCodeConfigFromValue(value: unknown): ProductCodeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return EMPTY_PRODUCT_CODE_CONFIG
  const v = value as Record<string, unknown>
  const aliases: Record<string, string> = {}
  if (typeof v.aliases === "object" && v.aliases !== null && !Array.isArray(v.aliases)) {
    for (const [k, code] of Object.entries(v.aliases as Record<string, unknown>)) {
      if (typeof code !== "string") continue
      const key = k.trim().toUpperCase()
      const c = code.trim()
      if (key !== "" && c !== "" && c.length <= MAX_PRODUCT_CODE_LENGTH) aliases[key] = c
    }
  }
  const out: ProductCodeConfig = {
    strip_prefixes: stringList(v.strip_prefixes),
    strip_suffixes: stringList(v.strip_suffixes),
    aliases,
  }
  // Ranks are optional: a value stored before they existed has none and keeps its first-appearance
  // order. A junk entry is skipped, never fatal.
  if (typeof v.ranks === "object" && v.ranks !== null && !Array.isArray(v.ranks)) {
    const ranks: Record<string, number> = {}
    for (const [k, rank] of Object.entries(v.ranks as Record<string, unknown>)) {
      const key = k.trim().toUpperCase()
      if (key !== "" && key.length <= MAX_PRODUCT_CODE_LENGTH && Number.isInteger(rank))
        ranks[key] = rank as number
    }
    if (Object.keys(ranks).length > 0) out.ranks = ranks
  }
  return out
}
