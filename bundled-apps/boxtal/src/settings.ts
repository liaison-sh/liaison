// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Boxtal settings tools. The ship-from (sender) address is org config the create
// path requires (a Boxtal v3 order needs a structured `fromAddress`). It is
// persisted in the generic `app_config` key/value store under `sender_address`
// as a `PostalParty`, and read back to pre-fill the settings form + drive the
// create-path sender assembly.

import { type PostalParty, partyFromConfig, validateParty } from "./address"
import { CARRIER_BRANDS, resolveCarrierBrand } from "./carriers"
import {
  NEUTRAL_PACKAGING_POLICY,
  normalizePackagingPolicy,
  PACKAGING_POLICY_KEY,
  type PackagingPolicy,
  packagingPolicyFromValue,
  packagingPolicyProblems,
} from "./packaging-policy"
import {
  MAX_PRODUCT_CODE_LENGTH,
  type ProductCodeConfig,
  productCodeConfigFromValue,
} from "./product-codes"

const SENDER_CONFIG_KEY = "sender_address"
const CARRIER_ALLOWLIST_KEY = "carrier_allowlist"
const EXCLUDE_PICKUP_POINT_KEY = "exclude_pickup_point_services"
const LABEL_FORMAT_KEY = "label_format"
const PRODUCT_CODES_KEY = "product_code_aliases"

/** The label geometries Boxtal will emit. `PDF_A4` is an office sheet carrying the
 *  4x6 label plus carrier boilerplate; `PDF_10x15` is the bare thermal label. */
export const LABEL_FORMATS = ["PDF_A4", "PDF_10x15"] as const
export type LabelFormat = (typeof LABEL_FORMATS)[number]
const DEFAULT_LABEL_FORMAT: LabelFormat = "PDF_A4"

export function isLabelFormat(v: unknown): v is LabelFormat {
  return typeof v === "string" && (LABEL_FORMATS as readonly string[]).includes(v)
}

export interface SettingsDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; limit?: number },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
}

export interface SettingsCtx {
  db: SettingsDb
}

export interface SenderAddressInput {
  name?: string
  company?: string
  email?: string
  phone?: string
  street?: string
  city?: string
  postalCode?: string
  countryIsoCode?: string
}

async function senderRow(ctx: SettingsCtx): Promise<{ id: string; value: unknown } | null> {
  const rows = (await ctx.db.findMany("app_config", {
    where: { key: SENDER_CONFIG_KEY },
    limit: 1,
  })) as Array<{ id: string; value: unknown }>
  return rows[0] ?? null
}

async function allowlistRow(ctx: SettingsCtx): Promise<{ id: string; value: unknown } | null> {
  const rows = (await ctx.db.findMany("app_config", {
    where: { key: CARRIER_ALLOWLIST_KEY },
    limit: 1,
  })) as Array<{ id: string; value: unknown }>
  return rows[0] ?? null
}

/** Read the org's carrier allowlist (canonical brand keys). Empty array means
 *  NO restriction — every carrier is quoted (the create/quote path treats an
 *  empty allowlist as pass-through). Non-string junk in the stored value is
 *  dropped so a corrupt config degrades to "allow all", never to a crash. */
export async function loadCarrierAllowlist(ctx: SettingsCtx): Promise<string[]> {
  const row = await allowlistRow(ctx)
  const v = row?.value
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string")
}

async function excludePickupPointRow(
  ctx: SettingsCtx,
): Promise<{ id: string; value: unknown } | null> {
  const rows = (await ctx.db.findMany("app_config", {
    where: { key: EXCLUDE_PICKUP_POINT_KEY },
    limit: 1,
  })) as Array<{ id: string; value: unknown }>
  return rows[0] ?? null
}

/** Whether the org excludes relay / pickup-point delivery services from quotes and
 *  shipments. DEFAULT true (a B2C door-to-door shop wants home delivery, not a relay
 *  drop), so an org that never set the flag still gets the safe default. Only an
 *  explicitly-persisted `false` lifts the exclusion; any non-boolean stored value
 *  degrades to the default rather than crashing. Stored beside the carrier allowlist
 *  in app_config. */
export async function loadExcludePickupPointServices(ctx: SettingsCtx): Promise<boolean> {
  const row = await excludePickupPointRow(ctx)
  return typeof row?.value === "boolean" ? row.value : true
}

async function labelFormatRow(ctx: SettingsCtx): Promise<{ id: string; value: unknown } | null> {
  const rows = (await ctx.db.findMany("app_config", {
    where: { key: LABEL_FORMAT_KEY },
    limit: 1,
  })) as Array<{ id: string; value: unknown }>
  return rows[0] ?? null
}

/**
 * The org's default label geometry, asked of Boxtal AT ORDER CREATION.
 *
 * This used to be the hardcoded `PDF_A4`, which is why every label came back as
 * an office sheet and printing on the thermal queue meant rasterising, finding
 * the label/terms separator, cropping and rescaling each PDF by hand -- a
 * destructive, layout-dependent pipeline that produces an unscannable barcode
 * the moment a carrier changes its sheet (ticket-10201). Boxtal emits the bare
 * 10x15 label on request, so the format is asked for, not recovered afterwards.
 *
 * An unrecognised or absent stored value degrades to PDF_A4: a wrong-but-legible
 * office sheet beats failing the label buy.
 */
export async function loadLabelFormat(ctx: SettingsCtx): Promise<LabelFormat> {
  const row = await labelFormatRow(ctx)
  return isLabelFormat(row?.value) ? row.value : DEFAULT_LABEL_FORMAT
}

export async function settingsLabelFormatGet(
  ctx: SettingsCtx,
): Promise<{ format: LabelFormat; available: LabelFormat[] }> {
  return { format: await loadLabelFormat(ctx), available: [...LABEL_FORMATS] }
}

export async function settingsLabelFormatSet(
  ctx: SettingsCtx,
  input: { format: string },
): Promise<{ format: LabelFormat }> {
  if (!isLabelFormat(input.format)) {
    throw new Error(`format must be one of: ${LABEL_FORMATS.join(", ")}`)
  }
  const row = await labelFormatRow(ctx)
  if (row) await ctx.db.update("app_config", row.id, { value: input.format })
  else await ctx.db.insert("app_config", { key: LABEL_FORMAT_KEY, value: input.format })
  return { format: input.format }
}

/** Read the allowlist + the pickup-point policy + the selectable brand catalogue
 *  (for the settings UI). */
export async function settingsCarrierAllowlistGet(ctx: SettingsCtx): Promise<{
  allowed: string[]
  available: Array<{ key: string; label: string }>
  exclude_pickup_point_services: boolean
}> {
  return {
    allowed: await loadCarrierAllowlist(ctx),
    available: CARRIER_BRANDS.map((b) => ({ key: b.key, label: b.label })),
    exclude_pickup_point_services: await loadExcludePickupPointServices(ctx),
  }
}

export interface CarrierAllowlistInput {
  /** Brand keys or names to allow, e.g. ["ups","fedex","dhl"]. Empty = allow all.
   *  Omit entirely to leave the allowlist unchanged (e.g. when only toggling the
   *  pickup-point policy). */
  carriers?: string[]
  /** Exclude relay / pickup-point delivery services from quotes and shipments.
   *  Omit to leave the policy unchanged. */
  exclude_pickup_point_services?: boolean
}

/** Persist (upsert) the carrier allowlist and/or the pickup-point policy. Only the
 *  fields present in `input` are written, so the settings UI can flip one without
 *  clobbering the other. Each allowlist entry is resolved to a canonical brand key
 *  (accepting a key, label, or brand name); an UNKNOWN entry is rejected with the
 *  valid-key list rather than silently dropped, so a typo never quietly narrows the
 *  allowed set. An empty `carriers` list LIFTS the carrier restriction. */
export async function settingsCarrierAllowlistSet(
  ctx: SettingsCtx,
  input: CarrierAllowlistInput,
): Promise<{ ok: true; allowed: string[]; exclude_pickup_point_services: boolean }> {
  if (Array.isArray(input.carriers)) {
    const normalized: string[] = []
    const unknown: string[] = []
    for (const raw of input.carriers) {
      const key = resolveCarrierBrand(String(raw))
      if (!key) {
        unknown.push(String(raw))
        continue
      }
      if (!normalized.includes(key)) normalized.push(key)
    }
    if (unknown.length > 0) {
      throw new Error(
        `Unknown carrier(s): ${unknown.join(", ")}. Valid carriers: ${CARRIER_BRANDS.map((b) => b.key).join(", ")}.`,
      )
    }
    const row = await allowlistRow(ctx)
    if (row) await ctx.db.update("app_config", row.id, { value: normalized })
    else await ctx.db.insert("app_config", { key: CARRIER_ALLOWLIST_KEY, value: normalized })
  }
  if (typeof input.exclude_pickup_point_services === "boolean") {
    const row = await excludePickupPointRow(ctx)
    if (row)
      await ctx.db.update("app_config", row.id, { value: input.exclude_pickup_point_services })
    else
      await ctx.db.insert("app_config", {
        key: EXCLUDE_PICKUP_POINT_KEY,
        value: input.exclude_pickup_point_services,
      })
  }
  return {
    ok: true,
    allowed: await loadCarrierAllowlist(ctx),
    exclude_pickup_point_services: await loadExcludePickupPointServices(ctx),
  }
}

/** Read the persisted ship-from address + whether it is complete. */
export async function settingsSenderAddressGet(
  ctx: SettingsCtx,
): Promise<{ sender: PostalParty | null; missing: string[] }> {
  const row = await senderRow(ctx)
  const sender = row ? partyFromConfig(row.value) : null
  return { sender, missing: sender ? validateParty(sender) : ["all"] }
}

/** Persist (upsert) the ship-from address. */
export async function settingsSenderAddressSet(
  ctx: SettingsCtx,
  input: SenderAddressInput,
): Promise<{ ok: true; missing: string[] }> {
  const value: PostalParty = {
    name: input.name ?? null,
    company: input.company ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    street: input.street ?? null,
    city: input.city ?? null,
    postalCode: input.postalCode ?? null,
    countryIsoCode: input.countryIsoCode ?? null,
    type: "BUSINESS",
  }
  const row = await senderRow(ctx)
  if (row) {
    await ctx.db.update("app_config", row.id, { value })
  } else {
    await ctx.db.insert("app_config", { key: SENDER_CONFIG_KEY, value })
  }
  return { ok: true, missing: validateParty(value) }
}

// — the settings page's reads and its own pair —

const SENDER_FORM_KEYS = [
  "name",
  "company",
  "email",
  "phone",
  "street",
  "city",
  "postalCode",
  "countryIsoCode",
] as const satisfies ReadonlyArray<keyof SenderAddressInput>

/**
 * `settings_sender_form_get` (read only, the settings page's own): the stored
 * ship-from fields, flat and only the non-empty ones, which is the shape
 * `settings_sender_address_set` takes. The page hands it back with one field
 * changed to that gated tool, so a click on the page is the same write as the
 * agent's: the same gate, approval card and org approval policy.
 */
export async function settingsSenderFormGet(ctx: SettingsCtx): Promise<SenderAddressInput> {
  const row = await senderRow(ctx)
  const party = row ? partyFromConfig(row.value) : null
  const out: SenderAddressInput = {}
  for (const k of SENDER_FORM_KEYS) {
    const v = party?.[k]
    if (typeof v === "string" && v.trim() !== "") out[k] = v
  }
  return out
}

/** What the settings page's own pair edits: the pickup-point policy and the label format. */
export interface SettingsForm {
  exclude_pickup_point_services: boolean
  label_format: LabelFormat
}

export interface SettingsFormInput {
  exclude_pickup_point_services?: boolean
  label_format?: string
}

/** `settings_form_get` (read only, the settings page's own): the form's current values. */
export async function settingsFormGet(ctx: SettingsCtx): Promise<SettingsForm> {
  return {
    exclude_pickup_point_services: await loadExcludePickupPointServices(ctx),
    label_format: await loadLabelFormat(ctx),
  }
}

/**
 * `settings_form_set` (the settings page's own): the object `settings_form_get`
 * returned, one value changed. Writes only the parts that differ from what is
 * stored. Both settings are ungated (their agent tools are too); the ship-from
 * address is not here, it goes through the gated `settings_sender_address_set`.
 */
export async function settingsFormSet(
  ctx: SettingsCtx,
  input: SettingsFormInput,
): Promise<SettingsForm> {
  const current = await settingsFormGet(ctx)
  if (input.label_format !== undefined && input.label_format !== current.label_format) {
    await settingsLabelFormatSet(ctx, { format: input.label_format })
  }
  if (
    typeof input.exclude_pickup_point_services === "boolean" &&
    input.exclude_pickup_point_services !== current.exclude_pickup_point_services
  ) {
    await settingsCarrierAllowlistSet(ctx, {
      exclude_pickup_point_services: input.exclude_pickup_point_services,
    })
  }
  return settingsFormGet(ctx)
}

// — product codes —

async function productCodesRow(ctx: SettingsCtx): Promise<{ id: string; value: unknown } | null> {
  const rows = (await ctx.db.findMany("app_config", {
    where: { key: PRODUCT_CODES_KEY },
    limit: 1,
  })) as Array<{ id: string; value: unknown }>
  return rows[0] ?? null
}

/** The org's sku to short-code mapping. Unset or corrupt reads as the empty default: skus are
 *  shown as they are, never renamed. */
export async function loadProductCodeConfig(ctx: SettingsCtx): Promise<ProductCodeConfig> {
  return productCodeConfigFromValue((await productCodesRow(ctx))?.value)
}

export interface ProductCodesInput {
  strip_prefixes?: string[]
  strip_suffixes?: string[]
  aliases?: Array<{ sku: string; code: string }>
  ranks?: Array<{ code: string; rank: number }>
}

export async function settingsProductCodesGet(ctx: SettingsCtx): Promise<{
  strip_prefixes: string[]
  strip_suffixes: string[]
  aliases: Array<{ sku: string; code: string }>
  ranks: Array<{ code: string; rank: number }>
}> {
  const cfg = await loadProductCodeConfig(ctx)
  return {
    strip_prefixes: cfg.strip_prefixes,
    strip_suffixes: cfg.strip_suffixes,
    aliases: Object.entries(cfg.aliases).map(([sku, code]) => ({ sku, code })),
    ranks: Object.entries(cfg.ranks ?? {})
      .map(([code, rank]) => ({ code, rank }))
      .sort((a, b) => a.rank - b.rank || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
  }
}

/** Persist the org's product-code mapping. Each field present in `input` REPLACES the stored one;
 *  an omitted field is kept. An empty list clears that part. A malformed alias is rejected with
 *  the offending entry named, never silently dropped. */
export async function settingsProductCodesSet(
  ctx: SettingsCtx,
  input: ProductCodesInput,
): Promise<Awaited<ReturnType<typeof settingsProductCodesGet>>> {
  const current = await loadProductCodeConfig(ctx)
  const next: ProductCodeConfig = {
    strip_prefixes: current.strip_prefixes,
    strip_suffixes: current.strip_suffixes,
    aliases: current.aliases,
    ...(current.ranks ? { ranks: current.ranks } : {}),
  }
  const cleanList = (field: string, v: unknown): string[] => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim() === "")) {
      throw new Error(`${field} must be a list of non-empty strings`)
    }
    return [...new Set(v.map((x) => String(x).trim()))]
  }
  if (input.strip_prefixes !== undefined)
    next.strip_prefixes = cleanList("strip_prefixes", input.strip_prefixes)
  if (input.strip_suffixes !== undefined)
    next.strip_suffixes = cleanList("strip_suffixes", input.strip_suffixes)
  if (input.aliases !== undefined) {
    if (!Array.isArray(input.aliases)) throw new Error("aliases must be a list of { sku, code }")
    const aliases: Record<string, string> = {}
    const bad: string[] = []
    for (const a of input.aliases) {
      const sku = typeof a?.sku === "string" ? a.sku.trim().toUpperCase() : ""
      const code = typeof a?.code === "string" ? a.code.trim() : ""
      if (sku === "" || code === "" || code.length > MAX_PRODUCT_CODE_LENGTH) {
        bad.push(JSON.stringify(a))
        continue
      }
      aliases[sku] = code
    }
    if (bad.length > 0) {
      throw new Error(
        `Invalid alias(es): ${bad.join(", ")}. Each needs a non-empty sku and a code of 1 to ${MAX_PRODUCT_CODE_LENGTH} characters.`,
      )
    }
    next.aliases = aliases
  }
  if (input.ranks !== undefined) {
    if (!Array.isArray(input.ranks)) throw new Error("ranks must be a list of { code, rank }")
    const ranks: Record<string, number> = {}
    const bad: string[] = []
    for (const r of input.ranks) {
      const code = typeof r?.code === "string" ? r.code.trim().toUpperCase() : ""
      const rank = r?.rank
      if (
        code === "" ||
        code.length > MAX_PRODUCT_CODE_LENGTH ||
        typeof rank !== "number" ||
        !Number.isInteger(rank)
      ) {
        bad.push(JSON.stringify(r))
        continue
      }
      ranks[code] = rank
    }
    if (bad.length > 0) {
      throw new Error(
        `Invalid rank(s): ${bad.join(", ")}. Each needs a code of 1 to ${MAX_PRODUCT_CODE_LENGTH} characters and an integer rank.`,
      )
    }
    if (Object.keys(ranks).length > 0) next.ranks = ranks
    else delete next.ranks
  }
  const row = await productCodesRow(ctx)
  if (row) await ctx.db.update("app_config", row.id, { value: next })
  else await ctx.db.insert("app_config", { key: PRODUCT_CODES_KEY, value: next })
  return settingsProductCodesGet(ctx)
}

// — packaging policy —

async function packagingPolicyRow(
  ctx: SettingsCtx,
): Promise<{ id: string; value: unknown } | null> {
  const rows = (await ctx.db.findMany("app_config", {
    where: { key: PACKAGING_POLICY_KEY },
    limit: 1,
  })) as Array<{ id: string; value: unknown }>
  return rows[0] ?? null
}

/** The org's packaging policy. Unset or corrupt reads as the neutral default (no cartons, one raw
 *  stack, no nominal value), never as another company's cartons. */
export async function loadPackagingPolicy(ctx: SettingsCtx): Promise<PackagingPolicy> {
  return packagingPolicyFromValue((await packagingPolicyRow(ctx))?.value)
}

export async function settingsPackagingPolicyGet(
  ctx: SettingsCtx,
): Promise<PackagingPolicy & { configured: boolean }> {
  const row = await packagingPolicyRow(ctx)
  const policy = packagingPolicyFromValue(row?.value)
  return { ...policy, configured: row != null && policy !== NEUTRAL_PACKAGING_POLICY }
}

export type PackagingPolicyInput = Partial<PackagingPolicy> & { reset?: boolean }

/** Persist the org's packaging policy. Each field present in `input` REPLACES the stored one; an
 *  omitted field is kept; `reset: true` starts from the neutral default. The merged policy is
 *  validated as a whole and refused with every problem named, writing nothing. */
export async function settingsPackagingPolicySet(
  ctx: SettingsCtx,
  input: PackagingPolicyInput,
): Promise<PackagingPolicy & { configured: boolean }> {
  const current = input.reset === true ? NEUTRAL_PACKAGING_POLICY : await loadPackagingPolicy(ctx)
  const next: PackagingPolicy = {
    raw_stack_max_height:
      input.raw_stack_max_height !== undefined
        ? input.raw_stack_max_height
        : current.raw_stack_max_height,
    cartons: input.cartons !== undefined ? input.cartons : current.cartons,
    merge_leftovers_into_packs:
      input.merge_leftovers_into_packs !== undefined
        ? input.merge_leftovers_into_packs
        : current.merge_leftovers_into_packs,
    pack_merge_height_allowance:
      input.pack_merge_height_allowance !== undefined
        ? input.pack_merge_height_allowance
        : current.pack_merge_height_allowance,
    nominal_proforma_value_minor:
      input.nominal_proforma_value_minor !== undefined
        ? input.nominal_proforma_value_minor
        : current.nominal_proforma_value_minor,
    master_cartons:
      input.master_cartons !== undefined ? input.master_cartons : current.master_cartons,
  }
  const problems = packagingPolicyProblems(next)
  if (problems.length > 0) throw new Error(`Invalid packaging policy: ${problems.join("; ")}.`)
  const value = normalizePackagingPolicy(next)
  const row = await packagingPolicyRow(ctx)
  if (row) await ctx.db.update("app_config", row.id, { value })
  else await ctx.db.insert("app_config", { key: PACKAGING_POLICY_KEY, value })
  return settingsPackagingPolicyGet(ctx)
}
